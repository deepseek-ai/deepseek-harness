/** Host Remote of the forge panel: checkout, code host, sign-in, change request, and worktree state per Session. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  BranchUpdateMethod, ChangeRequestKey, ChangeRequestRef, ChangeRequestReviewer, ChangeRequestSnapshot, ForgeActionFailure, ForgeCommitList,
  ForgeFailure,
  ForgeLineComment, ForgeRerunRequest, ForgeReviewData, ForgeReviewerCandidate, ForgeReviewRequest, ForgeReviewResult, ForgeReviewWrite,
  ForgeReviewWriteResult, ForgeViewedFiles, ForgeViewedRequest, MergeMethod,
} from '@deepseek-ai/dsh-experimental-forge'
import type { SessionChangeRequest } from '@deepseek-ai/dsh-experimental-forge-session'
import type { WorktreeCleanup } from '@deepseek-ai/dsh-experimental-worktree/types'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-query'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { gitIn, inspectCheckout, listBranches } from './git.ts'
import type { Inspection } from './git.ts'
import { parseDiff } from './diff.ts'
import {
  aheadOf, BaseMissing, baseBranches, chosenForkPoint, CommitsMissing, CommitsNotLinear, DiffTooLarge, FilterConfigError, forkPoint,
  localCommits, localDiff, localOldText, localText, NoForkPoint,
} from './local-diff.ts'
import type { ForkPoint } from './local-diff.ts'
import { LensCache, LensFailed, lensFrames, LensRegistry, LensWithdrawn, runLens } from './lenses.ts'
import type { LensSubject } from './lenses.ts'
import { lensVersion } from './lens-version.ts'
import { rangeStart } from './commit-range.ts'
import { ATTRIBUTES_PATH, FileLayers } from './layers.ts'
import { missingWorktree, SessionPanel } from './panel.ts'
import { PatchCache } from './patch-cache.ts'
import { ReviewCache } from './review-cache.ts'
import { ChangeRequestStates, changeRequestStatesDomain } from './states.ts'
import type { PanelConfig } from './panel.ts'
import type {
  Config, ForgeBaseBranches, ForgeBranches, ForgeChangeRequestDiff, ForgeChangeRequestStatesFrame, ForgeCommitRange, ForgeDiffFile,
  ForgeExtensionState, ForgeLens, ForgeLensFrame, ForgeLensRequest, ForgeLocalCommits, ForgeLocalDiff, ForgeLocalScope,
  ForgeMissingWorktree, ForgePanelState, ForgeSessionWorktree, ForgeWorktreeState,
} from './types.ts'
import { forgeWorktreeProjection, messageOf, within, WORKTREE_RECORD, WorktreeCreations } from './worktree.ts'
import type { HeldWork } from './worktree.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote that serves the forge panel of the GUI. */
    forgePanel: ForgePanelController
  }
}

/** Panel limits plus the branch and commit listing limits, the worktree branch prefix, and the lens and annotation limits. */
type ControllerConfig = PanelConfig & {
  readonly maxBranches: number
  readonly maxCommits: number
  readonly worktreePrefix: string
  readonly lensTimeoutMs: number
  readonly maxLensReadBytes: number
  readonly maxCachedLensBytes: number
  readonly maxAnnotationsPerFile: number
}

/**
 * Serves the forge panel. Following a Session inspects the checkout of its
 * current directory using the Session's permissions and execution world, recognizes the
 * code host of the upstream remote or `origin`, probes sign-in for that host,
 * and polls the Session's bound change requests through `ctx.forge` until the
 * last follower of that Session leaves. A worktree request makes the panel
 * create a branch and checkout through an optional `ctx.worktrees` and enter
 * it while the Session's first message waits in the inbox, or at the first
 * step proposal of a message no wait took. After a failed or stopped attempt
 * the message keeps waiting for another attempt or for the request to be
 * withdrawn. A message also waits while the worktree the Session works in is
 * gone, until that worktree is checked out again or left for the source
 * checkout. Changes to a Session's checkout run as Agent maintenance, so a
 * message that arrives meanwhile waits for them.
 */
export class ForgePanelController extends TypertRemoteService {
  static inject = [
    'forge', 'forgeSession', 'sessionProjections', 'workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy', 'agents',
  ]

  static Config: z<Config> = z.object({
    gitCommand: z.string().default('git'),
    gitTimeoutMs: z.number().default(10_000),
    graceMs: z.number().default(1_000),
    maxOutputBytes: z.number().default(1_048_576),
    readinessTimeoutMs: z.number().default(15_000),
    maxBranches: z.number().default(50),
    worktreePrefix: z.string().default('dsh-'),
    maxDiffBytes: z.number().default(8_388_608),
    maxUntrackedFiles: z.number().default(100),
    maxCachedDiffBytes: z.number().default(16_777_216),
    maxCommits: z.number().default(250),
    testPaths: z.array(z.string()).default([]),
    interfacePaths: z.array(z.string()).default([]),
    maxCachedReviewBytes: z.number().default(16_777_216),
    reviewRefreshMs: z.number().default(60_000),
    lensTimeoutMs: z.number().default(60_000),
    maxLensReadBytes: z.number().default(33_554_432),
    maxCachedLensBytes: z.number().default(4_194_304),
    maxAnnotationsPerFile: z.number().default(100),
  })

