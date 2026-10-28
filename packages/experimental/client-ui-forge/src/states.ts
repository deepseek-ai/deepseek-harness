/**
 * The last known state of every change request that a listed Session binds,
 * for the Session list. One run starts with the first stream and stops with
 * the last: it reads the stored states, lists the Sessions with their
 * bindings, follows binding changes of loaded Sessions, and polls each bound
 * change request, once however many Sessions bind it. The forge service
 * owns polling cadence and terminal-state refresh. Every state change is stored, so a restart shows it before the
 * first poll.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { ChangeRequestListener, ChangeRequestRef, ChangeRequestSnapshot } from '@deepseek-ai/dsh-experimental-forge/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ForgeChangeRequestListState, ForgeChangeRequestStatesFrame } from './types.ts'

const stateSchema: z.ZodType<ForgeChangeRequestListState> = z.object({
  url: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'merged', 'closed']),
  draft: z.boolean(),
  checksRollup: z.enum(['none', 'pending', 'success', 'failure']),
  reviewDecision: z.enum(['none', 'review-required', 'approved', 'changes-requested']),
  mergeability: z.enum(['mergeable', 'conflicting', 'unknown']),
}).strict()

/** Stored states keyed by {@link storedKey}; derived data, so a record that fails its schema is set aside. */
export const changeRequestStatesDomain = defineDomain({
  name: 'forge_panel_change_requests',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { states: { valueSchema: stateSchema } },
})

/**
 * The storage key of a change request's state: a path-safe digest of its URL.
 * @param url - the change request's web URL.
 * @returns the key.
 */
export function storedKey(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

/** The stored states the run reads and writes. */
export interface StoredStates {
  /** The state stored under a key. */
  get(key: string): ForgeChangeRequestListState | undefined
  /** Every stored state. */
  entries(): IterableIterator<[string, ForgeChangeRequestListState]>
  /** Store a state durably. */
  put(key: string, value: ForgeChangeRequestListState): Promise<void>
  /** Remove a stored state durably. */
  delete(key: string): Promise<boolean>
}

/** One listed Session and the URLs of its visible bindings, undefined when they are not known without loading it. */
export interface ListedSession {
  readonly id: SessionId
  readonly urls: readonly string[] | undefined
}

/** What a run reads, follows, and polls. */
export interface ChangeRequestStateSources {
  /** List every Session with its visible bindings. */
  readonly sessions: (signal: AbortSignal) => Promise<readonly ListedSession[]>
  /** Follow the visible bindings of loaded Sessions; returns the disposer. */
  readonly onBindings: (listener: (id: SessionId, urls: readonly string[]) => void) => () => void
  /** The change request a URL names, or undefined when no provider recognizes it. */
  readonly refOf: (url: string) => ChangeRequestRef | undefined
  /** Poll a change request until the returned disposer runs. */
  readonly watch: (ref: ChangeRequestRef, listener: ChangeRequestListener) => () => void
  /** Open the stored states. */
  readonly open: () => Promise<StoredStates>
  /** Report a failed durable write; the state stays in memory. */
  readonly report: (error: unknown) => void
}

function listStateOf(snapshot: ChangeRequestSnapshot, url: string): ForgeChangeRequestListState {
  return {
    url,
    number: snapshot.ref.number,
    title: snapshot.title,
    state: snapshot.state,
    draft: snapshot.draft,
    checksRollup: snapshot.checksRollup,
    reviewDecision: snapshot.reviewDecision,
    mergeability: snapshot.mergeability,
  }
}

function sameState(left: ForgeChangeRequestListState | undefined, right: ForgeChangeRequestListState): boolean {
  return left !== undefined && left.title === right.title && left.state === right.state && left.draft === right.draft
    && left.checksRollup === right.checksRollup && left.reviewDecision === right.reviewDecision
    && left.mergeability === right.mergeability && left.number === right.number
}

/** One stream's pending changes, coalesced by URL until the reader takes them. */
class Reader {
  private pending = new Map<string, ForgeChangeRequestListState>()
  private wake: (() => void) | undefined
  private ended = false
  private readonly completion = Promise.withResolvers<undefined>()
  readonly closed = this.completion.promise
  private readonly abort = (): void => { this.end() }

  constructor(readonly allowed: (id: SessionId) => boolean, private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.abort, { once: true })
  }

  push(state: ForgeChangeRequestListState): void {
    if (this.ended) return
    this.pending.set(state.url, state)
    this.wake?.()
  }

  end(): void {
    this.ended = true
    this.pending.clear()
    this.completion.resolve(undefined)
    this.wake?.()
  }

  dispose(): void {
    this.signal.removeEventListener('abort', this.abort)
    this.end()
  }

  async *frames(): AsyncIterable<ForgeChangeRequestStatesFrame> {
    while (!this.ended) {
      if (this.pending.size === 0) {
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
        continue
      }
      const states = [...this.pending.values()]
      this.pending = new Map()
      yield { type: 'changed', states }
    }
  }
}

