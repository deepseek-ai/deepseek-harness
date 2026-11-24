/**
 * Typed REST client of the Lark / Feishu OpenAPI.
 *
 * One request = one HTTPS call against the configured OpenAPI root, authorized with the tenant access token of
 * {@link ./token.ts}. The client is transport-injected (`LarkHttp`), so tests drive it with `ctx.http`'s `http/fetch`
 * hook and never touch the network.
 *
 * The platform answers every route with the same envelope — `{ code, msg, data }` — except the few routes that put
 * their payload at the top level (`bot/v3/info`). {@link LarkApi.request} validates that envelope and throws
 * {@link LarkApiError} for a `code` or a non-2xx status; `errors.classify` turns it into the core taxonomy. The
 * client itself never retries: the core pipeline owns retries.
 *
 * Routes: bot identity, message create/reply/update/patch/delete/get/list, chat get, image and file upload, message
 * resource download, and reactions. The generated `types/` tree stays the escape hatch (`bot.internal`, `/_api/:name`).
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/api/client
 */

import type { Im, Message, MessageReaction } from '../types/index.ts'
import { LarkApiError } from '../errors.ts'
import { isDict, nonEmpty } from './events.ts'

/** Request initializer the client hands to its transport. */
export interface LarkHttpInit {
  method?: string | undefined
  /** JSON body, multipart `FormData`, or nothing. */
  data?: unknown
  headers?: Record<string, string> | undefined
  /** Query parameters; the transport appends them to the URL and skips `undefined`. */
  params?: Record<string, string | number | undefined> | undefined
  signal?: AbortSignal | undefined
}

/** HTTP transport of the client: the `ctx.http` callable. */
export type LarkHttp = (url: string, init: LarkHttpInit) => Promise<Response>

export interface LarkApiOptions {
  /** Transport (the adapter passes the `ctx.http` callable). */
  http: LarkHttp
  /** OpenAPI root with a trailing slash. */
  baseUrl: string
  /** Current tenant access token; called before every request so a refresh applies immediately. */
  token: (signal?: AbortSignal) => Promise<string>
  /** `Authorization` header builder; default `Bearer <token>`. */
  authorize?: (token: string) => string
}

/** Query parameters of one request; `undefined` entries are dropped. */
export type LarkQuery = Record<string, string | number | undefined>

/** The platform envelope every route answers with. */
export interface LarkEnvelope<T = unknown> {
  /** 0 on success; any other value is a platform-declared failure. */
  code: number
  msg?: string
  /** Route payload; absent for routes that answer with a top-level field or nothing. */
  data?: T
  [key: string]: unknown
}

/** Identity of the bot itself (`GET /bot/v3/info`). */
export interface LarkBotInfo {
  open_id?: string
  app_name?: string
  avatar_url?: string
  ip_white_list?: string[]
}

/** Query of one message read; `card_msg_content_type` is what makes a card read as the JSON it was sent with. */
export interface LarkMessageQuery {
  user_id_type?: 'open_id' | 'union_id' | 'user_id'
  card_msg_content_type?: 'user_card_content'
}

/** Query of one message list page (`page_size` 1–50, chat or thread container). */
export interface LarkMessageListQuery {
  container_id_type: 'chat' | 'thread'
  container_id: string
  start_time?: string
  end_time?: string
  sort_type?: 'ByCreateTimeAsc' | 'ByCreateTimeDesc'
  page_size?: number
  page_token?: string
  card_msg_content_type?: 'user_card_content'
}

/** One page of messages, as the platform shapes it. */
export interface LarkMessagePage {
  items?: Message[]
  has_more?: boolean
  page_token?: string
  page_size?: number
}

/** One page of reactions (`IM.MessageReaction` of `types/`). */
export interface LarkReactionPage {
  items?: MessageReaction[]
  has_more?: boolean
  page_token?: string
  page_size?: number
}

/** Query of one reaction list page. */
export interface LarkReactionQuery {
  reaction_type?: string
  page_size?: number
  page_token?: string
  user_id_type?: 'open_id' | 'union_id' | 'user_id'
}

/** Which id the reply/create `receive_id` carries. */
export type LarkReceiveIdType = 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id'

/** File kind of an upload; the platform matches it to the message kind it is sent as. */
export type LarkFileType = Im.File.CreateForm['file_type']

/** Bytes of one downloaded resource plus the media type the platform answered with. */
export interface LarkResourceAnswer {
  data: ArrayBuffer
  /** `content-type` of the answer, when it carried one. */
  mime?: string
}

