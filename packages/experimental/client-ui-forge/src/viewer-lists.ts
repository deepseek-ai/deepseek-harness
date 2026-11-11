/**
 * The review page's lists of the signed-in user's change requests and its navigation count. Lists are read only while
 * some reader streams them and the count only while some reader streams it; neither joins the forge's status polling.
 * Readers of one repository scope share one poller, which reads every list of every host each round, hosts in parallel
 * and each host's lists one after another, so one host has at most one read in flight. A round with a failure delays
 * the next round as status polling does after consecutive failures.
 */

import type {
  ForgeFailure, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery, ForgeViewerSource,
} from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeReviewCountFrame, ForgeReviewFrame, ForgeReviewHost, ForgeReviewList } from './types.ts'

/** The lists in the order the page shows them. */
const FILTERS: readonly ForgeViewerFilter[] = ['review-requested', 'authored', 'involved']

/** What the hub reads through the forge registry. */
export interface ViewerListSources {
  /** The viewer lists every registered provider offers. */
  readonly sources: () => readonly ForgeViewerSource[]
  /** Read one list. */
  readonly list: (forge: string, query: ForgeViewerQuery, signal: AbortSignal) => Promise<ForgeViewerList | ForgeFailure>
  /** Read the size of every list on one host. */
  readonly count: (forge: string, host: string, signal: AbortSignal) => Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure>
  /** Report a read that rejected instead of resolving to a failure. */
  readonly report: (error: unknown) => void
}

/** Cadence and size of the reads. */
export interface ViewerListTiming {
  /** Milliseconds between two rounds of a list poller. */
  readonly listIntervalMs: number
  /** Milliseconds between two rounds of the count poller. */
  readonly countIntervalMs: number
  /** Largest delay in milliseconds after consecutive failed rounds. */
  readonly maxBackoffMs: number
  /** Most change requests one list read asks for, before each provider's own limit. */
  readonly pageSize: number
}

/** One repository to list in, or null for every repository. */
export type ViewerScope = { readonly owner: string; readonly name: string } | null

/** A stream's latest undelivered frame; a newer frame replaces one the reader has not taken. */
export class Reader<T> {
  private pending: T | undefined
  private wake: (() => void) | undefined
  private ended = false
  private readonly abort = (): void => { this.end() }

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.abort, { once: true })
  }

  /**
   * Offer a frame, replacing one the reader has not taken; ignored after the stream ended.
   * @param frame - the frame.
   */
  push(frame: T): void {
    if (this.ended) return
    this.pending = frame
    this.wake?.()
  }

  /** End the stream once the reader took the frame it waits for. */
  end(): void {
    this.ended = true
    this.wake?.()
  }

  /** End the stream and stop following its abort signal. */
  dispose(): void {
    this.signal.removeEventListener('abort', this.abort)
    this.end()
  }

  /**
   * Yield each latest frame as the reader takes it, until the stream ends.
   * @returns the frames.
   */
  async *frames(): AsyncIterable<T> {
    while (!this.ended) {
      if (this.pending === undefined) {
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
        continue
      }
      const frame = this.pending
      this.pending = undefined
      yield frame
    }
  }
}

/** A loop that runs one round, waits, and repeats until stopped; a refresh ends the wait early. */
class Poller {
  private readonly aborter = new AbortController()
  private wake: (() => void) | undefined
  private refreshing = false
  private failures = 0
  readonly done: Promise<void>

  constructor(private readonly round: (signal: AbortSignal) => Promise<boolean>, private readonly delay: (failures: number) => number) {
    this.done = this.loop()
  }

  refresh(): void {
    this.refreshing = true
    this.wake?.()
  }

  async stop(): Promise<void> {
    this.aborter.abort(new Error('viewer lists stopped'))
    this.wake?.()
    await this.done
  }

  /** Whether the loop starts its next round at once: it stopped, or a refresh arrived during the round. */
  private skipsWait(signal: AbortSignal): boolean {
    return signal.aborted || this.refreshing
  }

  private async loop(): Promise<void> {
    const { signal } = this.aborter
    while (!signal.aborted) {
      this.refreshing = false
      const succeeded = await this.round(signal)
      this.failures = succeeded ? 0 : this.failures + 1
      if (this.skipsWait(signal)) continue
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.delay(this.failures))
        this.wake = () => { clearTimeout(timer); resolve() }
      })
      this.wake = undefined
    }
  }
}

/** The readers of one repository scope, the poller they share, and what it read. */
class Scope {
  readonly readers = new Set<Reader<ForgeReviewFrame>>()
  readonly hosts = new Map<string, ForgeReviewHost>()
  reading = false
  readonly poller: Poller

