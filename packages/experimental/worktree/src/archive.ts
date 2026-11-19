/**
 * Archive-triggered reclamation of checkouts this service created. Installed by
 * the service constructor, as the job and Agent registries install their own
 * archive-admission families, so it holds for every Session the Workspace archives.
 */
import { sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle, SessionProjectionMap } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorktreeProjectionState } from './projection.ts'
import type { CreatedWorktree, WorktreeCleanup, WorktreeCreation } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A cleanup attempt changed state. Fires once at admission with
     * `scheduled` and once at settlement with the final status.
     * @param info - the archived Session, the checkout, and the attempt state.
     * @mode emit
     */
    'worktree/cleanup'(info: { sessionId: SessionId; path: string; cleanup: WorktreeCleanup }): void
  }
}

/** The service operations reclamation needs; kept narrow so the archive module never reaches Git directly. */
export interface ReclamationHost {
  /** Whether the deployment keeps every checkout on archive; read at each admission. */
  retainOnArchive(): boolean
  /** Run `body` after every operation on `path` that was requested earlier, and before any requested later. */
  exclusiveCheckout<T>(path: string, body: () => Promise<T>): Promise<T>
  /**
   * Inspect and, when eligible and admitted, remove the checkout without force. Rejects on Git failure.
   */
  removeCheckout(request: CreatedWorktree, signal: AbortSignal, admit: () => boolean): Promise<boolean>
}

/** The wire values cleanup reads from an observation; the service injects every owner, so each is always present. */
type Observed = Pick<SessionProjectionMap, 'worktree' | 'workingDirectory'>

interface Attempt {
  readonly worktree: CreatedWorktree
  readonly revision: number
  status: WorktreeCleanup['status']
  cancelled: boolean
  done: Promise<void>
}

/**
 * Whether `path` is `root` or lies below it. Both are canonical absolute
 * process paths without a trailing separator, so prefixing with the platform
 * separator is exact.
 * @param root - canonical absolute directory.
 * @param path - canonical absolute directory to test.
 * @returns whether `root` contains `path`.
 */
export function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

/** Owns pending cleanup, gates directory entry into a checkout being removed, and drains before the service is released. */
export class WorktreeReclamation {
  private readonly attempts = new Map<SessionId, Attempt>()
  private readonly removing = new Map<string, Promise<void>>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private revision = 0

