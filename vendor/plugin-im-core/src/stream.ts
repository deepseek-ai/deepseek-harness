/**
 * Streaming: full-state updates, coalesced and throttled by a core scheduler, applied by the adapter's per-mode
 * `StreamDriver` (`patch` | `edit` | `append`) or by the built-in `final` strategy.
 *
 * `Bot.stream` builds a `StreamHost` from the bot pipeline and calls `createMessageStream`.
 *
 * Driver contract (what the scheduler guarantees and expects):
 * - At most one driver call is in flight per stream; calls are strictly ordered `open → tick* → close`.
 * - A failed call may be repeated (retry with backoff for `retryable` / `rate-limit`). Drivers that number their
 *   requests (CardKit `sequence`) must take a fresh number for **every** request, also on a retry
 *   ({@link nextSequence}); a number is never reused after an error.
 * - `tick` receives `patches` only for strategies with a `mode.diff` (`patch`, `append`) when the diff is
 *   incremental. `patches === undefined` means "publish the whole state from `payload`" (diff said `replace`, the
 *   mode has no diff, or the previous tick failed and the platform state is uncertain).
 * - `close` always receives the full final state; it must also end platform streaming (CardKit `streaming_mode`
 *   off, QQ `input_state` 10) even when the content did not change.
 * - Every state renders with `RenderContext.stream` set (`{ strategy, final }`), so an element whose rendering
 *   changes as it grows can keep an `append` stream's published prefix intact; an intermediate state that renders no
 *   message at all is skipped.
 * - A driver signals "this platform message cannot take this state" by throwing {@link StreamLimitError}
 *   (`shape`: append-only got a non-prefix change; `budget`: edits/window exhausted; `size`: too large). The
 *   scheduler then stops intermediate publication and resolves the stream at close by recalling and resending. A
 *   classified `PlatformError` of kind `limit` is treated like a `budget` violation.
 * - `budget()` is consulted before every intermediate tick: one update is always reserved for `close`, and the
 *   interval is stretched so the remaining updates last.
 * - The driver owns `handle.parts`, `handle.edits` and `handle.state`; the scheduler sets `handle.content` to the
 *   published state after every successful publication.
 */

import type { Element, Fragment } from '@deepseek-ai/satori-element'
import type { Bot, MessageHandle, SendContext, SendOptions, SendResult, SentPart } from './bot.ts'
import { type LimitViolation, PlatformError, StreamLimitError } from './errors.ts'
import type { RenderReport } from './fallback.ts'
import type { InteractionAction, Mode, ModeTypes, TransformResult } from './mode.ts'
import type { Target } from './protocol.ts'
import type { Prepared } from './resource.ts'

export type StreamStrategy = 'patch' | 'edit' | 'append' | 'final'

/**
 * What the render of one stream state knows about the stream (`RenderContext.stream`).
 *
 * `final: false` marks an intermediate state. Under `append` the platform message keeps every character it was
 * sent, so an element whose rendering may still change as its content grows (`<markdown>`: an unclosed `**`, fence or
 * table re-parses once it closes) renders only the part a later state keeps.
 */
export interface StreamPhase {
  readonly strategy: StreamStrategy
  readonly final: boolean
}

export interface StreamOptions extends SendOptions {
  /** Minimum interval between platform updates; default max(limit.stream.interval, 300 ms). */
  intervalMs?: number
  /** Give up publishing intermediate states after this long (final still sent). */
  maxDurationMs?: number
  /** Delay of the first publication; default 0 for `patch` / `append`, 800 ms for `edit`. */
  firstDelayMs?: number
  /** Attempts per tick for `retryable` / `rate-limit` errors; default 3. */
  attempts?: number
}

export interface MessageStream {
  /** Replace the whole content with the latest state. Cheap; coalesced; never throws. */
  update(content: Fragment): void
  /** Publish the final state (or the last update), finish platform streaming, resolve the handle. */
  close(final?: Fragment): Promise<SendResult>
  /**
   * Stop without publishing a final state; with `recall`, the message is deleted when the platform still allows it.
   *
   * @param options - `recall` deletes the published message, `reason` labels the abort.
   * @returns whether a published message was recalled, i.e. whether it is gone from the chat.
   */
  abort(options?: { recall?: boolean; reason?: string }): Promise<boolean>
  readonly state: 'idle' | 'open' | 'closing' | 'closed' | 'failed'
  /** After the first platform message exists, until a confirmed recall clears it back to `undefined`. */
  readonly handle: MessageHandle | undefined
  readonly strategy: StreamStrategy
  /** Rejects with StreamLimitError / PlatformError when the stream failed; resolves on close. */
  readonly done: Promise<SendResult>
}