  /**
   * @param round - reads every list of the scope once; resolves to whether every read succeeded.
   * @param delay - milliseconds before the next round after the given number of consecutive failed rounds.
   */
  constructor(round: (scope: Scope, signal: AbortSignal) => Promise<boolean>, delay: (failures: number) => number) {
    this.poller = new Poller(signal => round(this, signal), delay)
  }

  frame(order: readonly ForgeViewerSource[]): ForgeReviewFrame {
    const hosts: ForgeReviewHost[] = []
    for (const source of order) {
      for (const host of source.hosts) {
        hosts.push(this.hosts.get(hostKey(source.forge, host)) ?? emptyHost(source, host))
      }
    }
    return { hosts, reading: this.reading }
  }
}

/** Streams the review page's lists and navigation count, reading them only while streamed. */
export class ViewerLists {
  private readonly scopes = new Map<string, Scope>()
  private readonly countReaders = new Set<Reader<ForgeReviewCountFrame>>()
  private readonly counts = new Map<string, number>()
  private countPoller: Poller | undefined
  private disposed = false

  /**
   * @param sources - the registry reads and the report of a rejected read.
   * @param timing - cadence and size of the reads.
   */
  constructor(private readonly sources: ViewerListSources, private readonly timing: ViewerListTiming) {}

  /**
   * Stream the lists of one repository scope: the lists read so far first, then a frame after each read settles.
   * The stream ends when `signal` aborts or the hub is disposed; the last stream of a scope stops its reads.
   * @param scope - one repository, or null for every repository.
   * @param signal - ends the stream.
   * @returns frames, each complete.
   */
  async *lists(scope: ViewerScope, signal: AbortSignal): AsyncIterable<ForgeReviewFrame> {
    signal.throwIfAborted()
    if (this.disposed) return
    const key = scope === null ? '' : `${scope.owner}/${scope.name}`.toLowerCase()
    let state = this.scopes.get(key)
    if (state === undefined) {
      state = new Scope(
        (created, round) => this.readScope(created, scope, round), failures => this.delay(this.timing.listIntervalMs, failures),
      )
      this.scopes.set(key, state)
    }
    const reader = new Reader<ForgeReviewFrame>(signal)
    state.readers.add(reader)
    reader.push(state.frame(this.sources.sources()))
    try {
      yield* reader.frames()
    } finally {
      reader.dispose()
      state.readers.delete(reader)
      if (state.readers.size === 0 && this.scopes.get(key) === state) {
        this.scopes.delete(key)
        await state.poller.stop()
      }
    }
  }

  /**
   * Stream the navigation count: the latest count first, then each change. The stream ends when `signal` aborts or the
   * hub is disposed; the last stream stops the count reads.
   * @param signal - ends the stream.
   * @returns frames, each complete.
   */
  async *count(signal: AbortSignal): AsyncIterable<ForgeReviewCountFrame> {
    signal.throwIfAborted()
    if (this.disposed) return
    const reader = new Reader<ForgeReviewCountFrame>(signal)
    this.countReaders.add(reader)
    reader.push(this.countFrame())
    this.countPoller ??= new Poller(round => this.readCounts(round), failures => this.delay(this.timing.countIntervalMs, failures))
    try {
      yield* reader.frames()
    } finally {
      reader.dispose()
      this.countReaders.delete(reader)
      if (this.countReaders.size === 0) await this.stopCounting()
    }
  }

  /** Stop the count reads; a disposed hub already stopped them. */
  private async stopCounting(): Promise<void> {
    const poller = this.countPoller
    this.countPoller = undefined
    await poller?.stop()
  }

  /** Read every streamed list and the count again at once. */
  refresh(): void {
    for (const scope of this.scopes.values()) scope.poller.refresh()
    this.countPoller?.refresh()
  }

  /** Forget hosts that no longer have a provider, publish that, and read the hosts that gained one. */
  sourcesChanged(): void {
    const current = new Set(this.sources.sources().flatMap(source => source.hosts.map(host => hostKey(source.forge, host))))
    for (const key of [...this.counts.keys()]) if (!current.has(key)) this.counts.delete(key)
    for (const scope of this.scopes.values()) {
      for (const key of [...scope.hosts.keys()]) if (!current.has(key)) scope.hosts.delete(key)
      this.publish(scope)
    }
    this.publishCount()
    this.refresh()
  }

