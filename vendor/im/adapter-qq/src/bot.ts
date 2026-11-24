/**
 * The QQ official-bot adapter shell: bot identity, REST client, token, mode selection, resource scope and error
 * classification. Everything that needs a platform connection or a mode implementation delegates to its module:
 *
 * - `ws.ts` is the gateway client: the constructor installs it on {@link QQBot.adapter} for `transport: 'ws'`, and it
 * uses {@link QQBot.gatewayUrl}, {@link QQBot.authorization}, `bot.online()` / `bot.user` / `bot.selfId`, and hands
 * every dispatch frame to {@link QQBot.decodeDispatch}.
 * - `decode.ts` implements {@link QQBot.decodeDispatch}.
 * - `modes/` implements {@link QQBot.createModes}.
 * - `passive.ts`, `prepare.ts`, `send.ts` implement {@link QQBot.upload}, {@link QQBot.sendPayload} and
 * `deletePart` (the platform recalls, it never edits, so this class deliberately has **no** `editPayload`).
 * - `stream.ts` implements {@link QQBot.streamDriver}.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/bot
 */

import { Adapter, Inject, type MessageHandle, type Mode, type PlatformError, type PrepareContext, type ResolvedResource, type ResourceKind, type ResourceRef, type SendContext, type SentPart, type Session, type StreamDriver, type Target } from '@deepseek-ai/cordis-plugin-im-core'
import { type Context } from '@deepseek-ai/cordis'
import { type Http } from '@deepseek-ai/cordis-plugin-http'
import { type QqAddress, QqApi, parseChatId } from './api.ts'
import { Config, type QQConfig, resolveBaseUrl } from './config.ts'
import { decodeDispatch as decodeFrame } from './decode.ts'
import { classify } from './errors.ts'
import { createQQModes } from './modes/index.ts'
import { PassiveManager, referrerOf } from './passive.ts'
import { uploadResource } from './prepare.ts'
import { deleteSentPart, sendMessagePayload } from './send.ts'
import { createStreamDriver } from './stream.ts'
import { AccessToken } from './token.ts'
import { WsClient } from './ws.ts'

/** Mode ids: plain text (`msg_type: 0`) and markdown (`msg_type: 2`). */
export type QQModeId = 'text' | 'markdown'

/**
 * The adapter's modes: `modes/text.ts` and `modes/markdown.ts`, returned from {@link QQBot.createModes}; both own an
 * element registry, `assemble` (media split, button hoisting) and `serialize`.
 */
export interface QQModes extends Record<QQModeId, Mode<any>> {}

/** One gateway dispatch frame (`op: 0`). */
export interface GatewayDispatch {
  op: 0
  /** Event name, e.g. `GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE` / `INTERACTION_CREATE`. */
  t: string
  /** Gateway sequence number; the resume handshake echoes it. */
  s?: number
  /** Outer event id of the dispatch (the QQ `event_id`). */
  id?: string
  /** Event payload. */
  d?: unknown
}

/** The gateway client; only the bot lifecycle calls into it. */
export interface QQGatewayClient {
  connect(): Promise<void>
  disconnect(): Promise<void>
}

/**
 * QQ official bot (group + C2C only).
 *
 * Bot id is `qq:<appId>`, `platform` is `qq`. Chat ids are self-describing (`group:` / `user:`) and double as the
 * resource scope, because a QQ upload key is only valid in the chat it was made for.
 */
@Inject('http')
export class QQBot extends Adapter<QQConfig, QQModes> {
  /** The Schemastery schema, so the loader validates a YAML row before the adapter mounts. */
  static Config = Config

  /** Gateway client of the WebSocket transport; absent for `transport: 'none'` (REST only). */
  adapter?: QQGatewayClient

  /**
   * Cross-application openid of this bot, read once by {@link QQBot.ensureIdentity}.
   *
   * `READY` reports the account id only, while a message body names a mentioned user by openid — the bot's own is the
   * `union_openid`, so a full-mode group message cannot be recognized as addressing the bot without it.
   */
  unionOpenid = ''

  /** Application access token with refresh window and single-flight refresh. */
  readonly tokens: AccessToken

  /** Typed REST client of the QQ routes. */
  readonly api: QqApi

  /** Passive-reply windows, budgets and `msg_seq` bookkeeping (`passive.ts`). */
  readonly passive = new PassiveManager({ config: this.config.passive })

  private _modes?: QQModes

  /** The C2C `append` driver, built once: its bookkeeping lives on each stream's handle, not in the driver. */
  private _stream?: StreamDriver

