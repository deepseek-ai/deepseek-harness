/** Host Remote of the forge panel: checkout, code host, sign-in, change request, and worktree state per Session. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  AutoMergeRequest, BranchUpdateMethod, ChangeRequestActivity, ChangeRequestDescription, ChangeRequestKey, ChangeRequestRef,
  ChangeRequestReviewer,
  ChangeRequestSnapshot, ChangeRequestUpdate, ForgeActionFailure, ForgeCommitList,
  ForgeFailure,
  ForgeLineComment, ForgeReadiness, ForgeRerunRequest, ForgeReviewChange, ForgeReviewData, ForgeReviewerCandidate, ForgeReviewRequest,
  ForgeReviewResult, ForgeReviewWrite, ForgeReviewWriteResult, ForgeViewedFiles, ForgeViewedRequest, MergeMethod,
} from '@deepseek-ai/dsh-experimental-forge'
import type { SessionChangeRequest } from '@deepseek-ai/dsh-experimental-forge-session'
import type { WorktreeCleanup } from '@deepseek-ai/dsh-experimental-worktree/types'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-query'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { gitIn, hasBranch, inspectCheckout } from './git.ts'
import type { Inspection } from './git.ts'
import { branchNameProblem, LOCAL_REF_PREFIX } from './branch-name.ts'
import { parseDiff } from './diff.ts'
import {
  aheadOf, baseBranches, BaseMissing, branchTip, branchWorktrees, chosenForkPoint, CommitsMissing, CommitsNotLinear, DiffTooLarge,
  FilterConfigError, forkPoint, HeadMissing, localCommits, localDiff, localOldText, localText, NoForkPoint, sessionHead,
} from './local-diff.ts'
import type { ForkPoint, SessionHead } from './local-diff.ts'
import { LocalChangesStale, LocalPathReplaced, localWrite } from './local-write.ts'
import { LensCache, LensFailed, lensFrames, LensRegistry, LensWithdrawn, runLens } from './lenses.ts'
import type { LensSubject } from './lenses.ts'
import { lensVersion } from './lens-version.ts'
import { rangeStart } from './commit-range.ts'
import { ATTRIBUTES_PATH, FileLayers } from './layers.ts'
import { missingWorktree, SessionPanel } from './panel.ts'
import { BASE_REF_PREFIXES, parseWorktreeBases, remoteOrder, remoteRepository } from './parse.ts'
import { PatchCache } from './patch-cache.ts'
import { ReviewCache } from './review-cache.ts'
import { ChangeRequestStates, changeRequestStatesDomain } from './states.ts'
import { Reader, ViewerLists } from './viewer-lists.ts'
import type { KeptPanel, PanelConfig } from './panel.ts'
import type {
  Config, ForgeBaseBranches, ForgeChangeRequestDiff, ForgeChangeRequestStatesFrame, ForgeCommitRange, ForgeDiffFile,
  ForgeReviewChangeRequest, ForgeReviewCountFrame, ForgeReviewFrame, ForgeReviewRepository,
  ForgeExtensionState, ForgeLens, ForgeLensFrame, ForgeLensRequest, ForgeLocalCommits, ForgeLocalDiff, ForgeLocalScope,
  ForgeLocalWrite, ForgeLocalWriteResult,
  ForgeMissingWorktree, ForgePanelState, ForgeSessionWorktree, ForgeWorktreeBases, ForgeWorktreeState,
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

/** What a local read targets. */
interface LocalTarget {
  /** The checkout Git runs in: the Session's own, or the worktree that has the head branch checked out. */
  readonly inspection: Inspection
  /** The worktree the Session created, while the read targets its own checkout; it fixes the automatic fork point. */
  readonly created: ForgeSessionWorktree | null
  /** `HEAD` for the checkout's working tree, or the verified ref of a head branch read from its commits. */
  readonly tip: string
  /** Top-level directory of the head branch's worktree, or null for the Session's own checkout and a head read from its commits. */
  readonly worktree: string | null
  /**
   * The Session's own HEAD, which a head branch is compared with while no base branch is chosen; null for the
   * Session's own checkout, and while its checked-out branch has no commit.
   */
  readonly against: SessionHead | null
}

/** A change request a read or action addresses, with its latest polling result. */
interface ChangeRequestTarget {
  readonly ref: ChangeRequestRef
  readonly update: ChangeRequestUpdate | null
}