  /**
   * End every stream and stop every read.
   * @returns settles once every poller stopped.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const pollers = [...this.scopes.values()].map(scope => scope.poller)
    if (this.countPoller !== undefined) pollers.push(this.countPoller)
    for (const scope of this.scopes.values()) for (const reader of scope.readers) reader.end()
    for (const reader of this.countReaders) reader.end()
    this.scopes.clear()
    this.countPoller = undefined
    await Promise.all(pollers.map(async (poller) =>{  await poller.stop() }))
  }

  /** Read every list of every host once; resolves to whether every read succeeded. */
  private async readScope(scope: Scope, repository: ViewerScope, signal: AbortSignal): Promise<boolean> {
    const order = this.sources.sources()
    scope.reading = true
    this.publish(scope)
    const results = await Promise.all(order.flatMap(source => source.hosts.map(async (host) => {
      let succeeded = true
      let hostFailure: ForgeFailure | undefined
      for (const filter of FILTERS) {
        if (!source.filters.has(filter)) continue
        const query: ForgeViewerQuery = { host, filter, repository, limit: Math.min(source.maxItems, this.timing.pageSize) }
        const result = hostFailure ?? await this.read(() => this.sources.list(source.forge, query, signal), signal)
        if (signal.aborted) return false
        if ('code' in result && HOST_FAILURES.has(result.code)) hostFailure = result
        succeeded = this.settle(scope, source, host, filter, result) && succeeded
        if (repository === null && !('code' in result) && filter === 'review-requested') {
          this.counts.set(hostKey(source.forge, host), result.total)
          this.publishCount()
        }
        this.publish(scope)
      }
      return succeeded
    })))
    scope.reading = false
    if (!signal.aborted) this.publish(scope)
    return results.every(Boolean)
  }

  /** Read the count of every host once; resolves to whether every read succeeded. */
  private async readCounts(signal: AbortSignal): Promise<boolean> {
    const results = await Promise.all(this.sources.sources().flatMap(source => source.hosts.map(async (host) => {
      if (!source.filters.has('review-requested')) return true
      const result = await this.read(() => this.sources.count(source.forge, host, signal), signal)
      if (signal.aborted || 'code' in result) return false
      this.counts.set(hostKey(source.forge, host), result.get('review-requested') ?? 0)
      this.publishCount()
      return true
    })))
    return results.every(Boolean)
  }

  /** Run one read, turning a rejection into an `unavailable` failure and reporting it unless `signal` aborted. */
  private async read<T>(run: () => Promise<T | ForgeFailure>, signal: AbortSignal): Promise<T | ForgeFailure> {
    try {
      return await run()
    } catch (error) {
      if (!signal.aborted) this.sources.report(error)
      return { code: 'unavailable', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Record one list read; resolves to whether it succeeded. */
  private settle(
    scope: Scope, source: ForgeViewerSource, host: string, filter: ForgeViewerFilter, result: ForgeViewerList | ForgeFailure,
  ): boolean {
    const key = hostKey(source.forge, host)
    const current = scope.hosts.get(key) ?? emptyHost(source, host)
    const previous = current.lists[filter] ?? EMPTY_LIST
    const list: ForgeReviewList = 'code' in result
      ? { ...previous, failure: result }
      : { items: result.items, total: result.total, fetchedAt: Date.now(), failure: null }
    scope.hosts.set(key, {
      ...current, viewer: 'code' in result ? current.viewer : result.viewer, lists: { ...current.lists, [filter]: list },
    })
    return !('code' in result)
  }

  private publish(scope: Scope): void {
    const frame = scope.frame(this.sources.sources())
    for (const reader of scope.readers) reader.push(frame)
  }

  private publishCount(): void {
    const frame = this.countFrame()
    for (const reader of this.countReaders) reader.push(frame)
  }

  private countFrame(): ForgeReviewCountFrame {
    return { reviewRequested: this.counts.size === 0 ? null : [...this.counts.values()].reduce((sum, value) => sum + value, 0) }
  }

  private delay(interval: number, failures: number): number {
    return failures === 0 ? interval : Math.min(this.timing.maxBackoffMs, interval * 2 ** failures)
  }
}

const EMPTY_LIST: ForgeReviewList = { items: null, total: 0, fetchedAt: null, failure: null }

/** Failures that the other lists of the host would meet in the same round, so the round reads them no further. */
const HOST_FAILURES: ReadonlySet<ForgeFailure['code']> = new Set(['unauthenticated', 'rate-limited', 'unavailable'])

/** The identity of one host of one provider. */
function hostKey(forge: string, host: string): string {
  return JSON.stringify([forge, host])
}

/** A host with an empty entry for each list its provider offers. */
function emptyHost(source: ForgeViewerSource, host: string): ForgeReviewHost {
  const lists: Partial<Record<ForgeViewerFilter, ForgeReviewList>> = {}
  for (const filter of FILTERS) if (source.filters.has(filter)) lists[filter] = EMPTY_LIST
  return { forge: source.forge, host, viewer: null, lists }
}
