/**
 * Bot (public API) and Adapter (implementer API).
 *
 * Pipeline implemented once here for every adapter:
 *
 * ```
 * normalize → transform → prepare → serialize → sendPayload × n
 * ```
 *
 * The four async stages are `Bot.pipeline()`; `send` / `render` / `edit` / `stream` differ only in what they do with
 * the frame (publish, return the payloads, edit instead of send, or hand it to the stream scheduler).
 *
 * Contract:
 *
 * 1. **Mode selection.** An adapter declares every mode it implements and the order it prefers them in
 *    (`Adapter.modeOrder`); no caller can name one. A publication resolves its mode from its own content: every
 *    candidate is transformed once, and the mode that renders it with the lowest degradation score wins,
 *    the adapter's order breaking a tie. That is what lets a plain reply fall back to the cheapest looking mode (QQ
 *    `text` for a message that needs no markdown). Two directives opt out of that rule:
 *    `<meta name="prefer-streamable-mode" value="true" />` narrows the candidates to the modes with a stream driver
 *    (`stream` implies it), and `<meta name="prefer-expressive-mode" value="true" />` takes the mode supporting the
 *    most element keys, whatever the content needs. The resolution happens once per publication: `edit` keeps the
 *    handle's mode and rejects a directive that mode cannot satisfy, and a stream keeps the mode it opened with.
 *    `<fallback>` gives the author a second lever: a mode that renders an earlier candidate costs less than one that
 *    needs a later candidate, so content that names its alternatives lands where its first choice renders natively.
 * 2. **`send` order and partial failure.** Every payload is serialized before the first request (payloads are pure),
 *    then parts are sent sequentially with `ctx.previous` = the parts published so far and `ctx.quote` only on part
 *    0 (the adapter decides which request body carries the reply reference; `SerializeContext.quote` is present on
 *    every part). When part *k > 0* fails, the error is `PartialSendError` whose `handle.parts` holds the published
 *    parts and whose `cause` is the classified `PlatformError`; when part 0 fails the classified error is thrown
 *    unchanged.
 * 3. **Retry.** `retryable` / `rate-limit` errors of `sendPayload` / `editPayload` / `deletePart` are retried
 *    (`PIPELINE_ATTEMPTS` = 3, `streamBackoff()` — honouring `retryAfterMs`), aborting with `SendOptions.signal`.
 *    Idempotency across attempts is the adapter's job (`SendOptions.idempotencyKey`: Lark `uuid`, QQ dedupe);
 *    `SendContext.index` is available to derive one key per part.
 * 4. **Platform refusals are errors, not predictions.** What a mode renders is fixed by its registry; what the platform
 *    allows in one chat is not known in advance. A refused call rejects with the classified `PlatformError`, so a
 *    caller sees the platform's own answer. Content that must degrade gracefully says so itself, with `<fallback>`.
 * 5. **`strict`.** `SendOptions.strict` rejects with `StrictRenderError(report)` when the report shows a semantic
 *    change — `degraded`, `dropped` or `folded` — but not for `moved` / `split` (position and multi-part splitting
 *    are lossless).
 * 6. **`edit` strategies.** `in-place` requires the adapter's `editPayload`, an edit budget left
 *    (`limit.update.count`) *and* the same number of parts as the handle; `replace` deletes the old parts and publishes
 *    the already staged frame as a new message (the frame was rendered in the handle's mode — harmless, an edit does not
 *    change how content renders); `auto` edits in place when possible, else replaces. An
 *    explicit `in-place` that is impossible throws `PlatformError('invalid')` with the reason. The mode never changes:
 *    the content is rendered in the handle's mode, and a directive that would need a different one is refused.
 * 7. **`delete`.** Impossible now (no `deletePart`, expired `limit.delete.window` such as QQ's 2 minutes) is a logged
 *    no-op — `delete()` is also used by stream recall, which must not throw.
 * 8. **Events.** `send(bot, result)` fires once per published logical message — from `send`, from an in-place
 *    `edit`, and from a stream close that did not go through `Bot.send` (the `final` strategy and recall-and-resend
 *    already announce themselves). `onClick` actions of the rendered state are registered on `bot.callbacks`.
 * 9. **`render`** is the dry run (`skipUpload: true`, no event, no callback registration, no cache writes).
 */

import { type Context, Service } from '@deepseek-ai/cordis'
import { type Element, type Fragment, normalize } from '@deepseek-ai/satori-element'
import { type ExtractParams } from 'path-to-regexp-typed'
import { PartialSendError, PlatformError, StrictRenderError } from './errors.ts'
import { type ContentDirectives, readDirectives, splitDirectives } from './directives.ts'
import { degradationScore } from './degradation.ts'
import type { RenderReport } from './fallback.ts'
import { type InternalRouteCallback, InternalRouter } from './internal.ts'
import type { Mode, TransformResult } from './mode.ts'
import {
  type ChatRef, type InboundMessage, type Login, type MembersPage, type MessageRef, Status, type Target, type User,
} from './protocol.ts'
import {
  createResourceFetcher, MemoryResourceCache, type PrepareContext, prepare, type Prepared, type ResolvedResource,
  type ResourceKind, type ResourceRef,
} from './resource.ts'
import { CallbackRegistry, Session, type SessionEvent } from './session.ts'
import {
  createMessageStream, type MessageStream, type StreamDriver, type StreamFrame, type StreamHost, type StreamOptions,
  type StreamPhase, streamBackoff,
} from './stream.ts'
import { transform } from './transform.ts'