/** The state of one run: stored and polled states, who binds what, and the polls. */
class Run {
  private readonly states = new Map<string, ForgeChangeRequestListState>()
  private readonly sessionsOf = new Map<string, Set<SessionId>>()
  private readonly urlsOf = new Map<SessionId, ReadonlySet<string>>()
  private readonly polls = new Map<string, () => void>()
  private readonly stopBindings: () => void
  private readonly startupBindings = new Map<SessionId, readonly string[]>()
  private starting = true
  private readonly writes = new Set<Promise<void>>()
  private stopped = false

  constructor(
    private readonly sources: ChangeRequestStateSources,
    private readonly readers: ReadonlySet<Reader>,
    private readonly table: StoredStates,
  ) {
    for (const [, state] of table.entries()) this.states.set(state.url, state)
    // Subscribe before listing; updates received during the read supersede its snapshot.
    this.stopBindings = sources.onBindings((id, urls) => {
      if (this.starting) this.startupBindings.set(id, urls)
      else this.bind(id, urls)
    })
  }

  async start(signal: AbortSignal): Promise<void> {
    const listed = await this.sources.sessions(signal)
    signal.throwIfAborted()
    const updates = this.startupBindings
    for (const session of listed) {
      const urls = updates.get(session.id) ?? session.urls
      if (urls !== undefined) this.bind(session.id, urls)
    }
    this.starting = false
    for (const [id, urls] of updates) this.bind(id, urls)
    updates.clear()
    // An uncached Session may still bind a stored request; absence is not established yet.
    if (listed.some(session => session.urls === undefined)) return
    for (const [url] of this.states) {
      if (this.sessionsOf.has(url)) continue
      this.states.delete(url)
      this.write(() => this.table.delete(storedKey(url)))
    }
  }

  /** The known states of every change request that some Session the reader may read binds. */
  visible(allowed: (id: SessionId) => boolean): ForgeChangeRequestListState[] {
    const states: ForgeChangeRequestListState[] = []
    for (const [url, ids] of this.sessionsOf) {
      const state = this.states.get(url)
      if (state !== undefined && [...ids].some(allowed)) states.push(state)
    }
    return states
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.stopBindings()
    for (const stop of this.polls.values()) stop()
    this.polls.clear()
    await Promise.all(this.writes)
  }

  private bind(id: SessionId, urls: readonly string[]): void {
    const next = new Set(urls)
    const previous = this.urlsOf.get(id) ?? new Set<string>()
    this.urlsOf.set(id, next)
    for (const url of previous) {
      if (next.has(url)) continue
      const ids = this.sessionsOf.get(url)
      ids?.delete(id)
      if (ids !== undefined && ids.size === 0) {
        this.sessionsOf.delete(url)
        this.polls.get(url)?.()
        this.polls.delete(url)
      }
    }
    for (const url of next) {
      if (previous.has(url)) continue
      const ids = this.sessionsOf.get(url) ?? new Set<SessionId>()
      ids.add(id)
      this.sessionsOf.set(url, ids)
      const state = this.states.get(url)
      if (state !== undefined) for (const reader of this.readers) if (reader.allowed(id)) reader.push(state)
      this.poll(url, ids)
    }
  }

