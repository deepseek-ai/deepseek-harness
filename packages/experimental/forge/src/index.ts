/** Registry of code-host providers with provider-neutral change requests and shared status polling. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { changeRequestKey } from './keys.ts'
import { nextPollDelay } from './schedule.ts'
import type {
  ChangeRequestKey, ChangeRequestListener, ChangeRequestRef, ChangeRequestSnapshot, ChangeRequestUpdate, Config,
  ForgeActionFailure, ForgeFailure, ForgeProvider, ForgeReadiness, ForgeRepository, ForgeReviewRequest, ForgeReviewResult, MergeRequest,
} from './types.ts'

export { changeRequestKey } from './keys.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    forge: ForgeService
  }
  interface Events {
    /**
     * Announces a provider registration or withdrawal after the registry changes.
     * Listener failures are logged without preventing other listeners from running.
     * @param forge - family whose provider changed.
     * @mode parallel
     */
    'forge/providers-changed'(forge: string): void | Promise<void>
  }
}

type FetchResults = ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>

interface Registration {
  readonly provider: ForgeProvider
  readonly lifetime: AbortController
  readonly pending: Set<Promise<void>>
}

interface Watch {
  readonly key: ChangeRequestKey
  readonly ref: ChangeRequestRef
  readonly listeners: Set<ChangeRequestListener>
  latest: ChangeRequestUpdate | undefined
  /** Epoch milliseconds of the next poll; undefined while in flight or after a terminal state. */
  dueAt: number | undefined
  failures: number
}

/**
 * Registry of forge providers. Watchers of one change request share a single
 * polling loop; each forge has at most one fetch in flight, which batches
 * every due change request of that forge.
 */
export class ForgeService extends Service {
  static Config: z<Config> = z.object({
    activeIntervalMs: z.number().default(30_000),
    idleIntervalMs: z.number().default(120_000),
    maxBackoffMs: z.number().default(600_000),
    fetchTimeoutMs: z.number().default(30_000),
  })