export interface SendOptions {
  /** Lark uuid; QQ: local dedupe. */
  idempotencyKey?: string
  silent?: boolean
  /** Any degradation ⇒ reject with `StrictRenderError` (carries the RenderReport). */
  strict?: boolean
  signal?: AbortSignal
}

export interface EditOptions extends SendOptions {
  /** `in-place` when `message.update` is supported; `replace` = delete + send; `auto` (default) = in-place when possible. */
  strategy?: 'in-place' | 'replace' | 'auto'
}

export interface SentPart {
  id: string
  kind: string
  time: number
  /** Actual thread the platform placed this part in, when reported by the send answer. */
  thread?: { id: string; root?: string }
  /** Adapter-opaque reply context (referrer) of this published part, when reported by the send answer. */
  referrer?: unknown
  /** Platform-local alternate ids (such as QQ `ext_info.ref_idx`) by which later quotes may refer to this part. */
  aliases?: string[]
  raw?: unknown
}

export interface MessageHandle {
  /** Bot id. */
  bot: string
  target: Target
  mode: string
  /** Platform messages of this logical message. */
  parts: SentPart[]
  createdAt: number
  edits: number
  /** The tree this message was published from (re-rendered by a `replace` edit). */
  content: Element<'message'>
  /** Adapter-private (CardKit card_id + sequence, QQ msg_seq …). */
  state?: unknown
}

export interface SendResult {
  handle: MessageHandle
  report: RenderReport
}

/** Dry-run result of `bot.render`. */
export interface RenderResult {
  /** The mode core resolved from this content (the same rule `send` applies). */
  mode: string
  payloads: unknown[]
  report: RenderReport
}

export interface SendContext {
  /** Part index within the logical message. */
  index: number
  /** Reply target (first part only unless the adapter repeats it). */
  quote?: string
  options: SendOptions
  /** Results of earlier parts (dependency chain). */
  previous: readonly SentPart[]
}

export interface BotInit {
  /** Stable configured id: `lark:<appId>`, `qq:<appId>`. */
  id: string
  /** Platform name (`feishu` | `lark` | `qq` …); also the first segment of `satori:` internal URLs. */
  platform: string
  /** Adapter name, default `platform`. */
  adapter?: string
}

/** Attempts per platform call of the pipeline (`sendPayload` / `editPayload` / `deletePart`). */
const PIPELINE_ATTEMPTS = 3

/** One fully staged logical message: everything `send` / `edit` / `render` need. */
interface PipelineFrame {
  /** The normalized root (kept in the handle). */
  content: Element<'message'>
  mode: Mode<any>
  result: TransformResult<any>
  prepared: Prepared<any>[]
  payloads: unknown[]
}

interface PipelineOptions {
  /** Existing message this render is for (edit / delete): freezes its mode and applies its edit/deletion window. */
  handle?: MessageHandle
  /** `bot.render`: no upload, deterministic `dryrun:` keys. */
  skipUpload?: boolean
  signal?: AbortSignal
  /** Frozen mode of a stream: every state of one stream is rendered in the mode it opened with. */
  mode?: Mode<any>
  /** The publication is a stream state, so the mode must be able to stream. */
  stream?: boolean
  /** The stream state this render publishes (`RenderContext.stream`). */
  phase?: StreamPhase
}

export abstract class Bot<C = unknown> {
  static inject = ['satori']

  public [Service.tracker] = {
    associate: 'bot',
    property: 'ctx',
  }

  /** Stable configured id: `lark:<appId>`, `qq:<appId>`. */
  readonly id: string
  readonly platform: string
  readonly adapterName: string
  /** Platform user id of the bot itself; empty until known. */
  selfId = ''
  user?: User
  sn: number
  hidden = false
  error: unknown
  /** Platform API client (adapter-defined; used by the `/_api/:name` internal route). */
  internal: any = null
  /** In-process `onClick` callbacks of sent buttons. */
  readonly callbacks = new CallbackRegistry()

  /** `prepare` cache of this bot; one per bot, so re-transformed messages re-upload nothing. */
  protected readonly resourceCache = new MemoryResourceCache({ now: () => this.now() })
  /** Handles already announced through the `send` event (a stream must not announce its final state twice). */
  private readonly announced = new WeakSet<MessageHandle>()

  _internalRouter: InternalRouter

  // Same as `this.ctx`, but with a more specific type.
  protected context: Context
  protected _status: Status = Status.OFFLINE

  constructor(public ctx: Context, public config: C, init: BotInit) {
    this.id = init.id
    this.platform = init.platform
    this.adapterName = init.adapter ?? init.platform
    this.sn = ++ctx.satori._loginSeq
    this._internalRouter = new InternalRouter(ctx)
    this.context = ctx
    ctx.bots.push(this)

    ctx.on('interaction/button', (session) => {
      // Cordis proxies event arguments: compare the stable id, never object identity.
      if (session.bot?.id !== this.id || !session.button) return
      void this.callbacks.dispatchButton(session.button).catch(error => ctx.logger.warn(error))
    })

    ctx.on('interaction/select', (session) => {
      if (session.bot?.id !== this.id || !session.select) return
      void this.callbacks.dispatchSelect(session.select).catch(error => ctx.logger.warn(error))
    })

    ctx.on('interaction/check', (session) => {
      if (session.bot?.id !== this.id || !session.check) return
      void this.callbacks.dispatchCheck(session.check).catch(error => ctx.logger.warn(error))
    })
  }

