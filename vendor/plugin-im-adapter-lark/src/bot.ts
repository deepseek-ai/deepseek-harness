/**
 * The Lark / Feishu adapter shell: bot identity, the mode table and its preference order, the typed REST client, the
 * tenant token, the `satori:` resource route and error classification. Everything that needs a mode, a platform
 * connection or the decoder is a named hook delegating to its own module:
 *
 * - `modes/post.ts` + `modes/shared.ts` and `modes/card.ts`, both mounted by {@link LarkBot.createModes};
 *   {@link LarkBot.modeOrder} declares card before post, and core resolves one of them per message.
 * - `prepare.ts` (`upload`) and `send.ts` ({@link LarkBot.sendPayload}, {@link LarkBot.editPayload},
 *   {@link LarkBot.deletePart}): create vs reply vs reply_in_thread, `receive_id_type`, the per-part `uuid`,
 *   `PUT`/`PATCH` by payload kind.
 * - {@link LarkBot.streamDriver}: the core `edit` driver in card and post mode, or none for the buffered `final`
 *   strategy.
 * - `decode.ts` ({@link LarkBot.decodeEvent}, {@link LarkBot.decodeMessage}).
 *
 * `upload`, `sendPayload`, `editPayload`, `deletePart`, `decodeEvent` and `decodeMessage` are one-line
 * delegations to their module, so each concern keeps its own file and the shell stays free of algorithm.
 *
 * The long connection ({@link ./ws.ts}) is installed by the constructor: it picks the adapter up as `bot.adapter`
 * (the core `WsClientBase` machinery drives connect/reconnect/dispose) and calls {@link LarkBot.initialize} before it
 * admits the first event, which is what gives the bot its `selfId` and its `satori:` URLs.
 *
 * Bot id is `lark:<appId>`; the reported `platform` is the configured `feishu`/`lark` and the adapter name is the
 * stable `lark`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/bot
 */

import { type Context } from '@deepseek-ai/cordis'
import { type Http } from '@deepseek-ai/cordis-plugin-http'
import {
  Adapter, type ChatRef, createEditDriver, type InboundMessage, Inject, type MembersPage, type MessageHandle,
  type MessageRef, type Mode, type PlatformError, type PrepareContext, type ResolvedResource, type ResourceKind,
  type ResourceRef, type SendContext, type SentPart, type Session, type StreamDriver, type Target, type User,
  type UserRef,
} from '@deepseek-ai/cordis-plugin-im-core'
import { type LarkHttp, type LarkMessageListQuery, LarkApi } from './api/client.ts'
import { type LarkChatKind, type LarkRawEvent, readLarkReferrer } from './api/events.ts'
import { AccessToken, type TenantAccessTokenResult } from './api/token.ts'
import { Config, type LarkConfig, resolveBaseUrl } from './config.ts'
import { decodeEvent as decodeLarkEvent, decodeMessage as decodeLarkMessage } from './decode.ts'
import { classify } from './errors.ts'
import { Internal } from './internal.ts'
import { createCardMode } from './modes/card.ts'
import { createPostMode } from './modes/post.ts'
import { uploadResource } from './prepare.ts'
import { deleteSentPart, editMessagePayload, sendMessagePayload } from './send.ts'
import type { Im, Message } from './types/index.ts'
import { WsClient } from './ws.ts'

/** Mode ids: rich-text `post` and interactive `card`. */
export type LarkModeId = 'post' | 'card'

/**
 * The adapter's modes: `modes/post.ts` (+ `modes/shared.ts`) and `modes/card.ts`; each owns an element registry,
 * `assemble`, `serialize`, `check` and — for the card mode — `diff`.
 */
export interface LarkModes extends Record<LarkModeId, Mode<any>> {}

/** How long a probed chat kind stays cached (ms). */
const CHAT_TYPE_TTL = 10 * 60_000

/**
 * Lark / Feishu bot.
 *
 * One instance per configured application. `config.platform` picks the OpenAPI host and the reported platform, and
 * `config.appId` is both the bot id suffix and the resource scope: a Lark `image_key` / `file_key` belongs to the
 * application, so it is reusable across chats.
 */
@Inject('http')
export class LarkBot extends Adapter<LarkConfig, LarkModes> {
  /** Configuration schema, so a host can mount this class by reference (`LarkBot.Config`). */
  static readonly Config = Config