export interface StreamTickContext {
  readonly target: Target
  readonly mode: string
  readonly options: StreamOptions
  /** Reply target from `<quote>` of the current state. */
  readonly quote?: string
  readonly signal: AbortSignal
  readonly report: RenderReport
  /** The normalized state being published (drivers put it into the handle they create in `open`). */
  readonly content: Element<'message'>
  /** 1-based attempt of this call (> 1 on a retry). */
  readonly attempt: number
}

export interface StreamDriver<T extends ModeTypes = ModeTypes> {
  readonly strategy: 'patch' | 'edit' | 'append'
  /** First publication; returns the handle (creates CardKit entity + sends; or sends the first message). */
  open(first: Prepared<T['draft']>, payload: T['payload'], ctx: StreamTickContext): Promise<MessageHandle>
  /** Apply one coalesced change. `patches` present for strategy 'patch', payload for 'edit'/'append'. */
  tick(handle: MessageHandle, change: { draft: Prepared<T['draft']>; payload: T['payload']; patches?: T['patch'][] }, ctx: StreamTickContext): Promise<void>
  /** Finish platform streaming (CardKit streaming_mode false, QQ input_state 10). */
  close(handle: MessageHandle, last: { draft: Prepared<T['draft']>; payload: T['payload'] }, ctx: StreamTickContext): Promise<void>
  /** Remaining budget (edits, time window); core stretches intervals or triggers recall-and-resend from it. */
  budget(handle: MessageHandle): { updatesLeft?: number; until?: number }
}

/** One fully rendered state of the stream content. */
export interface StreamFrame<T extends ModeTypes = ModeTypes> {
  content: Element<'message'>
  result: TransformResult<T['draft']>
  prepared: Prepared<T['draft']>[]
  payloads: T['payload'][]
}

/** What the scheduler needs from the bot pipeline (provided by `Bot.stream`). */
export interface StreamHost<T extends ModeTypes = ModeTypes> {
  readonly bot: Bot
  readonly target: Target
  readonly mode: Mode<T>
  /** `undefined` ⇒ built-in `final` strategy. */
  readonly driver: StreamDriver<T> | undefined
  /**
   * normalize → transform → prepare (cached) → serialize of the full state. May reject.
   *
   * @param content - the state.
   * @param signal - aborts the render.
   * @param final - the state is the one `close` publishes; the render sees it as `RenderContext.stream.final`.
   * @returns the frame; `undefined` for an intermediate state that renders nothing yet.
   */
  render(content: Fragment, signal: AbortSignal, final: boolean): Promise<StreamFrame<T> | undefined>
  /** Plain `bot.send` (final strategy, recall + resend). */
  send(content: Fragment, options: SendOptions): Promise<SendResult>
  /** Recall a published message; resolves `false` when `message.delete` is not supported for it now. */
  recall(handle: MessageHandle): Promise<boolean>
  /** Register the `onClick` actions of a published state. */
  register(actions: TransformResult<unknown>['actions']): void
  classify(error: unknown): PlatformError
  /** Whether a single-part `open` send with `ctx` carries platform deduplication (safe to retry on `published: 'unknown'`). */
  idempotentSend?(ctx: SendContext): boolean
  now(): number
}

/** `done` of an aborted stream rejects with this error (`name === 'AbortError'`). */
export class StreamAbortError extends Error {
  override name = 'AbortError'
  constructor(readonly reason?: string, readonly recalled = false) {
    super(reason ? `stream aborted: ${reason}` : 'stream aborted')
  }
}

/** Default minimum interval between platform updates. */
export const STREAM_INTERVAL_MS = 300
/** Default first-publication delay of the `edit` strategy. */
export const STREAM_EDIT_FIRST_DELAY_MS = 800
/** Maximum time best-effort `driver.close` may take after `abort({ recall: false })`. */
export const STREAM_ABORT_CLOSE_TIMEOUT_MS = 5000
/** Retry backoff: base, factor 2, cap. */
export const STREAM_BACKOFF_BASE_MS = 500
export const STREAM_BACKOFF_MAX_MS = 8_000
export const STREAM_ATTEMPTS = 3

/** Backoff before retry number `attempt` (1-based count of failed attempts so far); honours `retryAfterMs`. */
export function streamBackoff(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return retryAfterMs
  return Math.min(STREAM_BACKOFF_BASE_MS * 2 ** (attempt - 1), STREAM_BACKOFF_MAX_MS)
}

/**
 * Strictly increasing request numbers for drivers (CardKit `sequence`): bumps the counter before every request,
 * so a number is never reused, not even after a failed request.
 */
export function nextSequence(state: { sequence: number }): number {
  return ++state.sequence
}

