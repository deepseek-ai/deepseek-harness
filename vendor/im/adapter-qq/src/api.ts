/**
 * Typed REST client of the QQ official bot.
 *
 * Routes: gateway discovery, group / C2C messages, file upload, message recall, interaction acknowledgement
 * and the C2C `stream_messages` endpoint. The client is transport-injected (`QqHttp`) so tests drive it with a
 * stub and never touch the network; the adapter passes the `ctx.http` callable extended with the API base URL.
 *
 * `ChatRef.id` is self-describing: `group:<group_openid>` or `user:<user_openid>`. Those strings are parsed
 * by {@link parseChatId} and formatted by {@link chatId}; they are also the resource scope, because a QQ upload is
 * only valid in the chat it was made for.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/api
 */

import { PlatformError } from '@deepseek-ai/cordis-plugin-im-core'
import { DEFAULT_BASE_URL } from './config.ts'
import { QqApiError } from './errors.ts'

/** Whether an address is a group (群聊) or a C2C (单聊) conversation. */
export type ChatKind = 'group' | 'user'

/** A parsed `group:<id>` / `user:<id>` target. */
export interface QqAddress {
  kind: ChatKind
  /** `group_openid` or `user_openid`, without the `group:` / `user:` prefix. */
  id: string
}

/** Route segment of one chat kind: `/v2/groups/{id}` or `/v2/users/{id}`. */
const SEGMENT: Readonly<Record<ChatKind, string>> = { group: 'groups', user: 'users' }

/**
 * Format the self-describing chat id.
 *
 * @param kind - group or C2C.
 * @param id - `group_openid` / `user_openid`.
 * @returns `group:<id>` or `user:<id>`.
 */
export function chatId(kind: ChatKind, id: string) {
  return `${kind}:${id}`
}

/**
 * Parse a self-describing chat id.
 *
 * @param value - `group:<group_openid>` or `user:<user_openid>`.
 * @returns the parsed address.
 * @throws Error when the string is not one of the two supported shapes.
 */
export function parseChatId(value: string): QqAddress {
  const index = value.indexOf(':')
  const kind = index < 0 ? '' : value.slice(0, index)
  const id = index < 0 ? '' : value.slice(index + 1)
  if ((kind !== 'group' && kind !== 'user') || !id) {
    throw new Error(`QQ chat id must be group:<group_openid> or user:<user_openid>, got ${JSON.stringify(value)}`)
  }
  return { kind, id }
}

/**
 * Collection path of one chat: `/v2/groups/{id}` or `/v2/users/{id}`.
 *
 * @param address - parsed chat.
 * @returns the collection path below the API root.
 */
export function chatPath(address: QqAddress) {
  return `/v2/${SEGMENT[address.kind]}/${encodeURIComponent(address.id)}`
}

/**
 * The same path from a chat id string, for callers that only hold `ChatRef.id`.
 *
 * @param id - `group:<id>` / `user:<id>`.
 * @returns the collection path.
 */
export function chatPathOf(id: string) {
  return chatPath(parseChatId(id))
}

/** One button of a custom keyboard row. */
export interface QqKeyboardButton {
  /** Identifier of a `type: 1` (callback) button; unique within one keyboard. */
  id?: string
  render_data?: {
    label?: string
    visited_label?: string
    /** 0 grey, 1 blue, 3 white-bg/red text, 4 blue-bg/white text. */
    style?: number
  }
  action?: {
    /** 0 = open URL, 1 = callback, 2 = insert command text. */
    type?: number
    permission?: { type?: number }
    data?: string
    /** `type: 2` only: send the inserted text without the user pressing send. */
    enter?: boolean
    reply?: boolean
    anchor?: number
    unsupport_tips?: string
  }
}

/**
 * One row of a custom keyboard: an object with a `buttons` array, at most 5 buttons per row and 5 rows in total.
 *
 * The platform takes `content.rows[].buttons[]` (QQ 消息按钮: `"rows": [{"buttons": […]}…]`); a bare button array per
 * row is refused with `40011000 请求数据异常`, which is why the row is an object and not `QqKeyboardButton[]`.
 */
export interface QqKeyboardRow {
  /** Buttons of this row, left to right (max 5). */
  buttons: QqKeyboardButton[]
}

/** `keyboard` of a message body. */
export interface QqKeyboard {
  content?: { rows: QqKeyboardRow[] }
  /** Template keyboard id; unused. */
  id?: string
}