  private readonly home: Context
  private readonly config: ControllerConfig
  private readonly panels = new Map<Session, SessionPanel>()
  private worktreeStates!: ProjectionHandle<ForgeWorktreeState>
  private creations!: WorktreeCreations
  private readonly patches: PatchCache
  private readonly layers: FileLayers
  private readonly reviews: ReviewCache
  private readonly lenses = new LensRegistry()
  private readonly lensResults: LensCache
  /** Review changes `forge/review-changed` announced per change request, which each panel entry reports. */
  private readonly reviewRevisions = new Map<ChangeRequestKey, number>()
  private states: ChangeRequestStates | undefined
  private readonly stopPanels: () => Promise<void>
  private readonly stopStates: () => Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'forgePanel')
    const resolved = config as Required<Config>
    if (resolved.gitCommand.trim().length === 0) throw new Error('forge-panel: gitCommand must not be empty')
    for (const key of ['gitTimeoutMs', 'graceMs', 'maxOutputBytes', 'readinessTimeoutMs', 'reviewRefreshMs', 'lensTimeoutMs'] as const) {
      const value = resolved[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new Error(`forge-panel: ${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
      }
    }
    for (const key of [
      'maxBranches', 'maxDiffBytes', 'maxUntrackedFiles', 'maxCachedDiffBytes', 'maxCommits', 'maxCachedReviewBytes', 'maxLensReadBytes',
      'maxCachedLensBytes', 'maxAnnotationsPerFile',
    ] as const) {
      if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-panel: ${key} must be a positive integer`)
    }
    if (!branchPrefix(resolved.worktreePrefix)) throw new Error('forge-panel: worktreePrefix must start a valid Git branch name')
    for (const key of ['testPaths', 'interfacePaths'] as const) {
      if (resolved[key].some(glob => glob.trim() === '')) throw new Error(`forge-panel: ${key} entries must not be empty`)
    }
    this.layers = new FileLayers(resolved.testPaths, resolved.interfacePaths)
    this.home = ctx
    this.config = resolved
    this.patches = new PatchCache(resolved.maxCachedDiffBytes)
    this.reviews = new ReviewCache(resolved.maxCachedReviewBytes, resolved.reviewRefreshMs)
    this.lensResults = new LensCache(resolved.maxCachedLensBytes)
    ctx.effect(() => () => { this.lenses.close() }, 'forge-panel: lens streams')
    this.stopPanels = ctx.effect(() => async () => {
      const panels = [...this.panels.values()]
      this.panels.clear()
      await Promise.allSettled(panels.map(panel => panel.dispose()))
    }, 'forge-panel: stop panels')
    this.stopStates = ctx.effect(() => async () => {
      await this.states?.dispose()
    }, 'forge-panel: stop change request states')
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.home
    const stateOwner = ctx.plugin({
      name: 'forge-panel-state',
      inject: ['sessionProjections'],
      apply: async (scope: Context) => {
        this.worktreeStates = await scope.sessionProjections.register(forgeWorktreeProjection)
      },
    })
    await stateOwner
    // Inbox insertions, step proposals, and Session events read the worktree state, so they start once its reader is ready.
    this.creations = new WorktreeCreations(ctx, this.worktreeStates, this.config.worktreePrefix, (session) => {
      this.panels.get(session)?.updateWorktree()
    })
    const inbox = ctx.on('agent/inbox/inserted', ({ agent }) => { this.holdTurn(agent) })
    const events = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.panels.get(session)?.observe(event)
    })
    const reviewChanges = ctx.on('forge/review-changed', (ref: ChangeRequestRef) => { this.reviewChanged(ref) })
    const services = ctx.on('internal/service', (name: string) => {
      if (name !== 'worktrees') return
      for (const panel of this.panels.values()) panel.updateWorktree()
    })
    const { creations, stopPanels, stopStates } = this
    ctx.effect(function* () {
      yield stateOwner.dispose
      yield inbox
      yield events
      yield reviewChanges
      yield services
      yield stopPanels
      yield stopStates
      yield creations.dispose
    }, 'forge-panel: drain before releasing state')
  }

  /**
   * Stream the panel state of a Session: the current state first, then each
   * later state. Intermediate states may be skipped when the reader is slower
   * than the updates. The stream ends when `signal` aborts or the Remote stops.
   * @param session - Session to follow.
   * @param signal - ends the stream.
   * @returns panel states in publication order.
   */
  @Remote({ mode: 'stream' })
  async *follow(session: Session, signal: AbortSignal): AsyncIterable<ForgePanelState> {
    yield* this.panelOf(session).follow(signal)
  }

  /**
   * Stream the last known state of every change request that a listed
   * Session the caller may read binds: the stored states first, then each
   * state a poll changes or a new binding reveals. Listing reads no Session
   * log: loaded Sessions report their bindings, others the cached Session
   * summary, and a Session without one shows nothing until it is opened.
   * Closed requests are polled at the idle cadence so reopening is observed. The
   * stream ends when `signal` aborts or the Remote stops.
   * @param signal - ends the stream.
   * @returns frames in publication order.
   * @throws when the Host lacks the Session query, projection cache, storage, or Session store service.
   */
  @Remote({ mode: 'stream' })
  async *changeRequestStates(signal: AbortSignal): AsyncIterable<ForgeChangeRequestStatesFrame> {
    const access = this.ctx.get('remoteAccess')
    yield* this.changeRequestStatesHub().stream(id => access === undefined || access.allows({ kind: 'session', id }), signal)
  }

  /**
   * Read or await the worktree service's archive cleanup of the Session's checkout.
   * @param session - Session whose cleanup is visible to the caller.
   * @param revision - null reads now; a matching revision waits for completion.
   * @returns the cleanup state, or null without a worktree service, an attempt, or a current revision.
   */
  @Remote
  async worktreeCleanup(session: Session, revision: number | null): Promise<WorktreeCleanup | null> {
    return await this.home.get('worktrees')?.cleanupOf(session, revision) ?? null
  }

  /**
   * List the local branches that can start a worktree of the Session's current checkout.
   * @param session - Session whose current directory is listed.
   * @param signal - request cancellation.
   * @returns the checked-out branch and at most `maxBranches` local branches, the checked-out one first.
   * @throws when the current directory is not inside a checkout or Git fails.
   */
  @Remote
  async branches(session: Session, signal: AbortSignal): Promise<ForgeBranches> {
    return await listBranches(this.home, this.config, session, this.home.workingDirectory.get(session), this.config.maxBranches, signal)
  }

  /**
   * List the branches the `branch` scope of the Session's current checkout can compare with.
   * @param session - Session whose checkout is read.
   * @param query - text the branch names must contain, ignoring case; empty for every branch.
   * @param signal - request cancellation.
   * @returns the automatic fork point and at most `maxBranches` remote-tracking and local branches each,
   * most recently committed first, without the checked-out branch.
   * @throws `forgePanel/not-a-checkout` outside a checkout; the Git error when Git fails or the listed refs exceed `maxDiffBytes`.
   */
  @Remote
  async diffBases(session: Session, query: string, signal: AbortSignal): Promise<ForgeBaseBranches> {
    signal.throwIfAborted()
    const inspection = await this.checkoutOf(session, signal)
    // A search can match any branch, so every ref is listed; a repository's refs can far exceed other short Git output.
    const git = gitIn(this.home, { ...this.config, maxOutputBytes: this.config.maxDiffBytes }, session, inspection.checkout.root, signal)
    return await baseBranches(git, inspection, this.worktreeState(session).created, query, this.config.maxBranches)
  }

  /* oxlint-disable typescript/require-await -- async keeps a refused or cancelled request a rejection, as Remote callers expect */
  /**
   * Bind a change request to a Session by URL, or restore a dismissed binding.
   * @param session - Session that receives the binding.
   * @param url - web URL of the change request.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no registered provider serves the URL.
   */
  @Remote
  async track(session: Session, url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.home.forge.changeRequestFromUrl(url) === undefined) {
      throw new RemoteError('forgePanel/unrecognized-url', 'No code host provider recognizes the change request URL', {})
    }
    this.home.forgeSession.track(session, url)
  }

  /**
   * Hide a visible binding of a Session; other URLs leave the Session unchanged.
   * @param session - Session that owns the binding.
   * @param url - web URL of the change request.
   * @param signal - request cancellation.
   */
  @Remote
  async dismiss(session: Session, url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.home.forgeSession.dismiss(session, url)
  }

  /**
   * Reinspect a followed Session's checkout, probe sign-in again, and poll its
   * change requests at once; an unfollowed Session is unchanged.
   * @param session - Session whose panel refreshes.
   * @param signal - request cancellation.
   * @returns settles once the inspection and the sign-in probe have ended; poll results reach the panel stream later.
   */
  @Remote
  async refresh(session: Session, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.panels.get(session)?.refresh()
  }

  /**
   * Read the changes one scope covers in the checkout of the Session's
   * current directory, with Git using the Session's sandbox policy.
   * @param session - Session whose checkout is read.
   * @param scope - which changes to read.
   * @param signal - request cancellation.
   * @returns the files, the base of the `branch` scope, and the untracked files left out.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/base-missing` when the base branch
   * chosen for the `branch` scope does not exist; `forgePanel/no-fork-point` for the `branch` scope without
   * a fork point; `forgePanel/commits-missing` when chosen commits are not between the fork point and HEAD in order;
   * `forgePanel/commits-not-linear` when a chosen commit's first parent is not the commit listed before it;
   * `forgePanel/filter-config-failed` when filter configuration cannot be read completely, before
   * any comparison; `forgePanel/diff-too-large` over `maxDiffBytes`; the Git error when Git fails.
   */
  @Remote
  async localDiff(session: Session, scope: ForgeLocalScope, signal: AbortSignal): Promise<ForgeLocalDiff> {
    signal.throwIfAborted()
    const inspection = await this.checkoutOf(session, signal)
    const root = inspection.checkout.root
    const git = gitIn(this.home, this.config, session, root, signal)
    const created = this.worktreeState(session).created
    const fork = scope.kind !== 'branch' ? null
      : await diffing(scope.base === null ? forkPoint(git, inspection, created) : chosenForkPoint(git, scope.base))
    return await diffing(localDiff(this.home, this.config, session, root, fork, scope, this.layers, signal))
  }

  /**
   * List the commits of the `branch` scope of the Session's current checkout, which the changes view can show one or
   * several of instead of the whole scope.
   * @param session - Session whose checkout is read.
   * @param base - the base ref of the `branch` scope, or null for its automatic fork point.
   * @param signal - request cancellation.
   * @returns the newest `maxCommits` commits between the fork point and HEAD, oldest first, and HEAD's commit.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/base-missing` when the base branch does not
   * exist; `forgePanel/no-fork-point` without a fork point; the Git error when Git fails or the listing exceeds `maxDiffBytes`.
   */
  @Remote
  async localCommits(session: Session, base: string | null, signal: AbortSignal): Promise<ForgeLocalCommits> {
    signal.throwIfAborted()
    const inspection = await this.checkoutOf(session, signal)
    const git = gitIn(this.home, { ...this.config, maxOutputBytes: this.config.maxDiffBytes }, session, inspection.checkout.root, signal)
    const created = this.worktreeState(session).created
    const fork = await diffing(base === null ? forkPoint(git, inspection, created) : chosenForkPoint(git, base))
    if (fork === null) throw new RemoteError('forgePanel/no-fork-point', 'The checkout has no fork point to compare its branch with', {})
    return await localCommits(git, fork, this.config.maxCommits)
  }

  /**
   * Read the new side of one changed file in a scope, which supplies the
   * unchanged lines between its hunks: the index for `staged`, the last chosen commit for chosen commits of
   * the `branch` scope, else the working tree.
   * @param session - Session whose checkout is read.
   * @param scope - the scope the diff was read in.
   * @param path - path relative to the checkout's top-level directory, as the diff names it.
   * @param signal - request cancellation.
   * @returns the text.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/diff-too-large` over `maxDiffBytes`;
   * `forgePanel/commits-missing` for a chosen commit that is not a full object name; an error for a path outside
   * the checkout, binary content, or a failed read.
   */
  @Remote
  async localText(session: Session, scope: ForgeLocalScope, path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const inspection = await this.checkoutOf(session, signal)
    return await diffing(localText(this.home, this.config, session, inspection.checkout.root, scope, path, signal))
  }

  /**
   * Load complete checks for the change request whose list the user opened.
   * @param session - Session retaining the visible binding.
   * @param url - binding URL.
   * @param headSha - commit displayed by the card; a different head rejects the result.
   * @param signal - cancellation when the list closes.
   * @returns the complete snapshot at the displayed head.
   * @throws `forgePanel/not-bound` for an invisible binding, `forgePanel/stale-head` for a moved head,
   * or `forgePanel/checks-failed` when the provider cannot complete the read.
   */
  @Remote
  async changeRequestChecks(session: Session, url: string, headSha: string, signal: AbortSignal): Promise<ChangeRequestSnapshot> {
    signal.throwIfAborted()
    const result = await this.home.forge.fetchChecks(this.bound(session, url).ref, signal)
    this.bound(session, url)
    if ('code' in result) throw new RemoteError('forgePanel/checks-failed', result.message, {})
    if (result.headSha !== headSha) throw new RemoteError('forgePanel/stale-head', 'The change request head changed; refresh its status', {})
    return result
  }

  /**
   * List the commits of a change request of a Session at its current head, which the changes view can show one or
   * several of instead of the whole change request.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param signal - request cancellation.
   * @returns the commits oldest first with the head they were read at, or null when the provider does not read commits.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/diff-failed` when the host does not list them.
   */
  @Remote
  async changeRequestCommits(session: Session, url: string, signal: AbortSignal): Promise<ForgeCommitList | null> {
    signal.throwIfAborted()
    const list = await this.home.forge.commits(this.bound(session, url).ref, signal)
    if (list !== undefined && 'code' in list) throw readError(list)
    return list ?? null
  }

  /**
   * Read the changes of a change request of a Session as its code host
   * computes them, with each file's layer following the root `.gitattributes`
   * of the commit the diff ends at. Without `commits` the diff covers the change
   * request at the head commit of its latest status; a patch already read at the
   * same head commit and base branch is reused from memory with its attributes, for
   * any Session, until `maxCachedDiffBytes` evicts it. With `commits`, it covers those
   * commits, from the first one's first parent to the last, and is read every time.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param commits - consecutive commits of the change request, or null for all of it.
   * @param signal - request cancellation.
   * @returns the files, the commit they end at, each file's web page, and the commits the checkout has beyond the head.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/commits-missing` when chosen commits are not among the change request's commits in order;
   * `forgePanel/commits-not-linear` when a chosen commit's first parent is not the commit listed before it;
   * `forgePanel/stale-head` without `commits` when the head moved past the latest status, which is then polled again;
   * `forgePanel/diff-too-large` when the host or its provider refuses the diff over a size limit;
   * `forgePanel/diff-failed` before its status was read, for a first chosen commit without a parent, and when the host
   * does not provide the commits, the diff, or an existing `.gitattributes` otherwise.
   */
  @Remote
  async changeRequestDiff(
    session: Session, url: string, commits: ForgeCommitRange | null, signal: AbortSignal,
  ): Promise<ForgeChangeRequestDiff> {
    signal.throwIfAborted()
    const { ref, update } = this.bound(session, url)
    if (update === null || !('snapshot' in update)) {
      throw new RemoteError('forgePanel/diff-failed', 'The change request status has not been read yet', {})
    }
    if (commits !== null) {
      const { files } = await this.commitFiles(ref, commits, signal)
      const fileUrls = Object.fromEntries(files.map(file => [file.path, this.home.forge.fileUrl(ref, commits.to, file.path)]))
      return { headSha: commits.to, files, localAhead: null, fileUrls }
    }
    const { headSha, headBranch } = update.snapshot
    const files = await this.headFiles(ref, update.snapshot, signal)
    let localAhead: number | null = null
    try {
      localAhead = await aheadOf(
        gitIn(this.home, this.config, session, this.home.workingDirectory.get(session), signal), headBranch, headSha,
      )
    } catch (_error) {
      // The count only adds a notice; without Git the view still shows the host's diff.
    }
    signal.throwIfAborted()
    const fileUrls = Object.fromEntries(files.map(file => [file.path, this.home.forge.fileUrl(ref, headSha, file.path)]))
    return { headSha, files, localAhead, fileUrls }
  }

  /**
   * Read one file of a change request's repository at a commit, which
   * supplies the unchanged lines between the hunks of its diff.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param commit - commit object name, the head commit of the diff.
   * @param path - path relative to the repository root.
   * @param signal - request cancellation.
   * @returns the text.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/diff-too-large` when the host or its provider refuses the file over a size limit;
   * `forgePanel/diff-failed` when the host does not provide the file otherwise.
   */
  @Remote
  async changeRequestText(session: Session, url: string, commit: string, path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const text = await this.home.forge.fileText(this.bound(session, url).ref, commit, path, signal)
    if (typeof text !== 'string') throw readError(text)
    return text
  }

  /**
   * Register a filter lens as an effect on the calling fiber. The changes views list it while it is registered; ending
   * the registration aborts its running classifications and waits for them.
   * @param lens - the lens.
   * @returns the disposer that unregisters the lens and waits for its classifications to stop.
   * @throws when another registration holds `lens.id`.
   */
  registerLens(lens: ForgeLens): () => Promise<void> {
    const dispose = this.ctx.effect(() => this.lenses.add(lens), 'forge-panel: lens')
    return async () => { await dispose() }
  }

  /**
   * Stream the facts every changes view reads about the panel's extensions: the current facts first, then the facts
   * after each lens registration or withdrawal. The stream ends when `signal` aborts or the Remote stops.
   * @param signal - ends the stream.
   * @returns the registered lenses and the annotation limit, in publication order.
   */
  @Remote({ mode: 'stream' })
  async *extensions(signal: AbortSignal): AsyncIterable<ForgeExtensionState> {
    for await (const lenses of this.lenses.follow(signal)) yield { lenses, maxAnnotationsPerFile: this.config.maxAnnotationsPerFile }
  }

  /**
   * Classify the files a changes view of a Session shows with one registered lens: progress frames while the lens
   * runs, then the files it keeps. Results for the same files, lens, and lens version are reused from memory until
   * `maxCachedLensBytes` evicts them. Local changes are read with the Session's permissions; a change request's files
   * are those `changeRequestDiff` reads.
   * @param session - Session whose checkout or binding the view shows.
   * @param request - the view's source, the version of the files it shows, and the lens.
   * @param signal - ends the classification.
   * @returns progress frames, then one result frame.
   * @throws `forgePanel/lens-missing` while no lens holds the identity or once its registration ends;
   * `forgePanel/lens-stale` before a change request's status was read, when the files differ from `request.version`, and
   * when local files changed while the lens ran;
   * `forgePanel/lens-failed` when the lens fails, runs past `lensTimeoutMs`, reads past `maxLensReadBytes`, or answers
   * over `maxCachedLensBytes`; the errors of `localDiff` and `changeRequestDiff` for the files.
   */
  @Remote({ mode: 'stream' })
  async *changesLens(session: Session, request: ForgeLensRequest, signal: AbortSignal): AsyncIterable<ForgeLensFrame> {
    signal.throwIfAborted()
    const registration = this.lenses.get(request.lens)
    if (registration === undefined) throw new RemoteError('forgePanel/lens-missing', `No lens "${request.lens}" is registered`, {})
    const subject = await this.lensSubject(session, request.source, signal)
    // The registration may have ended while the files were read; its lens neither runs nor answers from memory then.
    signal.throwIfAborted()
    if (registration.lifetime.aborted) throw new RemoteError('forgePanel/lens-missing', `No lens "${request.lens}" is registered`, {})
    if (lensVersion(subject.files) !== request.version) {
      throw new RemoteError('forgePanel/lens-stale', 'The changes were read again since the view showed them', {})
    }
    const key = JSON.stringify([subject.key, request.version, request.lens, registration.lens.version])
    const kept = this.lensResults.get(key)
    if (kept !== undefined) {
      yield { kind: 'result', files: kept }
      return
    }
    const limits = {
      timeoutMs: this.config.lensTimeoutMs, maxReadBytes: this.config.maxLensReadBytes, maxResultBytes: this.config.maxCachedLensBytes,
    }
    try {
      for await (const frame of lensFrames(progress => runLens(registration, subject, limits, signal, progress))) {
        if (frame.kind === 'result') {
          // Local files can change while the lens reads them; a result about other contents is neither kept nor sent.
          if (request.source.kind === 'local') {
            const now = await this.lensSubject(session, request.source, signal)
            if (lensVersion(now.files) !== request.version) {
              throw new RemoteError('forgePanel/lens-stale', 'The changes moved while the lens read them', {})
            }
          }
          this.lensResults.set(key, frame.files)
        }
        yield frame
      }
    } catch (error) {
      if (error instanceof LensWithdrawn) throw new RemoteError('forgePanel/lens-missing', error.message, {})
      if (error instanceof LensFailed) throw new RemoteError('forgePanel/lens-failed', error.message, {})
      throw error
    }
  }

  /**
   * Read the signed-in user's viewed marks on the files of a change request of a Session, which the host keeps for the
   * whole change request.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param headSha - head commit of the shown diff; marks read at another head are refused.
   * @param signal - request cancellation.
   * @returns the marks at `headSha`, or null when the provider keeps no viewed marks.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/stale-head` when the head moved past `headSha`, which is then polled again; `forgePanel/viewed-failed`
   * when the host does not provide the marks otherwise.
   */
  @Remote
  async changeRequestViewed(session: Session, url: string, headSha: string, signal: AbortSignal): Promise<ForgeViewedFiles | null> {
    signal.throwIfAborted()
    const result = await this.home.forge.viewedFiles(this.bound(session, url).ref, headSha, signal)
    if (result === undefined) return null
    if ('code' in result) {
      throw new RemoteError(result.code === 'stale' ? 'forgePanel/stale-head' : 'forgePanel/viewed-failed', result.message, {})
    }
    return result
  }

  /**
   * Set or clear the signed-in user's viewed mark on one file of a change request of a Session.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param request - the file, its mark, and the head commit of the shown diff.
   * @param signal - request cancellation.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/stale-head` when the head moved past `request.headSha`; `forgePanel/action-failed` with the host's
   * reason when the host refuses, cannot be reached, or keeps no viewed marks; `forgePanel/action-unknown` when the host
   * did not confirm whether it saved the mark.
   */
  @Remote
  async setFileViewed(session: Session, url: string, request: ForgeViewedRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const { ref } = this.bound(session, url)
    if (request.path === '') throw new Error('Invalid viewed file')
    const failure = await this.home.forge.setViewed(ref, request, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Read the review threads of a change request of a Session at the head commit of its displayed diff. Threads read
   * at the same head commit and update time are reused from memory, for any Session, until they are
   * `reviewRefreshMs` old, `maxCachedReviewBytes` evicts them, or a review write through this panel drops them; a read
   * again after that age, or a `fresh` read, shows threads resolved elsewhere since, which do not change a GitHub pull
   * request's update time.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param headSha - head commit of the displayed diff.
   * @param fresh - whether to read from the host even when threads at this head and update time are kept, as after the
   * reader refreshes the view; the result replaces the kept threads.
   * @param signal - request cancellation.
   * @returns the threads at `headSha`, with `current` positions numbering the files of that diff.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/stale-head` when the latest status or the host names another head, which a host answer polls again;
   * `forgePanel/review-unsupported` when the provider cannot read reviews; `forgePanel/review-failed` before the
   * status was read and when the host does not provide the threads otherwise.
   */
  @Remote
  async changeRequestReview(session: Session, url: string, headSha: string, fresh: boolean, signal: AbortSignal): Promise<ForgeReviewData> {
    signal.throwIfAborted()
    const { ref, update } = this.bound(session, url)
    if (update === null || !('snapshot' in update)) {
      throw new RemoteError('forgePanel/review-failed', 'The change request status has not been read yet', {})
    }
    if (update.snapshot.headSha !== headSha) {
      throw new RemoteError('forgePanel/stale-head', `The change request head moved from ${headSha} to ${update.snapshot.headSha}`, {})
    }
    const key = changeRequestKey(ref)
    const version = JSON.stringify([headSha, update.snapshot.updatedAt])
    const readAt = Date.now()
    const kept = fresh ? undefined : this.reviews.get(key, version, readAt)
    if (kept !== undefined) return kept
    const token = this.reviews.token()
    const review = await this.home.forge.readReview(ref, headSha, signal)
    if ('code' in review) throw reviewError(review)
    this.reviews.set(key, version, review, readAt, token)
    return review
  }

  /**
   * Publish a line comment or completed review for a visible Session binding. The threads kept for the change request
   * are dropped once the host answers, so the next read shows the comments.
   * @param session - Session retaining the change request.
   * @param url - visible binding URL.
   * @param request - reviewed head, ranges, plain text, and explicit review decision.
   * @param signal - request cancellation.
   * @returns confirmed publication or a typed failure; unknown outcomes require reconciliation on the host.
   */
  @Remote
  async submitReview(session: Session, url: string, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult> {
    signal.throwIfAborted()
    const { ref } = this.bound(session, url)
    if (!isCommit(request.headSha)) throw new Error('Invalid review commit')
    const comments = request.kind === 'comment' ? [request.comment] : request.comments
    if (!comments.every(validComment)) throw new Error('Invalid review comment')
    if (request.kind === 'review' && request.event !== 'approve' && request.body.trim() === '' && comments.length === 0) throw new Error('Empty review')
    try {
      return await this.home.forge.submitReview(ref, request, signal)
    } finally {
      this.reviews.drop(changeRequestKey(ref))
    }
  }

  /**
   * Write to the review threads or the pending review of a change request of a Session while its head is still the
   * head the user saw. The threads kept for the change request are dropped once the host answers, so the next read
   * shows the write, which a resolve does not show through a GitHub pull request's update time.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param write - the write and the head commit of the threads the user saw.
   * @param signal - request cancellation.
   * @returns whether the host took the write; `stale` once the head moved, which polls the change request again, and
   * `unknown` when the outcome must be checked on the host before the write is tried again.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves; an error
   * for a write without text, a head that is not a commit object name, or an invalid line range.
   */
  @Remote
  async changeRequestReviewWrite(
    session: Session, url: string, write: ForgeReviewWrite, signal: AbortSignal,
  ): Promise<ForgeReviewWriteResult> {
    signal.throwIfAborted()
    const { ref } = this.bound(session, url)
    if (!isCommit(write.headSha)) throw new Error('Invalid review commit')
    if (!validWrite(write)) throw new Error('Invalid review write')
    try {
      return await this.home.forge.writeReview(ref, write, signal)
    } finally {
      this.reviews.drop(changeRequestKey(ref))
    }
  }

  /**
   * Mark a draft change request of a Session ready for review; the change
   * request is polled again once the host answers.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param signal - request cancellation.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/action-failed` with the host's reason when the host refuses or cannot be reached.
   */
  @Remote
  async markReady(session: Session, url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const failure = await this.home.forge.markReady(this.bound(session, url).ref, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Merge a change request of a Session while its head is still `headSha`;
   * the change request is polled again once the host answers.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param method - how the commits enter the base branch.
   * @param headSha - head commit the user confirmed.
   * @param signal - request cancellation.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/stale-head` when the head moved past `headSha`; `forgePanel/action-failed` with the host's
   * reason when the host refuses otherwise or cannot be reached.
   */
  @Remote
  async merge(session: Session, url: string, method: MergeMethod, headSha: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const failure = await this.home.forge.merge(this.bound(session, url).ref, { method, headSha }, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Rerun the failed checks of a change request of a Session while its head is still the commit whose checks the user
   * saw; the change request is polled again once the host answers.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param request - the head commit whose checks the user saw.
   * @param signal - request cancellation.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/stale-head` when the head moved past `request.headSha`; `forgePanel/action-failed` with the host's
   * reason when the host refuses, cannot be reached, or reruns no checks; `forgePanel/action-unknown` when the host did
   * not confirm whether it started the rerun.
   */
  @Remote
  async rerunChecks(session: Session, url: string, request: ForgeRerunRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const failure = await this.home.forge.rerunChecks(this.bound(session, url).ref, request, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Request reviews of a change request of a Session from more reviewers; the change request is polled again once the
   * host answers.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param reviewers - the reviewers to ask, by kind and login.
   * @param signal - request cancellation.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/action-failed` with the host's reason when the host refuses, cannot be reached, or requests no reviews;
   * `forgePanel/action-unknown` when the host did not confirm whether it requested the reviews.
   */
  @Remote
  async requestReviews(
    session: Session, url: string, reviewers: readonly Pick<ChangeRequestReviewer, 'kind' | 'login'>[], signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    const { ref } = this.bound(session, url)
    if (reviewers.length === 0 || reviewers.some(reviewer => reviewer.login.trim() === '')) throw new Error('Invalid reviewers')
    const failure = await this.home.forge.requestReviews(ref, { reviewers }, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * List accounts a review of a change request of a Session can be requested from.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param query - text the login or name contains; empty for the host's suggestions and first accounts.
   * @param signal - request cancellation.
   * @returns the accounts, the host's suggestions first.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/reviewers-failed` when the host does not list them.
   */
  @Remote
  async reviewerCandidates(session: Session, url: string, query: string, signal: AbortSignal): Promise<readonly ForgeReviewerCandidate[]> {
    signal.throwIfAborted()
    const result = await this.home.forge.reviewerCandidates(this.bound(session, url).ref, query, signal)
    if ('code' in result) throw new RemoteError('forgePanel/reviewers-failed', result.message, {})
    return result
  }

  /**
   * Bring the base branch's new commits into the head branch of a change request of a Session while its head is still
   * `headSha`; the change request is polled again once the host answers.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param method - merge commit or rebase.
   * @param headSha - head commit the user confirmed.
   * @param signal - request cancellation.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/stale-head` when the head moved past `headSha`; `forgePanel/action-failed` with the host's reason when
   * the host refuses, cannot be reached, or updates no branches; `forgePanel/action-unknown` when the host did not
   * confirm whether it started the update.
   */
  @Remote
  async updateBranch(session: Session, url: string, method: BranchUpdateMethod, headSha: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const failure = await this.home.forge.updateBranch(this.bound(session, url).ref, { method, headSha }, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Ask for a new worktree before the Session's first turn, replacing an open
   * request and forgetting a failed attempt. While the next message waits in
   * the inbox, or else at the first step proposal, the panel creates a branch
   * from `from`, or from HEAD of the current checkout when it is null, and
   * enters its checkout. A message that already waits after a failed or
   * stopped attempt keeps waiting for {@link ForgePanelController.retryWorktree}.
   * @param session - Session without a started turn.
   * @param from - local base branch, or null for HEAD.
   * @param signal - request cancellation.
   * @throws `forgePanel/invalid-branch` when `from` is empty; `forgePanel/worktrees-unavailable`
   * without a worktree service; `forgePanel/session-started` after a turn started or the worktree was
   * created; `forgePanel/session-busy` while the worktree is being created.
   */
  @Remote
  async requestWorktree(session: Session, from: string | null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (from?.length === 0) throw new RemoteError('forgePanel/invalid-branch', 'The base branch name is empty', {})
    this.editableWorktree(session)
    this.creations.forget(session)
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from })
    this.creations.recheck(session)
  }

  /**
   * Withdraw the open worktree request of a Session with its failed attempt,
   * which lets a waiting message go on in the current checkout; without a
   * request the Session is unchanged. Withdrawing needs no worktree service.
   * @param session - Session without a started turn.
   * @param signal - request cancellation.
   * @throws `forgePanel/session-started` after a turn started or the worktree was created;
   * `forgePanel/session-busy` while the worktree is being created.
   */
  @Remote
  async cancelWorktree(session: Session, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.changeableWorktree(session).request === null) return
    this.creations.forget(session)
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'cancel' })
    this.creations.recheck(session)
  }

  /**
   * Stop the creation a message of the Session waits for; the message keeps
   * waiting with the request still open. Without such a creation the Session
   * is unchanged.
   * @param session - Session whose creation stops.
   * @param signal - request cancellation.
   */
  @Remote
  async stopCreation(session: Session, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.creations.stop(session)
  }

  /**
   * Make another attempt, with a new branch name, at the worktree a message
   * of the Session waits for after a failed or stopped attempt.
   * @param session - Session whose message waits.
   * @param signal - request cancellation.
   * @throws `forgePanel/not-waiting` when no message waits or an attempt is running.
   */
  @Remote
  async retryWorktree(session: Session, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.creations.retry(session)) {
      throw new RemoteError('forgePanel/not-waiting', 'No message waits for another attempt at the worktree', {})
    }
  }

  /**
   * Check out the created worktree of a Session again at its recorded
   * directory when that directory is gone: its branch when the branch still
   * exists, otherwise a new branch of the same name at the base commit. Changes
   * that were never committed are not recovered. Runs as Agent maintenance,
   * inside the wait of a message that waits for the restoration, which then
   * goes on; without a missing directory the Session is unchanged.
   * @param session - Session whose worktree directory is gone.
   * @param signal - request cancellation, which aborts the restoration.
   * @throws `forgePanel/no-worktree` without a created worktree; `forgePanel/worktrees-unavailable`
   * without a worktree service; `forgePanel/session-busy` while the Session's Agent is not loaded or
   * has other work; `forgePanel/restore-failed` when Git fails.
   */
  @Remote
  async restoreWorktree(session: Session, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const created = this.createdWorktree(session)
    const worktrees = this.home.get('worktrees')
    if (worktrees === undefined) throw new RemoteError('forgePanel/worktrees-unavailable', 'No worktree service is mounted', {})
    await this.maintain(session, async (agent, work) => {
      const operation = AbortSignal.any([signal, work])
      try {
        await this.creations.restore(agent, worktrees, created, operation,
          () => { this.panels.get(session)?.restored() },
          async check => await missingWorktree(this.home, this.config, session, this.worktreeState(session), created.path, check) === null)
      } catch (error) {
        operation.throwIfAborted()
        throw new RemoteError('forgePanel/restore-failed', messageOf(error), {}, { cause: error })
      }
    })
    this.panels.get(session)?.reinspect()
  }

  /**
   * Move a Session from its created worktree to the source checkout the
   * worktree came from; the Session no longer works in the worktree. Runs as
   * Agent maintenance, inside the wait of a message that waits for the removed
   * worktree, which then goes on.
   * @param session - Session with a created worktree.
   * @param signal - request cancellation.
   * @throws `forgePanel/no-worktree` without a created worktree; `forgePanel/session-busy` while the
   * Session's Agent is not loaded or has other work; the working-directory service's error when the
   * source checkout no longer exists.
   */
  @Remote
  async continueInProject(session: Session, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const created = this.createdWorktree(session)
    await this.maintain(session, async (agent, work) => {
      await this.home.workingDirectory.set(agent, created.repositoryRoot, AbortSignal.any([signal, work]))
    })
  }

  /* oxlint-enable typescript/require-await */

  /**
   * Hold the turn of a message entering a Session's inbox while the
   * Session's requested worktree does not exist yet, or while the worktree
   * the Session works in is checked and, when gone, until it is restored or
   * left. The message is entering, so the delivery has not woken the Agent
   * yet and its wake waits for the hold.
   * @param agent - Agent whose inbox receives the message.
   */
  private holdTurn(agent: Agent): void {
    const session = agent.session
    const state = this.worktreeState(session)
    if (state.request !== null && state.created === null && !state.locked) {
      this.creations.holdCreation(agent)
    } else if (state.created !== null && within(state.created.path, this.home.workingDirectory.get(session))) {
      this.creations.holdRestoration(agent, signal => this.missingFor(session, signal))
    }
  }

  /**
   * Check whether the worktree the Session works in is gone.
   * @param session - Session to check.
   * @param signal - cancellation of the check.
   * @returns the missing worktree, or null while it exists or once the Session works elsewhere.
   * @throws when the filesystem or Git cannot answer.
   */
  private async missingFor(session: Session, signal: AbortSignal): Promise<ForgeMissingWorktree | null> {
    const directory = this.home.workingDirectory.get(session)
    const panel = this.panels.get(session)
    const missing = panel === undefined
      ? await missingWorktree(this.home, this.config, session, this.worktreeState(session), directory, signal)
      : await panel.checkMissing(signal)
    return this.home.workingDirectory.get(session) === directory ? missing : null
  }

  /** The files of a change request at the head a status recorded, read once per head and base branch while the cache keeps them. */
  private async headFiles(ref: ChangeRequestRef, snapshot: ChangeRequestSnapshot, signal: AbortSignal): Promise<ForgeDiffFile[]> {
    const { headSha, baseBranch } = snapshot
    const key = changeRequestKey(ref)
    const version = JSON.stringify([headSha, baseBranch])
    let read = this.patches.get(key, version)
    if (read === undefined) {
      read = await this.patchAt(ref, headSha, async operation => await this.home.forge.diff(ref, headSha, operation), signal)
      this.patches.set(key, version, read)
    }
    return this.layers.classify(parseDiff(read.patch), read.attributes)
  }

  /** The files of consecutive commits of a change request, from the first one's first parent, which is returned too, to the last. */
  private async commitFiles(
    ref: ChangeRequestRef, commits: ForgeCommitRange, signal: AbortSignal,
  ): Promise<{ readonly files: ForgeDiffFile[]; readonly parent: string }> {
    const list = await this.home.forge.commits(ref, signal)
    if (list === undefined) throw new RemoteError('forgePanel/diff-failed', 'The code host provider does not read commits', {})
    if ('code' in list) throw readError(list)
    const start = rangeStart(list.commits, commits)
    if (start === 'missing') throw new RemoteError('forgePanel/commits-missing', 'The chosen commits are no longer in the change request', {})
    if (start === 'not-linear') throw new RemoteError('forgePanel/commits-not-linear', 'The chosen commits are not one run of first parents', {})
    const parent = start.parent
    if (parent === null) throw new RemoteError('forgePanel/diff-failed', 'The first chosen commit has no parent to compare with', {})
    const { patch, attributes } = await this.patchAt(
      ref, commits.to, async operation => await this.home.forge.compare(ref, parent, commits.to, operation), signal,
    )
    return { files: this.layers.classify(parseDiff(patch), attributes), parent }
  }

  /**
   * Read a patch that ends at `commit` together with the root `.gitattributes` at that commit. A failed patch read
   * cancels the attributes read. Both reads end before the result: the patch's failure passes on first, and the
   * attributes failure only after the patch was read, so the outcome does not depend on which read ends first.
   * @param ref - change request whose repository holds the commit.
   * @param commit - commit the patch ends at.
   * @param readPatch - reads the patch under the given cancellation.
   * @param signal - request cancellation.
   * @returns the patch and the attributes text, empty when the commit has none.
   * @throws the Remote error for a refused patch or attributes read, or `signal.reason` when it aborts.
   */
  private async patchAt(
    ref: ChangeRequestRef, commit: string, readPatch: (signal: AbortSignal) => Promise<string | ForgeFailure>, signal: AbortSignal,
  ): Promise<{ readonly patch: string; readonly attributes: string }> {
    const unneeded = new AbortController()
    const patch = readPatch(signal).then((result) => {
      if (typeof result !== 'string') throw readError(result)
      return result
    })
    const attributes = this.attributesAt(ref, commit, AbortSignal.any([signal, unneeded.signal]))
    void patch.then(undefined, () => { unneeded.abort() })
    const [text, rules] = await Promise.allSettled([patch, attributes])
    if (text.status === 'rejected') throw text.reason
    if (rules.status === 'rejected') throw rules.reason
    return { patch: text.value, attributes: rules.value }
  }

  /** The root `.gitattributes` of a change request's repository at a commit, empty when the commit has none. */
  private async attributesAt(ref: ChangeRequestRef, commit: string, signal: AbortSignal): Promise<string> {
    const attributes = await this.home.forge.fileText(ref, commit, ATTRIBUTES_PATH, signal)
    if (typeof attributes === 'string') return attributes
    if (attributes.code === 'not-found') return ''
    throw readError(attributes)
  }

  /** Inspect the checkout of the Session's current directory, which local diffs read. */
  private async checkoutOf(session: Session, signal: AbortSignal): Promise<Inspection> {
    const inspection = await inspectCheckout(this.home, this.config, session, this.home.workingDirectory.get(session), signal)
    if (inspection === undefined) throw new RemoteError('forgePanel/not-a-checkout', 'The Session\'s directory is not inside a Git checkout', {})
    return inspection
  }

  /** A visible binding of the Session that a provider serves, which actions and reads are limited to. */
  private bound(session: Session, url: string): SessionChangeRequest & { readonly ref: NonNullable<SessionChangeRequest['ref']> } {
    const entry = this.home.forgeSession.changeRequests(session).find(candidate => candidate.url === url)
    if (entry?.ref == null) throw new RemoteError('forgePanel/not-bound', 'The change request is not bound to this Session or no provider serves it', {})
    return { ...entry, ref: entry.ref }
  }

  private worktreeState(session: Session): ForgeWorktreeState {
    return this.worktreeStates.stateOf(session)
  }

  private editableWorktree(session: Session): ForgeWorktreeState {
    if (this.home.get('worktrees') === undefined) {
      throw new RemoteError('forgePanel/worktrees-unavailable', 'No worktree service is mounted', {})
    }
    return this.changeableWorktree(session)
  }

  /** The worktree state of a Session whose request may still change: no turn started, nothing created, and no attempt running. */
  private changeableWorktree(session: Session): ForgeWorktreeState {
    const state = this.worktreeState(session)
    if (state.locked || state.created !== null) {
      throw new RemoteError('forgePanel/session-started', 'The Session has started, so its worktree can no longer change', {})
    }
    // A creation records its worktree only for the request it started from.
    if (this.creations.of(session) !== null) throw new RemoteError('forgePanel/session-busy', 'The worktree is being created', {})
    return state
  }

  private createdWorktree(session: Session): ForgeSessionWorktree {
    const created = this.worktreeState(session).created
    if (created === null) throw new RemoteError('forgePanel/no-worktree', 'The Session has no created worktree', {})
    return created
  }

  /**
   * Run work as maintenance of the Session's Agent: inside the wait of a
   * message that waits for the removed worktree, else as a task of its own,
   * which the Agent refuses while it has other work.
   */
  private async maintain(session: Session, work: HeldWork): Promise<void> {
    const held = this.creations.within(session, work)
    if (held !== undefined) {
      await held
      return
    }
    const agent = this.home.agents.get(session.id)
    if (agent === undefined) throw new RemoteError('forgePanel/session-busy', 'The Session is not loaded', {})
    let running: Promise<void>
    try {
      running = agent.runMaintenance(async (signal) => { await work(agent, signal) })
    } catch (error) {
      throw new RemoteError('forgePanel/session-busy', 'The Session is busy', {}, { cause: error })
    }
    await running
  }

  /** The shared change request states, created for the first stream from the Host's Session and storage services. */
  private changeRequestStatesHub(): ChangeRequestStates {
    if (this.states !== undefined) return this.states
    const ctx = this.home
    const query = ctx.get('sessionQuery')
    const cache = ctx.get('sessionProjectionCache')
    const storage = ctx.get('storageDomain')
    const store = ctx.get('sessions')
    if (query === undefined || cache === undefined || storage === undefined || store === undefined) {
      throw new Error('forge-panel: change request states need the sessionQuery, sessionProjectionCache, storageDomain, and sessions services')
    }
    const visibleUrls = (session: Session): string[] => ctx.forgeSession.changeRequests(session).map(entry => entry.url)
    this.states = new ChangeRequestStates({
      sessions: async signal => (await query.listSessions(signal)).map(({ header }) => {
        const live = store.get(header.id)
        if (live !== undefined) return { id: header.id, urls: visibleUrls(live) }
        const bindings = cache.cachedSnapshot(header, ['forgeChangeRequests'])?.values.forgeChangeRequests
        return { id: header.id, urls: bindings?.filter(binding => !binding.dismissed).map(binding => binding.url) }
      }),
      onBindings: listener => ctx.sessionProjections.onChanged((session, key) => {
        if (key === 'forgeChangeRequests') listener(session.id, visibleUrls(session))
      }),
      refOf: url => ctx.forge.changeRequestFromUrl(url),
      watch: (ref, listener) => ctx.forge.watch(ref, listener),
      open: async () => {
        const domain = await storage.open(changeRequestStatesDomain)
        return { table: domain.table('states'), close: () => domain.close() }
      },
      report: (error) => { ctx.logger.warn(`forge-panel: storing a change request state failed: ${String(error)}`) },
    })
    return this.states
  }

  /** Drop the threads kept for a change request after an accepted review change and let its panel entries report it. */
  private reviewChanged(ref: ChangeRequestRef): void {
    const key = changeRequestKey(ref)
    this.reviews.drop(key)
    this.reviewRevisions.set(key, (this.reviewRevisions.get(key) ?? 0) + 1)
    for (const panel of this.panels.values()) panel.reviewChanged()
  }

  /** The files a lens request names with their reader and the key results for them are kept under. */
  private async lensSubject(
    session: Session, source: ForgeLensRequest['source'], signal: AbortSignal,
  ): Promise<LensSubject & { readonly key: string }> {
    if (source.kind === 'local') {
      const inspection = await this.checkoutOf(session, signal)
      const root = inspection.checkout.root
      const { scope } = source
      const fork: ForkPoint | null = scope.kind !== 'branch' ? null : await diffing(scope.base === null
        ? forkPoint(gitIn(this.home, this.config, session, root, signal), inspection, this.worktreeState(session).created)
        : chosenForkPoint(gitIn(this.home, this.config, session, root, signal), scope.base))
      const { files } = await diffing(localDiff(this.home, this.config, session, root, fork, scope, this.layers, signal))
      return {
        key: JSON.stringify(['local', session.id, scope]),
        source: { kind: 'local', scope },
        files,
        read: async (side, file, inner) => {
          if (file.binary || (side === 'old' ? file.status === 'added' : file.status === 'deleted')) return null
          return side === 'new'
            ? await diffing(localText(this.home, this.config, session, root, scope, file.path, inner))
            : await diffing(localOldText(this.home, this.config, session, root, scope, fork, file.previousPath ?? file.path, inner))
        },
      }
    }
    const { ref, update } = this.bound(session, source.url)
    if (update === null || !('snapshot' in update)) {
      throw new RemoteError('forgePanel/lens-stale', 'The change request status has not been read yet', {})
    }
    const { snapshot } = update
    const { commits } = source
    let files: ForgeDiffFile[]
    let newCommit: string
    let oldCommit: (inner: AbortSignal) => Promise<string>
    if (commits === null) {
      files = await this.headFiles(ref, snapshot, signal)
      newCommit = snapshot.headSha
      // One merge base serves every old side of the run; a failed lookup is tried again by the next read.
      let base: Promise<string> | undefined
      oldCommit = async (inner) => {
        base ??= this.mergeBaseOf(ref, snapshot, inner)
        try {
          return await base
        } catch (error) {
          base = undefined
          throw error
        }
      }
    } else {
      const read = await this.commitFiles(ref, commits, signal)
      files = read.files
      newCommit = commits.to
      oldCommit = () => Promise.resolve(read.parent)
    }
    return {
      key: JSON.stringify(['change', changeRequestKey(ref), newCommit, commits]),
      source: { kind: 'change', ref, headSha: snapshot.headSha, commits },
      files,
      read: async (side, file, inner) => {
        if (file.binary || (side === 'old' ? file.status === 'added' : file.status === 'deleted')) return null
        const commit = side === 'new' ? newCommit : await oldCommit(inner)
        const text = await this.home.forge.fileText(ref, commit, side === 'new' ? file.path : file.previousPath ?? file.path, inner)
        if (typeof text === 'string') return text
        if (text.code === 'not-found') return null
        throw new Error(text.message)
      },
    }
  }

  /** The merge base whose files the old side of a change request's diff at the status's head shows. */
  private async mergeBaseOf(ref: ChangeRequestRef, snapshot: ChangeRequestSnapshot, signal: AbortSignal): Promise<string> {
    if (snapshot.baseSha === undefined) throw new Error('The code host provider reports no base commit to read the old side at')
    const base = await this.home.forge.mergeBase(ref, snapshot.baseSha, snapshot.headSha, signal)
    if (typeof base !== 'string') throw new Error(base.message)
    return base
  }

  private panelOf(session: Session): SessionPanel {
    let panel = this.panels.get(session)
    if (panel === undefined) {
      const revision = (ref: ChangeRequestRef): number => this.reviewRevisions.get(changeRequestKey(ref)) ?? 0
      const created: SessionPanel = new SessionPanel(this.home, this.config, session, this.worktreeStates, this.creations, revision, () => {
        if (this.panels.get(session) !== created) return
        this.panels.delete(session)
        void created.dispose()
      })
      panel = created
      this.panels.set(session, panel)
    }
    return panel
  }
}

/**
 * Whether a value names a full commit object name.
 * @param value - the value from the browser.
 * @returns whether it is 40 or 64 hexadecimal digits.
 */
function isCommit(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
}

/**
 * Whether a line comment from the browser names a path, consecutive positive lines, and text.
 * @param comment - the comment.
 * @returns whether a provider may write it.
 */
function validComment(comment: ForgeLineComment): boolean {
  return comment.path !== '' && comment.body.trim() !== '' && Number.isSafeInteger(comment.startLine) && comment.startLine >= 1
    && Number.isSafeInteger(comment.endLine) && comment.endLine >= comment.startLine
}

/**
 * Whether a review write from the browser names its target and carries text where the write needs it.
 * @param write - the write.
 * @returns whether a provider may perform it.
 */
function validWrite(write: ForgeReviewWrite): boolean {
  switch (write.kind) {
    case 'reply': return write.thread !== '' && write.body.trim() !== ''
    case 'resolve': return write.thread !== ''
    case 'edit-comment': return write.comment !== '' && write.body.trim() !== ''
    case 'delete-comment': return write.comment !== ''
    case 'add-pending': return validComment(write.comment)
    case 'submit-pending': return write.review !== '' && (write.event !== 'request-changes' || write.body.trim() !== '')
    case 'discard-pending': return write.review !== ''
    /* v8 ignore next -- closed ForgeReviewWrite kind union exhaustiveness guard */
    default: return assertNever(write, 'ForgeReviewWrite.kind')
  }
}

/**
 * Report why the code host did not provide a diff or file.
 * @param failure - the provider's failure.
 * @returns `forgePanel/diff-too-large` for an answer over a size limit, `forgePanel/stale-head` for a head that moved,
 * else `forgePanel/diff-failed`, with the provider's message.
 */
function readError(failure: ForgeFailure): RemoteError {
  switch (failure.code) {
    case 'too-large': return new RemoteError('forgePanel/diff-too-large', failure.message, {})
    case 'stale': return new RemoteError('forgePanel/stale-head', failure.message, {})
    case 'not-found':
    case 'unauthenticated':
    case 'unsupported':
    case 'unavailable': return new RemoteError('forgePanel/diff-failed', failure.message, {})
    /* v8 ignore next -- closed ForgeFailure code union exhaustiveness guard */
    default: return assertNever(failure.code, 'ForgeFailure.code')
  }
}

/**
 * Report why the code host did not provide review threads.
 * @param failure - the provider's failure.
 * @returns `forgePanel/stale-head` for a head that moved, `forgePanel/review-unsupported` for a provider without
 * review reads, else `forgePanel/review-failed`, with the provider's message.
 */
function reviewError(failure: ForgeFailure): RemoteError {
  switch (failure.code) {
    case 'stale': return new RemoteError('forgePanel/stale-head', failure.message, {})
    case 'unsupported': return new RemoteError('forgePanel/review-unsupported', failure.message, {})
    case 'not-found':
    case 'unauthenticated':
    case 'too-large':
    case 'unavailable': return new RemoteError('forgePanel/review-failed', failure.message, {})
    /* v8 ignore next -- closed ForgeFailure code union exhaustiveness guard */
    default: return assertNever(failure.code, 'ForgeFailure.code')
  }
}

/**
 * Settle a diff read, reporting its size limit, its filter configuration, a missing fork point, a missing base branch, and chosen
 * commits that are not on the branch as Remote errors.
 * @param reading - the read.
 * @returns what the read returned.
 */
async function diffing<T>(reading: Promise<T>): Promise<T> {
  try {
    return await reading
  } catch (error) {
    if (error instanceof FilterConfigError) throw new RemoteError('forgePanel/filter-config-failed', error.message, {}, { cause: error })
    if (error instanceof DiffTooLarge) throw new RemoteError('forgePanel/diff-too-large', error.message, {}, { cause: error })
    if (error instanceof NoForkPoint) throw new RemoteError('forgePanel/no-fork-point', error.message, {}, { cause: error })
    if (error instanceof BaseMissing) throw new RemoteError('forgePanel/base-missing', error.message, {}, { cause: error })
    if (error instanceof CommitsMissing) throw new RemoteError('forgePanel/commits-missing', error.message, {}, { cause: error })
    if (error instanceof CommitsNotLinear) throw new RemoteError('forgePanel/commits-not-linear', error.message, {}, { cause: error })
    throw error
  }
}

/**
 * Report a failed change request action, separating a head that moved since the user confirmed it.
 * @param failure - the provider's failure.
 * @returns the Remote error to throw.
 */
function actionError(failure: ForgeActionFailure): RemoteError {
  const code = failure.code === 'stale' ? 'forgePanel/stale-head' : failure.code === 'unknown' ? 'forgePanel/action-unknown'
    : 'forgePanel/action-failed'
  return new RemoteError(code, failure.message, {})
}

/**
 * Whether `prefix` followed by hexadecimal digits is a branch name that Git
 * accepts: no leading `-` or `/`, no empty component, no component that
 * starts with `.` or ends with `.lock`, and none of `..`, `@{`, whitespace,
 * control characters, `~`, `^`, `:`, `?`, `*`, `[`, or `\`.
 * @param prefix - configured worktree branch prefix.
 * @returns whether every generated name passes `git check-ref-format --branch`.
 */
function branchPrefix(prefix: string): boolean {
  const name = `${prefix}0`
  if (name.startsWith('-') || name.includes('..') || name.includes('@{')) return false
  for (const char of name) {
    if (char <= ' ' || char === '\x7f' || '~^:?*[\\'.includes(char)) return false
  }
  return name.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

export default ForgePanelController