  async* [Service.init]() {
    yield () => this.dispose()
    this.dispatchLoginEvent('login-added')
    await this.start()
  }

  // -------------------------------------------------------------------------------------------------------------
  // What this adapter can still do to a published message

  /** Whether this adapter implements `editPayload` at all. */
  private get canEdit(): boolean {
    return typeof this.adapterHooks.editPayload === 'function'
  }

  /**
   * Whether `mode` may still edit `handle` in place: the adapter edits at all, and the handle has an edit left.
   *
   * @param mode - the handle's mode.
   * @param handle - the message to rewrite.
   * @returns `true` when an in-place edit is still possible.
   */
  private editableNow(mode: Mode<any>, handle: MessageHandle): boolean {
    if (!this.canEdit) return false
    const max = mode.limits['limit.update.count']
    return max === undefined || handle.edits < max
  }

  /**
   * Whether `handle` can still be deleted: the adapter implements `deletePart`, and `mode`'s deletion window is open.
   *
   * @param mode - the handle's mode.
   * @param handle - the message to delete.
   * @returns `true` when a deletion is still accepted.
   */
  private deletableNow(mode: Mode<any>, handle: MessageHandle): boolean {
    if (typeof this.adapterHooks.deletePart !== 'function') return false
    const window = mode.limits['limit.delete.window']
    return window === undefined || this.now() < handle.createdAt + window
  }

  // -------------------------------------------------------------------------------------------------------------
  // Pipeline

  /**
   * Publish one logical message, in the mode its content needs (see {@link resolveMode}).
   *
   * @param target - the chat to publish into.
   * @param content - the content; root-level directives are read and removed.
   * @param options - retry signal, idempotency key, `strict`.
   * @returns the published handle and the render report.
   */
  async send(target: Target, content: Fragment, options: SendOptions = {}): Promise<SendResult> {
    let frame: PipelineFrame
    try {
      frame = await this.pipeline(target, content, options)
    } catch (error) {
      throw this.unpublished(error)
    }
    return this.publish(target, frame, options)
  }

  /**
   * One failure raised before any platform request: the pipeline rendered, fetched and uploaded, but no message left
   * for the platform, so the error reports that nothing was published instead of an unknown outcome.
   *
   * @param error - whatever the pipeline raised.
   * @returns the error to throw: a render refusal keeps its own type, everything else is classified and marked as
   *   unpublished; an already classified refusal passes through.
   */
  private unpublished(error: unknown): unknown {
    // `StrictRenderError` carries the report the caller reports; `partial` needs published parts, which cannot exist yet.
    if (error instanceof StrictRenderError || error instanceof PartialSendError) return error
    const cause = this.classifyError(error)
    if (cause.published === 'no') return cause
    return new PlatformError(cause.kind, cause.message, {
      published: 'no',
      ...cause.code === undefined ? {} : { code: cause.code },
      ...cause.retryAfterMs === undefined ? {} : { retryAfterMs: cause.retryAfterMs },
      cause,
    })
  }

  /**
   * Edit a published message, always in the mode it was published in.
   *
   * The mode is never re-resolved: a platform message cannot change its mode, so content whose directive asks for a
   * streamable mode while the message's mode has no stream driver is refused instead of being published in another
   * mode.
   *
   * @param handle - the message to edit.
   * @param content - the new content.
   * @param options - edit strategy, retry signal, idempotency key.
   * @returns the result, carrying the same handle.
   * @throws PlatformError `invalid` for a mode change, a refused `in-place` or an impossible `replace`.
   */
  async edit(handle: MessageHandle, content: Fragment, options: EditOptions = {}): Promise<SendResult> {
    const target = handle.target
    const directives = readDirectives(content)
    if (directives.preferStreamableMode && !this.driverOf(handle.mode, target)) {
      throw new PlatformError(
        'invalid',
        `${this.id}: the message is published in mode "${handle.mode}", which cannot stream; changing the mode of a`
        + ' published message is not supported',
      )
    }
    if (directives.preferExpressiveMode) {
      const broadest = this.expressiveMode(this.directivePool(target, directives))
      if (broadest.id !== handle.mode) {
        throw new PlatformError(
          'invalid',
          `${this.id}: the message is published in mode "${handle.mode}", and the content asks for the mode with the`
          + ` most elements ("${broadest.id}"); changing the mode of a published message is not supported`,
        )
      }
    }
    const frame = await this.pipeline(target, content, options, { handle })
    const strategy = options.strategy ?? 'auto'
    // In-place needs the adapter's `editPayload` (inside the handle's edit budget) and the same part count.
    const editable = frame.payloads.length > 0
      && frame.payloads.length === handle.parts.length
      && this.editableNow(frame.mode, handle)
    if (editable && strategy !== 'replace') return this.applyEdit(handle, frame, options)
    if (strategy === 'in-place') {
      throw new PlatformError('invalid', `${this.id}: cannot edit the message in place — ${this.editBlocker(handle, frame)}`)
    }
    if (!this.deletableNow(frame.mode, handle)) {
      throw new PlatformError('invalid', `${this.id}: cannot replace the message — ${this.deleteBlocker(frame.mode, handle)}`)
    }
    await this.deleteParts(handle)
    return this.publish(target, frame, options)
  }