/** Native markdown body of a `msg_type: 2` message. */
export interface QqMarkdown {
  /** Raw markdown; mutually exclusive with the template fields. */
  content?: string
  custom_template_id?: string
  params?: { key: string; values: string[] }[]
}

/** An uploaded media reference, as answered by `/files`. */
export interface QqMediaReference {
  file_info?: string
}

/**
 * Body of `POST /v2/{groups|users}/{id}/messages`. Modes serialize into this shape; every field is optional because
 * `msg_type` decides which ones the platform reads.
 */
export interface QqMessageRequest {
  /** `0` text, `2` markdown, `7` media. */
  msg_type?: number
  content?: string
  markdown?: QqMarkdown
  keyboard?: QqKeyboard
  media?: QqMediaReference
  /** Quote target: a `REFIDX_…` / `ROBOT1.0_…` id, never a `msg_id`. */
  message_reference?: { message_id: string; ignore_get_message_error?: boolean }
  /** Passive reply context: the inbound `msg_id`. */
  msg_id?: string
  /** Strictly increasing per `msg_id`; the platform deduplicates `(msg_id, msg_seq)`. */
  msg_seq?: number
  /** Passive context of `INTERACTION_CREATE`. */
  event_id?: string
  /** C2C 互动召回; unused. */
  is_wakeup?: boolean
  /** C2C typing state; unused. */
  input_notify?: { input_type?: number; input_second?: number }
}

/** Answer of a successful message create. */
export interface QqMessageResponse {
  id: string
  timestamp?: string
  /** `ref_idx` quotes the bot's own message. */
  ext_info?: { ref_idx?: string }
  audit_id?: string
  audit_tips?: string
}

/** Body of `POST /v2/{groups|users}/{id}/files`: 1 image, 2 video, 3 voice (silk), 4 file. */
export interface QqFileRequest {
  file_type: 1 | 2 | 3 | 4
  /** Remote `http(s)` source; mutually exclusive with `file_data`. */
  url?: string
  /** Base64 payload for every other source. */
  file_data?: string
  /** Always `false` in the prepare stage: the upload is consumed by a later message. */
  srv_send_msg: false
}

/** Answer of a successful upload; `file_info` is the key a `msg_type: 7` message carries. */
export interface QqFileResponse {
  file_uuid?: string
  file_info: string
  /** Seconds the key stays valid. */
  ttl?: number
}

/** Body of `POST /v2/users/{id}/stream_messages` (C2C only). */
export interface QqStreamRequest {
  content_type?: 'text' | 'markdown'
  /** The text this chunk carries. The streaming endpoint names it `content_raw`, not the `content` of a plain send. */
  content_raw: string
  msg_id?: string
  msg_seq?: number
  /** Index of this chunk within the streamed message. */
  index?: number
  /** Identity of the streamed message: the `id` of the first answer, echoed by every later chunk. */
  stream_msg_id?: string
  input_mode?: 'append' | 'replace'
  /** 1 = keep streaming, 10 = finish. */
  input_state?: 1 | 10
}

/** Answer of a `stream_messages` call. */
export interface QqStreamResponse {
  /**
   * Message id of this chunk. The **first** answer's `id` is the streamed message's `stream_msg_id` — the endpoint has
   * no separate field for it — and every later chunk must send it back.
   */
  id?: string
  /** Present on answers that repeat the streamed message's identity. */
  stream_msg_id?: string
  /** Characters the streamed message still accepts. */
  remain_msg_len?: number
}

/** Answer of `GET /gateway`. */
export interface QqGateway {
  url: string
}

/**
 * Answer of `GET /users/@me`: the bot's own identity.
 *
 * `id` is the account id the gateway reports in `READY`, while a message body addresses the bot by
 * `union_openid`, so both are needed to recognize a mention of itself.
 */
export interface QqSelf {
  id: string
  username?: string
  /** Cross-application openid; the form `<@…>` takes inside a message body. */
  union_openid?: string
}

/** Request initializer the client hands to its transport. */
export interface QqHttpInit {
  method?: string | undefined
  /** JSON body; the HTTP plugin encodes it and sets `content-type`. */
  data?: unknown
  headers?: Record<string, string> | undefined
  signal?: AbortSignal | undefined
}

/** Options of one {@link QqApi.request}. */
export interface QqRequestOptions {
  data?: unknown
  signal?: AbortSignal | undefined
  expect?: Expect
}

