/** Live panel state of one followed Session, shared by all of its followers. */

import type { Context } from '@deepseek-ai/cordis'
import type { ChangeRequestSnapshot, ForgeReadiness, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'
import type { SessionChangeRequest } from '@deepseek-ai/dsh-experimental-forge-session'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-working-directory'
import { gitIn, hasBranch, inspectCheckout } from './git.ts'
import type { GitConfig, Inspection } from './git.ts'
import { localChanges } from './local-diff.ts'
import type { DiffConfig } from './local-diff.ts'
import { remoteOrder, upstreamBranch } from './parse.ts'
import type {
  ForgeCheckoutState, ForgeLocalChanges, ForgeMissingWorktree, ForgePanelChangeRequest, ForgePanelState, ForgePanelWorktree,
  ForgeWorktreeBlocker, ForgeWorktreeState,
} from './types.ts'
import { within, WORKTREE_RECORD } from './worktree.ts'
import type { WorktreeCreations } from './worktree.ts'

/** Git and diff limits plus the sign-in probe deadline. */
export interface PanelConfig extends DiffConfig {
  /** Deadline in milliseconds for one provider sign-in probe. */
  readonly readinessTimeoutMs: number
}

/** The checkout's upstream branch and the remote URL its change requests are looked up at. */
interface Upstream {
  /** URL of the upstream's remote that a provider recognizes. */
  readonly remote: string
  /** Branch name on that remote. */
  readonly branch: string
}

/**
 * Panel state of one Session. Construction starts the first checkout
 * inspection and watches the Session's change requests. Inspections run one at
 * a time; a request that arrives during one runs once more after it, and a
 * result for a directory the Session has since left is dropped. A sign-in
 * probe runs when an inspection recognizes a new code host and on `refresh`;
 * a probe result for a host the panel no longer shows is dropped. Each change
 * request keeps the latest snapshot a poll returned while later polls fail.
 * When an inspection finds an upstream branch on a remote a provider
 * recognizes, the open change requests of that branch are bound as discovered,
 * once per remote and branch until a refresh. The
 * worktree facts follow the `forgeWorktree` projection, the live creation, and the last failed one;
 * each inspection also decides whether the Session's sandbox can write the
 * checkout and its shared Git directory, which a new worktree needs, whether
 * the worktree the Session created and works in is gone, and how many lines
 * the `branch` scope changes; a measurement that fails leaves that null.
 */
export class SessionPanel {
  private current: ForgePanelState
  private readonly followers = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private readonly tasks = new Set<Promise<void>>()
  private readonly stopWatching: () => void
  private readonly snapshots = new Map<string, ChangeRequestSnapshot>()
  private blocker: ForgeWorktreeBlocker | null = null
  private missing: ForgeMissingWorktree | null = null
  private inspection: Promise<void> | null = null
  private rerun: Promise<void> | null = null
  /** Remote URL and branch of the upstream that the last branch lookup covered, until a refresh. */
  private discovered: string | null = null

  /**
   * @param ctx - service context that provides the forge, Session, directory, and process services.
   * @param config - Git limits and the sign-in probe deadline.
   * @param session - Session the panel describes.
   * @param worktreeStates - reads the `forgeWorktree` projection of the Session.
   * @param creations - reads the running creation and restoration, the last failed creation, and what a message of the
   * Session waits for.
   * @param onIdle - called when the last follower leaves.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: PanelConfig,
    readonly session: Session,
    private readonly worktreeStates: ProjectionHandle<ForgeWorktreeState>,
    private readonly creations: Pick<WorktreeCreations, 'of' | 'restorationOf' | 'failureOf' | 'waitingOf'>,
    private readonly onIdle: () => void,
  ) {
    this.current = {
      directory: ctx.workingDirectory.get(session),
      checkout: { state: 'pending' },
      repository: null,
      readiness: null,
      changeRequests: this.entries(ctx.forgeSession.changeRequests(session)),
      worktree: this.worktree(),
      local: null,
    }
    this.stopWatching = ctx.forgeSession.watch(session, (changeRequests) => {
      this.publish({ ...this.current, changeRequests: this.entries(changeRequests) })
    })
    void this.inspect()
  }

  /**
   * Yield the current state, then each later state, until `signal` aborts or the panel stops.
   * @param signal - ends this follower.
   * @returns the states in publication order; intermediate states may be skipped.
   */
  async *follow(signal: AbortSignal): AsyncGenerator<ForgePanelState> {
    let wake: (() => void) | undefined
    const notify = (): void => { wake?.() }
    this.followers.add(notify)
    signal.addEventListener('abort', notify)
    this.lifetime.signal.addEventListener('abort', notify)
    try {
      let delivered: ForgePanelState | undefined
      while (!signal.aborted && !this.lifetime.signal.aborted) {
        if (this.current !== delivered) {
          delivered = this.current
          yield delivered
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      this.followers.delete(notify)
      signal.removeEventListener('abort', notify)
      this.lifetime.signal.removeEventListener('abort', notify)
      if (this.followers.size === 0) this.onIdle()
    }
  }

  /**
   * React to one committed event of the Session: a directory change moves the
   * panel and reinspects; a tool result reinspects, because the tool may have
   * changed the checkout; a sandbox mode change reinspects, because it decides
   * whether a worktree can be created; the first turn, the first step, and
   * worktree records update the worktree facts.
   * @param event - committed Session event.
   */
  observe(event: SessionEvent): void {
    if (event.type === 'working-directory/change') {
      this.publish({ ...this.current, directory: event.data.cwd, checkout: { state: 'pending' }, local: null })
      void this.inspect()
    } else if (event.type === 'tool/result' || event.type === 'sandbox/mode') {
      void this.inspect()
    } else if (event.type === 'turn/start' || event.type === 'step/start' || pluginRecordOf(event)?.type === WORKTREE_RECORD) {
      this.updateWorktree()
    }
  }

  /** Republish the worktree facts when they changed, such as after a creation moved or a worktree service appeared or left. */
  updateWorktree(): void {
    const worktree = this.worktree()
    if (!sameWorktree(worktree, this.current.worktree)) this.publish({ ...this.current, worktree })
  }

  /** Forget the missing worktree once it was checked out again; the next publication carries it, and a reinspection confirms it. */
  restored(): void {
    this.missing = null
  }

  /** Reinspect the checkout, such as after its directory was created again. */
  reinspect(): void {
    void this.inspect()
  }

  /**
   * Check again whether the worktree the Session works in is gone, publishing a change.
   * @param signal - cancellation of the check.
   * @returns the unavailable worktree, or null for a valid checkout or a Session working elsewhere.
   * @throws when the filesystem or Git cannot answer.
   */
  async checkMissing(signal: AbortSignal): Promise<ForgeMissingWorktree | null> {
    const directory = this.current.directory
    const state = this.worktreeStates.stateOf(this.session)
    const missing = await missingWorktree(
      this.ctx, this.config, this.session, state, directory, AbortSignal.any([signal, this.lifetime.signal]),
    )
    if (this.current.directory === directory) {
      this.missing = missing
      this.updateWorktree()
    }
    return missing
  }

  /**
   * Reinspect the checkout, probe sign-in again, and poll every bound change request at once.
   * @returns settles once the inspection and the sign-in probe have ended; each poll publishes its result when it finishes.
   */
  async refresh(): Promise<void> {
    this.discovered = null
    const inspection = this.inspect()
    const probe = this.current.repository === null ? undefined : this.probe(this.current.repository)
    for (const entry of this.current.changeRequests) {
      if (entry.ref !== null) this.ctx.forge.refresh(entry.ref)
    }
    await Promise.all([inspection, probe])
  }

  /**
   * Stop inspections, probes, and the change request watch, end every follower, and wait for pending work.
   * @returns settles once pending inspections and probes have ended.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.stopWatching()
    await Promise.allSettled(this.tasks)
  }

  private entries(changeRequests: readonly SessionChangeRequest[]): ForgePanelChangeRequest[] {
    return changeRequests.map((entry) => {
      if (entry.update !== null && 'snapshot' in entry.update) this.snapshots.set(entry.url, entry.update.snapshot)
      return { ...entry, snapshot: this.snapshots.get(entry.url) ?? null }
    })
  }

  private worktree(): ForgePanelWorktree {
    const state = this.worktreeStates.stateOf(this.session)
    return {
      editable: this.ctx.get('worktrees') !== undefined && !state.locked && state.created === null,
      blocker: this.blocker,
      request: state.request,
      created: state.created,
      creation: this.creations.of(this.session),
      failure: this.creations.failureOf(this.session),
      missing: this.missing,
      restoration: this.creations.restorationOf(this.session),
      waiting: this.creations.waitingOf(this.session),
    }
  }

  private publish(next: ForgePanelState): void {
    this.current = next
    for (const notify of [...this.followers]) notify()
  }

  /** Track `task` for disposal; the returned promise resolves once it settles, whatever the outcome. */
  private run(task: Promise<void>): Promise<void> {
    this.tasks.add(task)
    const settle = (): void => { this.tasks.delete(task) }
    return task.then(settle, settle)
  }

  /**
   * Inspect the checkout, one inspection at a time; calls during an
   * inspection share one trailing rerun.
   * @returns resolves once an inspection that started after the call has ended.
   */
  private inspect(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    if (this.inspection === null) {
      this.inspection = this.run(this.inspectOnce()).then(() => { this.inspection = null })
      return this.inspection
    }
    this.rerun ??= this.inspection.then(() => {
      this.rerun = null
      return this.inspect()
    })
    return this.rerun
  }

  private async inspectOnce(): Promise<void> {
    const directory = this.current.directory
    let checkout: ForgeCheckoutState
    let repository: ForgeRepository | null = null
    let blocker: ForgeWorktreeBlocker | null = null
    let local: ForgeLocalChanges | null = null
    let upstream: Upstream | null = null
    try {
      const inspection = await inspectCheckout(this.ctx, this.config, this.session, directory, this.lifetime.signal)
      if (inspection === undefined) {
        checkout = { state: 'none' }
        blocker = 'not-git'
      } else {
        checkout = { state: 'ready', checkout: inspection.checkout }
        repository = this.recognize(inspection)
        upstream = this.upstreamOf(inspection)
        blocker = await this.blockerOf(inspection)
        local = await this.localOf(inspection)
      }
    } catch (error) {
      checkout = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
    let missing: ForgeMissingWorktree | null = null
    try {
      const state = this.worktreeStates.stateOf(this.session)
      missing = await missingWorktree(this.ctx, this.config, this.session, state, directory, this.lifetime.signal)
    } catch (_error) {
      // Without an answer from the filesystem or Git the panel offers no restoration.
    }
    if (this.lifetime.signal.aborted || this.current.directory !== directory) return
    this.blocker = blocker
    this.missing = missing
    const sameHost = repository !== null && this.current.repository !== null && hostOf(repository) === hostOf(this.current.repository)
    const readiness = sameHost ? this.current.readiness : null
    this.publish({ ...this.current, checkout, repository, readiness, worktree: this.worktree(), local })
    if (repository !== null && !sameHost) void this.probe(repository)
    if (upstream !== null) this.discover(upstream)
  }

  /** The upstream branch with the first URL of its remote that a provider recognizes. */
  private upstreamOf(inspection: Inspection): Upstream | null {
    const tracked = upstreamBranch(inspection.upstream, inspection.remotes)
    const remote = tracked?.remote.urls.find(url => this.ctx.forge.repositoryFromRemote(url) !== undefined)
    return tracked === undefined || remote === undefined ? null : { remote, branch: tracked.branch }
  }

  /** Bind the open change requests of the upstream branch, once per remote and branch until a refresh. */
  private discover(upstream: Upstream): void {
    const key = `${upstream.remote}\n${upstream.branch}`
    if (this.discovered === key) return
    this.discovered = key
    void this.run(this.ctx.forgeSession.discoverBranch(this.session, upstream.remote, upstream.branch))
  }

  /** Decide whether the Session's sandbox lets the worktree service write the checkout and its shared Git directory. */
  private async blockerOf(inspection: Inspection): Promise<ForgeWorktreeBlocker | null> {
    const policy = this.ctx.sandboxPolicy.resolve({ session: this.session })
    if (policy.mode === 'danger-full-access') return null
    if (policy.mode === 'read-only') return 'read-only'
    const root = this.ctx.fs.processPath(await this.ctx.fs.resolve(policy.workspaceRoot, { signal: this.lifetime.signal }))
    return within(root, inspection.checkout.root) && within(root, inspection.commonDir) ? null : 'outside-writable-root'
  }

  /** Measure the `branch` scope; a failed measurement only hides the local changes card. */
  private async localOf(inspection: Inspection): Promise<ForgeLocalChanges | null> {
    try {
      return await localChanges(this.ctx, this.config, this.session, inspection, this.worktree().created, this.lifetime.signal)
    } catch (_error) {
      // The changes view reads and reports the same changes itself.
      return null
    }
  }

  private recognize(inspection: Inspection): ForgeRepository | null {
    for (const remote of remoteOrder(inspection.upstream, inspection.remotes)) {
      for (const url of remote.urls) {
        const repository = this.ctx.forge.repositoryFromRemote(url)
        if (repository !== undefined) return repository
      }
    }
    return null
  }

  /** Probe sign-in on the repository's host; resolves once the probe has ended. */
  private probe(repository: ForgeRepository): Promise<void> {
    const host = hostOf(repository)
    return this.run((async () => {
      let readiness: ForgeReadiness
      try {
        using timeout = deadline(this.lifetime.signal, this.config.readinessTimeoutMs, 'FORGE_PANEL_READINESS_TIMEOUT')
        readiness = await this.ctx.forge.readiness(repository, timeout.signal)
      } catch (error) {
        readiness = { state: 'unavailable', message: error instanceof Error ? error.message : String(error) }
      }
      if (this.lifetime.signal.aborted || this.current.repository === null || hostOf(this.current.repository) !== host) return
      this.publish({ ...this.current, readiness })
    })())
  }
}

function sameWorktree(left: ForgePanelWorktree, right: ForgePanelWorktree): boolean {
  return left.editable === right.editable && left.blocker === right.blocker && left.request === right.request
    && left.created === right.created && left.creation === right.creation && left.failure === right.failure
    && left.missing?.branchExists === right.missing?.branchExists && left.restoration === right.restoration
    && left.waiting === right.waiting
}

/**
 * Decide whether a Session works inside the worktree it created while that
 * worktree's directory is gone, and whether its branch still exists.
 * @param ctx - context that provides `fs` and the process services.
 * @param config - Git limits.
 * @param session - Session to check.
 * @param state - recorded worktree and restoration completion.
 * @param directory - the Session's current directory.
 * @param signal - cancellation of the check.
 * @returns the unavailable worktree, or null for a valid checkout or a Session working elsewhere.
 * @throws when the filesystem or Git cannot answer.
 */
export async function missingWorktree(
  ctx: Context,
  config: GitConfig,
  session: Session,
  state: ForgeWorktreeState,
  directory: string,
  signal: AbortSignal,
): Promise<ForgeMissingWorktree | null> {
  const created = state.created
  if (created === null || !within(created.path, directory)) return null
  if (!state.restoring && await ctx.fs.lstat(created.path, undefined, signal) !== undefined) {
    const git = gitIn(ctx, config, session, created.path, signal)
    const top = await git('rev-parse', ['rev-parse', '--show-toplevel'], [0, 128])
    if (top.exitCode === 0) {
      const target = await ctx.fs.resolve(created.path, { signal })
      const root = await ctx.fs.resolve(top.stdout.replace(/\r?\n$/, ''), { cwd: created.path, signal })
      if (root.targetKey === target.targetKey) {
        const common = await git('common-dir', ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        const source = await gitIn(ctx, config, session, created.repositoryRoot, signal)(
          'common-dir', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        )
        const actual = await ctx.fs.resolve(common.stdout.replace(/\r?\n$/, ''), { cwd: created.path, signal })
        const expected = await ctx.fs.resolve(source.stdout.replace(/\r?\n$/, ''), { cwd: created.repositoryRoot, signal })
        if (actual.targetKey === expected.targetKey) return null
      }
    }
  }
  try {
    return { branchExists: await hasBranch(ctx, config, session, created.repositoryRoot, created.branch, signal) }
  } catch (error) {
    signal.throwIfAborted()
    if (!state.restoring) throw error
    return { branchExists: null }
  }
}

function hostOf(repository: ForgeRepository): string {
  return `${repository.forge}:${repository.host}`
}