/** The stream scheduler over a host. Timers are plain `setTimeout` (fake-timer friendly). */
export function createMessageStream<T extends ModeTypes>(host: StreamHost<T>, options: StreamOptions = {}): MessageStream {
  return new Scheduler(host, options)
}

// ---------------------------------------------------------------------------------------------------------------
// Generic `edit` driver (whole-message resend platforms: transform → prepare (upsert) → serialize → edit)

/** The adapter surface the generic edit driver needs (structurally an `Adapter` with `editPayload`). */
export interface EditDriverAdapter {
  readonly id: string
  sendPayload(payload: unknown, target: Target, ctx: SendContext): Promise<SentPart>
  editPayload(part: SentPart, payload: unknown, handle: MessageHandle, signal?: AbortSignal): Promise<void>
}

export interface EditDriverOptions {
  /** Edits one message accepts (`limit.update.count`, Lark post: 20); `undefined` ⇒ unbounded. */
  limit?: number
  /** Adapter-private `handle.state` for the freshly sent part (e.g. Lark `{ kind: 'post' }`). */
  state?(part: SentPart, payload: unknown): unknown
  now?(): number
}

/**
 * `edit` strategy for platforms that can only replace a whole message (Lark post `PUT /messages/:id`): the first
 * state is sent with `sendPayload`, later states with `editPayload` on the same part. Counts `handle.edits`
 * (before each request: a failed edit may still have consumed platform budget) and reports
 * `updatesLeft = limit - edits`; the scheduler keeps one for `close`. `close` skips the request when the final
 * payload equals the last published one.
 */