  async delete(handle: MessageHandle | MessageRef): Promise<void> {
    const resolved = this.asHandle(handle)
    if (await this.recall(resolved)) return
    const mode = this.modeOf(resolved.mode)
    this.ctx.logger.warn(
      `[${this.id}] did not delete ${resolved.parts.map(part => part.id).join(', ')}: ${this.deleteBlocker(mode, resolved)}`,
    )
  }

  /**
   * Open a streamed message.
   *
   * A stream cannot change its mode — it publishes many states into one platform message — so it opens in the
   * broadest mode that can stream ({@link streamMode}) and every state is rendered in it. That is what a
   * `prefer-streamable-mode` plus `prefer-expressive-mode` content asks for, resolved before any content exists.
   *
   * @param target - the chat to publish into.
   * @param options - stream options (intervals, budget) plus send options.
   * @returns the stream; `done` settles with the final result.
   */
  stream(target: Target, options: StreamOptions = {}): MessageStream {
    const mode = this.streamMode(target)
    const driver = this.driverOf(mode.id, target)
    const strategy = driver?.strategy ?? 'final'
    const host: StreamHost<any> = {
      bot: this,
      target,
      mode,
      driver,
      render: async (content, signal, final): Promise<StreamFrame<any> | undefined> => {
        const frame = await this.pipeline(target, content, options, { signal, mode, phase: { strategy, final } })
        if (!frame) return undefined
        return {
          content: frame.content,
          result: frame.result,
          prepared: frame.prepared,
          payloads: frame.payloads,
        }
      },
      send: (content, sendOptions) => this.send(target, content, sendOptions),
      recall: handle => this.recall(handle),
      register: actions => this.registerActions(actions),
      classify: error => this.classifyError(error),
      idempotentSend: ctx => this.adapterHooks.idempotentSend?.(target, ctx) ?? false,
      now: () => this.now(),
    }
    const stream = createMessageStream<any>(host, options)
    // A driver-based stream publishes its final state itself: announce it here unless `Bot.send` already did
    // (`final` strategy, or recall + resend).
    void stream.done.then((result) => {
      if (!this.announced.has(result.handle)) this.announce(result, [])
    }).catch(() => {})
    return stream
  }

  /**
   * Dry run: resolve the mode from the content, then transform + prepare(skipUpload) + serialize.
   *
   * @param target - the chat the publication would go to.
   * @param content - the content; root-level directives are read and removed.
   * @param options - send options (only `strict` is consulted).
   * @returns the payloads a `send` of the same content would use, and the render report.
   */
  async render(target: Target, content: Fragment, options: SendOptions = {}): Promise<RenderResult> {
    const frame = await this.pipeline(target, content, options, { skipUpload: true })
    return { mode: frame.mode.id, payloads: frame.payloads, report: frame.result.report }
  }

  // -- pipeline stages ------------------------------------------------------------------------------------------

  /**
   * The four pure/async stages shared by `send` / `edit` / `render` / `stream`.
   *
   * @param target - the chat.
   * @param content - the content, directives included.
   * @param options - send options.
   * @param extra - stage options of the caller (`handle`, `skipUpload`, `signal`, a frozen `mode`, the `stream` intent
   * or the stream `phase`).
   * @returns the staged frame; its `content` is the tree without the directives. `undefined` only for an intermediate
   * stream state (`phase.final === false`) that renders no platform message yet.
   * @throws PlatformError `invalid` when the chosen mode renders no platform message.
   */
  private async pipeline(
    target: Target,
    content: Fragment,
    options: SendOptions,
    extra?: PipelineOptions & { phase?: undefined },
  ): Promise<PipelineFrame>
  private async pipeline(
    target: Target,
    content: Fragment,
    options: SendOptions,
    extra: PipelineOptions,
  ): Promise<PipelineFrame | undefined>
  private async pipeline(
    target: Target,
    content: Fragment,
    options: SendOptions,
    extra: PipelineOptions = {},
  ): Promise<PipelineFrame | undefined> {
    const { content: stripped, directives } = splitDirectives(content)
    const root = normalize(stripped)
    const mode = extra.mode
      ?? await this.resolveMode(
        target,
        root,
        extra.stream === true ? { ...directives, preferStreamableMode: true } : directives,
        extra.handle,
      )
    const result = transform(root, { bot: this, target, mode, stream: extra.phase })
    if (!result.msgs.length) {
      if (extra.phase?.final === false) return undefined
      throw new PlatformError('invalid', `${this.id}: mode "${mode.id}" rendered no platform message (empty content?)`)
    }
    this.checkStrict(result.report, options)
    // A draft the platform is known to refuse (too many elements, too many bytes) fails here, before any request: a
    // final state of a stream is checked by the stream scheduler itself, which can recall and resend.
    if (extra.phase === undefined) {
      for (const msg of result.msgs) {
        const violation = mode.check?.(msg)[0]
        if (violation !== undefined) {
          throw new PlatformError('limit', `: ${violation.message}`, { published: 'no' })
        }
      }
    }
    const signal = extra.signal ?? options.signal
    const prepared = await prepare(result.msgs, {
      adapter: this.adapterHooks,
      target,
      cache: this.resourceCache,
      fetch: createResourceFetcher(this.ctx),
      ...signal ? { signal } : {},
      ...extra.skipUpload ? { skipUpload: true } : {},
    })
    const payloads = prepared.map((draft, index) => mode.serialize(draft, {
      bot: this,
      target,
      mode: mode.id,
      index,
      count: prepared.length,
      ...result.quote === undefined ? {} : { quote: result.quote },
      options,
    }))
    return { content: root, mode, result, prepared, payloads }
  }