/** HTTP transport of the client: the `ctx.http` callable (absolute or base-URL-relative path). */
export type QqHttp = (url: string, init: QqHttpInit) => Promise<Response>

export interface QqApiOptions {
  /** Transport (the adapter passes the `ctx.http` callable). */
  http: QqHttp
  /** Bot AppID, sent as `X-Union-Appid`. */
  appId: string
  /** Current access token; called before every request so a refresh applies immediately. */
  token: (signal?: AbortSignal) => Promise<string>
  /** API root; default {@link DEFAULT_BASE_URL}. */
  baseUrl?: string
  /** `Authorization` header builder; default `QQBot <token>`. */
  authorize?: (token: string) => string
}

/** What to do with the answer body: decode JSON (default), return text, or ignore it. */
export type Expect = 'json' | 'text' | 'none'

/** Decode `JSON.parse`, tolerating an empty or non-JSON body. */
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
  const code = (body as { code?: unknown } | undefined)?.code
  return typeof code === 'number' ? code : undefined
}

/** The platform's own sentence of an answer body, if it carries one. */
function platformMessageOf(body: unknown): string | undefined {
  const message = (body as { message?: unknown } | undefined)?.message
  return typeof message === 'string' && message.trim() ? message.trim() : undefined
}

/**
 * The platform's own code and sentence of an answer body, as the detail a request failure carries.
 *
 * The taxonomy names the codes it knows (`errors.ts`), but a code it does not must still reach the operator: dropping
 * it left `40034105 主动消息失败, 无权限`, `40034128 被动回复时间或者次数超过限制` and `40034025 event_id 无效` behind one
 * anonymous sentence.
 *
 * @param body - decoded answer body.
 * @returns ` (code 40034105: 主动消息失败, 无权限)`, or `''` when the body names no code.
 */
function detailOf(body: unknown): string {
  const code = codeOf(body)
  if (code === undefined) return ''
  const message = platformMessageOf(body)
  return message === undefined ? ` (code ${code})` : ` (code ${code}: ${message})`
}

/** `Retry-After` of an answer in milliseconds (the header is in seconds). */
function retryAfterOf(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'))
  return Number.isFinite(value) && value > 0 ? value * 1000 : undefined
}

/**
 * REST client of one QQ application.
 *
 * Every call throws {@link QqApiError} when the platform answered with a non-2xx status, or with a `code` in an
 * otherwise successful body; `bot.classify` turns that into a `PlatformError`. The client itself never retries — the
 * core pipeline owns retries, and `send.ts` owns the `40054005` dedupe retry because it must bump `msg_seq`.
 */
export class QqApi {
  constructor(readonly options: QqApiOptions) {}

  /** API root with a trailing slash. */
  get baseUrl() {
    return (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/?$/, '/')
  }

  /**
 * Absolute URL of one route.
 *
 * @param path - path below the API root, or an absolute URL.
 * @returns the absolute URL.
 */
  resolve(path: string) {
    return new URL(path, this.baseUrl).href
  }

  /** `Authorization` header value of one token. */
  authorization(token: string) {
    return (this.options.authorize ?? (value => `QQBot ${value}`))(token)
  }