  constructor(ctx: Context, config: QQConfig) {
    super(ctx, config, { id: `qq:${config.appId}`, platform: 'qq' })
    const tokenUrl = config.tokenUrl
    this.tokens = new AccessToken({
      appId: config.appId,
      secret: config.secret,
      tokenUrl,
      post: async (url, data, signal) => {
 // The token endpoint is absolute, so the API base URL does not apply; it needs no authorization header.
        const init: Http.RequestConfig = { method: 'POST', data }
        if (signal) init.signal = signal
        const response = await ctx.http(url, init)
        if (!response.ok) {
          throw Object.assign(new Error(`QQ access-token endpoint answered ${response.status}`), { response })
        }
        return await response.json()
      },
    })
    this.api = new QqApi({
      http: (url, init) => {
        const request: Http.RequestConfig = {}
        if (init.method !== undefined) request.method = init.method
        if (init.data !== undefined) request.data = init.data
        if (init.headers !== undefined) request.headers = init.headers
        if (init.signal !== undefined) request.signal = init.signal
        return ctx.http(url, request)
      },
      appId: config.appId,
      baseUrl: resolveBaseUrl(config),
      token: signal => this.tokens.get(signal),
    })
 // `transport: 'none'` runs REST only, so it never creates a socket. The client assigns `bot.adapter` in its constructor.
    if (config.transport !== 'none') ctx.plugin(WsClient, this)
  }

  /** The two modes, built on first use so that a REST-only bot never needs them. */
  override get modes(): QQModes {
    return (this._modes ??= this.createModes())
  }

 // -------------------------------------------------------------------------------------------------------------
 // Adapter hooks

  /**
 * Build the `text` and `markdown` modes.
 *
 * @returns the mode table keyed by mode id.
 */
  createModes(): QQModes {
    return createQQModes(this.config, this.keyboardEnabled)
  }

  /**
 * Decode one gateway dispatch into the sessions to publish. The gateway client awaits `bot.receive(session)` for each
 * of them, so the intake gate still runs before the transport advances to the next frame.
 *
 * The decoding lives in `decode.ts`; its module documentation holds the event coverage and the referrer contract.
 *
 * @param frame - dispatch frame (`op: 0`).
 * @returns the sessions of this frame, possibly empty.
 */
  async decodeDispatch(frame: GatewayDispatch): Promise<Session[]> {
    return await decodeFrame(this, frame)
  }

  /**
   * Upload one resource through `POST /v2/{groups|users}/{id}/files` and cache its `file_info`.
   *
 * @param ref - resource to upload.
 * @param scope - chat scope (`group:<id>` / `user:<id>`).
 * @param ctx - prepare context (fetch, cache, cancellation).
 * @returns the resolved `file_info` with its TTL.
 */
  override async upload(ref: ResourceRef, scope: string, ctx: PrepareContext): Promise<ResolvedResource> {
    return await uploadResource(this, ref, scope, ctx)
  }

  /**
 * Publish one serialized payload of the modes, with the passive `msg_id` / `msg_seq` bookkeeping.
 *
 * @param payload - mode payload (a `msg_type` body).
 * @param target - target chat.
 * @param ctx - part index, quote target and options.
 * @returns the sent part.
 */
  override idempotentSend(target: Target, ctx: SendContext): boolean {
    const key = ctx.options.idempotencyKey
    if (key === undefined) return false
    return this.passive.canClaim(referrerOf(target), `${key}:${ctx.index}`)
  }

  override async sendPayload(payload: unknown, target: Target, ctx: SendContext): Promise<SentPart> {
    return await sendMessagePayload(this, payload, target, ctx)
  }

  /**
 * Recall one part. The platform has no message update at all, so this is the only mutating operation of the adapter —
 * there is deliberately no `editPayload`.
 *
 * @param part - the published part to delete.
 * @param handle - the message it belongs to.
 */
  override async deletePart(part: SentPart, handle: MessageHandle): Promise<void> {
    await deleteSentPart(this, part, handle)
  }

  /**
 * The C2C `append` driver when `stream` is enabled, otherwise `undefined` so the core uses the buffered `final`
 * strategy — which is the only supported strategy for groups.
 *
 * Both branches are pure: the driver is created once (its per-message state lives on `handle.state`), and the group
 * test is a property read, because the core consults this hook on every mode lookup.
 *
 * @param _mode - mode id (`text` or `markdown`; the stream content type follows the serialized body).
 * @param target - target chat.
 * @returns the driver, or `undefined` for `final`.
 */
  override streamDriver(_mode: string, target: Target): StreamDriver | undefined {
 // `stream_messages` refuses 群消息, so a group buffers and publishes once at close.
    if (!this.config.stream || target.chat.type !== 'direct') return undefined
    return (this._stream ??= createStreamDriver(this))
  }