  private readonly config: Required<Config>
  private readonly providers = new Map<string, Registration>()
  private readonly watches = new Map<ChangeRequestKey, Watch>()
  private readonly fetching = new Set<string>()
  private readonly pending = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  /**
   * Poll what is due. A field rather than a method, so the timer runs it on
   * the instance itself: a polling round started through a caller's `ctx.forge`
   * would otherwise run on that caller's shadow receiver, and every later round
   * would nest one more shadow until a property write overflows the stack.
   */
  private readonly tick = (): void => {
    this.timer = undefined
    this.poll()
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'forge')
    this.config = config as Required<Config>
    for (const key of ['activeIntervalMs', 'idleIntervalMs', 'maxBackoffMs', 'fetchTimeoutMs'] as const) {
      const value = this.config[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new Error(`forge: ${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
      }
    }
    if (this.config.maxBackoffMs < this.config.activeIntervalMs) {
      throw new Error('forge: maxBackoffMs must be greater than or equal to activeIntervalMs')
    }
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('forge service disposed'))
      clearTimeout(this.timer)
      this.timer = undefined
      await Promise.allSettled(this.pending)
    }, 'forge: stop polling')
  }

  /**
   * Register the provider of one forge family as an effect on the calling
   * fiber. Watches of that forge receive an `unavailable` failure when the
   * registration ends. Unregistering cancels and awaits its in-flight calls;
   * results from the withdrawn registration are discarded.
   * @param provider - provider to serve `provider.forge`.
   * @returns the disposer that unregisters the provider and waits for its calls to finish.
   * @throws when another provider already serves the same forge.
   */
  register(provider: ForgeProvider): () => Promise<void> {
    const dispose = this.ctx.effect(() => {
      if (this.providers.has(provider.forge)) throw new Error(`forge: a provider for "${provider.forge}" is already registered`)
      const registration: Registration = { provider, lifetime: new AbortController(), pending: new Set() }
      this.providers.set(provider.forge, registration)
      for (const watch of this.watches.values()) {
        if (watch.ref.repository.forge === provider.forge) watch.dueAt = Date.now()
      }
      this.providersChanged(provider.forge)
      this.schedule()
      return async () => {
        this.providers.delete(provider.forge)
        registration.lifetime.abort(new Error(`forge: provider "${provider.forge}" was unregistered`))
        for (const watch of [...this.watches.values()]) {
          if (watch.ref.repository.forge === provider.forge) this.settle(watch, this.missing(provider.forge), undefined)
        }
        this.providersChanged(provider.forge)
        this.schedule()
        await Promise.allSettled(registration.pending)
      }
    }, `forge.register(${provider.forge})`)
    return async () => { await dispose() }
  }

  /**
   * Map a Git remote URL to a repository through the first provider that serves it.
   * @param url - fetch or push URL as Git reports it.
   * @returns the repository, or undefined when no provider serves the URL.
   */
  repositoryFromRemote(url: string): ForgeRepository | undefined {
    for (const { provider } of this.providers.values()) {
      const repository = provider.repositoryFromRemote(url)
      if (repository !== undefined) return repository
    }
    return undefined
  }

  /**
   * Map a change request web URL through the first provider that serves it.
   * @param url - web URL of a pull or merge request.
   * @returns the change request, or undefined when no provider serves the URL.
   */
  changeRequestFromUrl(url: string): ChangeRequestRef | undefined {
    for (const { provider } of this.providers.values()) {
      const ref = provider.changeRequestFromUrl(url)
      if (ref !== undefined) return ref
    }
    return undefined
  }

  /**
   * Build the canonical web URL of a change request.
   * @param ref - change request served by a registered provider.
   * @returns the provider's canonical URL.
   * @throws when no provider serves the change request's forge.
   */
  changeRequestUrl(ref: ChangeRequestRef): string {
    return this.provider(ref.repository.forge).changeRequestUrl(ref)
  }

  /**
   * Find open change requests whose head is `branch`, excluding the default branch and forks.
   * @param repository - repository served by a registered provider.
   * @param branch - head branch name on the host.
   * @param signal - cancellation for the lookup.
   * @returns matching change requests, newest first as the provider reports them.
   * @throws when no provider serves the repository's forge or the lookup fails.
   */
  async findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ChangeRequestRef[]> {
    return await this.invoke(this.registration(repository.forge), signal,
      (provider, operation) => provider.findByHead(repository, branch, operation))
  }

  /**
   * Report whether the provider can reach the repository's host with current credentials.
   * @param repository - repository served by a registered provider.
   * @param signal - cancellation for the probe.
   * @returns the provider's readiness for the host.
   * @throws when no provider serves the repository's forge.
   */
  async readiness(repository: ForgeRepository, signal: AbortSignal): Promise<ForgeReadiness> {
    return await this.invoke(this.registration(repository.forge), signal,
      (provider, operation) => provider.readiness(repository.host, operation))
  }

  /**
   * Mark a draft change request ready for review, then poll it at once when it is watched.
   * @param ref - change request served by a registered provider.
   * @param signal - cancellation of the request.
   * @returns undefined once the host accepted the change, or why it did not.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async markReady(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const failure = await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.markReady(ref, operation))
    this.refresh(ref)
    return failure
  }

  /**
   * Merge a change request while its head is still `request.headSha`, then
   * poll it at once when it is watched.
   * @param ref - change request served by a registered provider.
   * @param request - merge method and the head commit the user confirmed.
   * @param signal - cancellation of the request.
   * @returns undefined once the host merged it, or why it did not.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async merge(ref: ChangeRequestRef, request: MergeRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const failure = await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.merge(ref, request, operation))
    this.refresh(ref)
    return failure
  }

  /**
   * Read complete check details independently of periodic polling.
   * @param ref - change request served by a registered provider.
   * @param signal - cancellation of the detail view.
   * @returns a complete snapshot or the provider's failure; unsupported providers return unavailable.
   * @throws on cancellation, provider disposal, or expiry of this read's own `fetchTimeoutMs` deadline.
   */
  async fetchChecks(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure> {
    using timeout = deadline(signal, this.config.fetchTimeoutMs, 'FORGE_FETCH_TIMEOUT')
    return await this.invoke(this.registration(ref.repository.forge), timeout.signal,
      (provider, operation) => provider.fetchChecks?.(ref, operation)
        ?? Promise.resolve({ code: 'unavailable', message: 'This provider does not support complete check reads' } as const))
  }

  /**
   * Read the changes of a change request as its host computes them.
   * @param ref - change request served by a registered provider.
   * @param signal - cancellation of the read.
   * @returns one unified patch with `a/` and `b/` path prefixes, or why the host did not provide it.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async diff(ref: ChangeRequestRef, signal: AbortSignal): Promise<string | ForgeFailure> {
    return await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.diff(ref, operation))
  }

  /**
   * Publish one comment or a completed review, then refresh the watched status.
   * @param ref - change request served by a registered provider.
   * @param request - explicitly selected commit, comments, and review decision.
   * @param signal - request cancellation.
   * @returns a publication URL or a failure, including an unknown write outcome.
   */
  async submitReview(ref: ChangeRequestRef, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult> {
    const result = await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.submitReview?.(ref, request, operation)
        ?? Promise.resolve({ ok: false, code: 'unsupported', message: 'This provider does not support review submission' } as const))
    this.refresh(ref)
    return result
  }

  /**
   * Read the text of one file at a commit of a change request's repository.
   * @param ref - change request served by a registered provider.
   * @param commit - commit object name.
   * @param path - path relative to the repository root.
   * @param signal - cancellation of the read.
   * @returns the text, or why the host did not provide it.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async fileText(ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    return await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.fileText(ref, commit, path, operation))
  }

  /**
   * Build the web page of one file at a commit of a change request's repository.
   * @param ref - change request served by a registered provider.
   * @param commit - commit object name.
   * @param path - path relative to the repository root.
   * @returns the provider's URL.
   * @throws when no provider serves the change request's forge.
   */
  fileUrl(ref: ChangeRequestRef, commit: string, path: string): string {
    return this.provider(ref.repository.forge).fileUrl(ref, commit, path)
  }

  /**
   * Watch one change request as an effect on the calling fiber. The first
   * watcher starts polling at once; listeners receive every later result,
   * and `latest` returns the current one. Polling stops when the last watcher
   * leaves. Listeners must not throw; a thrown error is logged and skipped.
   * @param ref - change request to poll.
   * @param listener - receives each polling result.
   * @returns the disposer that stops this watch.
   */
  watch(ref: ChangeRequestRef, listener: ChangeRequestListener): () => void {
    const key = changeRequestKey(ref)
    const dispose = this.ctx.effect(() => {
      let watch = this.watches.get(key)
      if (watch === undefined) {
        watch = { key, ref, listeners: new Set(), latest: undefined, dueAt: Date.now(), failures: 0 }
        this.watches.set(key, watch)
        this.schedule()
      }
      const owned = watch
      owned.listeners.add(listener)
      return () => {
        owned.listeners.delete(listener)
        if (owned.listeners.size === 0 && this.watches.get(key) === owned) {
          this.watches.delete(key)
          this.schedule()
        }
      }
    }, 'forge.watch()')
    return () => void dispose()
  }

  /**
   * Poll a watched change request at once, including after a terminal state.
   * A fetch already in flight is followed immediately by another fetch; an
   * unwatched change request is unchanged.
   * @param ref - change request to poll.
   */
  refresh(ref: ChangeRequestRef): void {
    const watch = this.watches.get(changeRequestKey(ref))
    if (watch === undefined) return
    watch.dueAt = Date.now()
    this.schedule()
  }

  /**
   * Read the latest polling result of a watched change request.
   * @param ref - change request to read.
   * @returns the latest result, or undefined before the first result or without a watch.
   */
  latest(ref: ChangeRequestRef): ChangeRequestUpdate | undefined {
    return this.watches.get(changeRequestKey(ref))?.latest
  }

  private provider(forge: string): ForgeProvider {
    return this.registration(forge).provider
  }

  private providersChanged(forge: string): void {
    if (this.lifetime.signal.aborted) return
    const task = this.ctx.parallel('forge/providers-changed', forge).catch((error: unknown) => {
      this.ctx.logger.warn(`forge: provider change listener failed: ${String(error)}`)
    })
    this.pending.add(task)
    void task.then(() => this.pending.delete(task))
  }

  private registration(forge: string): Registration {
    const registration = this.providers.get(forge)
    if (registration === undefined) throw new Error(`forge: ${this.missing(forge).message}`)
    return registration
  }

  private async invoke<T>(
    registration: Registration,
    signal: AbortSignal,
    action: (provider: ForgeProvider, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation = AbortSignal.any([signal, this.lifetime.signal, registration.lifetime.signal])
    operation.throwIfAborted()
    const completion = Promise.withResolvers<void>()
    registration.pending.add(completion.promise)
    this.pending.add(completion.promise)
    try {
      const result = await action(registration.provider, operation)
      operation.throwIfAborted()
      return result
    } finally {
      registration.pending.delete(completion.promise)
      this.pending.delete(completion.promise)
      completion.resolve()
    }
  }

  private missing(forge: string): ForgeFailure {
    return { code: 'unavailable', message: `no provider is registered for "${forge}"` }
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.lifetime.signal.aborted) return
    let next: number | undefined
    for (const watch of this.watches.values()) {
      if (watch.dueAt === undefined || this.fetching.has(watch.ref.repository.forge)) continue
      next = next === undefined ? watch.dueAt : Math.min(next, watch.dueAt)
    }
    if (next === undefined) return
    this.timer = setTimeout(this.tick, Math.max(0, next - Date.now()))
  }

  private poll(): void {
    const now = Date.now()
    const due = new Map<string, Watch[]>()
    for (const watch of this.watches.values()) {
      const forge = watch.ref.repository.forge
      if (watch.dueAt === undefined || watch.dueAt > now || this.fetching.has(forge)) continue
      const batch = due.get(forge)
      if (batch === undefined) due.set(forge, [watch])
      else batch.push(watch)
    }
    for (const [forge, batch] of due) {
      const task = this.fetch(forge, batch)
      this.pending.add(task)
      void task.then(() => this.pending.delete(task))
    }
    this.schedule()
  }

  /** Fetch one forge's batch; never rejects. */
  private async fetch(forge: string, batch: readonly Watch[]): Promise<void> {
    this.fetching.add(forge)
    for (const watch of batch) watch.dueAt = undefined
    let results: FetchResults | undefined
    let failure: ForgeFailure | undefined
    const registration = this.providers.get(forge)
    try {
      if (registration === undefined) {
        failure = this.missing(forge)
      } else {
        using timeout = deadline(this.lifetime.signal, this.config.fetchTimeoutMs, 'FORGE_FETCH_TIMEOUT')
        results = await this.invoke(registration, timeout.signal,
          (provider, operation) => provider.fetch(batch.map(watch => watch.ref), operation))
      }
    } catch (error) {
      failure = { code: 'unavailable', message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.fetching.delete(forge)
    }
    if (this.lifetime.signal.aborted) return
    if (registration !== this.providers.get(forge)) {
      this.schedule()
      return
    }
    for (const watch of batch) {
      if (this.watches.get(watch.key) !== watch) continue
      const result = failure ?? results?.get(watch.key) ?? { code: 'unavailable', message: `provider returned no result for ${watch.key}` }
      this.settle(watch, result, watch.dueAt)
    }
    this.schedule()
  }

  private settle(watch: Watch, result: ChangeRequestSnapshot | ForgeFailure, refreshAt: number | undefined): void {
    const fetchedAt = Date.now()
    let update: ChangeRequestUpdate
    if ('code' in result) {
      watch.failures++
      update = { key: watch.key, fetchedAt, failure: result }
    } else {
      watch.failures = 0
      update = { key: watch.key, fetchedAt, snapshot: result }
    }
    watch.latest = update
    const delay = nextPollDelay(result, watch.failures, this.config)
    // A refresh requested after this fetch started needs a subsequent fetch, even for a terminal result.
    watch.dueAt = refreshAt ?? (delay === undefined ? undefined : fetchedAt + delay)
    for (const listener of [...watch.listeners]) {
      try {
        listener(update)
      } catch (error) {
        this.ctx.logger.warn(`forge: change request listener failed: ${String(error)}`)
      }
    }
  }
}

export default ForgeService