  /** Poll a bound change request; `ids` is the live set of Sessions binding it, which outlives the poll. */
  private poll(url: string, ids: ReadonlySet<SessionId>): void {
    if (this.polls.has(url)) return
    const ref = this.sources.refOf(url)
    if (ref === undefined) return
    this.polls.set(url, this.sources.watch(ref, (update) => {
      if ('failure' in update) return
      this.settle(url, ids, listStateOf(update.snapshot, url))
    }))
  }

  private settle(url: string, ids: ReadonlySet<SessionId>, state: ForgeChangeRequestListState): void {
    if (this.stopped || sameState(this.states.get(url), state)) return
    this.states.set(url, state)
    this.write(() => this.table.put(storedKey(url), state))
    for (const reader of this.readers) if ([...ids].some(reader.allowed)) reader.push(state)
  }

  private write(operation: () => Promise<unknown>): void {
    const task = operation().then(() => undefined, (error: unknown) => { this.sources.report(error) })
    this.writes.add(task)
    void task.then(() => { this.writes.delete(task) })
  }

}

/** Streams the states of the change requests that listed Sessions bind. */
export class ChangeRequestStates {
  private readonly readers = new Set<Reader>()
  private stopping: Promise<void> = Promise.resolve()
  private disposed = false
  private run: { readonly started: Promise<Run | undefined>; readonly aborter: AbortController } | undefined

  /** @param sources - what runs read, follow, and poll. */
  constructor(private readonly sources: ChangeRequestStateSources) {}

  /**
   * Stream the known states the reader may see first, then each state that
   * changes or becomes visible to it. The stream ends when `signal` aborts or
   * the hub is disposed.
   * @param allowed - whether the reader may read a Session.
   * @param signal - ends the stream.
   * @returns frames in publication order.
   */
  async *stream(allowed: (id: SessionId) => boolean, signal: AbortSignal): AsyncIterable<ForgeChangeRequestStatesFrame> {
    signal.throwIfAborted()
    if (this.disposed) return
    const reader = new Reader(allowed, signal)
    this.readers.add(reader)
    try {
      const run = await Promise.race([this.ensureRun(), reader.closed.then(() => undefined)])
      // A run that the hub stopped while it started leaves nothing to read.
      if (run === undefined) return
      yield { type: 'baseline', states: run.visible(allowed) }
      yield* reader.frames()
    } finally {
      reader.dispose()
      this.readers.delete(reader)
      if (this.readers.size === 0) await this.stopRun()
    }
  }

  /**
   * End every stream, stop polling, and wait for initialization and accepted storage writes.
   * @returns settles after all owned work stops; subsequent streams end without starting work.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const reader of this.readers) reader.end()
    await this.stopRun()
  }

  private ensureRun(): Promise<Run | undefined> {
    if (this.run !== undefined) return this.run.started
    const aborter = new AbortController()
    const preceding = this.stopping
    const started = (async () => {
      await preceding
      aborter.signal.throwIfAborted()
      const table = await this.sources.open()
      aborter.signal.throwIfAborted()
      const run = new Run(this.sources, this.readers, table)
      try {
        await run.start(aborter.signal)
        return run
      } catch (error) {
        await run.stop()
        throw error
      }
    })()
    this.run = { started, aborter }
    return started
  }

  private stopRun(): Promise<void> {
    const current = this.run
    if (current === undefined) return this.stopping
    this.run = undefined
    current.aborter.abort()
    this.stopping = current.started.then(run => run?.stop(), (error: unknown) => {
      void error // Initialization failure is reported to the stream that awaited it.
    })
    return this.stopping
  }
}