  /** Long-connection client; the constructor installs it, and it assigns itself here. */
  adapter?: WsClient

  /** Tenant access token with refresh window and single-flight refresh. */
  readonly tokens: AccessToken

  /** Typed REST client of the OpenAPI routes. */
  readonly api: LarkApi

  /** Generated route tree of the OpenAPI subset, also served as `/_api/:name`. */
  declare internal: Internal

  private _modes?: LarkModes
  private _cardDriver?: StreamDriver
  private _postDriver?: StreamDriver
  private readonly chats = new Map<string, { type: LarkChatKind; until: number }>()

  constructor(ctx: Context, config: LarkConfig) {
    super(ctx, config, { id: `lark:${config.appId}`, platform: config.platform, adapter: 'lark' })
    const baseUrl = resolveBaseUrl(config)
    const http: LarkHttp = (url, init) => {
      const request: Http.RequestConfig = {}
      if (init.method !== undefined) request.method = init.method
      if (init.data !== undefined) request.data = init.data
      if (init.headers !== undefined) request.headers = init.headers
      if (init.params !== undefined) request.params = init.params
      if (init.signal !== undefined) request.signal = init.signal
      return ctx.http(url, request)
    }
    this.tokens = new AccessToken({
      appId: config.appId,
      appSecret: config.appSecret,
      baseUrl,
      post: async (url, data, signal) => {
        // The token route is absolute and carries the application credentials in its body; it needs no authorization.
        const request: Http.RequestConfig = {}
        if (signal) request.signal = signal
        return await ctx.http.post<TenantAccessTokenResult>(url, data, request)
      },
    })
    this.api = new LarkApi({ http, baseUrl, token: signal => this.tokens.get(signal) })
    this.internal = new Internal(this)

    // Decode turns a resource of a message into a `satori:` URL; this route authorizes and streams it back, so a
    // fetch of that URL never needs the bot's credentials at the call site and `readBounded` enforces `maxBytes` on
    // the live stream without buffering the whole upstream body first.
    this.defineInternalRoute('/messages/:messageId/resources/:fileKey', async (request) => {
      const type = request.query.get('type') === 'file' ? 'file' : 'image'
      return await this.api.getResourceStream(request.params.messageId, request.params.fileKey, type, request.signal)
    })

    // A card shows its pictures by `image_key`, which is downloaded by key rather than as a resource of the message.
    this.defineInternalRoute('/images/:imageKey', async (request) => {
      return await this.api.getImageStream(request.params.imageKey, request.signal)
    })

    ctx.plugin(WsClient, this)
  }

  /** The two modes, built on first use so a bot that never sends needs no mode. */
  override get modes(): LarkModes {
    return (this._modes ??= this.createModes())
  }

  // -------------------------------------------------------------------------------------------------------------
  // Mode construction

  /**
   * Build the `post` and `card` modes, passing the adapter configuration into them.
   *
   * `modes/post.ts` provides `post`; `card` is {@link LarkBot.createCardMode} (`modes/card.ts`).
   *
   * @returns the mode table keyed by mode id.
   */
  createModes(): LarkModes {
    const modes: Partial<LarkModes> = {
      post: createPostMode(this.config.allowAtAll === undefined ? {} : { allowAtAll: this.config.allowAtAll }),
    }
    // Lazy, so that a bot which never renders a card never builds the card mode (and its element table).
    Object.defineProperty(modes, 'card', { enumerable: true, get: () => this.createCardMode() })
    return modes as LarkModes
  }

  /**
   * The interactive card mode — built by `createCardMode()` from `./modes/card.ts` (JSON 2.0, card-markdown
   * escaping, element folding, `diff`) from this adapter's configuration.
   *
   * @returns the card mode.
   */
  createCardMode(): Mode<any> {
    return createCardMode(this.config)
  }

  /**
   * Upload one resource and cache its platform key (images through `/im/v1/images`, files through `/im/v1/files` with
   * the `file_type` mapping; audio that is not opus and video that is not mp4 upload as a plain file). See `prepare.ts`.
   *
   * @param ref - resource to upload.
   * @param scope - resource scope ({@link LarkBot.resourceScope}: the application).
   * @param ctx - prepare context (fetch, cache, cancellation).
   * @returns the resolved key with the classification of the upload.
   */
  override async upload(ref: ResourceRef, scope: string, ctx: PrepareContext): Promise<ResolvedResource> {
    return await uploadResource(this, ref, scope, ctx)
  }

