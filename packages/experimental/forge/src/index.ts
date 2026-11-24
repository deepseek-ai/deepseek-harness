/** Registry of code-host providers with provider-neutral change requests and shared status polling. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { changeRequestKey } from './keys.ts'
import { backoffDelay, nextPollDelay } from './schedule.ts'
import type {
  AutoMergeRequest, BranchUpdateRequest, ChangeRequestActivity, ChangeRequestBrief, ChangeRequestBriefListener, ChangeRequestBriefUpdate,
  ChangeRequestDescription, ChangeRequestKey,
  ChangeRequestKnownState, ChangeRequestListener, ChangeRequestRef, ChangeRequestSnapshot, ChangeRequestUpdate, ChangeRequestWatchOptions,
  Config,
  ForgeCommitList, ForgeActionFailure, ForgeDescription, ForgeFailure, ForgeProvider, ForgeReadiness, ForgeRegistrationHandle,
  ForgeRepository, ForgeRerunRequest,
  ForgeReviewData,
  ForgeReviewChange, ForgeReviewerCandidate, ForgeReviewersRequest, ForgeReviewRequest, ForgeReviewResult, ForgeReviewWrite,
  ForgeReviewWriteResult,
  ForgeViewedFiles, ForgeViewedRequest, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery, ForgeViewerSource, MergeRequest,
} from './types.ts'

export { changeRequestKey } from './keys.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    forge: ForgeService
  }
  interface Events {
    /**
     * Announces a provider registration, replacement, or withdrawal after the registry changes.
     * Listener failures are logged without preventing other listeners from running.
     * @param forge - family whose provider changed.
     * @mode parallel
     */
    'forge/providers-changed'(forge: string): void | Promise<void>
    /**
     * Announces a review change the host accepted through this service: a thread or pending-review write, a submitted
     * review, or a viewed mark. Changes whose outcome is unknown, refused, stale, or unsupported are not announced.
     * Listener failures are logged without preventing other listeners from running.
     * @param ref - change request the change went to.
     * @param change - what changed and the head commit it was made against.
     * @mode parallel
     */
    'forge/review-changed'(ref: ChangeRequestRef, change: ForgeReviewChange): void | Promise<void>
  }
}

/** What a poll reads: the brief of a change request, or the snapshot that holds it. */
type StatusLevel = 'brief' | 'snapshot'

/** The results of one provider read, by what the provider returned. */
type Reading =
  | { readonly kind: 'snapshot'; readonly results: ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure> }
  | { readonly kind: 'brief'; readonly results: ReadonlyMap<ChangeRequestKey, ChangeRequestBrief | ForgeFailure> }

/** The settled result of one poll of a watch; a failure names the level the poll read at. */
type Outcome =
  | { readonly snapshot: ChangeRequestSnapshot }
  | { readonly brief: ChangeRequestBrief }
  | { readonly failure: ForgeFailure; readonly level: StatusLevel }

interface Registration {
  readonly provider: ForgeProvider
  readonly lifetime: AbortController
  readonly pending: Set<Promise<void>>
}

interface Watch {
  readonly key: ChangeRequestKey
  readonly ref: ChangeRequestRef
  /** Watchers of the snapshot; polls read the snapshot while there is one, and the brief otherwise. */
  readonly listeners: Set<ChangeRequestListener>
  /** Watchers of the brief, which every poll result reaches. */
  readonly briefListeners: Set<ChangeRequestBriefListener>
  /** Result of the latest snapshot poll; it stays while only brief watchers remain. */
  latest: ChangeRequestUpdate | undefined
  /** Epoch milliseconds of the next poll; undefined while in flight or after a terminal state. */
  dueAt: number | undefined
  /**
   * Epoch milliseconds from which a poll of the same lane also reads this change request: the midpoint of the wait
   * after a status. Undefined after a failure, whose backoff the change request waits out in full.
   */
  joinAt: number | undefined
  /** Level of the poll in flight, when there is one. */
  reading: StatusLevel | undefined
  /** Epoch milliseconds when the latest poll at either level started, or when the state a brief watcher knew was read. */
  polledAt: number | undefined
  /** Whether the latest status reported an unknown mergeability. */
  unknownMergeability: boolean
  /** Epoch milliseconds until which an announced change keeps polls at the active interval; undefined without one. */
  expectingUntil: number | undefined
  failures: number
  /** Head commit whose `stale` diff or review read last polled at once, so further stale reads at it wait for the regular poll. */
  staleHead: string | undefined
}

/**
 * Registry of forge providers. Watchers of one change request share a single
 * polling loop, which reads its snapshot while a snapshot watcher remains and
 * its brief otherwise. Each forge has at most one snapshot fetch and one brief
 * fetch in flight; each batches every due change request of that forge at its
 * level, and those past the midpoint of the wait after a status, so change
 * requests that became due at different times come to share one fetch. A fetch
 * calls a provider that names a batch size once per that many change requests
 * of a host, and settles the results of each call when it returns.
 */
export class ForgeService extends Service {
  static Config: z<Config> = z.object({
    activeIntervalMs: z.number().default(15_000),
    idleIntervalMs: z.number().default(60_000),
    maxBackoffMs: z.number().default(600_000),
    fetchTimeoutMs: z.number().default(30_000),
  })