  /**
   * The mode one publication uses.
   *
   * Without a directive every candidate renders the content once and the mode with the lowest degradation score wins,
   * dropped wins, a tie going to the adapter's declared order — a message that needs nothing special lands in the
   * cheapest looking mode. `prefer-streamable-mode` narrows the pool to the modes with a stream driver;
   * `prefer-expressive-mode` then takes the mode supporting the most elements, whatever this content needs. A handle
   * answers its own mode, because an edit cannot change it.
   *
   * @param target - the chat; drivers may be target-dependent.
   * @param root - the normalized content.
   * @param directives - what the content asked for.
   * @param handle - the message an edit republishes.
   * @returns the resolved mode.
   * @throws PlatformError `invalid` when no candidate can render the content.
   */
  private async resolveMode(
    target: Target,
    root: Element<'message'>,
    directives: ContentDirectives,
    handle?: MessageHandle,
  ): Promise<Mode<any>> {
    if (handle) return this.modeOf(handle.mode)
    const pool = this.directivePool(target, directives)
    if (directives.preferExpressiveMode) return this.expressiveMode(pool)
    let best: { mode: Mode<any>; cost: number } | undefined
    for (const id of pool) {
      const mode = this.modeOf(id)
      const cost = this.renderCost(target, mode, root)
      if (cost === undefined) continue
      if (!best || cost < best.cost) best = { mode, cost }
    }
    if (!best) throw new PlatformError('invalid', `${this.id}: no mode can render this content`)
    return best.mode
  }

  /**
   * The candidate ids a publication may use, in preference order (the streamable directive narrows them).
   *
   * @param target - the chat, whose drivers the directive reads.
   * @param directives - what the content asked for.
   * @returns the candidate mode ids; every declared mode when none of them can stream.
   */
  private directivePool(target: Target, directives: ContentDirectives): string[] {
    const candidates = this.modeCandidates()
    if (!directives.preferStreamableMode) return candidates
    const streamable = candidates.filter(id => this.driverOf(id, target) !== undefined)
    return streamable.length ? streamable : candidates
  }

  /**
   * The mode of `pool` that declares the most element keys, a tie going to the declared order.
   *
   * The content is not consulted at all: "the mode that can express the most" is a property of the mode's registry, so
   * a card that could also have been a rich-text post goes out as a card.
   *
   * @param pool - the candidate mode ids, in preference order.
   * @returns the broadest mode.
   */
  private expressiveMode(pool: readonly string[]): Mode<any> {
    let best: { mode: Mode<any>; breadth: number } | undefined
    for (const id of pool) {
      const mode = this.modeOf(id)
      const breadth = mode.elements.keys().length
      if (!best || breadth > best.breadth) best = { mode, breadth }
    }
    if (!best) throw new PlatformError('invalid', `${this.id}: no mode to publish in`)
    return best.mode
  }

  /**
   * What one mode would pay for this content, weighted per element ({@link degradationScore}): a lost picture, mention
   * or interactive block costs far more than lost bold, and the inline formatting of one message is charged once.
   *
   * @param target - the chat, for handlers that ask about it.
   * @param mode - the candidate mode.
   * @param root - the normalized content.
   * @returns the score, or `undefined` when the mode cannot render the content at all.
   */
  private renderCost(target: Target, mode: Mode<any>, root: Element<'message'>): number | undefined {
    let result: TransformResult<any>
    try {
      result = transform(root, { bot: this, target, mode })
    } catch {
      // A mode that throws on this content cannot publish it, so it is not a candidate for it.
      return undefined
    }
    if (!result.msgs.length) return undefined
    return degradationScore(result.report, mode.degradation)
  }

  /**
   * Every mode the adapter declares, in its preference order.
   *
   * @returns the candidate mode ids.
   * @throws PlatformError `invalid` when the adapter declares none.
   */
  private modeCandidates(): string[] {
    const candidates = this.adapterHooks.modeOrder
    if (!candidates?.length) throw new PlatformError('invalid', `${this.id}: the adapter declares no mode order`)
    return [...candidates]
  }

  /**
   * The mode a stream opens in: the broadest mode that can stream into `target`.
   *
   * A stream publishes many states into one platform message and cannot change its mode, so the choice is made once,
   * before any content exists — and it is made exactly the way a content-level `prefer-streamable-mode` plus
   * `prefer-expressive-mode` would make it: narrow to the modes with a driver, then take the one declaring the most
   * elements. Opening in the *first* streamable mode instead spent the whole turn in whatever the adapter declared
   * first, so a streamed answer lost every emphasis, code block and link while the same answer sent once kept them.
   *
   * @param target - the chat, whose drivers decide what may stream.
   * @returns the mode.
   */
  private streamMode(target: Target): Mode<any> {
    return this.expressiveMode(this.directivePool(target, { preferStreamableMode: true, preferExpressiveMode: true }))
  }

