/** Passive per-Session streams; subscriptions never acquire Session observations. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { entryFor } from '../history.ts'
import type { SessionProjectionChange, SessionEventEntry } from '../types.ts'

/** Raw history notifications buffered before an opening cut is known. */
export type EventItem =
  | { readonly type: 'event'; readonly session: Session; readonly event: SessionEvent }
  | { readonly type: 'created'; readonly session: Session; readonly end: number }

/** A single subscription buffers before either consumption mode starts. */
export class EventListener implements Disposable {
  private readonly buffer: ListenerBuffer<SessionEventEntry> | undefined
  private readonly disposes: (() => void)[] = []
  private firstReceivedSeq: number | undefined
  private nextExpectedSeq: number | undefined

  /**
   * @param ctx - context owning the event registrations.
   * @param sessionId - Session whose notifications are emitted.
   * @param signal - cancellation that wakes consumers.
   * @param queue - optional caller-owned buffer; only an internally created buffer is disposed here.
   */
  constructor(ctx: Context, sessionId: SessionId, signal: AbortSignal,
    queue?: Pick<ListenerBuffer<SessionEventEntry>, 'createInput' | 'capture'>) {
    signal.throwIfAborted()
    const buffer = queue ?? new ListenerBuffer(ctx, signal)
    this.buffer = queue === undefined ? buffer as ListenerBuffer<SessionEventEntry> : undefined
    const input = buffer.createInput<EventItem>(item => this.transform(item))
    const target = sessionId
    try {
      this.disposes.push(ctx.on('session/event', (session, event) => {
        if (session.id !== target) return
        buffer.capture(() => {
          this.recordFirst(event.seq)
          input.append({ type: 'event', session, event })
        })
      }, { global: true }))
      this.disposes.push(ctx.on('session/created', (session) => {
        if (session.id !== target) return
        buffer.capture(() => {
          if (session.firstLiveSeq < session.seq) this.recordFirst(session.firstLiveSeq)
          input.prepend({ type: 'created', session, end: session.seq })
        })
      }, { global: true }))
      this.buffer?.own(() => { this[Symbol.dispose]() })
    } catch (error: unknown) {
      this[Symbol.dispose]()
      throw error
    }
  }

  /** Consume notifications without reading history.
   * @returns event frames from the first received event, without loading a baseline. */
  events(): AsyncIterable<SessionEventEntry> {
    return this.iterate()
  }

  /** Set the inclusive opening cut for buffered history notifications.
   * @param cursor - snapshot cut set before consuming the queue. */
  setCursor(cursor: number): void {
    this.nextExpectedSeq = cursor + 1
  }

  private *transform(item: EventItem): Iterable<SessionEventEntry> {
    if (this.disposes.length === 0) return
    this.nextExpectedSeq ??= this.firstReceivedSeq
    const result = eventItem(item, this.nextExpectedSeq)
    this.nextExpectedSeq = result.next
    for (const event of result.events) {
      if (this.disposes.length === 0) return
      yield entryFor(event)
    }
  }

  private async *iterate(): AsyncIterable<SessionEventEntry> {
    if (this.buffer === undefined) throw new Error('Consume the externally owned history buffer directly')
    try {
      yield* this.buffer.items()
    } finally {
      this[Symbol.dispose]()
    }
  }

  private recordFirst(seq: number): void {
    this.firstReceivedSeq = this.firstReceivedSeq === undefined ? seq : Math.min(this.firstReceivedSeq, seq)
  }

  [Symbol.dispose](): void {
    for (const dispose of this.disposes.splice(0).reverse()) dispose()
    this.buffer?.[Symbol.dispose]()
  }
}

/**
 * Select the uncovered events represented by one notification.
 * @param item - one buffered notification.
 * @param next - next required seq, or undefined before the first event.
 * @returns uncovered events and the next required seq without acquiring an observation.
 */
export function eventItem(item: EventItem, next?: number): {
  events: readonly SessionEvent[]
  next: number | undefined
} {
  if (item.type === 'event') {
    if (next !== undefined && item.event.seq < next) return { events: [], next }
    if (next !== undefined && item.event.seq !== next) {
      throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(next)}`, {})
    }
    return { events: [item.event], next: item.event.seq + 1 }
  }
  const start = next ?? item.session.firstLiveSeq
  if (start >= item.end) return { events: [], next }
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session-created history adaptation.
  const events = item.session.snapshotEvents(SessionLogOffset(start), SessionLogOffset(item.end))
  for (const event of events) {
    if (next !== undefined && event.seq !== next) {
      throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(next)}`, {})
    }
    next = event.seq + 1
  }
  return { events, next }
}

/** Sparse projection changes retain every key, including keys sharing a seq. */
export class ProjectionListener implements Disposable {
  private readonly buffer: ListenerBuffer<{ session: Session; change: SessionProjectionChange }>