/** Options of one {@link LarkApi.request}. */
export interface LarkRequestOptions {
  /** JSON body or multipart `FormData`. */
  data?: unknown
  params?: LarkQuery | undefined
  signal?: AbortSignal | undefined
}

/** `Retry-After` of an answer, in milliseconds (the header is in seconds). */
function retryAfterMsOf(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'))
  return Number.isFinite(value) && value > 0 ? value * 1000 : undefined
}

/** Turn a typed query object into transport parameters, dropping the absent fields. */
function queryOf(query: object): LarkQuery {
  const params: LarkQuery = {}
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' || typeof value === 'number') params[key] = value
  }
  return params
}

/** Decode an answer body, tolerating an empty or non-JSON one. */
function parseBody(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The numeric platform code of an answer body, if it carries one. */
function codeOf(body: unknown): number | undefined {
  const code = isDict(body) ? body.code : undefined
  return typeof code === 'number' ? code : undefined
}

/** The `msg` of an answer body, if it carries one. */
function msgOf(body: unknown): string | undefined {
  const msg = isDict(body) ? body.msg : undefined
  return typeof msg === 'string' ? msg : undefined
}

/** A key the caller cannot work without; a successful envelope without it is still a failure. */
function requiredKey(value: unknown, field: string): string {
  const key = nonEmpty(value)
  if (!key) throw new LarkApiError(`Lark answered without ${field}`, { status: 200, published: 'unknown' })
  return key
}

/**
 * REST client of one Lark application.
 *
 * Every call throws {@link LarkApiError} when the platform answered with a non-2xx status, or with a `code` in an
 * otherwise successful body.
 */
export class LarkApi {
  constructor(readonly options: LarkApiOptions) {}

  /** OpenAPI root with a trailing slash. */
  get baseUrl() {
    return this.options.baseUrl.replace(/\/?$/, '/')
  }

  /**
   * Absolute URL of one route.
   *
   * @param path - path below the OpenAPI root (leading `/` optional), or an absolute URL.
   * @returns the absolute URL.
   */
  resolve(path: string) {
    return new URL(path.replace(/^\//, ''), this.baseUrl).href
  }

  /** `Authorization` header value of one token. */
  authorization(token: string) {
    return (this.options.authorize ?? (value => `Bearer ${value}`))(token)
  }

  /**
   * One request, answered with the validated platform envelope.
   *
   * @param method - HTTP method.
   * @param path - path below the OpenAPI root.
   * @param options - body, query, cancellation.
   * @returns the envelope (`code` is 0).
   * @throws LarkApiError for a platform-level failure or a transport failure (wrapped as its cause); a token failure
   * rejects with the error the token client raised.
   */
  async request<T = unknown>(method: string, path: string, options: LarkRequestOptions = {}): Promise<LarkEnvelope<T>> {
    const url = this.resolve(path)
    const response = await this.send(method, url, options)
    const body = parseBody(await response.text())
    const code = codeOf(body)
    if (response.status >= 400) {
      throw new LarkApiError(`${method} ${path} answered ${response.status}`, {
        code,
        status: response.status,
        body,
        retryAfterMs: retryAfterMsOf(response),
      })
    }
    if (code !== undefined && code !== 0) {
      throw new LarkApiError(`${method} ${path} answered code ${code}${msgOf(body) ? `: ${msgOf(body)}` : ''}`, {
        code,
        status: response.status,
        body,
      })
    }
    return (isDict(body) ? body : { code: 0 }) as LarkEnvelope<T>
  }

  /**
   * One request whose answer rides in `data`.
   *
   * @param method - HTTP method.
   * @param path - path below the OpenAPI root.
   * @param options - body, query, cancellation.
   * @returns the `data` payload.
   * @throws LarkApiError when the envelope carried no payload.
   */
  async answer<T>(method: string, path: string, options: LarkRequestOptions = {}): Promise<T> {
    const envelope = await this.request<T>(method, path, options)
    if (envelope.data === undefined || envelope.data === null) {
      throw new LarkApiError(`${method} ${path} answered without data`, {
        status: 200, published: 'unknown', body: envelope,
      })
    }
    return envelope.data
  }

  /**
   * One request whose answer is a raw byte stream (resource routes), validated against HTTP error statuses without
   * buffering the body in memory first.
   *
   * @param method - HTTP method.
   * @param path - path below the OpenAPI root.
   * @param options - body, query, cancellation.
   * @returns the upstream response with its body stream and headers intact.
   * @throws LarkApiError for a platform-level failure or a transport failure.
   */
  async downloadStream(method: string, path: string, options: LarkRequestOptions = {}): Promise<Response> {
    const url = this.resolve(path)
    const response = await this.send(method, url, options)
    if (response.status >= 400) {
      const body = parseBody(await response.text())
      throw new LarkApiError(`${method} ${path} answered ${response.status}`, {
        code: codeOf(body),
        status: response.status,
        body,
        retryAfterMs: retryAfterMsOf(response),
      })
    }
    return response
  }

  /**
   * One request whose answer is raw bytes (resource routes).
   *
   * @param method - HTTP method.
   * @param path - path below the OpenAPI root.
   * @param options - body, query, cancellation.
   * @returns the bytes and the answered media type.
   * @throws LarkApiError for a platform-level failure or a transport failure.
   */
  async download(method: string, path: string, options: LarkRequestOptions = {}): Promise<LarkResourceAnswer> {
    const response = await this.downloadStream(method, path, options)
    const mime = response.headers.get('content-type')
    return { data: await response.arrayBuffer(), ...(mime ? { mime } : {}) }
  }

  /** Perform one authorized request. */
  private async send(method: string, url: string, options: LarkRequestOptions): Promise<Response> {
    const { data, params, signal } = options
    const token = await this.options.token(signal)
    const init: LarkHttpInit = { method, headers: { Authorization: this.authorization(token) } }
    if (data !== undefined) init.data = data
    if (params !== undefined) init.params = params
    if (signal !== undefined) init.signal = signal
    try {
      return await this.options.http(url, init)
    } catch (error) {
      // No answer at all: whether the platform saw the request is unknown, so `classify` must not claim `published`.
      throw new LarkApiError(`${method} ${url} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Identity

  /**
   * The bot's own identity (`GET /bot/v3/info`); the long connection learns `selfId` from it.
   *
   * @param signal - cancellation.
   * @returns the `bot` object of the answer.
   */
  async getBotInfo(signal?: AbortSignal): Promise<LarkBotInfo> {
    const body = await this.request('GET', '/bot/v3/info', { signal })
    // This route puts its payload at the top level instead of in `data`.
    const bot = body.bot
    if (!isDict(bot)) throw new LarkApiError('GET /bot/v3/info answered without bot identity', { status: 200, body })
    return bot
  }

  // -------------------------------------------------------------------------------------------------------------
  // Messages

  /**
   * Send one message (`POST /im/v1/messages?receive_id_type=…`).
   *
   * @param receiveIdType - which id `body.receive_id` carries.
   * @param body - `msg_type` + JSON `content` and the `uuid` of this part.
   * @param signal - cancellation.
   * @returns the created message; `message_id` is checked.
   */
  async createMessage(receiveIdType: LarkReceiveIdType, body: Im.Message.CreateRequest, signal?: AbortSignal): Promise<Im.Message.CreateResponse> {
    const answer = await this.answer<Im.Message.CreateResponse>('POST', '/im/v1/messages', {
      data: body,
      params: { receive_id_type: receiveIdType },
      signal,
    })
    requiredKey(answer.message_id, 'message id')
    return answer
  }

  /**
   * Reply to one message (`POST /im/v1/messages/{message_id}/reply`).
   *
   * @param messageId - the message being answered (a quote, or the clicked card's message).
   * @param body - `msg_type` + JSON `content`, the `uuid` of this part and `reply_in_thread`.
   * @param signal - cancellation.
   * @returns the created message; `message_id` is checked.
   */
  async replyMessage(messageId: string, body: Im.Message.ReplyRequest, signal?: AbortSignal): Promise<Im.Message.ReplyResponse> {
    const answer = await this.answer<Im.Message.ReplyResponse>(
      'POST',
      `/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { data: body, signal },
    )
    requiredKey(answer.message_id, 'message id')
    return answer
  }

  /**
   * Edit one text or post message in place (`PUT /im/v1/messages/{message_id}`).
   *
   * @param messageId - own message to edit.
   * @param body - `msg_type` (`text` or `post`) and the serialized `content`.
   * @param signal - cancellation.
   */
  async updateMessage(messageId: string, body: Im.Message.UpdateRequest, signal?: AbortSignal): Promise<void> {
    await this.request(
      'PUT',
      `/im/v1/messages/${encodeURIComponent(messageId)}`,
      { data: body, signal },
    )
  }

  /**
   * Edit one inline card in place (`PATCH /im/v1/messages/{message_id}`).
   *
   * @param messageId - own message to edit; the new content must be an interactive card.
   * @param body - the card JSON as the serialized `content` string.
   * @param signal - cancellation.
   */
  async patchMessage(messageId: string, body: Im.Message.PatchRequest, signal?: AbortSignal): Promise<void> {
    await this.request(
      'PATCH',
      `/im/v1/messages/${encodeURIComponent(messageId)}`,
      { data: body, signal },
    )
  }

  /**
   * Recall one own message (`DELETE /im/v1/messages/{message_id}`).
   *
   * @param messageId - own message to delete.
   * @param signal - cancellation.
   */
  async deleteMessage(messageId: string, signal?: AbortSignal): Promise<void> {
    await this.request('DELETE', `/im/v1/messages/${encodeURIComponent(messageId)}`, { signal })
  }

  /**
   * Read one message (`GET /im/v1/messages/{message_id}`).
   *
   * The answer is a list because a merged forward answers with its entries after the container, each naming the
   * container in `upper_message_id`; the container itself is the item whose id is `messageId`.
   *
   * @param messageId - message to read.
   * @param query - `user_id_type`, and `card_msg_content_type: 'user_card_content'` to get a card's original JSON.
   * @param signal - cancellation.
   * @returns every item the answer carried, empty when it carried none.
   */
  async getMessage(messageId: string, query: LarkMessageQuery = {}, signal?: AbortSignal): Promise<Message[]> {
    const answer = await this.answer<Im.Message.GetResponse>(
      'GET',
      `/im/v1/messages/${encodeURIComponent(messageId)}`,
      { params: queryOf(query), signal },
    )
    return answer.items ?? []
  }

  /**
   * Read one page of messages of a chat or a thread (`GET /im/v1/messages`).
   *
   * @param query - container and paging.
   * @param signal - cancellation.
   * @returns the page as the platform shaped it.
   */
  async listMessages(query: LarkMessageListQuery, signal?: AbortSignal): Promise<LarkMessagePage> {
    const answer = await this.answer<LarkMessagePage>('GET', '/im/v1/messages', { params: queryOf(query), signal })
    return answer
  }

  // -------------------------------------------------------------------------------------------------------------
  // Chats

  /**
   * Read one chat's metadata (`GET /im/v1/chats/{chat_id}`): `chat_mode` decides `ChatRef.type`.
   *
   * @param chatId - chat to read.
   * @param query - `user_id_type`.
   * @param signal - cancellation.
   */
  async getChat(chatId: string, query: Im.Chat.GetQuery = {}, signal?: AbortSignal): Promise<Im.Chat.GetResponse> {
    return await this.answer<Im.Chat.GetResponse>('GET', `/im/v1/chats/${encodeURIComponent(chatId)}`, {
      params: queryOf(query),
      signal,
    })
  }

  /**
   * Read one page of a chat's members (`GET /im/v1/chats/{chat_id}/members`), addressed by `open_id` unless
   * `member_id_type` says otherwise.
   *
   * @param chatId - chat to read.
   * @param query - `member_id_type`, `page_size` (1–100) and `page_token`.
   * @param signal - cancellation.
   * @returns the page as the platform shaped it: `items`, a `page_token` while `has_more`.
   */
  async getChatMembers(
    chatId: string,
    query: Im.Chat.Members.GetQuery = {},
    signal?: AbortSignal,
  ): Promise<Im.Chat.Members.GetResponse> {
    return await this.answer<Im.Chat.Members.GetResponse>(
      'GET',
      `/im/v1/chats/${encodeURIComponent(chatId)}/members`,
      { params: queryOf(query), signal },
    )
  }

  // -------------------------------------------------------------------------------------------------------------
  // Uploads and resources

  /**
   * Upload one image for sending (`POST /im/v1/images`, multipart).
   *
   * @param data - exact image bytes.
   * @param name - file name shown in the multipart part.
   * @param mediaType - content type the caller verified; the platform receives the format instead of an opaque blob.
   * @param signal - cancellation.
   * @returns the platform `image_key`.
   */
  async uploadImage(data: Uint8Array, name: string, mediaType?: string, signal?: AbortSignal): Promise<string> {
    const file = new File([data as unknown as BlobPart], name, mediaType === undefined ? {} : { type: mediaType })
    const form = new FormData()
    form.append('image_type', 'message')
    form.append('image', file, file.name)
    const answer = await this.answer<Im.Image.CreateResponse>('POST', '/im/v1/images', { data: form, signal })
    return requiredKey(answer.image_key, 'image key')
  }

  /**
   * Upload one file, audio or video (`POST /im/v1/files`, multipart).
   *
   * @param data - exact bytes; the caller has already decided that the platform accepts them (`opus`/`mp4` only).
   * @param name - file name, with its suffix (the platform shows it).
   * @param fileType - `file_type` matching the message kind it will be sent as.
   * @param signal - cancellation.
   * @param duration - media duration in ms (audio/video only).
   * @returns the platform `file_key`.
   */
  async uploadFile(data: Uint8Array, name: string, fileType: LarkFileType, signal?: AbortSignal, duration?: number): Promise<string> {
    const form = new FormData()
    form.append('file_type', fileType)
    form.append('file_name', name)
    if (duration !== undefined) form.append('duration', String(duration))
    form.append('file', new File([data as unknown as BlobPart], name), name)
    const answer = await this.answer<Im.File.CreateResponse>('POST', '/im/v1/files', { data: form, signal })
    return requiredKey(answer.file_key, 'file key')
  }

  /**
   * Stream one resource of a message (`GET /im/v1/messages/{message_id}/resources/{file_key}`) without buffering its
   * body ahead of the caller's byte-limit reader.
   *
   * @param messageId - message holding the resource (the platform authorizes by it, not by the key alone).
   * @param fileKey - `image_key` / `file_key` of the resource.
   * @param type - `image` for a picture, `file` for a file, audio or video.
   * @param signal - cancellation.
   * @returns the upstream response.
   */
  async getResourceStream(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    signal?: AbortSignal,
  ): Promise<Response> {
    return await this.downloadStream(
      'GET',
      `/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
      { params: { type }, signal },
    )
  }

  /**
   * Download one resource of a message (`GET /im/v1/messages/{message_id}/resources/{file_key}`).
   *
   * @param messageId - message holding the resource (the platform authorizes by it, not by the key alone).
   * @param fileKey - `image_key` / `file_key` of the resource.
   * @param type - `image` for a picture, `file` for a file, audio or video.
   * @param signal - cancellation.
   */
  async getResource(messageId: string, fileKey: string, type: 'image' | 'file', signal?: AbortSignal): Promise<LarkResourceAnswer> {
    return await this.download(
      'GET',
      `/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
      { params: { type }, signal },
    )
  }

  /**
   * Stream one image by its `image_key` (`GET /im/v1/images/{image_key}`) without buffering its body ahead of the
   * caller's byte-limit reader.
   *
   * @param imageKey - platform `image_key` of the picture.
   * @param signal - cancellation.
   * @returns the upstream response.
   */
  async getImageStream(imageKey: string, signal?: AbortSignal): Promise<Response> {
    return await this.downloadStream('GET', `/im/v1/images/${encodeURIComponent(imageKey)}`, { signal })
  }

  /**
   * Bytes of one image by its `image_key` (`GET /im/v1/images/{image_key}`). A card shows its pictures by key rather
   * than as resources of the message, and the platform hands a key only to the application that sent it: another
   * application's key answers `234008` ("The app is not the resource sender").
   *
   * @param imageKey - platform `image_key` of the picture.
   * @param signal - cancellation.
   * @returns the bytes and their media type.
   */
  async getImage(imageKey: string, signal?: AbortSignal): Promise<LarkResourceAnswer> {
    return await this.download('GET', `/im/v1/images/${encodeURIComponent(imageKey)}`, { signal })
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reactions

  /**
   * Add one emoji of the platform catalogue to a message (`POST /im/v1/messages/{message_id}/reactions`).
   *
   * Adding a reaction the bot already carries is not an error: the platform answers with that same reaction.
   *
   * @param messageId - message to react to.
   * @param emojiType - `emoji_type` of the fixed catalogue, not a unicode character.
   * @param signal - cancellation.
   */
  async createReaction(messageId: string, emojiType: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      'POST',
      `/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      { data: { reaction_type: { emoji_type: emojiType } }, signal },
    )
  }

  /**
   * Read one page of a message's reactions (`GET /im/v1/messages/{message_id}/reactions`).
   *
   * @param messageId - message whose reactions are read.
   * @param query - emoji filter and paging.
   * @param signal - cancellation.
   */
  async listReactions(messageId: string, query: LarkReactionQuery = {}, signal?: AbortSignal): Promise<LarkReactionPage> {
    return await this.answer<LarkReactionPage>(
      'GET',
      `/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      { params: queryOf(query), signal },
    )
  }

  /**
   * Delete one reaction by its identity (`DELETE …/reactions/{reaction_id}`): the platform never deletes by emoji.
   *
   * @param messageId - message carrying the reaction.
   * @param reactionId - `reaction_id` read from {@link listReactions}.
   * @param signal - cancellation.
   */
  async deleteReaction(messageId: string, reactionId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      'DELETE',
      `/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      { signal },
    )
  }
}
