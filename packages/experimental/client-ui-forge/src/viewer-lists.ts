/**
 * The review page's lists of the signed-in user's change requests and its navigation count. Lists are read only while
 * some reader streams them and the count only while some reader streams it; neither joins the forge's status polling.
 * Readers of one repository scope share one poller, which reads every list of every due host each round, hosts in
 * parallel and each host's lists one after another, so one host has at most one read in flight. A host whose read
 * failed is read again later each time, as status polling waits after consecutive failures, while the other hosts
 * keep their cadence. A scope that names a repository reads only the host the repository is on.
 */

import type {
  ForgeFailure, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery, ForgeViewerSource,
} from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeReviewCountFrame, ForgeReviewFrame, ForgeReviewHost, ForgeReviewList, ForgeReviewRepository } from './types.ts'

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
  /** The command that signs the provider's CLI in to a host, or null when the provider names none. */
  readonly signIn: (forge: string, host: string, signal: AbortSignal) => Promise<string | null>
  /** Report a read that rejected instead of resolving to a failure. */
  readonly report: (error: unknown) => void
}

/** Cadence and size of the reads. */
export interface ViewerListTiming {
  /** Milliseconds between two rounds of a list poller. */
  readonly listIntervalMs: number
  /** Milliseconds between two rounds of the count poller. */
  readonly countIntervalMs: number
  /** Largest delay in milliseconds before a host is read again after consecutive failed reads. */
  readonly maxBackoffMs: number
  /** Most change requests one list read asks for, before each provider's own limit. */
  readonly pageSize: number
}

/** One repository on one host to list in, or null for every repository of every host. */
export type ViewerScope = ForgeReviewRepository | null

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

/** A loop that runs one round, waits as long as the round asks, and repeats until stopped; a refresh ends the wait early. */
class Poller {
  private readonly aborter = new AbortController()
  private wake: (() => void) | undefined
  private refreshing = false
  readonly done: Promise<void>

  /** @param round - runs one round, `forced` after a refresh, and resolves to the milliseconds to wait before the next. */
  constructor(private readonly round: (signal: AbortSignal, forced: boolean) => Promise<number>) {
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
      const forced = this.refreshing
      this.refreshing = false
      const wait = await this.round(signal, forced)
      if (this.skipsWait(signal)) continue
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait)
        this.wake = () => { clearTimeout(timer); resolve() }
      })
      this.wake = undefined
    }
  }
}

/**
 * When each host of one poller is read next. A host is due at once until its first read settles; after a read it is
 * due one delay after the start of the round that read it, and the delay grows with its consecutive failed reads.
 */
class HostSchedule {
  private readonly hosts = new Map<string, { readonly failures: number; readonly dueAt: number }>()

  /** @param delay - milliseconds between two reads of a host after the given number of consecutive failed reads. */
  constructor(private readonly delay: (failures: number) => number) {}

  /** Whether a round that starts at `now` reads the host. */
  due(key: string, now: number): boolean {
    return (this.hosts.get(key)?.dueAt ?? 0) <= now
  }

  /** Record whether the read of the host succeeded in the round that started at `started`. */
  settle(key: string, started: number, succeeded: boolean): void {
    const failures = succeeded ? 0 : (this.hosts.get(key)?.failures ?? 0) + 1
    this.hosts.set(key, { failures, dueAt: started + this.delay(failures) })
  }

  /** Milliseconds from `now` until the first of `keys` is due, or the delay between two successful reads without any key. */
  wait(keys: readonly string[], now: number): number {
    if (keys.length === 0) return this.delay(0)
    return Math.max(0, Math.min(...keys.map(key => this.hosts.get(key)?.dueAt ?? 0)) - now)
  }
}

/** One host a scope reads, with the provider that lists on it. */
interface Target {
  readonly source: ForgeViewerSource
  readonly host: string
  readonly key: string
}

/** The readers of one repository scope, the poller they share, when each host is read next, and what was read. */
class Scope {
  readonly readers = new Set<Reader<ForgeReviewFrame>>()
  readonly hosts = new Map<string, ForgeReviewHost>()
  readonly schedule: HostSchedule
  reading = false
  readonly poller: Poller

  /**
   * @param repository - the repository the scope lists in, or null for every repository of every host.
   * @param round - reads the scope's due hosts once, every host when `forced`; resolves to the wait before the next round.
   * @param delay - milliseconds between two reads of a host after the given number of consecutive failed reads.
   */
  constructor(
    readonly repository: ViewerScope,
    round: (scope: Scope, signal: AbortSignal, forced: boolean) => Promise<number>,
    delay: (failures: number) => number,
  ) {
    this.schedule = new HostSchedule(delay)
    this.poller = new Poller((signal, forced) => round(this, signal, forced))
  }

  /** The hosts the scope reads, in registration and configuration order: every host, or the one its repository is on. */
  targets(order: readonly ForgeViewerSource[]): Target[] {
    const only = this.repository?.host.toLowerCase()
    return order.flatMap(source => source.hosts.filter(host => only === undefined || host === only)
      .map(host => ({ source, host, key: hostKey(source.forge, host) })))
  }