  /**
   * A stand-in mode for a target: the first declared mode with a stream driver for it, else the first declared mode.
   *
   * Used where a handle needs *a* mode without saying anything about content — a `MessageRef` this bot did not send
   * ({@link asHandle}).
   *
   * @param target - the chat, when the question has one.
   * @returns the mode id.
   */
  private preferredModeId(target?: Target): string {
    const candidates = this.modeCandidates()
    if (!target) return candidates[0]!
    return candidates.find(id => this.driverOf(id, target) !== undefined) ?? candidates[0]!
  }

  /** `SendOptions.strict`: semantic changes of the report reject the send (position moves and splits are lossless). */
  private checkStrict(report: RenderReport, options: SendOptions) {
    if (!options.strict) return
    if (report.degraded.length || report.dropped.length || report.folded > 0) throw new StrictRenderError(report)
  }

  /** Sequential `sendPayload` of an already staged frame (also the `replace` half of `edit`). */
  private async publish(target: Target, frame: PipelineFrame, options: SendOptions): Promise<SendResult> {
    const parts: SentPart[] = []
    const handle: MessageHandle = {
      bot: this.id,
      target,
      mode: frame.mode.id,
      parts,
      createdAt: this.now(),
      edits: 0,
      content: frame.content,
    }
    const result: SendResult = { handle, report: frame.result.report }
    try {
      for (let index = 0; index < frame.payloads.length; index++) {
        const ctx: SendContext = {
          index,
          // Only the first platform message answers the quoted one; adapters may repeat it (`ctx.previous`).
          ...index === 0 && frame.result.quote !== undefined ? { quote: frame.result.quote } : {},
          options,
          previous: [...parts],
        }
        const part = await this.withRetry(
          () => this.adapterHooks.sendPayload(frame.payloads[index], target, ctx),
          options.signal,
          () => this.adapterHooks.idempotentSend?.(target, ctx) ?? false,
        )
        parts.push(part)
      }
    } catch (error) {
      const cause = this.classifyError(error)
      if (!parts.length) throw cause
      // Part 2 of 3 failed: the published parts stay, the caller records them as `partial` / `uncertain`.
      this.announce(result, frame.result.actions)
      throw new PartialSendError(handle, cause, frame.result.report)
    }
    this.announce(result, frame.result.actions)
    return result
  }

  /** In-place edit of every part of the handle, counting `handle.edits` before each request. */
  private async applyEdit(handle: MessageHandle, frame: PipelineFrame, options: EditOptions): Promise<SendResult> {
    const editPayload = this.adapterHooks.editPayload
    if (!editPayload) throw new PlatformError('invalid', `${this.id}: the adapter cannot edit messages`)
    for (let index = 0; index < frame.payloads.length; index++) {
      const part = handle.parts[index]!
      // Count before the request: a failed edit may still have consumed platform budget.
      handle.edits += 1
      await this.withRetry(() => editPayload.call(this.adapterHooks, part, frame.payloads[index], handle, options.signal), options.signal)
    }
    handle.content = frame.content
    const result: SendResult = { handle, report: frame.result.report }
    this.announce(result, frame.result.actions)
    return result
  }

  /** Why an in-place edit is impossible (the message of an explicit `strategy: 'in-place'` rejection). */
  private editBlocker(handle: MessageHandle, frame: PipelineFrame): string {
    if (frame.payloads.length !== handle.parts.length) {
      return `the new content needs ${frame.payloads.length} platform message(s) but the message has ${handle.parts.length}`
    }
    if (!this.canEdit) return 'the adapter cannot edit messages'
    return `the message used its ${frame.mode.limits['limit.update.count']} in-place edits`
  }

  /** Why a deletion is impossible (a logged `delete()` no-op, and the message of a refused `replace`). */
  private deleteBlocker(mode: Mode<any>, handle: MessageHandle): string {
    if (typeof this.adapterHooks.deletePart !== 'function') return 'the adapter cannot delete messages'
    const window = mode.limits['limit.delete.window']
    return `the ${window} ms deletion window of mode "${mode.id}" has closed`
  }

  // -------------------------------------------------------------------------------------------------------------
  // Deletion / recall

  /** Delete the handle now, without logging; `false` when the platform cannot (anymore). */
  private async recall(handle: MessageHandle): Promise<boolean> {
    if (!this.deletableNow(this.modeOf(handle.mode), handle)) return false
    try {
      await this.deleteParts(handle)
      return true
    } catch (error) {
      this.ctx.logger.warn(`[${this.id}] recall failed`, this.classifyError(error))
      return false
    }
  }

  /** Delete every part of the handle through `adapter.deletePart` (no window check; callers decide). */
  private async deleteParts(handle: MessageHandle): Promise<void> {
    const deletePart = this.adapterHooks.deletePart
    if (!deletePart) throw new PlatformError('invalid', `${this.id}: the adapter cannot delete messages`)
    for (const part of handle.parts) {
      await this.withRetry(() => deletePart.call(this.adapterHooks, part, handle))
    }
  }