/** Panel limits and worktree branch prefix plus the branch and commit listing limits and the lens and annotation limits. */
type ControllerConfig = PanelConfig & {
  readonly maxBranches: number
  readonly maxCommits: number
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
    statusMaxAgeMs: z.number().default(10_000),
    lensTimeoutMs: z.number().default(60_000),
    maxLensReadBytes: z.number().default(33_554_432),
    maxCachedLensBytes: z.number().default(4_194_304),
    maxAnnotationsPerFile: z.number().default(100),
    reviewListIntervalMs: z.number().default(120_000),
    reviewCountIntervalMs: z.number().default(300_000),
    reviewMaxBackoffMs: z.number().default(1_800_000),
    reviewPageSize: z.number().default(50),
  })

  private readonly home: Context
  private readonly config: ControllerConfig
  private readonly panels = new Map<Session, SessionPanel>()
  /** What the last panel of a Session kept when its last follower left. */
  private readonly keptPanels = new WeakMap<Session, KeptPanel>()
  private worktreeStates!: ProjectionHandle<ForgeWorktreeState>
  private creations!: WorktreeCreations
  private readonly patches: PatchCache
  private readonly layers: FileLayers
  private readonly reviews: ReviewCache<ForgeReviewData>
  /** The viewed marks read for each change request, by head commit. */
  private readonly viewed: ReviewCache<ForgeViewedFiles>
  private readonly lenses = new LensRegistry()
  private readonly lensResults: LensCache
  /** Review changes `forge/review-changed` announced per change request, which each panel entry reports. */
  private readonly reviewRevisions = new Map<ChangeRequestKey, number>()
  private states: ChangeRequestStates | undefined
  private readonly viewerLists: ViewerLists
  /** The change request a review conversation's draft quotes, per Session, bound once its first message enters the inbox. */
  private readonly staged = new Map<SessionId, string>()
  /** Review page streams of change requests shown in full, which a review change makes publish again. */
  private readonly reviewFollowers = new Set<{ readonly key: ChangeRequestKey; readonly emit: () => void }>()
  private readonly stopPanels: () => Promise<void>
  private readonly stopStates: () => Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'forgePanel')
    const resolved = config as Required<Config>
    if (resolved.gitCommand.trim().length === 0) throw new Error('forge-panel: gitCommand must not be empty')
    for (const key of [
      'gitTimeoutMs', 'graceMs', 'maxOutputBytes', 'readinessTimeoutMs', 'reviewRefreshMs', 'statusMaxAgeMs', 'lensTimeoutMs',
      'reviewListIntervalMs', 'reviewCountIntervalMs', 'reviewMaxBackoffMs',
    ] as const) {
      const value = resolved[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new Error(`forge-panel: ${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
      }
    }
    for (const key of [
      'maxBranches', 'maxDiffBytes', 'maxUntrackedFiles', 'maxCachedDiffBytes', 'maxCommits', 'maxCachedReviewBytes', 'maxLensReadBytes',
      'maxCachedLensBytes', 'maxAnnotationsPerFile', 'reviewPageSize',
    ] as const) {
      if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-panel: ${key} must be a positive integer`)
    }
    if (resolved.reviewMaxBackoffMs < Math.max(resolved.reviewListIntervalMs, resolved.reviewCountIntervalMs)) {
      throw new Error('forge-panel: reviewMaxBackoffMs must be at least reviewListIntervalMs and reviewCountIntervalMs')
    }
    // Generated names append hexadecimal digits, so the prefix followed by one digit must be a valid branch name.
    if (branchNameProblem(`${resolved.worktreePrefix}0`) !== null) throw new Error('forge-panel: worktreePrefix must start a valid Git branch name')
    for (const key of ['testPaths', 'interfacePaths'] as const) {
      if (resolved[key].some(glob => glob.trim() === '')) throw new Error(`forge-panel: ${key} entries must not be empty`)
    }
    this.layers = new FileLayers(resolved.testPaths, resolved.interfacePaths)
    this.home = ctx
    this.config = resolved
    this.patches = new PatchCache(resolved.maxCachedDiffBytes)
    this.reviews = new ReviewCache(resolved.maxCachedReviewBytes, resolved.reviewRefreshMs)
    this.viewed = new ReviewCache(resolved.maxCachedReviewBytes, resolved.reviewRefreshMs)
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
    this.viewerLists = new ViewerLists({
      sources: () => ctx.forge.viewerSources(),
      list: async (forge, query, signal) => await ctx.forge.listForViewer(forge, query, signal),
      count: async (forge, host, signal) => await ctx.forge.countForViewer(forge, host, signal),
      signIn: async (forge, host, signal) => (await ctx.forge.readiness({ forge, host }, signal)).signIn?.command ?? null,
      report: (error) => { ctx.logger.warn(`forge-panel: reading a review list failed: ${String(error)}`) },
    }, {
      listIntervalMs: resolved.reviewListIntervalMs,
      countIntervalMs: resolved.reviewCountIntervalMs,
      maxBackoffMs: resolved.reviewMaxBackoffMs,
      pageSize: resolved.reviewPageSize,
    })
    const viewerLists = this.viewerLists
    ctx.effect(() => async () => { await viewerLists.dispose() }, 'forge-panel: stop review lists')
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
    const inbox = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      this.bindStaged(agent.session)
      this.holdTurn(agent, message)
    })
    const providers = ctx.on('forge/providers-changed', () => { this.viewerLists.sourcesChanged() })
    const events = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.panels.get(session)?.observe(event)
    })
    // A change request staged for a Session that is disposed before its next message is never bound.
    const disposed = ctx.on('session/disposed', (session: Session) => { this.staged.delete(session.id) })
    const reviewChanges = ctx.on('forge/review-changed', (ref: ChangeRequestRef, change: ForgeReviewChange) => {
      this.reviewChanged(ref, change)
    })
    const services = ctx.on('internal/service', (name: string) => {
      if (name !== 'worktrees') return
      for (const panel of this.panels.values()) panel.updateWorktree()
    })
    const { creations, stopPanels, stopStates } = this
    ctx.effect(function* () {
      yield stateOwner.dispose
      yield inbox
      yield events
      yield disposed
      yield reviewChanges
      yield providers
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
   * Stream the review page's lists of the signed-in user's open change requests on every host a provider lists them on:
   * the lists read so far first, then a frame after each read settles. Readers of one repository scope share one
   * reader, which reads each host every `reviewListIntervalMs` while some stream lasts and reads a host whose read failed
   * again later each time, up to `reviewMaxBackoffMs`, without delaying the other hosts; nothing is read while no stream
   * lasts. The stream ends when `signal` aborts or the Remote stops.
   * @param repository - one repository to list in, read on its host only, or null for every repository the user can
   * read on every host.
   * @param signal - ends the stream.
   * @returns frames, each complete.
   */
  @Remote({ mode: 'stream' })
  async *reviewLists(
    repository: ForgeReviewRepository | null, signal: AbortSignal,
  ): AsyncIterable<ForgeReviewFrame> {
    yield* this.viewerLists.lists(repository, signal)
  }

  /**
   * Stream the number of open change requests that ask the signed-in user for a review, summed over the hosts read:
   * the latest count first, then each change. It is read every `reviewCountIntervalMs` while some stream lasts, and a
   * list stream of every repository updates it as well. The stream ends when `signal` aborts or the Remote stops.
   * @param signal - ends the stream.
   * @returns frames, each complete.
   */
  @Remote({ mode: 'stream' })
  async *reviewCount(signal: AbortSignal): AsyncIterable<ForgeReviewCountFrame> {
    yield* this.viewerLists.count(signal)
  }

  /**
   * Read every streamed review page list and the count again at once.
   * @param signal - request cancellation.
   */
  @Remote
  // oxlint-disable-next-line typescript/require-await -- async keeps a refused or cancelled request a rejection, as Remote callers expect
  async reviewRefresh(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.viewerLists.refresh()
  }

  /**
   * Report whether a provider reaches one of its hosts with the Host's current credentials, for the host list on the
   * Plugins page of that provider's row. The read names no Session, so, like the review page reads, only callers that
   * may use the Host's code host credentials reach it.
   * @param forge - forge family of a registered provider, such as `gitlab`.
   * @param host - host name as the provider's configuration lists it.
   * @param signal - request cancellation.
   * @returns the provider's readiness for the host; `unavailable` with the reason when no provider serves the family,
   * the probe fails, or it runs past `readinessTimeoutMs`.
   */
  @Remote
  async hostReadiness(forge: string, host: string, signal: AbortSignal): Promise<ForgeReadiness> {
    signal.throwIfAborted()
    try {
      using timeout = deadline(signal, this.config.readinessTimeoutMs, 'FORGE_PANEL_READINESS_TIMEOUT')
      return await this.home.forge.readiness({ forge, host: host.toLowerCase() }, timeout.signal)
    } catch (error) {
      signal.throwIfAborted()
      return { state: 'unavailable', message: messageOf(error), signIn: null }
    }
  }

  /**
   * Poll one change request the review page shows at once; its stream reports the result.
   * @param url - web URL of the change request.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL.
   */
  @Remote
  // oxlint-disable-next-line typescript/require-await -- async keeps a refused or cancelled request a rejection, as Remote callers expect
  async reviewPoll(url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.home.forge.refresh(this.served(url).ref)
  }

  /**
   * Stream one change request the review page shows in full: its latest polling result first, then each later result
   * and each review change `forge/review-changed` announces for it. The change request is polled through `ctx.forge`
   * while the stream lasts. Review page reads and actions name a change request by URL and need no Session binding, so
   * only callers that may use the Host's code host credentials reach them.
   * @param url - web URL of the change request.
   * @param signal - ends the stream.
   * @returns frames, each complete.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL.
   */
  @Remote({ mode: 'stream' })
  async *reviewChangeRequest(url: string, signal: AbortSignal): AsyncIterable<ForgeReviewChangeRequest> {
    signal.throwIfAborted()
    const { ref } = this.served(url)
    const key = changeRequestKey(ref)
    const reader = new Reader<ForgeReviewChangeRequest>(signal)
    let update: ChangeRequestUpdate | null = this.home.forge.latest(ref) ?? null
    let snapshot = update !== null && 'snapshot' in update ? update.snapshot : null
    const emit = (): void => {
      const forge = this.home.forge.describe(ref.repository.forge) ?? null
      reader.push({ url, ref, forge, update, snapshot, reviewRevision: this.reviewRevisions.get(key) ?? 0 })
    }
    const follower = { key, emit }
    this.reviewFollowers.add(follower)
    const stop = this.home.forge.watch(ref, (next) => {
      update = next
      if ('snapshot' in next) snapshot = next.snapshot
      emit()
    }, { maxAgeMs: this.config.statusMaxAgeMs })
    emit()
    try {
      yield* reader.frames()
    } finally {
      stop()
      this.reviewFollowers.delete(follower)
      reader.dispose()
    }
  }

  /**
   * Read the description and labels of a change request for the review page.
   * @param url - web URL of the change request.
   * @param signal - request cancellation.
   * @returns the description.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/description-failed` with the
   * host's reason when the host does not provide it.
   */
  @Remote
  async reviewDescription(url: string, signal: AbortSignal): Promise<ChangeRequestDescription> {
    signal.throwIfAborted()
    const result = await this.home.forge.readDescription(this.served(url).ref, signal)
    if ('code' in result) throw new RemoteError('forgePanel/description-failed', result.message, {})
    return result
  }

  /**
   * Read the activity of a change request for the review page: its comments, submitted reviews, commits, and changes
   * of state.
   * @param url - web URL of the change request.
   * @param signal - request cancellation.
   * @returns the activity, or null when the change request's provider reads none.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/activity-failed` with the
   * host's reason when the host does not provide it.
   */
  @Remote
  async reviewActivity(url: string, signal: AbortSignal): Promise<ChangeRequestActivity | null> {
    signal.throwIfAborted()
    const result = await this.home.forge.readActivity(this.served(url).ref, signal)
    if (!('code' in result)) return result
    if (result.code === 'unsupported') return null
    throw new RemoteError('forgePanel/activity-failed', result.message, {})
  }

  /**
   * Add a comment to the conversation of a change request the review page shows.
   * @param url - web URL of the change request.
   * @param body - Markdown source of the comment.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/action-failed` when `body` is
   * blank, or with the host's reason; `forgePanel/action-unknown` when the host's answer did not confirm the comment.
   */
  @Remote
  async reviewComment(url: string, body: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const { ref } = this.served(url)
    if (body.trim() === '') throw new RemoteError('forgePanel/action-failed', 'The comment is empty', {})
    const failure = await this.home.forge.addComment(ref, body, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Read every check of a change request the review page shows.
   * @param url - web URL of the change request.
   * @param headSha - head commit whose checks the page shows.
   * @param signal - request cancellation.
   * @returns the snapshot with every check.
   * @throws as {@link ForgePanelController.changeRequestChecks} does, with `forgePanel/unrecognized-url` in place of
   * `forgePanel/not-bound`.
   */
  @Remote
  async reviewChecks(url: string, headSha: string, signal: AbortSignal): Promise<ChangeRequestSnapshot> {
    signal.throwIfAborted()
    return await this.readChecks(this.served(url).ref, headSha, signal, () => {})
  }

  /**
   * Read the review threads of a change request the review page shows, at the head of its latest status.
   * @param url - web URL of the change request.
   * @param headSha - head commit the page shows.
   * @param fresh - whether to read from the host even when threads at this head and update time are kept.
   * @param signal - request cancellation.
   * @returns the threads at `headSha`.
   * @throws as {@link ForgePanelController.changeRequestReview} does, with `forgePanel/unrecognized-url` in place of
   * `forgePanel/not-bound`.
   */
  @Remote
  async reviewThreads(url: string, headSha: string, fresh: boolean, signal: AbortSignal): Promise<ForgeReviewData> {
    signal.throwIfAborted()
    return await this.readThreads(this.served(url), headSha, fresh, signal)
  }

  /**
   * Write to the review threads or the pending review of a change request the review page shows.
   * @param url - web URL of the change request.
   * @param write - the write and the head commit the user saw.
   * @param signal - request cancellation.
   * @returns whether the host took the write, as {@link ForgePanelController.changeRequestReviewWrite} does.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; an error for an invalid write.
   */
  @Remote
  async reviewThreadWrite(url: string, write: ForgeReviewWrite, signal: AbortSignal): Promise<ForgeReviewWriteResult> {
    signal.throwIfAborted()
    return await this.writeThreads(this.served(url).ref, write, signal)
  }

  /**
   * Publish a line comment or a completed review on a change request the review page shows.
   * @param url - web URL of the change request.
   * @param request - reviewed head, ranges, plain text, and explicit review decision.
   * @param signal - request cancellation.
   * @returns confirmed publication or a typed failure, as {@link ForgePanelController.submitReview} does.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; an error for an invalid review.
   */
  @Remote
  async reviewSubmit(url: string, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult> {
    signal.throwIfAborted()
    return await this.publishReview(this.served(url).ref, request, signal)
  }

  /**
   * Read the changes of a change request the review page shows, or of consecutive commits of it.
   * @param url - web URL of the change request.
   * @param commits - consecutive commits of the change request, or null for all of it.
   * @param signal - request cancellation.
   * @returns the files and the commit they end at, without a local checkout count.
   * @throws as {@link ForgePanelController.changeRequestDiff} does, with `forgePanel/unrecognized-url` in place of
   * `forgePanel/not-bound`.
   */
  @Remote
  async reviewDiff(url: string, commits: ForgeCommitRange | null, signal: AbortSignal): Promise<ForgeChangeRequestDiff> {
    signal.throwIfAborted()
    return await this.readDiff(this.served(url), commits, signal, async () => await Promise.resolve(null))
  }

  /**
   * List the commits of a change request the review page shows.
   * @param url - web URL of the change request.
   * @param signal - request cancellation.
   * @returns the commits, or null when the provider does not read commits.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/diff-failed` when the host does
   * not list them.
   */
  @Remote
  async reviewCommits(url: string, signal: AbortSignal): Promise<ForgeCommitList | null> {
    signal.throwIfAborted()
    const list = await this.home.forge.commits(this.served(url).ref, signal)
    if (list !== undefined && 'code' in list) throw readError(list)
    return list ?? null
  }

  /**
   * Read one file of a change request's repository at a commit for the review page.
   * @param url - web URL of the change request.
   * @param commit - commit object name.
   * @param path - path relative to the repository root.
   * @param signal - request cancellation.
   * @returns the text.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/diff-too-large` or
   * `forgePanel/diff-failed` when the host does not provide the file.
   */
  @Remote
  async reviewText(url: string, commit: string, path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const text = await this.home.forge.fileText(this.served(url).ref, commit, path, signal)
    if (typeof text !== 'string') throw readError(text)
    return text
  }

  /**
   * Read the signed-in user's viewed marks on the files of a change request the review page shows, as
   * {@link ForgePanelController.changeRequestViewed} keeps them.
   * @param url - web URL of the change request.
   * @param headSha - head commit of the shown diff.
   * @param fresh - whether to read the host although kept marks could answer, as after a refresh.
   * @param signal - request cancellation.
   * @returns the marks, or null when the provider keeps no viewed marks.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/stale-head` or
   * `forgePanel/viewed-failed` as {@link ForgePanelController.changeRequestViewed} does.
   */
  @Remote
  async reviewViewed(url: string, headSha: string, fresh: boolean, signal: AbortSignal): Promise<ForgeViewedFiles | null> {
    signal.throwIfAborted()
    return await this.readViewed(this.served(url).ref, headSha, fresh, signal)
  }

  /**
   * Set or clear the signed-in user's viewed mark on one file of a change request the review page shows.
   * @param url - web URL of the change request.
   * @param request - the file, its mark, and the head commit of the shown diff.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; the action errors of
   * {@link ForgePanelController.setFileViewed}.
   */
  @Remote
  async reviewSetViewed(url: string, request: ForgeViewedRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.writeViewed(this.served(url).ref, request, signal)
  }

  /**
   * Mark a draft change request the review page shows ready for review.
   * @param url - web URL of the change request.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/action-failed` or
   * `forgePanel/action-unknown` with the host's reason.
   */
  @Remote
  async reviewMarkReady(url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const failure = await this.home.forge.markReady(this.served(url).ref, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Merge a change request the review page shows while its head is still `headSha`.
   * @param url - web URL of the change request.
   * @param method - how the commits enter the base branch.
   * @param headSha - head commit the user confirmed.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/stale-head`,
   * `forgePanel/action-failed`, or `forgePanel/action-unknown` with the host's reason.
   */
  @Remote
  async reviewMerge(url: string, method: MergeMethod, headSha: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const failure = await this.home.forge.merge(this.served(url).ref, { method, headSha }, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Turn the code host's automatic merge of a change request the review page shows on, while its head is still the
   * request's `headSha`, or off.
   * @param url - web URL of the change request.
   * @param request - on with the merge method and the head commit the user confirmed, or off.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/stale-head`,
   * `forgePanel/action-failed`, or `forgePanel/action-unknown` with the host's reason.
   */
  @Remote
  async reviewSetAutoMerge(url: string, request: AutoMergeRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const failure = await this.home.forge.setAutoMerge(this.served(url).ref, request, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Rerun the failed checks of a change request the review page shows.
   * @param url - web URL of the change request.
   * @param request - the head commit whose checks the user saw.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/stale-head`,
   * `forgePanel/action-failed`, or `forgePanel/action-unknown` with the host's reason.
   */
  @Remote
  async reviewRerunChecks(url: string, request: ForgeRerunRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const failure = await this.home.forge.rerunChecks(this.served(url).ref, request, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Request reviews of a change request the review page shows from more reviewers.
   * @param url - web URL of the change request.
   * @param reviewers - the reviewers to ask, by kind and login.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/action-failed` or
   * `forgePanel/action-unknown` with the host's reason; an error without reviewers.
   */
  @Remote
  async reviewRequestReviews(url: string, reviewers: readonly Pick<ChangeRequestReviewer, 'kind' | 'login'>[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.askReviews(this.served(url).ref, reviewers, signal)
  }

  /**
   * List accounts a review of a change request the review page shows can be requested from.
   * @param url - web URL of the change request.
   * @param query - text the login or name contains; empty for the host's suggestions.
   * @param signal - request cancellation.
   * @returns the accounts, the host's suggestions first.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/reviewers-failed` when the host
   * does not list them.
   */
  @Remote
  async reviewReviewerCandidates(url: string, query: string, signal: AbortSignal): Promise<readonly ForgeReviewerCandidate[]> {
    signal.throwIfAborted()
    return await this.candidatesOf(this.served(url).ref, query, signal)
  }

  /**
   * Bring the base branch's new commits into the head branch of a change request the review page shows.
   * @param url - web URL of the change request.
   * @param method - merge or rebase.
   * @param headSha - head commit the user confirmed.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/stale-head`,
   * `forgePanel/action-failed`, or `forgePanel/action-unknown` with the host's reason.
   */
  @Remote
  async reviewUpdateBranch(url: string, method: BranchUpdateMethod, headSha: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const failure = await this.home.forge.updateBranch(this.served(url).ref, { method, headSha }, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /**
   * Remember the change request a review conversation's draft quotes, or forget it with null. When the Session's next
   * message enters its inbox, the change request is bound to the Session with a `track` record before the turn starts;
   * a Session that already started is bound at its next message. The choice lives in memory until then.
   * @param sessionId - the Session whose draft quotes the change request; staging neither loads nor resumes it.
   * @param url - web URL of the change request, or null.
   * @param signal - request cancellation.
   * @throws `forgePanel/unrecognized-url` when no provider serves the URL.
   */
  @Remote
  // oxlint-disable-next-line typescript/require-await -- async keeps a refused or cancelled request a rejection, as Remote callers expect
  async reviewStage(sessionId: SessionId, url: string | null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (url === null) {
      this.staged.delete(sessionId)
      return
    }
    this.served(url)
    this.staged.set(sessionId, url)
  }

  /**
   * Read or await the worktree service's archive cleanup of the Session's checkout.
   * @param sessionId - Session whose cleanup is visible to the caller; reading neither loads nor resumes it.
   * @param revision - null reads now; a matching revision waits for completion.
   * @returns the cleanup state, or null without a worktree service, an attempt, or a current revision.
   */
  @Remote
  async worktreeCleanup(sessionId: SessionId, revision: number | null): Promise<WorktreeCleanup | null> {
    return await this.home.get('worktrees')?.cleanupOf(sessionId, revision) ?? null
  }

  /**
   * List the branches that can start a worktree of the Session's current checkout: the checked-out branch, each
   * remote's default branch, other local branches, and each remote's other remote-tracking branches, remotes in the
   * order the panel recognizes code hosts.
   * @param session - Session whose checkout is read.
   * @param query - text the branch names must contain, ignoring case; empty for every branch.
   * @param signal - request cancellation.
   * @returns the branches, at most `maxBranches` local branches and `maxBranches` per remote, most recently committed first.
   * @throws `forgePanel/not-a-checkout` outside a checkout; the Git error when Git fails or the listed refs exceed `maxDiffBytes`.
   */
  @Remote
  async worktreeBases(session: Session, query: string, signal: AbortSignal): Promise<ForgeWorktreeBases> {
    signal.throwIfAborted()
    const inspection = await this.checkoutOf(session, signal)
    // A search can match any branch, so every ref is listed; a repository's refs can far exceed other short Git output.
    const git = gitIn(this.home, { ...this.config, maxOutputBytes: this.config.maxDiffBytes }, session, inspection.checkout.root, signal)
    const refs = await git('worktree-bases', ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(symref)', ...BASE_REF_PREFIXES])
    return parseWorktreeBases(refs.stdout, inspection.checkout.branch, remoteOrder(inspection.upstream, inspection.remotes), query,
      this.config.maxBranches, remote => remoteRepository(remote, url => this.home.forge.repositoryFromRemote(url)))
  }

  /**
   * List the branches the `branch` scope can compare with, for the Session's current checkout or for a head branch
   * read in its place.
   * @param session - Session whose checkout is read.
   * @param head - full ref of the branch the scope reads in place of the checked-out one, or null for the checkout.
   * @param query - text the branch names must contain, ignoring case; empty for every branch.
   * @param signal - request cancellation.
   * @returns the automatic fork point and at most `maxBranches` remote-tracking and local branches each,
   * most recently committed first, without the branch the scope shows and, for a head, without the Session's
   * checked-out branch, which the automatic fork point compares with; a local branch that a worktree has checked
   * out names that worktree's directory.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/head-missing` when the head does not exist; the
   * Git error when Git fails or the listed refs exceed `maxDiffBytes`.
   */
  @Remote
  async diffBases(session: Session, head: string | null, query: string, signal: AbortSignal): Promise<ForgeBaseBranches> {
    signal.throwIfAborted()
    const { inspection, created, tip, against } = await this.localTarget(session, head, false, signal)
    // A search can match any branch, so every ref is listed; a repository's refs can far exceed other short Git output.
    const git = gitIn(this.home, { ...this.config, maxOutputBytes: this.config.maxDiffBytes }, session, inspection.checkout.root, signal)
    return await baseBranches(git, inspection, created, query, this.config.maxBranches, tip, against)
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
   * @param sessionId - Session whose panel refreshes; refreshing neither loads nor resumes it.
   * @param signal - request cancellation.
   * @returns settles once the inspection and the sign-in probe have ended; poll results reach the panel stream later.
   */
  @Remote
  async refresh(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    for (const [session, panel] of this.panels) if (session.id === sessionId) await panel.refresh()
  }

  /**
   * Bring a followed Session's panel up to date after its surface showed again: reinspect the checkout, poll the
   * change requests whose latest poll is older than `statusMaxAgeMs`, probe sign-in again unless the last probe found
   * the host ready, and look the upstream branch up again while the Session shows no change request; an unfollowed
   * Session is unchanged.
   * @param sessionId - Session whose panel is revisited; revisiting neither loads nor resumes it.
   * @param signal - request cancellation.
   * @returns settles once the inspection and the sign-in probe have ended; poll results reach the panel stream later.
   */
  @Remote
  async revisit(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    for (const [session, panel] of this.panels) if (session.id === sessionId) await panel.revisit()
  }

  /**
   * Read the changes one scope covers in the checkout of the Session's current directory, or for the head branch the
   * scope names: in the worktree that has it checked out, else from its commits. Git uses the Session's sandbox policy.
   * @param session - Session whose checkout is read.
   * @param scope - which changes to read.
   * @param signal - request cancellation.
   * @returns the files, the base of the `branch` scope, the untracked files left out, and the worktree read for a head.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/head-missing` when the head the scope names
   * does not exist; `forgePanel/no-working-tree` for another scope than `branch` whose head no worktree has checked
   * out; `forgePanel/base-missing` when the base branch
   * chosen for the `branch` scope does not exist; `forgePanel/no-fork-point` for the `branch` scope without
   * a fork point; `forgePanel/commits-missing` when chosen commits are not between the fork point and HEAD in order;
   * `forgePanel/commits-not-linear` when a chosen commit's first parent is not the commit listed before it;
   * `forgePanel/filter-config-failed` when filter configuration cannot be read completely, before
   * any comparison; `forgePanel/diff-too-large` over `maxDiffBytes`; the Git error when Git fails.
   */
  @Remote
  async localDiff(session: Session, scope: ForgeLocalScope, signal: AbortSignal): Promise<ForgeLocalDiff> {
    signal.throwIfAborted()
    const target = await this.localTarget(session, scope.head ?? null, scope.kind !== 'branch', signal)
    const { inspection, created, tip, worktree, against } = target
    const root = inspection.checkout.root
    const git = gitIn(this.home, this.config, session, root, signal)
    const fork = scope.kind !== 'branch' ? null
      : await diffing(scope.base === null ? forkPoint(git, inspection, created, tip, against) : chosenForkPoint(git, scope.base, tip))
    const diff = await diffing(localDiff(this.home, this.config, session, root, fork, scope, this.layers, signal, tip))
    return worktree === null ? diff : { ...diff, worktree }
  }

  /**
   * List the commits of the `branch` scope of the Session's current checkout or of a head branch read in its place,
   * which the changes view can show one or several of instead of the whole scope.
   * @param session - Session whose checkout is read.
   * @param head - full ref of the branch the scope reads in place of the checked-out one, or null for the checkout.
   * @param base - the base ref of the `branch` scope, or null for its automatic fork point.
   * @param signal - request cancellation.
   * @returns the newest `maxCommits` commits between the fork point and the shown HEAD or branch, oldest first, and its commit.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/head-missing` when the head does not exist;
   * `forgePanel/base-missing` when the base branch does not exist; `forgePanel/no-fork-point` without a fork point;
   * the Git error when Git fails or the listing exceeds `maxDiffBytes`.
   */
  @Remote
  async localCommits(session: Session, head: string | null, base: string | null, signal: AbortSignal): Promise<ForgeLocalCommits> {
    signal.throwIfAborted()
    const { inspection, created, tip, against } = await this.localTarget(session, head, false, signal)
    const git = gitIn(this.home, { ...this.config, maxOutputBytes: this.config.maxDiffBytes }, session, inspection.checkout.root, signal)
    const fork = await diffing(base === null ? forkPoint(git, inspection, created, tip, against) : chosenForkPoint(git, base, tip))
    if (fork === null) throw new RemoteError('forgePanel/no-fork-point', 'The checkout has no fork point to compare its branch with', {})
    return await localCommits(git, fork, this.config.maxCommits, tip)
  }

  /**
   * Read the new side of one changed file in a scope, which supplies the
   * unchanged lines between its hunks: the index for `staged`, the last chosen commit for chosen commits of
   * the `branch` scope, the branch for a head read from its commits, else the working tree of the checkout the scope reads.
   * @param session - Session whose checkout is read.
   * @param scope - the scope the diff was read in.
   * @param path - path relative to the checkout's top-level directory, as the diff names it.
   * @param signal - request cancellation.
   * @returns the text.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/head-missing` and `forgePanel/no-working-tree`
   * as for {@link ForgePanelController.localDiff}; `forgePanel/diff-too-large` over `maxDiffBytes`;
   * `forgePanel/commits-missing` for a chosen commit that is not a full object name; an error for a path outside
   * the checkout, binary content, or a failed read.
   */
  @Remote
  async localText(session: Session, scope: ForgeLocalScope, path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const { inspection, tip } = await this.localTarget(session, scope.head ?? null, scope.kind !== 'branch', signal)
    return await diffing(localText(this.home, this.config, session, inspection.checkout.root, scope, path, signal, tip))
  }

  /**
   * Stage, unstage, or restore whole files in the checkout of the Session's current directory, or return index
   * entries to the tree an earlier write reported. The caller's press authorizes the write, so Git runs without the
   * Session's sandbox policy and under any access mode. The Session's panel inspects the checkout again afterwards,
   * whether or not the write succeeded.
   * @param session - Session whose checkout is written.
   * @param write - the write; `stage` and `restore` name each file with the digest of the change the reader saw.
   * @param signal - request cancellation.
   * @returns the index before a `stage` or `unstage` as a tree, for undoing it.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/local-stale` before anything is written when a
   * file's unstaged change is not the one the reader saw; `forgePanel/local-path-replaced` before anything is written
   * when a deleted file's path holds a directory; the errors of {@link ForgePanelController.localDiff} for the
   * `unstaged` scope; an error for a path outside the checkout, a tree that is not a full object name, a restore of a
   * submodule or of a file without index content, or a Git failure.
   */
  @Remote
  async localWrite(session: Session, write: ForgeLocalWrite, signal: AbortSignal): Promise<ForgeLocalWriteResult> {
    signal.throwIfAborted()
    const inspection = await this.checkoutOf(session, signal)
    try {
      return await diffing(localWrite(this.home, this.config, session, inspection.checkout.root, write, this.layers, signal))
    } catch (error) {
      if (error instanceof LocalChangesStale) throw new RemoteError('forgePanel/local-stale', error.message, {}, { cause: error })
      if (error instanceof LocalPathReplaced) throw new RemoteError('forgePanel/local-path-replaced', error.message, {}, { cause: error })
      throw error
    } finally {
      // A failed write can have changed the paths of its earlier commands.
      this.panels.get(session)?.reinspect()
    }
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
    return await this.readChecks(this.bound(session, url).ref, headSha, signal, () => { this.bound(session, url) })
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
    return await this.readDiff(this.bound(session, url), commits, signal, async (headBranch, headSha) => {
      try {
        return await aheadOf(gitIn(this.home, this.config, session, this.home.workingDirectory.get(session), signal), headBranch, headSha)
      } catch (_error) {
        // The count only adds a notice; without Git the view still shows the host's diff.
        return null
      }
    })
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
   * whole change request. Marks read at the same head are kept in memory and returned until they are `reviewRefreshMs`
   * old or `maxCachedReviewBytes` evicts them; a mark saved through `ctx.forge` at that head replaces the kept state
   * of its file, so the read after a save costs no request.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param headSha - head commit of the shown diff; marks read at another head are refused.
   * @param fresh - whether to read the host although kept marks could answer, as after a refresh.
   * @param signal - request cancellation.
   * @returns the marks at `headSha`, or null when the provider keeps no viewed marks.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/stale-head` when the head moved past `headSha`, which is then polled again; `forgePanel/viewed-failed`
   * when the host does not provide the marks otherwise.
   */
  @Remote
  async changeRequestViewed(
    session: Session, url: string, headSha: string, fresh: boolean, signal: AbortSignal,
  ): Promise<ForgeViewedFiles | null> {
    signal.throwIfAborted()
    return await this.readViewed(this.bound(session, url).ref, headSha, fresh, signal)
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
    await this.writeViewed(this.bound(session, url).ref, request, signal)
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
    return await this.readThreads(this.bound(session, url), headSha, fresh, signal)
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
    return await this.publishReview(this.bound(session, url).ref, request, signal)
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
    return await this.writeThreads(this.bound(session, url).ref, write, signal)
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
   * Turn the code host's automatic merge of a change request of a Session on, while its head is still the request's
   * `headSha`, or off; the change request is polled again once the host answers.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param request - on with the merge method and the head commit the user confirmed, or off.
   * @param signal - request cancellation.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/stale-head` when the head moved past the request's `headSha`; `forgePanel/action-failed` with the
   * host's reason when the host refuses otherwise, cannot be reached, or sets no automatic merge;
   * `forgePanel/action-unknown` when the host's answer did not confirm the change.
   */
  @Remote
  async setAutoMerge(session: Session, url: string, request: AutoMergeRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const failure = await this.home.forge.setAutoMerge(this.bound(session, url).ref, request, signal)
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
    await this.askReviews(this.bound(session, url).ref, reviewers, signal)
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
    return await this.candidatesOf(this.bound(session, url).ref, query, signal)
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
   * the inbox, or else at the first step proposal, the panel creates the
   * branch `name`, or a generated branch per attempt when it is null, from
   * `from`, or from HEAD of the current checkout when it is null, and enters
   * its checkout; a remote-tracking `from` is fetched first. A message that
   * already waits after a failed or stopped attempt keeps waiting for
   * {@link ForgePanelController.retryWorktree}.
   * @param session - Session without a started turn.
   * @param from - full name of a local or remote-tracking base branch, or null for HEAD.
   * @param name - new branch name, or null to generate one per attempt.
   * @param signal - request cancellation.
   * @throws `forgePanel/invalid-branch` when `from` is empty; `forgePanel/invalid-name` when `name` breaks
   * a branch-name rule; `forgePanel/branch-exists` when the checkout has a local branch named `name`;
   * `forgePanel/not-a-checkout` when a name is checked outside a checkout; `forgePanel/worktrees-unavailable`
   * without a worktree service; `forgePanel/session-started` after a turn started or the worktree was
   * created; `forgePanel/session-busy` while the worktree is being created.
   */
  @Remote
  async requestWorktree(session: Session, from: string | null, name: string | null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (from?.length === 0) throw new RemoteError('forgePanel/invalid-branch', 'The base branch name is empty', {})
    this.editableWorktree(session)
    if (name !== null) {
      await this.checkBranchName(session, name, signal)
      // The Session may have started or begun a creation while Git answered.
      this.editableWorktree(session)
    }
    this.creations.forget(session)
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from, ...name === null ? {} : { name } })
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
   * Make another attempt, on the requested branch name or a new generated
   * one, at the worktree a message of the Session waits for after a failed or
   * stopped attempt.
   * @param session - Session whose message waits.
   * @param fetch - false skips fetching a remote-tracking base branch for this attempt, which then starts from the
   * commit last fetched.
   * @param signal - request cancellation.
   * @throws `forgePanel/not-waiting` when no message waits or an attempt is running.
   */
  @Remote
  async retryWorktree(session: Session, fetch: boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.creations.retry(session, fetch)) {
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
   * Hold the turn of a message entering a Session's next-turn queue while the
   * Session's requested worktree does not exist yet, or while the worktree
   * the Session works in is checked and, when gone, until it is restored or
   * left. The message is entering, so the delivery has not woken the Agent
   * yet and its wake waits for the hold. A message for the next step, such as
   * a notice another plugin queues, opens no turn and gets no hold.
   * @param agent - Agent whose inbox receives the message.
   * @param message - the entering message.
   */
  private holdTurn(agent: Agent, message: UserMessage): void {
    if (!agent.inbox.nextTurn.some(queued => queued.id === message.id)) return
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

  /**
   * Resolve what a local read targets: the Session's own checkout with the worktree it created; for a head branch,
   * the worktree of the repository that has it checked out, read as a checkout; or, when none has, the verified
   * branch itself, read from its commits. A head branch also carries the Session's own HEAD, which is what it is
   * compared with while no base branch is chosen.
   * @param working - whether the read needs a working tree, as every scope but `branch` does.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/head-missing` when the branch does not exist;
   * `forgePanel/no-working-tree` when `working` and no worktree has the branch checked out.
   */
  private async localTarget(session: Session, head: string | null, working: boolean, signal: AbortSignal): Promise<LocalTarget> {
    const own = await this.checkoutOf(session, signal)
    const ownTarget: LocalTarget = {
      inspection: own, created: this.worktreeState(session).created, tip: 'HEAD', worktree: null, against: null,
    }
    if (head === null) return ownTarget
    // Worktree paths are as long as the directories users choose, so the listing takes the larger limit.
    const git = gitIn(this.home, { ...this.config, maxOutputBytes: this.config.maxDiffBytes }, session, own.checkout.root, signal)
    const tip = await diffing(branchTip(git, head))
    const against = await sessionHead(git, own.checkout)
    // Only a local branch can be checked out; a remote-tracking one is always read from its commits.
    const directory = head.startsWith(LOCAL_REF_PREFIX) ? (await branchWorktrees(git)).get(head) : undefined
    // The directory is as Git's listing spells it, which can be cut short or name one that is gone, so the read
    // confirms that a checkout of the branch in this repository is there.
    const inspection = directory === undefined || await this.home.fs.lstat(directory, undefined, signal) === undefined ? undefined
      : await inspectCheckout(this.home, this.config, session, directory, signal)
    if (inspection?.commonDir === own.commonDir && inspection.checkout.branch === head.slice(LOCAL_REF_PREFIX.length)) {
      return inspection.checkout.root === own.checkout.root ? ownTarget
        : { inspection, created: null, tip: 'HEAD', worktree: inspection.checkout.root, against }
    }
    if (working) throw new RemoteError('forgePanel/no-working-tree', 'No worktree has the branch checked out, so it has no working tree', {})
    return { inspection: own, created: null, tip, worktree: null, against }
  }

  /** Inspect the checkout of the Session's current directory, which local diffs read. */
  private async checkoutOf(session: Session, signal: AbortSignal): Promise<Inspection> {
    const inspection = await inspectCheckout(this.home, this.config, session, this.home.workingDirectory.get(session), signal)
    if (inspection === undefined) throw new RemoteError('forgePanel/not-a-checkout', 'The Session\'s directory is not inside a Git checkout', {})
    return inspection
  }

  /** Read every check of a change request, refusing a list read at another head; `recheck` runs once the host answers. */
  private async readChecks(
    ref: ChangeRequestRef, headSha: string, signal: AbortSignal, recheck: () => void,
  ): Promise<ChangeRequestSnapshot> {
    const result = await this.home.forge.fetchChecks(ref, signal)
    recheck()
    if ('code' in result) throw new RemoteError('forgePanel/checks-failed', result.message, {})
    if (result.headSha !== headSha) throw new RemoteError('forgePanel/stale-head', 'The change request head changed; refresh its status', {})
    return result
  }

  /** Read the changes of a change request at the head of its latest status, or of chosen commits; `ahead` counts local commits. */
  private async readDiff(
    target: ChangeRequestTarget, commits: ForgeCommitRange | null, signal: AbortSignal,
    ahead: (headBranch: string, headSha: string) => Promise<number | null>,
  ): Promise<ForgeChangeRequestDiff> {
    const { ref, update } = target
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
    const localAhead = await ahead(headBranch, headSha)
    signal.throwIfAborted()
    const fileUrls = Object.fromEntries(files.map(file => [file.path, this.home.forge.fileUrl(ref, headSha, file.path)]))
    return { headSha, files, localAhead, fileUrls }
  }

  /** Read the viewed marks at a head commit, reusing marks kept for that head unless `fresh`. */
  private async readViewed(ref: ChangeRequestRef, headSha: string, fresh: boolean, signal: AbortSignal): Promise<ForgeViewedFiles | null> {
    const key = changeRequestKey(ref)
    const readAt = Date.now()
    const kept = fresh ? undefined : this.viewed.get(key, headSha, readAt)
    if (kept !== undefined) return kept
    const token = this.viewed.token()
    const result = await this.home.forge.viewedFiles(ref, headSha, signal)
    if (result === undefined) return null
    if ('code' in result) throw new RemoteError(result.code === 'stale' ? 'forgePanel/stale-head' : 'forgePanel/viewed-failed', result.message, {})
    this.viewed.set(key, headSha, result, readAt, token)
    return result
  }

  /** Set or clear a viewed mark. */
  private async writeViewed(ref: ChangeRequestRef, request: ForgeViewedRequest, signal: AbortSignal): Promise<void> {
    if (request.path === '') throw new Error('Invalid viewed file')
    const failure = await this.home.forge.setViewed(ref, request, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /** Read the review threads at the head of the latest status, reusing threads kept for that head and update time. */
  private async readThreads(target: ChangeRequestTarget, headSha: string, fresh: boolean, signal: AbortSignal): Promise<ForgeReviewData> {
    const { ref, update } = target
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

  /** Publish a comment or a completed review, then drop the threads kept for the change request. */
  private async publishReview(ref: ChangeRequestRef, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult> {
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

  /** Write to the review threads or the pending review, then drop the threads kept for the change request. */
  private async writeThreads(ref: ChangeRequestRef, write: ForgeReviewWrite, signal: AbortSignal): Promise<ForgeReviewWriteResult> {
    if (!isCommit(write.headSha)) throw new Error('Invalid review commit')
    if (!validWrite(write)) throw new Error('Invalid review write')
    try {
      return await this.home.forge.writeReview(ref, write, signal)
    } finally {
      this.reviews.drop(changeRequestKey(ref))
    }
  }

  /** The change request a review page URL names, with its latest polling result. */
  /** Request reviews of a change request from the given accounts, refusing an empty list or an empty login. */
  private async askReviews(
    ref: ChangeRequestRef, reviewers: readonly Pick<ChangeRequestReviewer, 'kind' | 'login'>[], signal: AbortSignal,
  ): Promise<void> {
    if (reviewers.length === 0 || reviewers.some(reviewer => reviewer.login.trim() === '')) throw new Error('Invalid reviewers')
    const failure = await this.home.forge.requestReviews(ref, { reviewers }, signal)
    if (failure !== undefined) throw actionError(failure)
  }

  /** List accounts a review of a change request can be requested from, failing with the host's reason. */
  private async candidatesOf(ref: ChangeRequestRef, query: string, signal: AbortSignal): Promise<readonly ForgeReviewerCandidate[]> {
    const result = await this.home.forge.reviewerCandidates(ref, query, signal)
    if ('code' in result) throw new RemoteError('forgePanel/reviewers-failed', result.message, {})
    return result
  }

  private served(url: string): ChangeRequestTarget {
    const ref = this.home.forge.changeRequestFromUrl(url)
    if (ref === undefined) throw new RemoteError('forgePanel/unrecognized-url', 'No provider serves this change request URL', {})
    return { ref, update: this.home.forge.latest(ref) ?? null }
  }

  /** Bind the change request a review conversation staged once the Session's message enters its inbox. */
  private bindStaged(session: Session): void {
    const url = this.staged.get(session.id)
    if (url === undefined) return
    this.staged.delete(session.id)
    // A provider withdrawn since the draft was staged leaves the message unbound.
    if (this.home.forge.changeRequestFromUrl(url) !== undefined) this.home.forgeSession.track(session, url)
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

  /**
   * Refuse a new branch name that breaks a branch-name rule or names a local branch of the Session's checkout. The
   * rules cover every name `git check-ref-format` refuses, which the worktree service runs again at creation.
   */
  private async checkBranchName(session: Session, name: string, signal: AbortSignal): Promise<void> {
    if (branchNameProblem(name) !== null) throw new RemoteError('forgePanel/invalid-name', 'The new branch name is invalid', {})
    const root = (await this.checkoutOf(session, signal)).checkout.root
    if (await hasBranch(this.home, this.config, session, root, name, signal)) {
      throw new RemoteError('forgePanel/branch-exists', `A local branch named ${name} exists`, {})
    }
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
      throw new RemoteError('forgePanel/session-busy', `The Session is busy: ${messageOf(error)}`, {}, { cause: error })
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
      watch: (ref, listener, known) => ctx.forge.watchBrief(ref, listener, known),
      open: async () => {
        const domain = await storage.open(changeRequestStatesDomain)
        return { table: domain.table('states'), close: () => domain.close() }
      },
      report: (error) => { ctx.logger.warn(`forge-panel: storing a change request state failed: ${String(error)}`) },
    })
    return this.states
  }

  /**
   * Bring what is kept for a change request up to date after an accepted review change, and let its panel entries
   * report it: a saved viewed mark replaces the kept state of its file, which a host lists for every changed file, and
   * leaves the kept threads; any other change drops the kept threads.
   */
  private reviewChanged(ref: ChangeRequestRef, change: ForgeReviewChange): void {
    const key = changeRequestKey(ref)
    switch (change.kind) {
      case 'viewed': {
        const { path, viewed } = change
        this.viewed.amend(key, change.headSha, marks => path in marks.files
          ? { ...marks, files: { ...marks.files, [path]: viewed ? 'viewed' : 'unviewed' } } : marks)
        break
      }
      case 'write':
      case 'submit':
        this.reviews.drop(key)
        break
      /* v8 ignore next -- closed ForgeReviewChange kind union exhaustiveness guard */
      default: assertNever(change, 'ForgeReviewChange.kind')
    }
    this.reviewRevisions.set(key, (this.reviewRevisions.get(key) ?? 0) + 1)
    for (const panel of this.panels.values()) panel.reviewChanged()
    for (const follower of this.reviewFollowers) if (follower.key === key) follower.emit()
  }

  /** The files a lens request names with their reader and the key results for them are kept under. */
  private async lensSubject(
    session: Session, source: ForgeLensRequest['source'], signal: AbortSignal,
  ): Promise<LensSubject & { readonly key: string }> {
    if (source.kind === 'local') {
      const { scope } = source
      const target = await this.localTarget(session, scope.head ?? null, scope.kind !== 'branch', signal)
      const { inspection, created, tip, against } = target
      const root = inspection.checkout.root
      const fork: ForkPoint | null = scope.kind !== 'branch' ? null : await diffing(scope.base === null
        ? forkPoint(gitIn(this.home, this.config, session, root, signal), inspection, created, tip, against)
        : chosenForkPoint(gitIn(this.home, this.config, session, root, signal), scope.base, tip))
      const { files } = await diffing(localDiff(this.home, this.config, session, root, fork, scope, this.layers, signal, tip))
      return {
        key: JSON.stringify(['local', session.id, scope]),
        source: { kind: 'local', scope },
        files,
        read: async (side, file, inner) => {
          if (file.binary || (side === 'old' ? file.status === 'added' : file.status === 'deleted')) return null
          return side === 'new'
            ? await diffing(localText(this.home, this.config, session, root, scope, file.path, inner, tip))
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
      const idle = (): void => {
        if (this.panels.get(session) !== created) return
        this.panels.delete(session)
        this.keptPanels.set(session, created.keep())
        void created.dispose()
      }
      const created: SessionPanel = new SessionPanel(
        this.home, this.config, session, this.worktreeStates, this.creations, revision, this.keptPanels.get(session), idle,
      )
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
    case 'rate-limited':
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
    case 'rate-limited':
    case 'unavailable': return new RemoteError('forgePanel/review-failed', failure.message, {})
    /* v8 ignore next -- closed ForgeFailure code union exhaustiveness guard */
    default: return assertNever(failure.code, 'ForgeFailure.code')
  }
}

/**
 * Settle a diff read, reporting its size limit, its filter configuration, a missing fork point, a missing base branch, a missing
 * head, and chosen commits that are not on the branch as Remote errors.
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
    if (error instanceof HeadMissing) throw new RemoteError('forgePanel/head-missing', error.message, {}, { cause: error })
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

export default ForgePanelController