export function createEditDriver<T extends ModeTypes = ModeTypes>(adapter: EditDriverAdapter, options: EditDriverOptions = {}): StreamDriver<T> {
  const published = new WeakMap<MessageHandle, string | undefined>()
  const edit = async (handle: MessageHandle, payload: unknown, signal?: AbortSignal) => {
    const part = handle.parts[0]
    if (!part) throw new PlatformError('invalid', 'edit stream: handle has no part')
    handle.edits += 1
    try {
      await adapter.editPayload(part, payload, handle, signal)
    } catch (error) {
      // The platform may have applied the edit before the error (or left the message in an unknown state):
      // drop the cached last-published key so `close` does not skip writing back an earlier payload.
      published.delete(handle)
      throw error
    }
    published.set(handle, payloadKey(payload))
  }
  return {
    strategy: 'edit',
    async open(_first, payload, ctx) {
      const part = await adapter.sendPayload(payload, ctx.target, { index: 0, ...ctx.quote === undefined ? {} : { quote: ctx.quote }, options: ctx.options, previous: [] })
      const handle: MessageHandle = {
        bot: adapter.id,
        target: ctx.target,
        mode: ctx.mode,
        parts: [part],
        createdAt: options.now?.() ?? Date.now(),
        edits: 0,
        content: ctx.content,
        state: options.state?.(part, payload),
      }
      published.set(handle, payloadKey(payload))
      return handle
    },
    async tick(handle, change, ctx) {
      await edit(handle, change.payload, ctx.signal)
    },
    async close(handle, last, ctx) {
      const key = payloadKey(last.payload)
      if (key !== undefined && key === published.get(handle)) return
      await edit(handle, last.payload, ctx.signal)
    },
    budget(handle) {
      if (options.limit === undefined) return {}
      return { updatesLeft: Math.max(0, options.limit - handle.edits) }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scheduler

type State = MessageStream['state']

interface Applied<T extends ModeTypes> {
  draft: Prepared<T['draft']>
  payload: T['payload']
  key: string | undefined
}

/** A retry sleep was cut short by close/abort; the intermediate tick is dropped. */
class Interrupted extends Error {}

/** Rejected intermediate ticks, in a row, after which intermediate publication stops (close still publishes). */
const TICK_FAILURES_BEFORE_PAUSE = 3

/** Stable identity of a serialized payload (no-op detection); `undefined` when not serializable. */
function payloadKey(payload: unknown): string | undefined {
  try {
    return JSON.stringify(payload)
  } catch {
    return undefined
  }
}

class Scheduler<T extends ModeTypes> implements MessageStream {
  readonly strategy: StreamStrategy
  readonly done: Promise<SendResult>

  private _state: State = 'idle'
  private _handle: MessageHandle | undefined
  private resolveDone!: (result: SendResult) => void
  private rejectDone!: (error: unknown) => void
  private settled = false
  private aborted = false

  private readonly driver: StreamDriver<T> | undefined
  private readonly interval: number
  private readonly firstDelay: number
  private readonly attempts: number
  private readonly startedAt: number
  private readonly controller = new AbortController()
  private readonly sendOptions: SendOptions

  /** Latest content from `update` / `close(final)` and its version; `rendered` = version taken by the last tick. */
  private latest: Fragment | undefined
  private version = 0
  private rendered = 0
  private firstUpdateAt = 0

  /** What the platform message shows (last successful publication). */
  private applied: Applied<T> | undefined
  /** The last publication attempt failed: the platform state is unknown, so the next tick publishes the whole state. */
  private uncertain = false
  /** Intermediate publication stopped (budget, shape, limit, non-retryable error); close still publishes. */
  private paused: string | undefined
  /** Rejected intermediate ticks in a row; a single one is repaired by the next full publication. */
  private failedTicks = 0
  /** Sticky violation that the final publication must resolve by recall-and-resend. */
  private violation: LimitViolation | undefined

  private timer: ReturnType<typeof setTimeout> | undefined
  private inflight: Promise<void> | undefined
  private lastFinish = 0
  private closing: Promise<void> | undefined
  private readonly sleepers = new Set<{ wake: () => void; interruptible: boolean }>()
  private readonly registered = new Map<string, InteractionAction['callback']>()
  private readonly callerSignal: AbortSignal | undefined
  private readonly onCallerAbort: (() => void) | undefined

  constructor(private readonly host: StreamHost<T>, private readonly options: StreamOptions) {
    this.driver = host.driver
    this.strategy = host.driver?.strategy ?? 'final'
    const platformInterval = host.mode.limits?.['limit.stream.interval'] ?? 0
    this.interval = Math.max(options.intervalMs ?? STREAM_INTERVAL_MS, platformInterval)
    this.firstDelay = options.firstDelayMs ?? (this.strategy === 'edit' ? STREAM_EDIT_FIRST_DELAY_MS : 0)
    this.attempts = Math.max(1, options.attempts ?? STREAM_ATTEMPTS)
    this.startedAt = host.now()
    const { intervalMs: _i, maxDurationMs: _m, firstDelayMs: _f, attempts: _a, signal, ...send } = options
    this.sendOptions = { ...send, signal: this.controller.signal }
    this.done = new Promise<SendResult>((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })
    // `done` is informational; an unobserved failure must not become an unhandled rejection.
    this.done.catch(() => {})
    if (signal) {
      if (signal.aborted) {
        void this.abort({ reason: 'signal' })
      } else {
        this.callerSignal = signal
        this.onCallerAbort = () => void this.abort({ reason: 'signal' })
        signal.addEventListener('abort', this.onCallerAbort, { once: true })
      }
    }
  }

  get state(): State {
    return this._state
  }

  get handle(): MessageHandle | undefined {
    return this._handle
  }

  // -- public API --------------------------------------------------------------------------------------------

  update(content: Fragment): void {
    try {
      if (this._state !== 'idle' && this._state !== 'open') return
      this.latest = content
      this.version += 1
      if (this._state === 'idle') {
        this._state = 'open'
        this.firstUpdateAt = this.host.now()
      }
      this.schedule()
    } catch {
      // never throws
    }
  }

  close(final?: Fragment): Promise<SendResult> {
    if (this._state === 'closing' || this._state === 'closed' || this._state === 'failed') return this.done
    if (final !== undefined) {
      this.latest = final
      this.version += 1
    }
    this._state = 'closing'
    this.clearTimer()
    this.wake(true)
    this.closing = this.finish().then(
      result => {
        if (!result || this.aborted || this.settled) return
        this.settled = true
        this.unlisten()
        this._state = 'closed'
        this.resolveDone(result)
      },
      error => this.fail(error),
    )
    return this.done
  }

  async abort(options: { recall?: boolean; reason?: string } = {}): Promise<boolean> {
    if (this.aborted || this.settled) return false
    this.aborted = true
    this.unlisten()
    this._state = 'closing'
    this.clearTimer()
    this.wake(false)
    this.controller.abort(new StreamAbortError(options.reason))
    await this.inflight?.catch(() => {})
    await this.closing?.catch(() => {})
    let recalled = false
    const handle = this._handle
    if (handle) {
      if (options.recall) {
        recalled = await this.recall(handle)
      } else if (this.driver && this.applied && handle.parts.length && !this.resent) {
        // End platform streaming on what is shown (CardKit streaming_mode off, QQ input_state 10); best effort, bounded.
        const signal = AbortSignal.timeout(STREAM_ABORT_CLOSE_TIMEOUT_MS)
        await this.driver.close(handle, this.applied, this.context(handle.content, this.lastQuote, this.lastReport!, 1, signal)).catch(() => {})
      }
    }
    this.settled = true
    this._state = 'closed'
    this.rejectDone(new StreamAbortError(options.reason, recalled))
    return recalled
  }

  // -- scheduling ---------------------------------------------------------------------------------------------

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Arm the next intermediate tick if there is unpublished content and publication is allowed. */
  private schedule() {
    if (!this.driver || this._state !== 'open') return
    if (this.timer !== undefined || this.inflight) return
    if (this.version === this.rendered) return
    const now = this.host.now()
    if (!this.publishable(now)) return
    const at = this._handle ? this.lastFinish + this.currentInterval(now) : this.firstUpdateAt + this.firstDelay
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.run()
    }, Math.max(0, at - now))
  }

  private run() {
    const task = this.tick().catch(error => this.fail(error))
    const tracked = task.finally(() => {
      if (this.inflight === tracked) this.inflight = undefined
      this.lastFinish = this.host.now()
      this.schedule()
    })
    this.inflight = tracked
  }

  /** May an intermediate state be published now? (Budget keeps one update for close.) */
  private publishable(now: number): boolean {
    if (this.paused !== undefined) return false
    if (this.options.maxDurationMs !== undefined && now - this.startedAt >= this.options.maxDurationMs) return false
    const handle = this._handle
    if (!handle || !this.driver) return true
    const budget = this.driver.budget(handle)
    if (budget.updatesLeft !== undefined && budget.updatesLeft <= 1) return false
    if (budget.until !== undefined && now >= budget.until) return false
    return true
  }

  /**
   * Interval before the next tick: at least `interval`; with a counted budget, stretched so the usable updates
   * (one is reserved for close) last until the horizon — `maxDurationMs` / the budget window when known, else
   * "as long again as the stream has run so far".
   */
  private currentInterval(now: number): number {
    const handle = this._handle
    if (!handle || !this.driver) return this.interval
    const budget = this.driver.budget(handle)
    if (budget.updatesLeft === undefined) return this.interval
    const usable = budget.updatesLeft - 1
    if (usable < 1) return this.interval
    let horizon = Infinity
    if (this.options.maxDurationMs !== undefined) horizon = this.startedAt + this.options.maxDurationMs
    if (budget.until !== undefined) horizon = Math.min(horizon, budget.until)
    const span = horizon === Infinity ? now - this.startedAt : horizon - now
    return Math.max(this.interval, span / usable)
  }

  // -- ticks --------------------------------------------------------------------------------------------------

  private async tick(): Promise<void> {
    const driver = this.driver!
    const content = this.latest
    this.rendered = this.version
    if (content === undefined || this._state !== 'open') return

    let frame: StreamFrame<T> | undefined
    try {
      frame = await this.retry(() => this.host.render(content, this.controller.signal, false), true)
    } catch (error: unknown) {
      // An intermediate state that cannot render is dropped (close renders again and reports), but dropping it in
      // silence hides a content or deployment fault for the whole turn.
      try {
        this.host.bot.ctx?.logger?.warn?.('IM stream %s could not render an intermediate state: %s', this.strategy,
          error instanceof Error ? error.message : String(error))
      } catch {
        // Diagnostics never break a stream.
      }
      return
    }
    // Nothing of this state renders yet (e.g. markdown whose first block is still being written).
    if (frame === undefined || this._state !== 'open') return
    const violation = this.frameViolation(frame)
    if (violation) {
      this.warn('IM stream debug %s: frame violation %s (%s)',
        this.strategy, violation.violation.kind, violation.violation.message)
      return
    }

    const draft = frame.prepared[0]!
    const payload = frame.payloads[0]!

    if (!this._handle) {
      let handle: MessageHandle
      try {
        handle = await this.retry(
          attempt => driver.open(draft, payload, this.context(frame.content, frame.result.quote, frame.result.report, attempt)),
          false,
          (attempt) => {
            const tickCtx = this.context(frame.content, frame.result.quote, frame.result.report, attempt)
            return this.host.idempotentSend?.({
              index: 0,
              ...tickCtx.quote === undefined ? {} : { quote: tickCtx.quote },
              options: tickCtx.options,
              previous: [],
            }) ?? false
          },
        )
      } catch (error) {
        if (this.isLimit(error) && !(PlatformError.is(error) && error.published === 'unknown')) {
          this.paused = 'open: ' + this.limitOf(error).message
          this.warn('could not open its message: %s', this.paused)
          return // nothing published; close sends the final state as a plain message
        }
        throw error // open failure fails the stream
      }
      this._handle = handle
      this.published(frame)
      return
    }

    const handle = this._handle
    if (!this.publishable(this.host.now())) return
    const change = this.change(frame)
    if (change === 'noop') return
    if (change === 'shape') {
      this.stop({ kind: 'shape', message: 'append-only stream got a non-prefix change' })
      return
    }
    try {
      await this.retry(attempt => driver.tick(handle, { draft, payload, ...change.patches ? { patches: change.patches } : {} }, this.context(frame.content, frame.result.quote, frame.result.report, attempt)), true)
      this.published(frame)
      this.failedTicks = 0
    } catch (error) {
      if (this.aborted) return
      if (this.isLimit(error)) {
        this.stop(this.limitOf(error))
        return
      }
      // The platform may have applied part of the rejected tick, so the next one republishes the whole state.
      this.uncertain = true
      if (error instanceof Interrupted) return
      const kind = this.classify(error).kind
      // One rejected intermediate state must not freeze the card for the rest of the turn: the next tick publishes the
      // whole document (`uncertain`), which also repairs a partially applied one. Only a run of failures means the
      // content cannot be streamed at all.
      this.failedTicks += 1
      this.warn('tick failed (%s, %d in a row): %s', kind, this.failedTicks,
        error instanceof Error ? error.message : String(error))
      if (this.failedTicks >= TICK_FAILURES_BEFORE_PAUSE) this.paused = `tick failed (${kind})`
    }
  }

  /** Incremental change of `frame` relative to what is shown: no-op, a shape violation, or the patches to send. */
  private change(frame: StreamFrame<T>): 'noop' | 'shape' | { patches?: T['patch'][] } {
    const applied = this.applied
    const payload = frame.payloads[0]
    const key = payloadKey(payload)
    if (!this.uncertain && applied && key !== undefined && key === applied.key) return 'noop'
    const diff = this.host.mode.diff
    if (this.strategy === 'edit' || !diff || !applied || this.uncertain) return {}
    let patches: T['patch'][] | 'replace'
    try {
      patches = diff.call(this.host.mode, applied.draft.draft, frame.prepared[0]!.draft)
    } catch {
      patches = 'replace'
    }
    if (patches === 'replace') return this.strategy === 'append' ? 'shape' : {}
    if (patches.length === 0) return 'noop'
    return { patches }
  }

  /** Is the shown state a truthful prefix of `frame` (append case)? */
  private prefixOf(frame: StreamFrame<T>): boolean {
    if (this.strategy !== 'append' || this.uncertain || !this.applied) return false
    const diff = this.host.mode.diff
    if (!diff) return true
    try {
      return diff.call(this.host.mode, this.applied.draft.draft, frame.prepared[0]!.draft) !== 'replace'
    } catch {
      return false
    }
  }

  private published(frame: StreamFrame<T>) {
    const handle = this._handle!
    const payload = frame.payloads[0]
    this.applied = { draft: frame.prepared[0]!, payload, key: payloadKey(payload) }
    this.uncertain = false
    this.lastQuote = frame.result.quote
    this.lastReport = frame.result.report
    handle.content = frame.content
    this.register(frame.result.actions)
  }

  private lastQuote: string | undefined
  private lastReport: RenderReport | undefined
  private resent = false

  private register(actions: TransformResult<unknown>['actions']) {
    const fresh = actions.filter(action => this.registered.get(action.id) !== action.callback)
    if (!fresh.length) return
    for (const action of fresh) this.registered.set(action.id, action.callback)
    try {
      this.host.register(fresh)
    } catch {
      // registration problems never break the stream
    }
  }

  private stop(violation: LimitViolation) {
    this.violation = violation
    this.paused = violation.kind + ': ' + violation.message
  }

  /**
   * Single-message constraint of a frame: a mode `check()` size violation (only fixed by smaller content), or a
   * state that needs more than one platform message (fixed by a plain multi-part send at close).
   */
  private frameViolation(frame: StreamFrame<T>): { violation: LimitViolation; resendable: boolean } | undefined {
    const check = this.host.mode.check
    if (check) {
      for (let index = 0; index < frame.prepared.length; index++) {
        let found: LimitViolation[]
        try {
          found = check.call(this.host.mode, frame.prepared[index]!.draft)
        } catch {
          found = []
        }
        if (found.length) return { violation: { part: index, ...found[0]! }, resendable: false }
      }
    }
    if (frame.prepared.length !== 1 || frame.payloads.length !== 1) {
      return {
        violation: {
          kind: 'size',
          key: 'limit.message.parts',
          limit: 1,
          actual: frame.prepared.length,
          message: `the state needs ${frame.prepared.length} platform messages; a stream publishes into one`,
        },
        resendable: frame.prepared.length > 1,
      }
    }
  }

  // -- close and recall-and-resend ---------------------------------------------------------------------------

  /** Resolves the final result, `undefined` when aborted meanwhile; rejects to fail the stream. */
  private async finish(): Promise<SendResult | undefined> {
    await this.inflight?.catch(() => {})
    if (this.aborted || this.settled) return
    const content = this.latest
    if (content === undefined) throw new Error('stream closed without content')
    const driver = this.driver
    const handle = this._handle
    if (!driver || !handle) return this.send(content) // `final` strategy, or nothing published yet

    const frame = await this.retry(() => this.host.render(content, this.controller.signal, true), false)
    if (this.aborted) return
    if (frame === undefined) throw new Error('stream host rendered no frame for the final state')
    const sized = this.frameViolation(frame)
    if (sized && !sized.resendable) return this.limitFail(sized.violation, true, frame.result.report)
    if (sized) return this.resend(frame, sized.violation)
    // A sticky size violation (driver: "too large") is retried with the final state, which may be smaller.
    if (this.violation && this.violation.kind !== 'size') return this.resend(frame, this.violation)

    const budget = driver.budget(handle)
    if (budget.updatesLeft !== undefined && budget.updatesLeft < 1) {
      return this.resend(frame, { kind: 'budget', key: 'limit.update.count', actual: handle.edits, message: 'no update left for the final state' })
    }
    // A closed streaming window is not a reason to abandon the message. What expires is the platform's *streaming*
    // mode, not the message: the driver's own `tick` keeps publishing full updates with streaming switched off once the
    // window has passed, and `close` publishes the same full update with streaming off. Closing in place therefore
    // stays available, and a fresh message would replace a card the reader is already watching. The window is kept
    // only as the reason to fall back to {@link resend} when the platform refuses that update.
    const windowClosed = budget.until !== undefined && this.host.now() >= budget.until
    if (this.strategy === 'append' && this.host.mode.diff && this.applied && !this.uncertain && !this.prefixOf(frame)) {
      return this.resend(frame, { kind: 'shape', message: 'the final state does not extend the streamed prefix' })
    }

    const draft = frame.prepared[0]!
    const payload = frame.payloads[0]!
    try {
      await this.retry(attempt => driver.close(handle, { draft, payload }, this.context(frame.content, frame.result.quote, frame.result.report, attempt)), false)
    } catch (error) {
      if (this.aborted) return
      if (this.isLimit(error)) {
        const violation = this.limitOf(error)
        return violation.kind === 'size' ? this.limitFail(violation, true, frame.result.report) : this.resend(frame, violation)
      }
      if (windowClosed) return this.resend(frame, { kind: 'budget', message: 'the streaming window has closed' })
      throw error
    }
    if (this.aborted) return
    this.published(frame)
    return { handle, report: frame.result.report }
  }

  /** Recall the streamed message and send the final state fresh; a platform that cannot recall gets a settled copy. */
  private async resend(frame: StreamFrame<T>, violation: LimitViolation): Promise<SendResult | undefined> {
    const handle = this._handle!
    const recalled = await this.recall(handle)
    if (this.aborted) return
    if (!recalled) {
      // The old message stays, so it has to stop generating. A platform that refuses to delete a streamed message (QQ
      // answers `DELETE` with `40061001`) would otherwise leave a bubble that never finishes: closing publishes the
      // state the reader already has, and the final state follows as a fresh message below.
      await this.settle(handle, this.lastReport ?? frame.result.report)
    }
    this.resent = true
    // A fresh message: the idempotency key of the streamed one would dedupe it into the recalled message.
    const key = this.sendOptions.idempotencyKey
    return this.send(frame.content, key === undefined ? undefined : `${key}:resend`)
  }

  /**
   * Finish the platform's stream on the state it already shows.
   *
   * Used where the streamed message cannot be recalled: the reader keeps the partial content, but the platform stops
   * the "generating" state instead of freezing on it. Best effort — a rejected close (a spent passive budget, a torn
   * connection) must not replace the failure that is being reported.
   *
   * @param handle - the streamed message.
   * @param report - render report of the state being kept.
   */
  private async settle(handle: MessageHandle, report: RenderReport): Promise<void> {
    const applied = this.applied
    const driver = this.driver
    if (!applied || !driver) return
    const ctx = this.context(handle.content, this.lastQuote, report, 1, this.controller.signal)
    await driver.close(handle, applied, ctx).catch(() => {})
  }

  /** Recall if possible, then fail with `StreamLimitError`; a message that cannot be recalled is settled first. */
  private async limitFail(violation: LimitViolation, recall: boolean, report: RenderReport): Promise<never> {
    const handle = this._handle
    if (recall && handle && !await this.recall(handle)) await this.settle(handle, report)
    throw new StreamLimitError(violation, handle)
  }

  private async send(content: Fragment, idempotencyKey?: string): Promise<SendResult | undefined> {
    const options = idempotencyKey === undefined ? this.sendOptions : { ...this.sendOptions, idempotencyKey }
    const result = await this.host.send(content, options)
    this._handle = result.handle
    if (this.aborted) return
    return result
  }

  private async recall(handle: MessageHandle): Promise<boolean> {
    try {
      const recalled = await this.host.recall(handle)
      if (recalled && this._handle === handle) this._handle = undefined
      return recalled
    } catch {
      return false
    }
  }

  /** Report one stream-side failure through the bot's logger; a fake host without one stays silent. */
  private warn(message: string, ...args: unknown[]): void {
    try {
      this.host.bot.ctx?.logger?.warn?.(`IM stream ${this.strategy}: ${message}`, ...args)
    } catch {
      // Diagnostics never break a stream.
    }
  }

  private unlisten() {
    if (this.onCallerAbort) this.callerSignal?.removeEventListener('abort', this.onCallerAbort)
  }

  private fail(error: unknown) {
    if (this.settled || this.aborted) return
    this.settled = true
    this.unlisten()
    this._state = 'failed'
    this.clearTimer()
    this.wake(false)
    this.rejectDone(error)
  }

  // -- retry ----------------------------------------------------------------------------------------------------

  private context(content: Element<'message'>, quote: string | undefined, report: RenderReport, attempt: number, signal = this.controller.signal): StreamTickContext {
    return { target: this.host.target, mode: this.host.mode.id, options: { ...this.options, signal }, ...quote === undefined ? {} : { quote }, signal, report, content, attempt }
  }

  private classify(error: unknown): PlatformError {
    if (PlatformError.is(error)) return error
    try {
      return this.host.classify(error)
    } catch {
      return new PlatformError('fatal', error instanceof Error ? error.message : String(error), { cause: error })
    }
  }

  private isLimit(error: unknown): boolean {
    return error instanceof StreamLimitError || (!(error instanceof Interrupted) && this.classify(error).kind === 'limit')
  }

  private limitOf(error: unknown): LimitViolation {
    if (error instanceof StreamLimitError) return error.violation
    return { kind: 'budget', message: this.classify(error).message }
  }

  /**
   * Run `op` with up to `attempts` tries for `retryable` / `rate-limit` errors (exponential backoff, honouring
   * `retryAfterMs`). Once any attempt fails with `published: 'unknown'` (`sawUnknown`), every subsequent retry
   * (including after backoff sleep, before the next attempt) requires `idempotent(attempt)` to hold — even if a later
   * attempt fails with `published: 'no'` — and any terminal failure preserves `published: 'unknown'`. `StreamLimitError`
   * passes through untouched only when `sawUnknown` is false; otherwise it is converted to a `fatal` `PlatformError`
   * with `published: 'unknown'` so `tick()`'s open branch does not fall back to plain `host.send()`. An interruptible
   * retry (intermediate ticks) is cut short by close/abort with `Interrupted`.
   */
  private async retry<R>(
    op: (attempt: number) => Promise<R>,
    interruptible: boolean,
    idempotent: boolean | ((attempt: number) => boolean) = true,
  ): Promise<R> {
    let sawUnknown = false
    const isIdempotent = (attempt: number) => typeof idempotent === 'function' ? idempotent(attempt) : idempotent
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
        return await op(attempt)
      } catch (error) {
        if (error instanceof StreamLimitError) {
          if (sawUnknown) throw new PlatformError('fatal', error.message, { cause: error, published: 'unknown' })
          throw error
        }
        if (this.aborted) throw error
        const classified = this.classify(error)
        if (classified.published === 'unknown') sawUnknown = true
        const safe = (!sawUnknown && classified.published === 'no') || isIdempotent(attempt)
        const again = (classified.kind === 'retryable' || classified.kind === 'rate-limit') && safe && attempt < this.attempts
        if (!again) throw preserveUnknown(classified)
        if (!await this.sleep(streamBackoff(attempt, classified.retryAfterMs), interruptible)) throw new Interrupted(classified.message)
        if ((sawUnknown || classified.published !== 'no') && !isIdempotent(attempt + 1)) {
          throw preserveUnknown(classified)
        }
      }
    }
  }

  /** Resolves `true` after `ms`, `false` when woken early (abort; close for interruptible sleeps). */
  private sleep(ms: number, interruptible: boolean): Promise<boolean> {
    if (this.aborted || (interruptible && this._state !== 'open')) return Promise.resolve(false)
    return new Promise((resolve) => {
      const sleeper = {
        interruptible,
        wake: () => {
          clearTimeout(timer)
          this.sleepers.delete(sleeper)
          resolve(false)
        },
      }
      const timer = setTimeout(() => {
        this.sleepers.delete(sleeper)
        resolve(true)
      }, ms)
      this.sleepers.add(sleeper)
    })
  }

  /** Wake sleeping retries: interruptible ones only (close), or all (abort / failure). */
  private wake(interruptibleOnly: boolean) {
    for (const sleeper of [...this.sleepers]) {
      if (!interruptibleOnly || sleeper.interruptible) sleeper.wake()
    }
  }
}
