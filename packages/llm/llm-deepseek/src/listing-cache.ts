/** Credential-scoped `/models` cache with single-flight loads, background refresh, and last-known-good retention. */
import { createHash } from 'node:crypto'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { ListingSettings } from './listing-config.ts'
import { LISTING_TIMEOUT } from './listing.ts'
import type { ModelListing } from './listing.ts'

/** Host-owned inputs of one cache instance. */
export interface ListingCacheDependencies {
  /** Latest route configuration for automatic refresh; `undefined` stops following the listing. */
  readonly settings: () => ListingSettings | undefined
  /** The credential the route sends to `url`, or `undefined` when it has none. */
  readonly credential: (url: string) => Promise<string | undefined>
  /** Perform one listing request authenticated with `credential`; `signal` carries the {@link LISTING_TIMEOUT} request deadline. */
  readonly load: (url: string, credential: string, signal: AbortSignal) => Promise<ModelListing>
  /** Wall clock used for listing age. */
  readonly now: () => number
  /** Report a loaded listing. */
  readonly info: (message: string) => void
  /** Report the first failure of a failing streak. */
  readonly warn: (message: string) => void
  /** Publish a changed view; readers can immediately read `current()`. */
  readonly changed: () => void
}

/** What request resolution reads. */
export interface ListingView {
  /** Whether a credential is available for the listing endpoint. */
  readonly authenticated: boolean
  /** Last successful listing for this scope; `undefined` until one succeeds. */
  readonly listing: ModelListing | undefined
}

/** Wait for `task` unless `signal` aborts first; the task keeps running. */
async function abandonable(task: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return task
  const abandoned = Promise.withResolvers<never>()
  const abandon = (): void => { abandoned.reject(signal.reason) }
  signal.addEventListener('abort', abandon, { once: true })
  try {
    await Promise.race([task, abandoned.promise])
  } finally {
    signal.removeEventListener('abort', abandon)
  }
}

/** One route's listing cache; each endpoint and credential pair has its own scope. */
export class ModelListingCache {
  private scope: string | undefined
  private listing: ModelListing | undefined
  /** Settle time of the latest load in this scope; `undefined` before the first one settles. */
  private settledAt: number | undefined
  private inflight: Promise<void> | undefined
  private request: AbortController | undefined
  private generation = 0
  private failing = false
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly pending = new Set<Promise<void>>()

  /** @param dependencies - credential, transport, clock, and diagnostic callbacks. */
  constructor(private readonly dependencies: ListingCacheDependencies) {}

  /**
   * The last published view, without I/O.
   * @returns the credential state and listing of the current scope.
   */
  current(): ListingView {
    return { authenticated: this.scope !== undefined, listing: this.listing }
  }

  /**
   * Resolve the view for the current credential. The first access of a scope
   * waits for its load, which the request deadline bounds; later accesses
   * return at once and refresh a stale listing in the background. After a load settles,
   * automatic refresh uses the latest route settings; failures retain the last successful listing, including badges.
   * @param settings - endpoint and timing of the caller's configuration generation.
   * @param signal - abandons this wait only; the shared load continues.
   * @returns the view after any first load of the scope settles.
   */
  async view(settings: ListingSettings, signal?: AbortSignal): Promise<ListingView> {
    const credential = await this.dependencies.credential(settings.url)
    signal?.throwIfAborted()
    if (this.closed) return this.current()
    const scope = credential === undefined ? undefined : `${settings.url}\n${createHash('sha256').update(credential).digest('hex')}`
    if (scope !== this.scope) this.rescope(scope)
    if (credential !== undefined) {
      if (this.settledAt === undefined) await abandonable(this.start(settings, credential), signal)
      else if (this.dependencies.now() - this.settledAt >= settings.maxAgeMs) void this.start(settings, credential)
    }
    return this.current()
  }

  /** Discard the listing and abort any in-flight load; the next access loads again and waits like a first access. */
  invalidate(): void {
    this.rescope(this.scope)
  }

  /**
   * Stop automatic refresh and abort loads; later results and accesses change nothing.
   * @returns completion of all admitted loads and automatic credential lookups.
   */
  async dispose(): Promise<void> {
    this.closed = true
    this.generation += 1
    clearTimeout(this.timer)
    this.request?.abort()
    await Promise.allSettled(this.pending)
  }

  private rescope(scope: string | undefined): void {
    clearTimeout(this.timer)
    this.request?.abort()
    this.scope = scope
    this.listing = undefined
    this.settledAt = undefined
    this.inflight = undefined
    this.failing = false
    this.generation += 1
  }

  private start(settings: ListingSettings, credential: string): Promise<void> {
    if (this.inflight !== undefined) return this.inflight
    clearTimeout(this.timer)
    this.generation += 1
    const generation = this.generation
    const request = new AbortController()
    this.request = request
    const limit = deadline(request.signal, settings.timeoutMs, LISTING_TIMEOUT)
    const run = this.dependencies.load(settings.url, credential, limit.signal)
      .then((listing) => {
        if (generation !== this.generation) return
        const changed = !deepEqualJson(this.listing, listing)
        this.listing = listing
        this.settledAt = this.dependencies.now()
        this.failing = false
        this.dependencies.info(`model listing from ${settings.url} loaded ${listing.entries.length} model(s), skipped ${listing.skipped} row(s)`)
        if (changed) this.notify()
      }, (error: unknown) => {
        if (generation !== this.generation) return
        if (!this.failing) {
          const fallback = this.listing === undefined ? 'using the bundled catalog' : 'keeping the previous catalog'
          this.dependencies.warn(`model listing from ${settings.url} failed (${String(error)}); ${fallback}`)
        }
        this.settledAt = this.dependencies.now()
        this.failing = true
      })
      .finally(() => {
        limit[Symbol.dispose]()
        this.pending.delete(run)
        if (this.inflight === run) this.inflight = undefined
        if (generation === this.generation) this.schedule(settings)
      })
    this.inflight = run
    this.pending.add(run)
    return run
  }

  private notify(): void {
    try { this.dependencies.changed() }
    catch (error) { this.dependencies.warn(`model listing change notification failed (${String(error)}); reload the model catalog`) }
  }

  private schedule(settings: ListingSettings): void {
    clearTimeout(this.timer)
    if (this.closed || settings.maxAgeMs === 0) return
    const age = this.settledAt === undefined ? 0 : this.dependencies.now() - this.settledAt
    this.timer = setTimeout(() => {
      const operation = this.refresh(settings).finally(() => {
        this.pending.delete(operation)
      })
      this.pending.add(operation)
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(1, settings.maxAgeMs - age)))
    this.timer.unref()
  }

  private async refresh(previous: ListingSettings): Promise<void> {
    let settings = previous
    try {
      const next = this.dependencies.settings()
      if (next === undefined) {
        this.invalidate()
        this.notify()
        return
      }
      settings = next
      const wasAuthenticated = this.current().authenticated
      await this.view(settings)
      if (this.closed) return
      if (wasAuthenticated && !this.current().authenticated) this.notify()
    } catch (error) {
      if (this.closed) return
      if (!this.failing) {
        this.dependencies.warn(`model listing refresh failed (${String(error)}); keeping the previous catalog; check listing configuration and credentials`)
      }
      this.failing = true
      this.settledAt = this.dependencies.now()
    }
    if (this.inflight === undefined) this.schedule(settings)
  }
}