  /**
   * Publish one serialized payload of a mode: reply when `ctx.quote` is set (or when the referrer is threaded),
   * else create; `uuid` derived from `options.idempotencyKey` and `ctx.index`. See `send.ts`.
   *
   * @param payload - mode payload (`msg_type` + `content` as an object).
   * @param target - target chat.
   * @param ctx - part index, quote target and options.
   * @returns the sent part, with the kind the later edits need.
   */
  override idempotentSend(_target: Target, ctx: SendContext): boolean {
    return ctx.options.idempotencyKey !== undefined
  }

  override async sendPayload(payload: unknown, target: Target, ctx: SendContext): Promise<SentPart> {
    return await sendMessagePayload(this, payload, target, ctx)
  }

  /**
   * Edit one part in place: `PUT` for a post or text message, `PATCH` for a card. See `send.ts`.
   *
   * @param part - the sent part to edit.
   * @param payload - new payload of the part.
   * @param handle - message handle (mode, parts, `edits`, adapter state).
   */
  override async editPayload(part: SentPart, payload: unknown, handle: MessageHandle, signal?: AbortSignal): Promise<void> {
    await editMessagePayload(this, part, payload, handle, signal)
  }

  /**
   * Recall one part (`DELETE /im/v1/messages/{message_id}`). See `send.ts`.
   *
   * @param part - the sent part to delete.
   * @param handle - message handle the part belongs to.
   */
  override async deletePart(part: SentPart, handle: MessageHandle): Promise<void> {
    await deleteSentPart(this, part, handle)
  }

  /**
   * The stream driver: the core `edit` driver in card mode and for a post, or `undefined` for the buffered `final`
   * strategy.
   *
   * A card is a plain `interactive` message edited in place with `PATCH /im/v1/messages/:id`, not a CardKit entity.
   * CardKit streaming bought nothing here — a card that is republished whole every couple of seconds never uses its
   * incremental rendering — and cost plenty: streaming mode expires ten minutes after it is switched on, refuses
   * callbacks that update the card, and makes the card unforwardable. One message accepts an unbounded number of
   * edits (400 measured on a single message, none refused); the cap is 5 QPS for that message, which
   * `CARD_STREAM_INTERVAL` stays under.
   *
   * A post keeps the same driver with its own limit: `PUT` accepts 20 edits per message.
   *
   * The drivers are memoized: one stateless instance each, all per-message bookkeeping lives in `handle.state`.
   *
   * A tenant that refuses an edit answers `230075`, which `errors.ts` classifies `limit`: the stream scheduler
   * resolves a limit by recalling the message and sending the final state as a new one.
   *
   * @param mode - mode id.
   * @returns the driver, or `undefined` for `final`.
   */
  override streamDriver(mode: string): StreamDriver | undefined {
    switch (mode) {
      case 'card':
        // `cardStreaming: false` keeps the card buffered: one `PATCH` at the end instead of one per published state.
        if (this.config.cardStreaming === false) return undefined
        return (this._cardDriver ??= createEditDriver(this, { state: () => ({ kind: 'card' }) }))
      case 'post':
        return (this._postDriver ??= createEditDriver(this, { limit: 20, state: () => ({ kind: 'post' }) }))
      default:
        return undefined
    }
  }

  /**
   * Decode one event envelope into the sessions to publish. The WS client awaits `bot.receive(session)` for
   * each of them before it acknowledges a message event. See `decode.ts`.
   *
   * @param raw - validated envelope whose body is still the raw wire object.
   * @returns the sessions of this event, possibly empty.
   */
  async decodeEvent(raw: LarkRawEvent): Promise<Session[]> {
    return await decodeLarkEvent(this, raw, this.now())
  }