 // -------------------------------------------------------------------------------------------------------------
 // Adapter contract implemented here

  /**
 * `text` first and `markdown` second — only when the configuration enables markdown at all. Core resolves one mode per
 * message from how much each would degrade it and breaks a tie with this order, so a reply that needs no markdown goes
 * out as plain text (it reads better in QQ). Content that mixes text with a picture is not a tie: `text` has to lift
 * the picture into its own message, which the score now charges, so the markdown mode that keeps it inline wins.
 */
  override get modeOrder(): readonly QQModeId[] {
    return this.config.markdown ? ['text', 'markdown'] : ['text']
  }

  /** Whether custom keyboards are sent at all: they require the markdown mode. */
  get keyboardEnabled(): boolean {
    return this.config.keyboard && this.config.markdown
  }

  /** The resource scope is the self-describing chat id, independent of the resource kind. */
  override resourceScope(target: Target, _kind: ResourceKind): string {
    return target.chat.id
  }

  /** Map a platform failure onto the core taxonomy. */
  override classify(error: unknown): PlatformError {
    return classify(error)
  }

 // -------------------------------------------------------------------------------------------------------------
 // Helpers

  /**
 * Parsed address of a target.
 *
 * @param target - target chat.
 * @returns `group:<id>` / `user:<id>` parsed into kind and openid.
 */
  address(target: Target): QqAddress {
    return parseChatId(target.chat.id)
  }

  /**
 * `Authorization` header value of the current token; the gateway `IDENTIFY` frame uses the same form.
 *
 * @param signal - caller cancellation.
 * @returns `QQBot <access_token>`.
 */
  async authorization(signal?: AbortSignal): Promise<string> {
    return this.api.authorization(await this.tokens.get(signal))
  }

  /**
 * Gateway URL of this application (`GET /gateway`) rewritten to the configured host, so `sandbox` reaches the sandbox
 * gateway.
 *
 * @param signal - caller cancellation.
 * @returns the `wss://` gateway URL.
 */
  async gatewayUrl(signal?: AbortSignal): Promise<string> {
    const { url } = await this.api.getGateway(signal)
    // The endpoint answers with the host it serves, so a sandbox `/gateway` already returns
    // `wss://sandbox.api.sgroup.qq.com/websocket`. Replacing the production host inside that string prefixed the
    // configured host onto it a second time (`wss://sandbox.sandbox.…`), which no DNS answers.
    const gateway = new URL(url)
    const configured = new URL(this.api.baseUrl)
    if (gateway.host !== configured.host) gateway.host = configured.host
    return gateway.href
  }

  /**
 * Read {@link QQBot.unionOpenid} once per bot, so a message body that mentions the bot by openid is recognized.
 *
 * The read happens on demand rather than at `READY`: only a `GROUP_MESSAGE_CREATE` body names the bot by openid, so
 * an adapter that never receives one never makes the request.
 *
 * @param signal - caller cancellation.
 */
  async ensureIdentity(signal?: AbortSignal): Promise<void> {
    if (this.unionOpenid) return
    const self = await this.api.getSelf(signal)
    if (self.union_openid) this.unionOpenid = self.union_openid
  }

  /**
 * Acknowledge a button interaction; callers must do this before reacting, within the platform's 3 s.
 *
 * @param interactionId - `d.id` of the `INTERACTION_CREATE` event.
 * @param signal - caller cancellation.
 */
  async acknowledgeInteraction(interactionId: string, signal?: AbortSignal): Promise<void> {
    await this.api.acknowledgeInteraction(interactionId, 0, signal)
  }

 // -------------------------------------------------------------------------------------------------------------
 // Lifecycle

  override async connect(): Promise<void> {
 // REST only, no gateway session, so the bot is usable as soon as its token is.
    if (this.config.transport === 'none') {
      this.online()
      return
    }
    if (!this.adapter) throw new Error('qq: the WebSocket gateway client is not installed')
    await this.adapter.connect()
  }

  override async disconnect(): Promise<void> {
    await this.adapter?.disconnect()
  }

  /** A rest-only bot has no platform identity: it is only learned from the gateway's `READY` frame. */
  get isRestOnly() {
    return this.config.transport === 'none'
  }
}