  /**
   * @param ctx - scope injecting the Workspace registry, Session query, store, and working-directory
   *   providers; the projection cache is read when mounted.
   * @param host - the service operations the module runs through.
   * @param projection - the `worktree` unit, read live and through the persisted cache.
   */
  constructor(
    private readonly ctx: Context,
    private readonly host: ReclamationHost,
    private readonly projection: ProjectionHandle<WorktreeProjectionState>,
  ) {
    // Listeners withdraw before the drain so a disposing service never fails
    // unrelated directory access or an unarchive with its own abort.
    ctx.on('working-directory/access', ({ agent, path, signal }, next) => {
      const target = path ?? ctx.workingDirectory.get(agent.session)
      const blocked = [...this.removing.keys()].find(root => within(root, target))
      if (blocked === undefined) return next()
      return this.host.exclusiveCheckout(blocked, async () => {
        signal.throwIfAborted()
        return await next()
      })
    })
    ctx.on('workspace/session-archived', ({ sessionId }) => { this.schedule(sessionId) })
    ctx.on('workspace/session-unarchiving', async ({ sessionId }) => {
      const attempt = this.attempts.get(sessionId)
      if (attempt === undefined) return
      attempt.cancelled = true
      await attempt.done
      this.attempts.delete(sessionId)
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('worktree reclamation stopped'))
      for (const attempt of this.attempts.values()) attempt.cancelled = true
      await Promise.allSettled(this.pending)
      this.attempts.clear()
    }, 'worktree: drain archive cleanup')
  }

  /**
   * Read the most recent cleanup attempt of a Session; waiting never starts one.
   * @param sessionId - archived Session whose attempt is read.
   * @param revision - null reads at once; a matching revision waits for that attempt to settle.
   * @returns the attempt state, or null when none exists, the revision was superseded, or the service is stopping.
   */
  async cleanupOf(sessionId: SessionId, revision: number | null): Promise<WorktreeCleanup | null> {
    const attempt = this.attempts.get(sessionId)
    if (attempt === undefined || (revision !== null && revision !== attempt.revision)) return null
    if (revision !== null) await attempt.done
    // A cold Session without creations withdraws its placeholder while it settles.
    if (this.lifetime.signal.aborted || this.attempts.get(sessionId) !== attempt) return null
    return { revision: attempt.revision, status: attempt.status }
  }

  /** Register attempts for the Session's own creations and return; every inspection runs in the background. */
  private schedule(sessionId: SessionId): void {
    if (this.host.retainOnArchive()) return
    const live = this.ctx.sessions.get(sessionId)
    // A cold Session is observed in the background, below.
    const owned = live === undefined ? undefined : ownedOf(this.projection.stateOf(live).created)
    if (owned !== undefined && owned.length === 0) return
    const attempt: Attempt = {
      worktree: owned?.[0]?.worktree ?? { path: '', branch: '', baseCommit: '', repositoryRoot: '' },
      revision: ++this.revision, status: 'scheduled', cancelled: false, done: Promise.resolve(),
    }
    this.attempts.set(sessionId, attempt)
    // run() settles every outcome into the attempt, so the task never rejects.
    const task = this.run(sessionId, attempt, owned)
    this.pending.add(task)
    attempt.done = task.then(() => { this.pending.delete(task) })
  }

  private async run(sessionId: SessionId, attempt: Attempt, owned: readonly WorktreeCreation[] | undefined): Promise<void> {
    const ctx = this.ctx
    try {
      const creations = owned ?? ownedOf((await this.projected(sessionId)).worktree)
      const candidate = creations[0]?.worktree
      if (candidate === undefined) {
        this.attempts.delete(sessionId)
        return
      }
      Object.assign(attempt, { worktree: candidate })
      ctx.emit('worktree/cleanup', {
        sessionId, path: candidate.path, cleanup: { revision: attempt.revision, status: attempt.status },
      })
      if (attempt.cancelled || !await this.unused(candidate, sessionId)) {
        attempt.status = 'retained'
      } else {
        attempt.status = await this.remove(candidate, attempt) ? 'removed' : 'retained'
      }
    } catch (error: unknown) {
      attempt.status = 'failed'
      ctx.logger.warn(
        'Session %s archived; cleanup of its worktree %s failed and its branch was retained: %s', sessionId, attempt.worktree.path, error,
      )
    }
    ctx.emit('worktree/cleanup', {
      sessionId, path: attempt.worktree.path, cleanup: { revision: attempt.revision, status: attempt.status },
    })
  }

  /**
   * Remove under the path lock; a second use check runs inside it, after
   * competing operations settled. A Session has one attempt and unarchiving
   * awaits it, so removals of one path never overlap.
   */
  private async remove(worktree: CreatedWorktree, attempt: Attempt): Promise<boolean> {
    const operation = this.host.exclusiveCheckout(worktree.path, async () => {
      if (attempt.cancelled || !await this.unused(worktree, undefined)) return false
      return await this.host.removeCheckout(worktree, this.lifetime.signal, () => !attempt.cancelled)
    })
    this.removing.set(worktree.path, operation.then(() => {}, () => {}))
    try {
      return await operation
    } finally {
      this.removing.delete(worktree.path)
    }
  }

  /**
   * Whether no unarchived Session still refers to the checkout: by a recorded
   * creation, inherited or own, or by a working directory inside it. A Session
   * beneath an archived subagent ancestor counts as archived, as its own
   * archive admission does. Processes are not consulted: Git refuses a
   * removal that would discard changes, and an idle process in a removed
   * directory fails its next command.
   */
  private async unused(worktree: CreatedWorktree, archivingId: SessionId | undefined): Promise<boolean> {
    const ctx = this.ctx
    const signal = this.lifetime.signal
    signal.throwIfAborted()
    const records = await ctx.sessionQuery.listSessions(signal)
    const headers = new Map(records.map(record => [record.header.id, record.header] as const))
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
    if (archivingId !== undefined) archived.add(archivingId)
    for (const record of records) {
      const id = record.header.id
      if (archived.has(id) || ancestorArchived(record.header, headers, archived)) continue
      const live = ctx.sessions.get(id)
      const { workingDirectory: cwd, worktree: creations } = live === undefined
        ? await this.usageOf(record.header)
        : { workingDirectory: ctx.workingDirectory.get(live), worktree: this.projection.stateOf(live).created }
      if (cwd !== null && within(worktree.path, cwd)) return false
      if (creations.some(creation => creation.worktree.path === worktree.path)) return false
      signal.throwIfAborted()
    }
    return true
  }

  /**
   * The recorded directory (null when its log recorded none) and creations of a cold Session: the
   * persisted cache when it holds both, else one observation of its log.
   */
  private async usageOf(header: SessionHeader): Promise<Observed> {
    const cached = this.ctx.get('sessionProjectionCache')?.cachedSnapshot(header, ['workingDirectory', 'worktree'])?.values
    if (cached?.workingDirectory !== undefined && cached.worktree !== undefined) {
      return { workingDirectory: cached.workingDirectory, worktree: cached.worktree }
    }
    return await this.projected(header.id)
  }

  /**
   * The read wire values of a Session at its log end; observing a cold Session neither attaches nor resumes it.
   * @throws when an injected owner's value is missing, which a misassembled projection registry would cause.
   */
  private async projected(sessionId: SessionId): Promise<Observed> {
    using observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal: this.lifetime.signal })
    const values = observation.projections?.values
    /* v8 ignore next 3 -- the service injects the registry and every owner read here, so each value is registered. */
    if (values?.worktree === undefined || values.workingDirectory === undefined) {
      throw new Error(`worktree: the observation of Session ${sessionId} lacks a projected value`)
    }
    return { worktree: values.worktree, workingDirectory: values.workingDirectory }
  }
}

/** The creations the Session made itself, not those a fork inherited. */
function ownedOf(creations: readonly WorktreeCreation[]): readonly WorktreeCreation[] {
  return creations.filter(creation => creation.owned)
}

/** Whether any subagent ancestor of `header`, followed through the listed headers, is archived. */
function ancestorArchived(
  header: SessionHeader, headers: ReadonlyMap<SessionId, SessionHeader>, archived: ReadonlySet<SessionId>,
): boolean {
  const visited = new Set<SessionId>([header.id])
  let current = header
  while (current.origin === 'subagent' && current.parentSession !== undefined && !visited.has(current.parentSession)) {
    if (archived.has(current.parentSession)) return true
    visited.add(current.parentSession)
    const parent = headers.get(current.parentSession)
    if (parent === undefined) return false
    current = parent
  }
  return false
}
