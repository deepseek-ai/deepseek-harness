/** Host Remote of the forge panel: checkout, code host, sign-in, change request, and worktree state per Session. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ForgeActionFailure, ForgeFailure, MergeMethod } from '@deepseek-ai/dsh-experimental-forge'
import type { SessionChangeRequest } from '@deepseek-ai/dsh-experimental-forge-session'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-query'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { gitIn, inspectCheckout, listBranches } from './git.ts'
import type { Inspection } from './git.ts'
import { parseDiff } from './diff.ts'
import { aheadOf, DiffTooLarge, forkPoint, localDiff, localText, NoForkPoint } from './local-diff.ts'
import { missingWorktree, SessionPanel } from './panel.ts'
import { PatchCache } from './patch-cache.ts'
import { ChangeRequestStates, changeRequestStatesDomain } from './states.ts'
import type { PanelConfig } from './panel.ts'
import type {
  Config, ForgeBranches, ForgeChangeRequestDiff, ForgeChangeRequestStatesFrame, ForgeLocalDiff, ForgeLocalScope, ForgeMissingWorktree,
  ForgePanelState, ForgeSessionWorktree, ForgeWorktreeState,
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

/** Panel limits plus the branch listing limit and the worktree branch prefix. */
type ControllerConfig = PanelConfig & { readonly maxBranches: number; readonly worktreePrefix: string }