  /**
   * A handle for a message this bot published in an earlier process, rebuilt from its platform id, so it can be
   * edited or deleted after a restart. The handle claims no content (`edits` restarts at 0) and the mode the caller
   * names, which must be the mode the message was published in: an edit renders in it and the platform refuses a
   * payload of another kind.
   *
   * @param message - the published message (platform id and chat).
   * @param mode - id of the mode the message was published in; defaults to the bot's preferred mode for the chat.
   * @param kind - `SentPart.kind` the adapter recorded for the part (adapter-defined; `message` when unknown).
   * @returns a one-part handle.
   * @throws PlatformError `invalid` for a mode this bot does not implement.
   */
  handleOf(message: MessageRef, mode?: string, kind = 'message'): MessageHandle {
    const target: Target = { chat: message.chat }
    const id = mode ?? this.preferredModeId(target)
    this.modeOf(id)
    const now = this.now()
    return {
      bot: this.id,
      target,
      mode: id,
      parts: [{ id: message.id, kind, time: now }],
      createdAt: now,
      edits: 0,
      content: normalize([]),
    }
  }

  /** A `MessageRef` (a message we did not send) seen as a handle with one part and a fresh timestamp. */
  private asHandle(handle: MessageHandle | MessageRef): MessageHandle {
    if (Array.isArray((handle as MessageHandle).parts)) return handle as MessageHandle
    const { id, chat } = handle as MessageRef
    const target: Target = { chat }
    const now = this.now()
    return {
      bot: this.id,
      target,
      // We did not send this message, so its mode is unknown; the mode a stream would open in states nothing about it
      // and is only used for the adapter hooks and the deletion window, which are platform-level here.
      mode: this.preferredModeId(target),
      parts: [{ id, kind: 'message', time: now }],
      createdAt: now,
      edits: 0,
      content: normalize([]),
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Errors, retry, actions

  /** Classify an adapter error (identity for `PlatformError`s). */
  private classifyError(error: unknown): PlatformError {
    if (PlatformError.is(error)) return error
    try {
      return this.adapterHooks.classify(error)
    } catch {
      return new PlatformError('fatal', error instanceof Error ? error.message : String(error), { cause: error })
    }
  }

  /** Run a platform call, retrying `retryable` / `rate-limit` failures when safe (`published: 'no'` or idempotent). */
  private async withRetry<R>(
    operation: () => Promise<R>,
    signal?: AbortSignal,
    idempotent: boolean | (() => boolean) = true,
  ): Promise<R> {
    let sawUnknown = false
    const isIdempotent = () => typeof idempotent === 'function' ? idempotent() : idempotent
    const preserveUnknown = (classified: PlatformError): PlatformError =>
      sawUnknown && classified.published !== 'unknown'
        ? new PlatformError(classified.kind, classified.message, {
            cause: classified,
            published: 'unknown',
            ...classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {},
          })
        : classified
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation()
      } catch (error) {
        const classified = this.classifyError(error)
        if (classified.published === 'unknown') sawUnknown = true
        const safe = (!sawUnknown && classified.published === 'no') || isIdempotent()
        const again = (classified.kind === 'retryable' || classified.kind === 'rate-limit')
          && safe
          && attempt < PIPELINE_ATTEMPTS
        if (!again) throw preserveUnknown(classified)
        await this.sleep(streamBackoff(attempt, classified.retryAfterMs), signal)
        if ((sawUnknown || classified.published !== 'no') && !isIdempotent()) {
          throw preserveUnknown(classified)
        }
      }
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return signal?.aborted ? Promise.reject(abortReason(signal)) : Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal))
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortReason(signal!))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private registerActions(actions: TransformResult<unknown>['actions']) {
    for (const action of actions) {
      if (action.kind === 'select') this.callbacks.registerSelect(action.id, action.callback)
      else if (action.kind === 'check') this.callbacks.registerCheck(action.id, action.callback)
      else this.callbacks.registerButton(action.id, action.callback)
    }
  }

  /** Publish a result: register its `onClick` actions and emit `send` (once per logical message). */
  private announce(result: SendResult, actions: TransformResult<unknown>['actions']) {
    this.registerActions(actions)
    this.announced.add(result.handle)
    this.ctx.emit('send', this, result)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reads & misc (optional per adapter; absence ⇒ capability none)

  getMessage?(chat: ChatRef, id: string): Promise<InboundMessage>
  getMessageList?(chat: ChatRef, cursor?: string, limit?: number): Promise<{ data: InboundMessage[]; next?: string }>
  /**
   * The people a chat lists as its members, each with the id a mention addresses. One page of at most `limit`
   * members, from where `cursor` points (the previous page's {@link MembersPage.next}).
   */
  members?(chat: ChatRef, cursor?: string, limit?: number): Promise<MembersPage>
  createReaction?(message: MessageRef, emoji: string): Promise<void>
  deleteReaction?(message: MessageRef, emoji: string): Promise<void>
  /** `satori:` internal URLs from decode. */
  getResource?(src: string, signal?: AbortSignal): Promise<Response>

  // -------------------------------------------------------------------------------------------------------------
  // Lifecycle (ported, working)

  get sid() {
    return `${this.platform}:${this.selfId}`
  }

  getInternalUrl(path: string, init?: ConstructorParameters<typeof URLSearchParams>[0]) {
    let search = new URLSearchParams(init).toString()
    if (search) search = '?' + search
    return `satori:${this.platform}/${this.selfId}${path}${search}`
  }

  defineInternalRoute<P extends string>(path: P, callback: InternalRouteCallback<ExtractParams<P>>) {
    return this._internalRouter.define(path, callback)
  }

  dispose() {
    const index = this.ctx.bots.findIndex(bot => bot.id === this.id)
    if (index >= 0) {
      this.ctx.bots.splice(index, 1)
      this.dispatchLoginEvent('login-removed')
    }
    return this.stop()
  }

  private dispatchLoginEvent(type: string) {
    this.dispatch(this.session({ type, login: this.toJSON() }))
  }

  get status() {
    return this._status
  }

  set status(value) {
    if (value === this._status) return
    this._status = value
    // `bots` is a mixin of the `satori` service, so a fiber that no longer injects it (teardown of a failed boot)
    // throws on `ctx.bots`; read the service without the inject requirement instead, which answers `undefined`.
    if (this.ctx.get('satori')?.bots.some(bot => bot.id === this.id)) {
      this.dispatchLoginEvent('login-updated')
    }
  }

  get isActive() {
    return this._status !== Status.OFFLINE && this._status !== Status.DISCONNECT
  }

  online() {
    this.status = Status.ONLINE
    this.error = undefined
  }

  offline(error?: unknown) {
    this.status = Status.OFFLINE
    this.error = error
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async start() {
    if (this.isActive) return
    this.status = Status.CONNECT
    try {
      await this.context.parallel('bot-connect', this)
      await this.connect()
    } catch (error) {
      this.offline(error)
    }
  }

  async stop() {
    if (!this.isActive) return
    this.status = Status.DISCONNECT
    try {
      await this.context.parallel('bot-disconnect', this)
      await this.disconnect()
    } catch (error) {
      this.ctx.logger.error(error)
    } finally {
      this.offline()
    }
  }

  session(event: Partial<SessionEvent> = {}): Session {
    return new Session(this, event)
  }

  /**
   * Await intake consumers before publishing ordinary observer events.
   * @param session - External event envelope.
   * @returns Resolves when every intake consumer has accepted the event; rejects on failed intake.
   */
  async receive(session: Session): Promise<void> {
    await this.context.parallel(session, 'satori/receive', session)
    this.dispatch(session)
  }

  dispatch(session: Session) {
    this.context.emit('internal/session', session)
    if (session.type === 'internal') {
      const internal = session.event.internal
      if (internal) (this.context.emit as any)(internal.type, internal.data, this)
      return
    }
    ;(this.context.emit as any)(session, session.type, session)
  }

  toJSON(): Login {
    return {
      sn: this.sn,
      id: this.id,
      platform: this.platform,
      adapter: this.adapterName,
      selfId: this.selfId,
      user: this.user && { ...this.user },
      status: this.status,
      hidden: this.hidden,
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Adapter surface helpers (the pipeline lives here; `Adapter` adds the platform hooks)

  /**
   * `this` seen as the adapter surface: the pipeline needs it, `Bot` alone does not have it.
   * Deliberately not named `adapter` — the QQ adapter assigns its gateway client to `bot.adapter`.
   */
  protected get adapterHooks(): Adapter<any, Record<string, Mode<any>>> {
    return this as unknown as Adapter<any, Record<string, Mode<any>>>
  }

  /** Clock of the pipeline (handle timestamps, fact TTLs, deletion windows); tests may override. */
  protected now(): number {
    return Date.now()
  }

  private modeOf(id: string): Mode<any> {
    const modes = this.adapterHooks.modes
    const mode = modes?.[id]
    if (!mode) {
      throw new PlatformError(
        'invalid',
        `${this.id}: unknown mode "${id}" (known: ${Object.keys(modes ?? {}).join(', ') || 'none'})`,
      )
    }
    return mode
  }

  private driverOf(mode: string, target: Target): StreamDriver<any> | undefined {
    try {
      return this.adapterHooks.streamDriver?.(mode, target)
    } catch (error) {
      this.ctx.logger.warn(`[${this.id}] streamDriver(${mode}) failed`, error)
      return undefined
    }
  }
}

/** The abort reason of a signal, as a rejection value (`AbortError`, like `fetch`). */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

export abstract class Adapter<C = unknown, M extends Record<string, Mode<any>> = Record<string, Mode<any>>> extends Bot<C> {
  abstract readonly modes: M
  /**
   * Every mode the adapter implements, most preferred first. Core resolves one mode per publication from the content
   * and never lets a caller name one, so this order is the only influence an adapter has on the choice — besides the
   * modes it declares at all: a configuration that drops a mode (QQ `markdown: false`) makes it uncandidatable.
   */
  abstract readonly modeOrder: readonly (keyof M & string)[]
  abstract upload(ref: ResourceRef, scope: string, ctx: PrepareContext): Promise<ResolvedResource>
  abstract resourceScope(target: Target, kind: ResourceKind): string
  abstract sendPayload(payload: unknown, target: Target, ctx: SendContext): Promise<SentPart>
  /** Whether a retry of `sendPayload` is deduplicated by the platform when the outcome of an earlier attempt is unknown. */
  idempotentSend?(target: Target, ctx: SendContext): boolean
  editPayload?(part: SentPart, payload: unknown, handle: MessageHandle, signal?: AbortSignal): Promise<void>
  deletePart?(part: SentPart, handle: MessageHandle): Promise<void>
  /** Stream driver per mode; undefined ⇒ core uses the `final` strategy. */
  streamDriver?(mode: string, target: Target): StreamDriver | undefined
  /** Map a platform error to the taxonomy. */
  abstract classify(error: unknown): PlatformError
}