  /**
   * Decode one message body read back from the platform — text/post/image/file/audio/media/interactive/
   * merge_forward/sticker/recalled → elements, never empty. See `decode.ts`.
   *
   * @param raw - message as the platform returns it.
   * @param chat - chat the caller authorized, when it already knows it.
   * @param entries - the other items the same answer carried; they are a merged forward's contents.
   * @returns the decoded inbound message.
   */
  async decodeMessage(raw: Message, chat?: ChatRef, entries?: readonly Message[]): Promise<InboundMessage> {
    return await decodeLarkMessage(this, raw, chat, this.now(), entries)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Adapter contract implemented here

  /**
   * The card mode first, `post` second. Core resolves one mode per message from how much each mode would degrade
   * it and breaks a tie with this order, so a message the card cannot express better lands in `post` and everything
   * else stays a card.
   */
  override readonly modeOrder: readonly LarkModeId[] = ['card', 'post']
  /** A Lark upload key belongs to the application, so the scope is the app and not the chat. */
  override resourceScope(_target: Target, _kind: ResourceKind): string {
    return this.config.appId
  }

  /** Map a platform failure onto the core taxonomy. */
  override classify(error: unknown): PlatformError {
    return classify(error)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers

  /**
   * `satori:` URL of one message resource: `satori:<platform>/<selfId>/messages/<mid>/resources/<key>?type=…`.
   *
   * @param messageId - message holding the resource.
   * @param fileKey - `image_key` / `file_key`.
   * @param type - `image` for a picture, `file` for a file, audio or video.
   * @returns the internal URL the internal route serves.
   */
  getResourceUrl(messageId: string, fileKey: string, type: 'image' | 'file' = 'image') {
    return this.getInternalUrl(`/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`, { type })
  }

  /**
   * `satori:` URL of one card image: `satori:<platform>/<selfId>/images/<image_key>`.
   *
   * @param imageKey - platform `image_key` the card shows.
   * @returns the internal URL the image route serves.
   */
  getCardImageUrl(imageKey: string) {
    return this.getInternalUrl(`/images/${encodeURIComponent(imageKey)}`)
  }

  /**
   * Chat kind of one chat, from `GET /im/v1/chats/{chat_id}`, cached for 10 minutes.
   *
   * The card callback carries no chat type, so the intake needs this to build a `ChatRef`.
   *
   * @param chatId - chat to probe.
   * @param signal - cancellation.
   * @returns `direct`, `group` or `topic`; `group` when the platform cannot be asked.
   */
  async chatTypeOf(chatId: string, signal?: AbortSignal): Promise<LarkChatKind> {
    const cached = this.chats.get(chatId)
    if (cached && cached.until > this.now()) return cached.type
    try {
      const chat = await this.api.getChat(chatId, {}, signal)
      const type: LarkChatKind = chat.chat_mode === 'p2p' ? 'direct' : chat.chat_mode === 'topic' ? 'topic' : 'group'
      this.chats.set(chatId, { type, until: this.now() + CHAT_TYPE_TTL })
      return type
    } catch (error) {
      this.ctx.logger.warn(`[${this.id}] cannot read chat ${chatId}; treating it as a group`, error)
      return 'group'
    }
  }

  /** Forget the cached chat kind of one chat (the next {@link LarkBot.chatTypeOf} probes again). */
  forgetChat(chatId: string) {
    this.chats.delete(chatId)
  }

  /**
   * The referrer of a target, narrowed. `send.ts` reads it to decide between create and reply and to inherit the
   * thread; a target without one simply creates a message.
   *
   * @param target - target whose `referrer` may be a `LarkReferrer`.
   * @returns the referrer, or `undefined`.
   */
  referrerOf(target: Target) {
    return readLarkReferrer(target.referrer)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Lifecycle

  /**
   * Learn the bot identity: the tenant token is obtained first (a bad credential fails the connection here),
   * then `bot/v3/info` answers the bot's own `open_id`, name and avatar.
   *
   * @param signal - cancellation of the connection attempt.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    await this.tokens.get(signal)
    const info = await this.api.getBotInfo(signal)
    signal.throwIfAborted()
    const selfId = info.open_id
    if (!selfId) throw new Error('Lark bot info carried no open_id')
    this.selfId = selfId
    const user: User = { id: selfId, isBot: true }
    if (info.app_name) user.name = info.app_name
    if (info.avatar_url) user.avatar = info.avatar_url
    this.user = user
    this.online()
  }

  override async connect(): Promise<void> {
    if (!this.adapter) throw new Error('lark: the WebSocket client is not installed')
    await this.adapter.connect()
  }

  override async disconnect(): Promise<void> {
    await this.adapter?.disconnect()
  }

  /** A token the platform rejected is dropped so the next request fetches a fresh one. */
  invalidateToken() {
    this.tokens.invalidate()
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reads (optional hooks; absence ⇒ the operation is unavailable)

  /**
   * Read one message of a chat. The message is checked to belong to the chat the caller authorized before it
   * is decoded; a card is read as the JSON it was sent with, and a merged forward keeps the entries the same answer
   * carries (see `decode.ts`).
   *
   * @param chat - chat the caller is allowed to read.
   * @param id - platform message id.
   * @returns the decoded inbound message.
   */
  override async getMessage(chat: ChatRef, id: string): Promise<InboundMessage> {
    const items = await this.api.getMessage(id, { card_msg_content_type: 'user_card_content' })
    const message = items.find(item => item.message_id === id)
    if (!message || message.chat_id !== chat.id) {
      throw new Error(`Lark message ${id} is absent or belongs to another chat`)
    }
    return await this.decodeMessage(message, chat, items)
  }

  /**
   * Read one page of a chat's messages, oldest first.
   *
   * @param chat - chat the caller is allowed to read.
   * @param cursor - `page_token` of the previous page.
   * @param limit - page size, 1–50 (default 20).
   * @returns the decoded messages and the cursor of the next page, when there is one.
   */
  override async getMessageList(chat: ChatRef, cursor?: string, limit = 20): Promise<{ data: InboundMessage[]; next?: string }> {
    const query: LarkMessageListQuery = {
      container_id_type: 'chat',
      container_id: chat.id,
      sort_type: 'ByCreateTimeAsc',
      page_size: Math.min(Math.max(limit, 1), 50),
      card_msg_content_type: 'user_card_content',
    }
    if (cursor !== undefined) query.page_token = cursor
    const page = await this.api.listMessages(query)
    const data: InboundMessage[] = []
    for (const message of page.items ?? []) data.push(await this.decodeMessage(message, chat))
    const result: { data: InboundMessage[]; next?: string } = { data }
    if (page.has_more && page.page_token) result.next = page.page_token
    return result
  }

  /**
   * Read one page of a chat's members, addressed by `open_id` — the id a mention carries.
   *
   * The platform bounds a page at 100; a member it reports without an id (an unreadable outsider) is skipped, since
   * nothing can address it.
   *
   * @param chat - chat the caller is allowed to read.
   * @param cursor - `page_token` of the previous page.
   * @param limit - page size, 1–100 (default 50).
   * @returns the members with the cursor of the next page, when there is one.
   */
  override async members(chat: ChatRef, cursor?: string, limit = 50): Promise<MembersPage> {
    const query: Im.Chat.Members.GetQuery = {
      member_id_type: 'open_id',
      page_size: Math.min(Math.max(limit, 1), 100),
    }
    if (cursor !== undefined) query.page_token = cursor
    const page = await this.api.getChatMembers(chat.id, query)
    const data: UserRef[] = []
    for (const member of page.items ?? []) {
      if (!member.member_id) continue
      data.push({ id: member.member_id, ...member.name ? { name: member.name } : {} })
    }
    return page.has_more && page.page_token ? { data, next: page.page_token } : { data }
  }

  /**
   * Add one catalogue emoji to a message. A repetition is not an error: the platform answers with the same
   * reaction, which keeps a retried announcement harmless.
   *
   * @param message - message to react to.
   * @param emoji - `emoji_type` of the platform catalogue.
   */
  override async createReaction(message: MessageRef, emoji: string): Promise<void> {
    await this.api.createReaction(message.id, emoji)
  }

  /**
   * Withdraw this application's own reaction: the platform deletes by reaction identity, so the message's
   * reactions are read first and only the one this app carries is deleted; another member's identical emoji survives
   * and a reaction already gone makes this a no-op.
   *
   * @param message - message carrying the reaction.
   * @param emoji - `emoji_type` to withdraw.
   */
  override async deleteReaction(message: MessageRef, emoji: string): Promise<void> {
    const page = await this.api.listReactions(message.id, { reaction_type: emoji, page_size: 50 })
    const own = (page.items ?? []).find(reaction => reaction.reaction_type?.emoji_type === emoji
      && reaction.operator?.operator_type === 'app'
      && reaction.operator?.operator_id === this.config.appId)
    if (!own?.reaction_id) return
    await this.api.deleteReaction(message.id, own.reaction_id)
  }
}

export { LarkBot as FeishuBot }