  /**
   * @param ctx - context owning projection notifications.
   * @param sessionId - Session whose notifications are emitted.
   * @param signal - cancellation that removes registrations and wakes consumers.
   */
  constructor(ctx: Context, sessionId: SessionId, signal: AbortSignal) {
    this.buffer = new ListenerBuffer(ctx, signal)
    const input = this.buffer.createInput<{ session: Session; change: SessionProjectionChange }>(item => [item])
    const target = sessionId
    try {
      this.buffer.own(ctx.sessionProjections.onChanged((session, key, value, seq) => {
        if (session.id !== target) return
        this.buffer.capture(() => {
          input.append({
            session, change: { type: 'projection', key, value: value as JsonValue, seq } satisfies SessionProjectionChange,
          })
        })
      }))
    } catch (error: unknown) {
      this.buffer[Symbol.dispose]()
      throw error
    }
  }

  /** Consume sparse per-key projection replacements.
   * @returns validated replacement frames; projection seqs need not be contiguous. */
  async *changes(): AsyncIterable<SessionProjectionChange> {
    try {
      for await (const { change } of this.buffer.items()) {
        yield change
      }
    } finally {
      this[Symbol.dispose]()
    }
  }

  [Symbol.dispose](): void {
    this.buffer[Symbol.dispose]()
  }
}

/** Owns buffering, callback failure and registration cleanup for one consumer. */
export class ListenerBuffer<T> implements Disposable {
  private readonly values = new Deque<unknown>()
  private readonly transformIds = new Deque<number>()
  private readonly transforms: ((value: unknown) => Iterable<T>)[] = []
  private readonly cleanup: (() => void)[] = []
  private wake: (() => void) | undefined
  private closed = false
  private failure: { readonly error: unknown } | undefined
  private consumed = false

  constructor(ctx: Context, signal: AbortSignal) {
    signal.throwIfAborted()
    const close = (): void => { this[Symbol.dispose]() }
    signal.addEventListener('abort', close, { once: true })
    this.own(() => { signal.removeEventListener('abort', close) })
    try {
      const dispose = ctx.effect(() => close, 'session-controller.listener-buffer')
      this.own(() => { void dispose() })
    } catch (error: unknown) {
      this[Symbol.dispose]()
      throw error
    }
  }

  /**
   * Register cleanup, or run it immediately when already closed.
   * @param dispose - synchronous cleanup.
   */
  own(dispose: () => void): void {
    if (this.closed) dispose()
    else this.cleanup.push(dispose)
  }

  /**
   * Contain producer failure and wake the consumer with that failure.
   * @param action - synchronous producer operation.
   */
  capture(action: () => void): void {
    if (this.closed) return
    try {
      action()
    } catch (error: unknown) {
      this.failure = { error }
      this[Symbol.dispose]()
    }
  }

  /**
   * Register a dequeue transform and obtain its write-only input.
   * @param transform - conversion bound once and evaluated when each input is dequeued.
   * @returns a write-only input sharing this buffer's storage and lifetime.
   * @throws when this buffer is already closed.
   */
  createInput<Input>(transform: (item: Input) => Iterable<T>): { append(item: Input): void; prepend(item: Input): void } {
    if (this.closed) throw new Error('Cannot register a transform on a closed listener buffer')
    const transformId = this.transforms.length
    // Only this typed input can enqueue values with its private transform id.
    this.transforms.push(value => transform(value as Input))
    return {
      append: (item) => {
        if (this.closed) return
        this.values.pushBack(item)
        this.transformIds.pushBack(transformId)
        this.notify()
      },
      prepend: (item) => {
        if (this.closed) return
        this.values.pushFront(item)
        this.transformIds.pushFront(transformId)
        this.notify()
      },
    }
  }

  /**
   * Consume queued values once, releasing the buffer when iteration ends.
   * @returns transformed output values.
   */
  async *items(): AsyncIterable<T> {
    if (this.consumed) throw new RemoteError('gateway/internal', 'Session listener already has a consumer', {})
    this.consumed = true
    try {
      for (;;) {
        if (this.failure !== undefined) throw this.failure.error
        if (this.closed) return
        if (this.transformIds.size === 0) {
          await new Promise<void>((resolve) => { this.wake = resolve })
          continue
        }
        const transformId = this.transformIds.popFront() as number
        const value = this.values.popFront()
        for (const item of (this.transforms[transformId] as (value: unknown) => Iterable<T>)(value)) {
          this.throwIfFailed()
          if (this.isClosed()) return
          yield item
        }
      }
    } finally {
      this[Symbol.dispose]()
    }
  }

  private throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure.error
  }

  /** @returns whether disposal ended this buffer while a transform was yielding. */
  private isClosed(): boolean {
    return this.closed
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  [Symbol.dispose](): void {
    if (this.closed) return
    this.closed = true
    this.values.clear()
    this.transformIds.clear()
    this.transforms.length = 0
    this.notify()
    for (const dispose of this.cleanup.splice(0).reverse()) dispose()
  }
}