/**
 * Serves the forge panel. Following a Session inspects the checkout of its
 * current directory read-only in the Session's execution world, recognizes the
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
  })

  private readonly home: Context
  private readonly config: ControllerConfig
  private readonly panels = new Map<Session, SessionPanel>()
  private worktreeStates!: ProjectionHandle<ForgeWorktreeState>
  private creations!: WorktreeCreations
  private readonly patches: PatchCache
  private states: ChangeRequestStates | undefined
  private readonly stopPanels: () => Promise<void>
  private readonly stopStates: () => Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'forgePanel')
    const resolved = config as Required<Config>
    if (resolved.gitCommand.trim().length === 0) throw new Error('forge-panel: gitCommand must not be empty')
    for (const key of ['gitTimeoutMs', 'graceMs', 'maxOutputBytes', 'readinessTimeoutMs'] as const) {
      const value = resolved[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new Error(`forge-panel: ${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
      }
    }
    for (const key of ['maxBranches', 'maxDiffBytes', 'maxUntrackedFiles', 'maxCachedDiffBytes'] as const) {
      if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-panel: ${key} must be a positive integer`)
    }
    if (!branchPrefix(resolved.worktreePrefix)) throw new Error('forge-panel: worktreePrefix must start a valid Git branch name')
    this.home = ctx
    this.config = resolved
    this.patches = new PatchCache(resolved.maxCachedDiffBytes)
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
    const services = ctx.on('internal/service', (name: string) => {
      if (name !== 'worktrees') return
      for (const panel of this.panels.values()) panel.updateWorktree()
    })
    const { creations, stopPanels, stopStates } = this
    ctx.effect(function* () {
      yield stateOwner.dispose
      yield inbox
      yield events
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
   * current directory, with Git confined to the Session's read-only sandbox.
   * @param session - Session whose checkout is read.
   * @param scope - which changes to read.
   * @param signal - request cancellation.
   * @returns the files, the base of the `branch` scope, and the untracked files left out.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/no-fork-point` for the `branch`
   * scope of a checkout without one; `forgePanel/diff-too-large` over `maxDiffBytes`; the Git error when Git fails.
   */
  @Remote
  async localDiff(session: Session, scope: ForgeLocalScope, signal: AbortSignal): Promise<ForgeLocalDiff> {
    signal.throwIfAborted()
    const inspection = await this.checkoutOf(session, signal)
    const root = inspection.checkout.root
    const fork = scope.kind === 'branch'
      ? await forkPoint(gitIn(this.home, this.config, session, root, signal), inspection, this.worktreeState(session).created)
      : null
    return await diffing(localDiff(this.home, this.config, session, root, fork, scope, signal))
  }

  /**
   * Read the new side of one changed file in a scope, which supplies the
   * unchanged lines between its hunks: the index for `staged`, else the working tree.
   * @param session - Session whose checkout is read.
   * @param scope - the scope the diff was read in.
   * @param path - path relative to the checkout's top-level directory, as the diff names it.
   * @param signal - request cancellation.
   * @returns the text.
   * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/diff-too-large` over `maxDiffBytes`;
   * an error for a path outside the checkout, binary content, or a failed read.
   */
  @Remote
  async localText(session: Session, scope: ForgeLocalScope, path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const inspection = await this.checkoutOf(session, signal)
    return await diffing(localText(this.home, this.config, session, inspection.checkout.root, scope, path, signal))
  }

  /**
   * Read the changes of a change request of a Session as its code host
   * computes them, at the head commit of its latest status. A patch already
   * read at the same head commit and base branch is reused from memory, for
   * any Session, until `maxCachedDiffBytes` evicts it.
   * @param session - Session the change request is bound to.
   * @param url - binding URL of the change request.
   * @param signal - request cancellation.
   * @returns the files, the head commit, each file's web page, and the commits the checkout has beyond the head.
   * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
   * `forgePanel/diff-too-large` when the host or its provider refuses the diff over a size limit;
   * `forgePanel/diff-failed` before its status was read and when the host does not provide the diff otherwise.
   */
  @Remote
  async changeRequestDiff(session: Session, url: string, signal: AbortSignal): Promise<ForgeChangeRequestDiff> {
    signal.throwIfAborted()
    const { ref, update } = this.bound(session, url)
    if (update === null || !('snapshot' in update)) {
      throw new RemoteError('forgePanel/diff-failed', 'The change request status has not been read yet', {})
    }
    const { headSha, headBranch, baseBranch } = update.snapshot
    const key = changeRequestKey(ref)
    const version = JSON.stringify([headSha, baseBranch])
    let patch = this.patches.get(key, version)
    if (patch === undefined) {
      const read = await this.home.forge.diff(ref, signal)
      if (typeof read !== 'string') throw readError(read)
      this.patches.set(key, version, read)
      patch = read
    }
    const files = parseDiff(patch)
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
      open: async () => (await storage.open(changeRequestStatesDomain)).table('states'),
      report: (error) => { ctx.logger.warn(`forge-panel: storing a change request state failed: ${String(error)}`) },
    })
    return this.states
  }

  private panelOf(session: Session): SessionPanel {
    let panel = this.panels.get(session)
    if (panel === undefined) {
      const created: SessionPanel = new SessionPanel(this.home, this.config, session, this.worktreeStates, this.creations, () => {
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
 * Report why the code host did not provide a diff or file.
 * @param failure - the provider's failure.
 * @returns `forgePanel/diff-too-large` for an answer over a size limit, else `forgePanel/diff-failed`, with the provider's message.
 */
function readError(failure: ForgeFailure): RemoteError {
  return new RemoteError(failure.code === 'too-large' ? 'forgePanel/diff-too-large' : 'forgePanel/diff-failed', failure.message, {})
}

/**
 * Settle a diff read, reporting its size limit and a missing fork point as Remote errors.
 * @param reading - the read.
 * @returns what the read returned.
 */
async function diffing<T>(reading: Promise<T>): Promise<T> {
  try {
    return await reading
  } catch (error) {
    if (error instanceof DiffTooLarge) throw new RemoteError('forgePanel/diff-too-large', error.message, {}, { cause: error })
    if (error instanceof NoForkPoint) throw new RemoteError('forgePanel/no-fork-point', error.message, {}, { cause: error })
    throw error
  }
}

/**
 * Report a failed change request action, separating a head that moved since the user confirmed it.
 * @param failure - the provider's failure.
 * @returns the Remote error to throw.
 */
function actionError(failure: ForgeActionFailure): RemoteError {
  return new RemoteError(failure.code === 'stale' ? 'forgePanel/stale-head' : 'forgePanel/action-failed', failure.message, {})
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