  /**
 * One request against the API.
 *
 * @param method - HTTP method.
 * @param path - path below the API root (or an absolute URL).
 * @param options - body, cancellation and expected answer body.
 * @returns the decoded answer body (`undefined` for `expect: 'none'`).
 * @throws QqApiError for a platform-level failure or a transport failure (which it wraps as its cause); a token
 * failure rejects with the `PlatformError` the token client raised.
 */
  async request<T = unknown>(
    method: string,
    path: string,
    options: QqRequestOptions = {},
  ): Promise<T> {
    const { data, signal, expect = 'json' } = options
    const url = this.resolve(path)
    const token = await this.options.token(signal)
    let response: Response
    try {
      response = await this.options.http(url, {
        method,
        data,
        signal,
        headers: {
          Authorization: this.authorization(token),
          'X-Union-Appid': this.options.appId,
        },
      })
    } catch (error) {
      throw new QqApiError(`${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    const text = await response.text()
    const body = parseBody(text)
    const code = codeOf(body)
    if (response.status >= 400) {
      throw new QqApiError(`${method} ${path} answered ${response.status}${detailOf(body)}`, {
        code,
        status: response.status,
        body,
        retryAfterMs: retryAfterOf(response),
      })
    }
 // A `code` in a 2xx body is still a failure (audit rejection, quota …) unless the body also carries the
 // object the route promises (a message `id`).
    if (code !== undefined && code !== 0 && !(body && typeof body === 'object' && 'id' in body)) {
      const message = platformMessageOf(body)
      throw new QqApiError(`${method} ${path} answered code ${code}${message === undefined ? '' : `: ${message}`}`, {
        code,
        status: response.status,
        body,
      })
    }
    if (expect === 'text') return text as T
    if (expect === 'none') return undefined as T
    return body as T
  }

  /**
 * Gateway URL of this application (`GET /gateway`).
 *
 * @param signal - cancellation.
 * @returns `{ url }`.
 */
  async getGateway(signal?: AbortSignal) {
    return await this.request<QqGateway>('GET', '/gateway', { signal })
  }

  /**
 * The bot's own identity (`GET /users/@me`).
 *
 * The event body addresses the bot by `union_openid`, which `READY` does not carry, so recognizing a mention of
 * itself needs this read.
 *
 * @param signal - cancellation.
 * @returns the identity record.
 */
  async getSelf(signal?: AbortSignal) {
    return await this.request<QqSelf>('GET', '/users/@me', { signal })
  }

  /**
 * Send one message to a group or a C2C chat.
 *
 * @param address - target chat.
 * @param body - `msg_type` payload.
 * @param signal - cancellation.
 * @returns the created message; `ext_info.ref_idx` quotes it later.
 */
  async sendMessage(address: QqAddress, body: QqMessageRequest, signal?: AbortSignal) {
    const result = await this.request<QqMessageResponse>('POST', `${chatPath(address)}/messages`, { data: body, signal })
    if (!result || typeof result.id !== 'string' || !result.id) {
 // The request was accepted but promises nothing this client can address; whether the platform published it
 // is unknowable from here, so it must not look like a clean rejection.
      throw new QqApiError(`POST ${chatPath(address)}/messages answered without a message id`, {
        status: 200,
        body: result,
        published: 'unknown',
      })
    }
    return result
  }

  /**
 * Recall one of this bot's messages. The platform only accepts this for 2 minutes after the send.
 *
 * @param address - chat the message belongs to.
 * @param messageId - platform message id.
 * @param signal - cancellation.
 */
  async deleteMessage(address: QqAddress, messageId: string, signal?: AbortSignal) {
    await this.request('DELETE', `${chatPath(address)}/messages/${encodeURIComponent(messageId)}`, {
      signal,
      expect: 'none',
    })
  }

  /**
 * Upload one media file for later sending.
 *
 * @param address - chat the key is scoped to; keys are not interchangeable between chats.
 * @param body - `file_type` plus `url` or `file_data`.
 * @param signal - cancellation.
 * @returns `{ file_info, ttl }`.
 */
  async uploadFile(address: QqAddress, body: QqFileRequest, signal?: AbortSignal) {
    const result = await this.request<QqFileResponse>('POST', `${chatPath(address)}/files`, { data: body, signal })
    if (!result || typeof result.file_info !== 'string' || !result.file_info) {
      throw new QqApiError(`POST ${chatPath(address)}/files answered without file_info`, {
        status: 200,
        body: result,
        published: 'no',
      })
    }
    return result
  }

  /**
 * Acknowledge a button interaction; the platform expects this within 3 s.
 *
 * @param interactionId - `d.id` of the `INTERACTION_CREATE` event.
 * @param code - answer code, 0 for success.
 * @param signal - cancellation.
 */
  async acknowledgeInteraction(interactionId: string, code = 0, signal?: AbortSignal) {
    await this.request('PUT', `/interactions/${encodeURIComponent(interactionId)}`, {
      data: { code },
      signal,
      expect: 'none',
    })
  }

  /**
 * Append to (or start) a streamed C2C message.
 *
 * @param address - the C2C chat; the platform refuses group streaming.
 * @param body - content plus the stream bookkeeping (`index`, `stream_msg_id`, `input_state`).
 * @param signal - cancellation.
 * @returns the platform's stream bookkeeping.
 */
  async streamMessage(address: QqAddress, body: QqStreamRequest, signal?: AbortSignal) {
    if (address.kind !== 'user') {
      throw new PlatformError('fatal', 'QQ streams messages only in C2C chats', { published: 'no' })
    }
    return await this.request<QqStreamResponse>('POST', `${chatPath(address)}/stream_messages`, { data: body, signal })
  }
}