  frame(order: readonly ForgeViewerSource[]): ForgeReviewFrame {
    const hosts = this.targets(order).map(({ source, host, key }) => this.hosts.get(key) ?? emptyHost(source, host))
    return { hosts, reading: this.reading }
  }
}

/** Streams the review page's lists and navigation count, reading them only while streamed. */
export class ViewerLists {
  private readonly scopes = new Map<string, Scope>()
  private readonly countReaders = new Set<Reader<ForgeReviewCountFrame>>()
  private readonly counts = new Map<string, number>()
  private readonly countSchedule = new HostSchedule(failures => this.delay(this.timing.countIntervalMs, failures))
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
   * @param scope - one repository on its host, or null for every repository of every host.
   * @param signal - ends the stream.
   * @returns frames, each complete.
   */
  async *lists(scope: ViewerScope, signal: AbortSignal): AsyncIterable<ForgeReviewFrame> {
    signal.throwIfAborted()
    if (this.disposed) return
    const key = scope === null ? '' : `${scope.host}\n${scope.owner}/${scope.name}`.toLowerCase()
    let state = this.scopes.get(key)
    if (state === undefined) {
      state = new Scope(
        scope, (created, round, forced) => this.readScope(created, round, forced),
        failures => this.delay(this.timing.listIntervalMs, failures),
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
    this.countPoller ??= new Poller((round, forced) => this.readCounts(round, forced))
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

  /**
   * Read every list of the scope's due hosts once, of every host when `forced`.
   * @returns milliseconds until the scope's next host is due.
   */
  private async readScope(scope: Scope, signal: AbortSignal, forced: boolean): Promise<number> {
    const started = Date.now()
    const targets = scope.targets(this.sources.sources())
    const repository = scope.repository === null ? null : { owner: scope.repository.owner, name: scope.repository.name }
    scope.reading = true
    this.publish(scope)
    await Promise.all(targets.filter(target => forced || scope.schedule.due(target.key, started)).map(async ({ source, host, key }) => {
      let succeeded = true
      let hostFailure: ForgeFailure | undefined
      for (const filter of FILTERS) {
        if (!source.filters.has(filter)) continue
        const query: ForgeViewerQuery = { host, filter, repository, limit: Math.min(source.maxItems, this.timing.pageSize) }
        const result = hostFailure ?? await this.read(() => this.sources.list(source.forge, query, signal), signal)
        if (signal.aborted) return
        if ('code' in result && HOST_FAILURES.has(result.code)) hostFailure = result
        succeeded = this.settle(scope, source, host, filter, result) && succeeded
        if (repository === null && !('code' in result) && filter === 'review-requested') {
          this.counts.set(key, result.total)
          this.publishCount()
        }
        this.publish(scope)
      }
      const signIn = hostFailure?.code === 'unauthenticated' ? await this.signInOf(scope, source, host, signal) : null
      if (signal.aborted) return
      const current = scope.hosts.get(key) ?? emptyHost(source, host)
      if (current.signIn !== signIn) {
        scope.hosts.set(key, { ...current, signIn })
        this.publish(scope)
      }
      scope.schedule.settle(key, started, succeeded)
    }))
    scope.reading = false
    if (!signal.aborted) this.publish(scope)
    return scope.schedule.wait(targets.map(target => target.key), Date.now())
  }

  /** The sign-in command the scope already holds for the host, else the one its provider names now, else null. */
  private async signInOf(scope: Scope, source: ForgeViewerSource, host: string, signal: AbortSignal): Promise<string | null> {
    const known = scope.hosts.get(hostKey(source.forge, host))?.signIn ?? null
    if (known !== null) return known
    const command = await this.read<string | null>(() => this.sources.signIn(source.forge, host, signal), signal)
    return typeof command === 'string' ? command : null
  }

  /**
   * Read the count of every due host once, of every host when `forced`.
   * @returns milliseconds until the next host is due.
   */
  private async readCounts(signal: AbortSignal, forced: boolean): Promise<number> {
    const started = Date.now()
    const targets = this.sources.sources().filter(source => source.filters.has('review-requested'))
      .flatMap(source => source.hosts.map(host => ({ source, host, key: hostKey(source.forge, host) })))
    await Promise.all(targets.filter(target => forced || this.countSchedule.due(target.key, started)).map(async ({ source, host, key }) => {
      const result = await this.read(() => this.sources.count(source.forge, host, signal), signal)
      if (signal.aborted) return
      if (!('code' in result)) {
        this.counts.set(key, result.get('review-requested') ?? 0)
        this.publishCount()
      }
      this.countSchedule.settle(key, started, !('code' in result))
    }))
    return this.countSchedule.wait(targets.map(target => target.key), Date.now())
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
  return { forge: source.forge, host, viewer: null, signIn: null, lists }
}