  private readonly config: Required<Config>
  private readonly providers = new Map<string, Registration>()
  private readonly watches = new Map<ChangeRequestKey, Watch>()
  /** Lanes with a fetch in flight, as {@link laneOf} names them. */
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
   * @param provider - provider to serve `provider.forge` on `provider.hosts`.
   * @returns the disposer that unregisters the provider and waits for its calls to finish, carrying
   *   {@link ForgeRegistrationHandle.replace}.
   * @throws when another provider already serves the same forge or one of the same hosts, compared without case, and
   * when the provider names a batch size that is not a positive safe integer.
   */
  register(provider: ForgeProvider): ForgeRegistrationHandle {
    const { forge } = provider
    // The registration this handle holds; `replace` swaps it and the disposer clears it.
    let held: Registration | undefined
    // Calls of replaced providers still in flight, which the disposer waits for.
    const retired = new Set<Promise<void>>()
    const dispose = this.ctx.effect(() => {
      if (this.providers.has(forge)) throw new Error(`forge: a provider for "${forge}" is already registered`)
      held = this.admit(provider)
      return async () => {
        const registration = held as Registration
        held = undefined
        this.providers.delete(forge)
        registration.lifetime.abort(new Error(`forge: provider "${forge}" was unregistered`))
        for (const watch of [...this.watches.values()]) {
          if (watch.ref.repository.forge === forge) this.settle(watch, { failure: this.missing(forge), level: levelOf(watch) }, undefined)
        }
        this.providersChanged(forge)
        this.schedule()
        await Promise.allSettled([...registration.pending, ...retired])
      }
    }, `forge.register(${forge})`)
    const handle = (async () => { await dispose() }) as ForgeRegistrationHandle
    handle.replace = (next) => {
      if (held === undefined) throw new Error(`forge: the withdrawn registration of "${forge}" cannot replace its provider`)
      if (next.forge !== forge) throw new Error(`forge: the registration of "${forge}" cannot serve "${next.forge}"`)
      const previous = held
      held = this.admit(next)
      previous.lifetime.abort(new Error(`forge: provider "${forge}" was replaced`))
      for (const call of previous.pending) {
        retired.add(call)
        void call.then(() => retired.delete(call))
      }
    }
    return handle
  }

  /**
   * Make `provider` the provider of its forge family, in place of the family's current one when there is one: its
   * watches poll at once and `forge/providers-changed` announces the change.
   * @throws when the provider names a batch size that is not a positive safe integer, or another family's provider
   * serves one of `provider.hosts`, compared without case; the registry is unchanged.
   */
  private admit(provider: ForgeProvider): Registration {
    for (const key of ['snapshotBatchSize', 'briefBatchSize'] as const) {
      const size = provider[key]
      if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0)) {
        throw new Error(`forge: ${key} of the "${provider.forge}" provider must be a positive safe integer`)
      }
    }
    for (const { provider: other } of this.providers.values()) {
      if (other.forge === provider.forge) continue
      const taken = new Set(other.hosts.map(host => host.toLowerCase()))
      const host = provider.hosts.find(candidate => taken.has(candidate.toLowerCase()))
      if (host !== undefined) throw new Error(`forge: host "${host}" is already served by the "${other.forge}" provider`)
    }
    const registration: Registration = { provider, lifetime: new AbortController(), pending: new Set() }
    this.providers.set(provider.forge, registration)
    for (const watch of this.watches.values()) {
      if (watch.ref.repository.forge === provider.forge) watch.dueAt = Date.now()
    }
    this.providersChanged(provider.forge)
    this.schedule()
    return registration
  }

  /**
   * Name a forge family and its change requests for readers.
   * @param forge - forge family name, such as `github`.
   * @returns the registered provider's description, or undefined when no provider serves the family.
   */
  describe(forge: string): ForgeDescription | undefined {
    const provider = this.providers.get(forge)?.provider
    return provider === undefined ? undefined : { forge, label: provider.label, changeRequestNoun: provider.changeRequestNoun }
  }

  /**
   * Map a Git remote URL to a repository through the provider that serves its host.
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
   * Map a change request web URL through the provider that serves its host.
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
   * Report whether a provider can reach one host with current credentials.
   * @param repository - forge family of a registered provider and the host to probe; a repository names both.
   * @param signal - cancellation for the probe.
   * @returns the provider's readiness for the host.
   * @throws when no provider serves the forge.
   */
  async readiness(repository: Pick<ForgeRepository, 'forge' | 'host'>, signal: AbortSignal): Promise<ForgeReadiness> {
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
   * Rerun the failed checks of a change request's head commit while the head is still `request.headSha`, then poll it
   * at once when it is watched.
   * @param ref - change request served by a registered provider.
   * @param request - the head commit whose checks the user saw.
   * @param signal - cancellation of the request.
   * @returns undefined once the host accepted the rerun, or why it did not; a provider that reruns no checks fails.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async rerunChecks(ref: ChangeRequestRef, request: ForgeRerunRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    return await this.act(ref, signal, provider => provider.rerunChecks?.bind(provider), 'reruns no checks',
      (action, operation) => action(ref, request, operation))
  }

  /**
   * Request reviews of a change request from more reviewers, then poll it at once when it is watched.
   * @param ref - change request served by a registered provider.
   * @param request - the reviewers to ask.
   * @param signal - cancellation of the request.
   * @returns undefined once the host accepted the request, or why it did not; a provider that requests no reviews fails.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async requestReviews(
    ref: ChangeRequestRef, request: ForgeReviewersRequest, signal: AbortSignal,
  ): Promise<ForgeActionFailure | undefined> {
    return await this.act(ref, signal,
      provider => provider.reviewerCandidates === undefined ? undefined : provider.requestReviews?.bind(provider), 'requests no reviews',
      (action, operation) => action(ref, request, operation))
  }

  /**
   * List accounts a review of a change request can be requested from.
   * @param ref - change request served by a registered provider.
   * @param query - text the login or name contains; empty for the host's suggestions and first accounts.
   * @param signal - cancellation of the read.
   * @returns the accounts, the host's suggestions first, or why the host did not list them; a provider that requests no
   * reviews returns `unsupported`.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async reviewerCandidates(
    ref: ChangeRequestRef, query: string, signal: AbortSignal,
  ): Promise<readonly ForgeReviewerCandidate[] | ForgeFailure> {
    return await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.reviewerCandidates === undefined || provider.requestReviews === undefined
        ? Promise.resolve({ code: 'unsupported', message: 'This provider requests no reviews' } as const)
        : provider.reviewerCandidates(ref, query, operation))
  }

  /**
   * Bring the base branch's new commits into a change request's head branch while its head is still
   * `request.headSha`, then poll it at once when it is watched.
   * @param ref - change request served by a registered provider.
   * @param request - update method and the head commit the user confirmed.
   * @param signal - cancellation of the request.
   * @returns undefined once the host accepted the update, or why it did not; a provider that updates no branches fails.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async updateBranch(ref: ChangeRequestRef, request: BranchUpdateRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    return await this.act(ref, signal, provider => provider.updateBranch?.bind(provider), 'updates no branches',
      (action, operation) => action(ref, request, operation))
  }

  /**
   * Turn the host's automatic merge of a change request on, while its head is still the request's `headSha`, or off,
   * then poll it at once when it is watched.
   * @param ref - change request served by a registered provider.
   * @param request - on with the merge method and the head commit the user confirmed, or off.
   * @param signal - cancellation of the request.
   * @returns undefined once the host accepted it, or why it did not; a provider that sets no automatic merge fails.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async setAutoMerge(
    ref: ChangeRequestRef, request: AutoMergeRequest, signal: AbortSignal,
  ): Promise<ForgeActionFailure | undefined> {
    return await this.act(ref, signal, provider => provider.setAutoMerge?.bind(provider), 'sets no automatic merge',
      (action, operation) => action(ref, request, operation))
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
   * Read the changes of a change request at one head commit as its host
   * computes them. The first `stale` failure at a head commit polls a watched
   * change request again at once, so its next status names the current head;
   * later stale reads at the same commit wait for the regular poll, which
   * bounds the reads while the host's answers disagree. When the latest status of a watched change request names
   * `headSha`, its `baseSha` goes to the provider, which may then read the patch while it confirms the head.
   * @param ref - change request served by a registered provider.
   * @param headSha - head commit the patch must describe, usually the head of the latest status.
   * @param signal - cancellation of the read.
   * @returns one unified patch with `a/` and `b/` path prefixes, or why the host did not provide it at `headSha`.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async diff(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const latest = this.watches.get(changeRequestKey(ref))?.latest
    const base = latest !== undefined && 'snapshot' in latest && latest.snapshot.headSha === headSha ? latest.snapshot.baseSha : undefined
    const result = await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.diff(ref, headSha, operation, base))
    if (typeof result !== 'string') this.staleRead(ref, headSha, result.code)
    return result
  }

  /**
   * Read the review threads of a change request at one head commit. A
   * `stale` failure polls a watched change request again as {@link ForgeService.diff} does.
   * @param ref - change request served by a registered provider.
   * @param headSha - head commit the threads must be read at, usually the head of the displayed diff.
   * @param signal - cancellation of the read.
   * @returns the threads read at `headSha`, or why the host did not provide them; `unsupported` when the provider cannot read reviews.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async readReview(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<ForgeReviewData | ForgeFailure> {
    const result = await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.readReview?.(ref, headSha, operation)
        ?? Promise.resolve({ code: 'unsupported', message: 'This provider does not support review reads' } as const))
    if ('code' in result) this.staleRead(ref, headSha, result.code)
    return result
  }

  /**
   * Write to the review threads or the pending review of a change request while its head is still `write.headSha`, then
   * poll the change request at once when it is watched, unless the provider cannot write reviews. A `stale` result polls
   * it as a stale read does; a write the host took is announced with `forge/review-changed`.
   * @param ref - change request served by a registered provider.
   * @param write - the write and the head commit the user saw.
   * @param signal - cancellation of the write.
   * @returns whether the host took the write; `unsupported` when the provider cannot write reviews, and `unknown` when the
   * outcome must be checked on the host before the write is tried again.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async writeReview(ref: ChangeRequestRef, write: ForgeReviewWrite, signal: AbortSignal): Promise<ForgeReviewWriteResult> {
    const result = await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.writeReview?.(ref, write, operation)
        ?? Promise.resolve({ ok: false, code: 'unsupported', message: 'This provider does not support review writes' } as const))
    if (!result.ok && result.code === 'stale') this.staleRead(ref, write.headSha, result.code)
    else if (result.ok || result.code !== 'unsupported') this.refresh(ref)
    if (result.ok) this.reviewChanged(ref, { kind: 'write', write: write.kind, headSha: write.headSha })
    return result
  }

  /**
   * Read the signed-in user's viewed marks on the files of a change request at one head commit. A `stale` failure
   * polls a watched change request again as {@link ForgeService.diff} does.
   * @param ref - change request served by a registered provider.
   * @param headSha - head commit the marks must be read at, usually the head of the displayed diff.
   * @param signal - cancellation of the read.
   * @returns the marks read at `headSha`, why the host did not provide them, or undefined when the provider keeps no
   * viewed marks.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async viewedFiles(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<ForgeViewedFiles | ForgeFailure | undefined> {
    const result = await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.viewedFiles === undefined || provider.setViewed === undefined
        ? Promise.resolve(undefined) : provider.viewedFiles(ref, headSha, operation))
    if (result !== undefined && 'code' in result) this.staleRead(ref, headSha, result.code)
    return result
  }

  /**
   * Set or clear the signed-in user's viewed mark on one file of a change request while its head is still
   * `request.headSha`. A `stale` failure polls a watched change request again as {@link ForgeService.diff} does; a saved
   * mark is announced with `forge/review-changed`.
   * @param ref - change request served by a registered provider.
   * @param request - the file, its mark, and the head commit the user saw.
   * @param signal - cancellation of the request.
   * @returns undefined once the host saved the mark, or why it did not; a provider that keeps no viewed marks fails.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async setViewed(ref: ChangeRequestRef, request: ForgeViewedRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const failure = await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.viewedFiles === undefined || provider.setViewed === undefined
        ? Promise.resolve({ code: 'failed', message: 'This provider keeps no viewed marks' } as const)
        : provider.setViewed(ref, request, operation))
    if (failure?.code === 'stale') this.staleRead(ref, request.headSha, failure.code)
    if (failure === undefined) this.reviewChanged(ref, { kind: 'viewed', path: request.path, viewed: request.viewed, headSha: request.headSha })
    return failure
  }

  /**
   * List the commits of a change request at its current head.
   * @param ref - change request served by a registered provider.
   * @param signal - cancellation of the read.
   * @returns the commits, why the host did not provide them, or undefined when the provider does not read commits.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async commits(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeCommitList | ForgeFailure | undefined> {
    return await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.commits === undefined || provider.compare === undefined
        ? Promise.resolve(undefined) : provider.commits(ref, operation))
  }

  /**
   * Read the changes between two commits of a change request's repository.
   * @param ref - change request served by a registered provider.
   * @param base - full object name of the commit compared from.
   * @param head - full object name of a commit that descends from `base`.
   * @param signal - cancellation of the read.
   * @returns one unified patch with `a/` and `b/` path prefixes, or why the host did not provide it; a provider that
   * does not read commits returns `unavailable`.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async compare(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    return await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.commits === undefined || provider.compare === undefined
        ? Promise.resolve({ code: 'unavailable', message: 'This provider does not read commits' } as const)
        : provider.compare(ref, base, head, operation))
  }

  /**
   * Find the merge base of two commits of a change request's repository: the commit whose files the old side of the
   * change request's diff shows when `base` is the snapshot's `baseSha` and `head` its `headSha`.
   * @param ref - change request served by a registered provider.
   * @param base - full object name of the base commit.
   * @param head - full object name of the head commit.
   * @param signal - cancellation of the read.
   * @returns the merge base's full object name, or why the host did not provide it; `unsupported` when the provider
   * cannot name merge bases.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async mergeBase(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    return await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.mergeBase?.(ref, base, head, operation)
        ?? Promise.resolve({ code: 'unsupported', message: 'This provider does not name merge bases' } as const))
  }

  /**
   * List the viewer lists every registered provider offers; `forge/providers-changed` announces a change.
   * @returns one source per provider that declares viewer lists and reads them, in registration order.
   */
  viewerSources(): ForgeViewerSource[] {
    const sources: ForgeViewerSource[] = []
    for (const { provider } of this.providers.values()) {
      const { viewer } = provider
      if (viewer !== undefined && provider.listForViewer !== undefined && provider.countForViewer !== undefined) {
        sources.push({ forge: provider.forge, hosts: viewer.hosts, filters: viewer.filters, maxItems: viewer.maxItems })
      }
    }
    return sources
  }

  /**
   * Read one list of open change requests that involve the signed-in user.
   * @param forge - forge family of a registered provider.
   * @param query - host, list, repository, and limit of the read.
   * @param signal - cancellation of the read.
   * @returns the list, or why the host did not provide it; `unsupported` when the provider does not offer the host or list.
   * @throws when no provider serves `forge`, or with `signal.reason` when it aborts.
   */
  async listForViewer(forge: string, query: ForgeViewerQuery, signal: AbortSignal): Promise<ForgeViewerList | ForgeFailure> {
    return await this.invoke(this.registration(forge), signal, (provider, operation) => {
      const reads = viewerReads(provider, query.host, query.filter)
      return 'code' in reads ? Promise.resolve(reads) : reads.list(query, operation)
    })
  }

  /**
   * Count the change requests in each viewer list a provider offers on one host.
   * @param forge - forge family of a registered provider.
   * @param host - lowercase host name the provider lists on.
   * @param signal - cancellation of the read.
   * @returns the count of each list, or why the host did not provide them; `unsupported` when the provider does not list on `host`.
   * @throws when no provider serves `forge`, or with `signal.reason` when it aborts.
   */
  async countForViewer(forge: string, host: string, signal: AbortSignal): Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure> {
    return await this.invoke(this.registration(forge), signal, (provider, operation) => {
      const reads = viewerReads(provider, host, undefined)
      return 'code' in reads ? Promise.resolve(reads) : reads.count(host, operation)
    })
  }

  /**
   * Read the description and labels of a change request.
   * @param ref - change request served by a registered provider.
   * @param signal - cancellation of the read.
   * @returns the description, or why the host did not provide it; `unsupported` when the provider reads no descriptions.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async readDescription(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestDescription | ForgeFailure> {
    return await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.readDescription?.(ref, operation)
        ?? Promise.resolve({ code: 'unsupported', message: 'This provider does not read descriptions' } as const))
  }

  /**
   * Read the activity of a change request: its comments, submitted reviews, commits, and changes of state.
   * @param ref - change request served by a registered provider.
   * @param signal - cancellation of the read.
   * @returns the activity, or why the host did not provide it; `unsupported` when the provider reads no activity.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async readActivity(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestActivity | ForgeFailure> {
    return await this.invoke(this.registration(ref.repository.forge), signal,
      (provider, operation) => provider.readActivity?.(ref, operation)
        ?? Promise.resolve({ code: 'unsupported', message: 'This provider does not read activity' } as const))
  }

  /**
   * Add a comment to a change request's conversation, then poll it at once when it is watched.
   * @param ref - change request served by a registered provider.
   * @param body - Markdown source of the comment.
   * @param signal - cancellation of the request.
   * @returns undefined once the host saved the comment, or why it did not; a provider that adds no comments fails.
   * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
   */
  async addComment(ref: ChangeRequestRef, body: string, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    return await this.act(ref, signal, provider => provider.addComment?.bind(provider), 'adds no comments',
      (action, operation) => action(ref, body, operation))
  }

  /**
   * Publish one comment or a completed review, then refresh the watched status; a publication the host took is announced
   * with `forge/review-changed`.
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
    if (result.ok) this.reviewChanged(ref, { kind: 'submit', headSha: request.headSha })
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
   * Watch the snapshot of one change request as an effect on the calling fiber. Its first snapshot watcher polls it at
   * once, and a later one does when `options.maxAgeMs` is given and the latest result is older. Listeners receive every
   * later snapshot poll result, and `latest` returns the current one. While a snapshot watcher remains, polls read the
   * snapshot; polling stops when the last watcher of the snapshot and the brief leaves. Listeners must not throw; a
   * thrown error is logged and skipped.
   * @param ref - change request to poll.
   * @param listener - receives each snapshot poll result.
   * @param options - when the watcher needs a status newer than the latest one.
   * @returns the disposer that stops this watch.
   */
  watch(ref: ChangeRequestRef, listener: ChangeRequestListener, options: ChangeRequestWatchOptions = {}): () => void {
    const dispose = this.ctx.effect(() => {
      const now = Date.now()
      const watch = this.open(ref, { dueAt: now, joinAt: undefined, polledAt: undefined, unknownMergeability: false })
      const { latest } = watch
      const outdated = latest === undefined ? watch.listeners.size === 0
        : options.maxAgeMs !== undefined && now - latest.fetchedAt > options.maxAgeMs
      watch.listeners.add(listener)
      // A snapshot poll in flight answers a watcher that joins it.
      if (outdated && watch.reading !== 'snapshot') watch.dueAt = now
      this.schedule()
      return () => {
        watch.listeners.delete(listener)
        this.close(watch)
      }
    }, 'forge.watch()')
    return () => void dispose()
  }

  /**
   * Watch the brief of one change request as an effect on the calling fiber. Listeners receive the brief of every
   * later poll result: of a brief read while only brief watchers remain, and of a snapshot read otherwise. The first
   * watcher of a change request polls it at once, or as `known` times it. Polling stops when the last watcher of the
   * snapshot and the brief leaves. Listeners must not throw; a thrown error is logged and skipped.
   * @param ref - change request to poll.
   * @param listener - receives the brief of each poll result.
   * @param known - the state the caller last saw, which times the first poll of a change request without a watcher.
   * @returns the disposer that stops this watch.
   */
  watchBrief(ref: ChangeRequestRef, listener: ChangeRequestBriefListener, known?: ChangeRequestKnownState): () => void {
    const dispose = this.ctx.effect(() => {
      let timing: WatchTiming = { dueAt: Date.now(), joinAt: undefined, polledAt: undefined, unknownMergeability: false }
      if (known !== undefined) {
        timing = {
          ...waitOf(known.fetchedAt, nextPollDelay(known, this.config, false)),
          polledAt: known.fetchedAt,
          unknownMergeability: known.mergeability === 'unknown',
        }
      }
      const watch = this.open(ref, timing)
      watch.briefListeners.add(listener)
      this.schedule()
      return () => {
        watch.briefListeners.delete(listener)
        this.close(watch)
      }
    }, 'forge.watchBrief()')
    return () => void dispose()
  }

  /**
   * Poll a watched change request at once, including after a terminal state.
   * A fetch already in flight is followed immediately by another fetch; an
   * unwatched change request is unchanged. With `options.maxAgeMs`, the caller
   * needs a status no older than that many milliseconds: a change request
   * whose latest poll at either level, in flight or settled, started within
   * them is left alone, and so is a merged one, whose status is final.
   * @param ref - change request to poll.
   * @param options - when the caller needs a status newer than the latest one.
   */
  refresh(ref: ChangeRequestRef, options: ChangeRequestWatchOptions = {}): void {
    const watch = this.watches.get(changeRequestKey(ref))
    if (watch === undefined) return
    const now = Date.now()
    if (options.maxAgeMs !== undefined) {
      // Only a merged change request has no poll scheduled while none is in flight.
      if (watch.dueAt === undefined && watch.reading === undefined) return
      if (watch.polledAt !== undefined && now - watch.polledAt <= options.maxAgeMs) return
    }
    watch.dueAt = now
    this.schedule()
  }

  /**
   * Announce that a watched change request is about to change, as after a push to its head branch. It is polled at
   * once and then every `activeIntervalMs`, until a status reports running checks or a closed or merged change
   * request, and for at most `idleIntervalMs`; after that the regular cadence applies. A fetch already in flight is
   * followed immediately by another fetch; an unwatched change request is unchanged.
   * @param ref - change request the caller expects to change.
   */
  expectChange(ref: ChangeRequestRef): void {
    const watch = this.watches.get(changeRequestKey(ref))
    if (watch === undefined) return
    const now = Date.now()
    watch.expectingUntil = now + this.config.idleIntervalMs
    watch.dueAt = now
    this.schedule()
  }

  /**
   * Read the latest snapshot poll result of a watched change request.
   * @param ref - change request to read.
   * @returns the latest result, or undefined before the first snapshot poll settled or without a watch.
   */
  latest(ref: ChangeRequestRef): ChangeRequestUpdate | undefined {
    return this.watches.get(changeRequestKey(ref))?.latest
  }

  /** The watch of a change request, created with `timing` when it has none. */
  private open(ref: ChangeRequestRef, timing: WatchTiming): Watch {
    const key = changeRequestKey(ref)
    let watch = this.watches.get(key)
    if (watch === undefined) {
      watch = {
        key, ref, listeners: new Set(), briefListeners: new Set(), latest: undefined, reading: undefined, failures: 0, staleHead: undefined,
        expectingUntil: undefined, ...timing,
      }
      this.watches.set(key, watch)
    }
    return watch
  }

  /** Stop polling a change request once its last watcher left. */
  private close(watch: Watch): void {
    if (watch.listeners.size > 0 || watch.briefListeners.size > 0) return
    this.watches.delete(watch.key)
    this.schedule()
  }

  /** Poll a watched change request at once after the first `stale` read or write at `headSha`; later ones wait for the regular poll. */
  private staleRead(ref: ChangeRequestRef, headSha: string, code: ForgeFailure['code']): void {
    const watch = this.watches.get(changeRequestKey(ref))
    if (code !== 'stale' || watch === undefined || watch.staleHead === headSha) return
    watch.staleHead = headSha
    this.refresh(ref)
  }

  /**
   * Run one optional provider action, then poll the change request at once when it is watched and the provider has the
   * action.
   * @param ref - change request served by a registered provider.
   * @param signal - cancellation of the action.
   * @param pick - the provider's action, or undefined when it lacks the capability.
   * @param missing - what a provider without the action does not do, for its failure.
   * @param run - calls the action.
   * @returns the action's failure, or undefined once the host accepted it.
   */
  private async act<A>(
    ref: ChangeRequestRef,
    signal: AbortSignal,
    pick: (provider: ForgeProvider) => A | undefined,
    missing: string,
    run: (action: A, signal: AbortSignal) => Promise<ForgeActionFailure | undefined>,
  ): Promise<ForgeActionFailure | undefined> {
    // Null stands for a provider without the action, which the host was never asked about.
    const failure = await this.invoke(this.registration(ref.repository.forge), signal, (provider, operation) => {
      const action = pick(provider)
      return action === undefined ? Promise.resolve(null) : run(action, operation)
    })
    if (failure === null) return { code: 'failed', message: `This provider ${missing}` }
    this.refresh(ref)
    return failure
  }

  private provider(forge: string): ForgeProvider {
    return this.registration(forge).provider
  }

  private providersChanged(forge: string): void {
    this.announce('provider change', () => this.ctx.parallel('forge/providers-changed', forge))
  }

  private reviewChanged(ref: ChangeRequestRef, change: ForgeReviewChange): void {
    this.announce('review change', () => this.ctx.parallel('forge/review-changed', ref, change))
  }

  /**
   * Start one parallel dispatch unless the service stopped, keeping it among the work disposal waits for and logging
   * listener failures.
   */
  private announce(what: string, dispatch: () => Promise<void>): void {
    if (this.lifetime.signal.aborted) return
    const task = dispatch().catch((error: unknown) => {
      this.ctx.logger.warn(`forge: ${what} listener failed: ${String(error)}`)
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
      if (watch.dueAt === undefined || this.fetching.has(laneOf(watch.ref.repository.forge, levelOf(watch)))) continue
      next = next === undefined ? watch.dueAt : Math.min(next, watch.dueAt)
    }
    if (next === undefined) return
    this.timer = setTimeout(this.tick, Math.max(0, next - Date.now()))
  }

  private poll(): void {
    const now = Date.now()
    const lanes = new Map<string, { readonly forge: string; readonly level: StatusLevel; readonly batch: Watch[]; due: boolean }>()
    for (const watch of this.watches.values()) {
      const forge = watch.ref.repository.forge
      const level = levelOf(watch)
      const lane = laneOf(forge, level)
      if (watch.dueAt === undefined || this.fetching.has(lane)) continue
      const due = watch.dueAt <= now
      if (!due && (watch.joinAt === undefined || watch.joinAt > now)) continue
      let entry = lanes.get(lane)
      if (entry === undefined) lanes.set(lane, entry = { forge, level, batch: [], due: false })
      entry.batch.push(watch)
      entry.due ||= due
    }
    for (const { forge, level, batch, due } of lanes.values()) {
      // Watches past the midpoint of their wait ride along with a due one; alone they wait.
      if (!due) continue
      const task = this.fetch(forge, level, batch)
      this.pending.add(task)
      void task.then(() => this.pending.delete(task))
    }
    this.schedule()
  }

  /**
   * Fetch one forge's batch at one level, as briefs when the level is `brief` and the provider reads them. The batch
   * is read in the parts {@link partsOf} names, one provider call after another; each call has its own
   * `fetchTimeoutMs` deadline, and its watches are settled before the next call starts, so a call that fails or
   * outlives its deadline fails only its own change requests. Never rejects.
   */
  private async fetch(forge: string, level: StatusLevel, batch: readonly Watch[]): Promise<void> {
    const lane = laneOf(forge, level)
    this.fetching.add(lane)
    for (const watch of batch) {
      watch.dueAt = undefined
      watch.reading = level
    }
    const registration = this.providers.get(forge)
    try {
      for (const part of partsOf(batch, registration?.provider, level)) {
        const reading = this.claim(part, level)
        if (reading.length === 0) continue
        const read = await this.read(forge, registration, level, reading)
        // The results of a withdrawn registration are discarded; its withdrawal settled the watches.
        if (this.lifetime.signal.aborted || registration !== this.providers.get(forge)) return
        for (const watch of reading) {
          // A watch whose level changed during this call may be in a call of the other lane by now.
          if (watch.reading === level) watch.reading = undefined
          if (this.watches.get(watch.key) !== watch) continue
          this.settle(watch, 'code' in read ? { failure: read, level } : outcomeOf(watch.key, level, read), watch.dueAt)
        }
      }
    } finally {
      this.fetching.delete(lane)
      for (const watch of batch) if (watch.reading === level) watch.reading = undefined
      this.schedule()
    }
  }

  /**
   * Take the watches of one part that its provider call reads: those still watched that no fetch of the other level
   * has read since the fetch started. A watch whose watchers changed its level while it waited is made due for the
   * fetch of that level instead.
   */
  private claim(part: readonly Watch[], level: StatusLevel): Watch[] {
    const startedAt = Date.now()
    const reading: Watch[] = []
    let moved = false
    for (const watch of part) {
      if (this.watches.get(watch.key) !== watch || watch.reading !== level) continue
      if (levelOf(watch) !== level) {
        watch.reading = undefined
        watch.dueAt ??= startedAt
        moved = true
        continue
      }
      // This call answers a refresh that was asked for while the watch waited for it.
      watch.dueAt = undefined
      watch.polledAt = startedAt
      reading.push(watch)
    }
    if (moved) this.schedule()
    return reading
  }

  /** Read one part of a batch within its own `fetchTimeoutMs` deadline; a call that rejects or outlives it is the part's failure. */
  private async read(
    forge: string, registration: Registration | undefined, level: StatusLevel, part: readonly Watch[],
  ): Promise<Reading | ForgeFailure> {
    if (registration === undefined) return this.missing(forge)
    try {
      using timeout = deadline(this.lifetime.signal, this.config.fetchTimeoutMs, 'FORGE_FETCH_TIMEOUT')
      const refs = part.map(watch => watch.ref)
      return await this.invoke(registration, timeout.signal, async (provider, operation): Promise<Reading> =>
        level === 'brief' && provider.fetchBriefs !== undefined
          ? { kind: 'brief', results: await provider.fetchBriefs(refs, operation) }
          : { kind: 'snapshot', results: await provider.fetch(refs, operation) })
    } catch (error) {
      return { code: 'unavailable', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Record one poll result of a watch, time its next poll, and deliver the result: a snapshot or a snapshot-level
   * failure to both kinds of watchers, a brief or a brief-level failure to brief watchers only.
   */
  private settle(watch: Watch, outcome: Outcome, refreshAt: number | undefined): void {
    const fetchedAt = Date.now()
    const { key } = watch
    let update: ChangeRequestUpdate | undefined
    let brief: ChangeRequestBriefUpdate
    let wait: Pick<Watch, 'dueAt' | 'joinAt'>
    if ('failure' in outcome) {
      watch.failures++
      brief = { key, fetchedAt, failure: outcome.failure }
      if (outcome.level === 'snapshot') update = brief
      wait = { dueAt: fetchedAt + backoffDelay(watch.failures, this.config), joinAt: undefined }
    } else {
      watch.failures = 0
      if ('snapshot' in outcome) update = { key, fetchedAt, snapshot: outcome.snapshot }
      const state = 'snapshot' in outcome ? outcome.snapshot : outcome.brief
      brief = { key, fetchedAt, brief: state }
      let delay = nextPollDelay(state, this.config, watch.unknownMergeability)
      if (watch.expectingUntil !== undefined) {
        // Running checks are the announced change, and nothing follows a closed or merged change request.
        if (state.state !== 'open' || state.checksRollup === 'pending' || fetchedAt >= watch.expectingUntil) watch.expectingUntil = undefined
        else delay = this.config.activeIntervalMs
      }
      wait = waitOf(fetchedAt, delay)
      watch.unknownMergeability = state.mergeability === 'unknown'
    }
    if (update !== undefined) watch.latest = update
    // A refresh requested after this fetch started needs a subsequent fetch, even for a terminal result.
    watch.dueAt = refreshAt ?? wait.dueAt
    watch.joinAt = refreshAt === undefined ? wait.joinAt : undefined
    if (update !== undefined) this.deliver(watch.listeners, update)
    this.deliver(watch.briefListeners, brief)
  }

  private deliver<U>(listeners: ReadonlySet<(update: U) => void>, update: U): void {
    for (const listener of [...listeners]) {
      try {
        listener(update)
      } catch (error) {
        this.ctx.logger.warn(`forge: change request listener failed: ${String(error)}`)
      }
    }
  }
}

/** What a new watch starts with: when it polls first, and what its watcher already knows. */
type WatchTiming = Pick<Watch, 'dueAt' | 'joinAt' | 'polledAt' | 'unknownMergeability'>

/**
 * Time the poll after a status.
 * @param settledAt - epoch milliseconds when the status was read.
 * @param delay - the wait {@link nextPollDelay} chose, or undefined after a terminal state.
 * @returns when the change request is due, and the midpoint of the wait, from which a poll of its lane reads it too.
 */
function waitOf(settledAt: number, delay: number | undefined): Pick<Watch, 'dueAt' | 'joinAt'> {
  return delay === undefined ? { dueAt: undefined, joinAt: undefined } : { dueAt: settledAt + delay, joinAt: settledAt + delay / 2 }
}

/**
 * Split the batch of one fetch into the parts that one provider call reads each.
 * @param batch - watches of one forge that are read at `level`.
 * @param provider - the forge's provider, or undefined without one.
 * @param level - what the fetch reads.
 * @returns the whole batch as one part, unless the provider names a batch size for the method that reads `level`:
 * then the watches of each host, compared without case, in parts of at most that size.
 */
function partsOf(batch: readonly Watch[], provider: ForgeProvider | undefined, level: StatusLevel): readonly (readonly Watch[])[] {
  const size = level === 'brief' && provider?.fetchBriefs !== undefined ? provider.briefBatchSize : provider?.snapshotBatchSize
  if (size === undefined) return [batch]
  const parts: Watch[][] = []
  for (const hosted of Map.groupBy(batch, watch => watch.ref.repository.host.toLowerCase()).values()) {
    for (let start = 0; start < hosted.length; start += size) parts.push(hosted.slice(start, start + size))
  }
  return parts
}

/** The level polls of a watch read at: the snapshot while a snapshot watcher remains. */
function levelOf(watch: Watch): StatusLevel {
  return watch.listeners.size > 0 ? 'snapshot' : 'brief'
}

/** Name the fetch lane of one forge at one level; a level holds no colon, so no two lanes share a name. */
function laneOf(forge: string, level: StatusLevel): string {
  return `${level}:${forge}`
}

/** The outcome of one provider read for one of its change requests, read at `level`. */
function outcomeOf(key: ChangeRequestKey, level: StatusLevel, reading: Reading): Outcome {
  const missing: Outcome = { failure: { code: 'unavailable', message: `provider returned no result for ${key}` }, level }
  if (reading.kind === 'snapshot') {
    const result = reading.results.get(key)
    return result === undefined ? missing : 'code' in result ? { failure: result, level } : { snapshot: result }
  }
  const result = reading.results.get(key)
  return result === undefined ? missing : 'code' in result ? { failure: result, level } : { brief: result }
}

const UNSUPPORTED_VIEWER: ForgeFailure = { code: 'unsupported', message: 'This provider does not read viewer lists' }

/** The viewer reads of one provider, bound to it. */
interface ViewerReads {
  readonly list: NonNullable<ForgeProvider['listForViewer']>
  readonly count: NonNullable<ForgeProvider['countForViewer']>
}

/**
 * The viewer reads a provider offers on a host.
 * @param provider - registered provider.
 * @param host - host the read names.
 * @param filter - list the read names, or undefined for the counts of every list.
 * @returns the bound reads, or an `unsupported` failure naming the missing host or list.
 */
function viewerReads(provider: ForgeProvider, host: string, filter: ForgeViewerFilter | undefined): ViewerReads | ForgeFailure {
  const { viewer } = provider
  const list = provider.listForViewer?.bind(provider)
  const count = provider.countForViewer?.bind(provider)
  if (viewer === undefined || list === undefined || count === undefined) return UNSUPPORTED_VIEWER
  if (!viewer.hosts.includes(host)) return { code: 'unsupported', message: `This provider does not list change requests on ${host}` }
  if (filter !== undefined && !viewer.filters.has(filter)) return { code: 'unsupported', message: `This provider does not read the ${filter} list` }
  return { list, count }
}

export default ForgeService
