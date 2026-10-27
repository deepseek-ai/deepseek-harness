/** Archive-triggered reclamation of UI-owned checkouts, independent of open panel followers. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-terminal'
import type {} from '@deepseek-ai/dsh-jobs/view'
import type {} from '@deepseek-ai/dsh-workspace'
import type { ForgeSessionWorktree, ForgeWorktreeCleanup, ForgeWorktreeRetention } from './types.ts'
import { within } from './worktree.ts'

interface Attempt {
  readonly worktree: ForgeSessionWorktree
  readonly revision: number
  status: ForgeWorktreeCleanup['status']
  cancelled: boolean
  done: Promise<void>
}

/** Owns pending cleanup, serializes directory entry, and drains before its providers are released. */
export class WorktreeArchives {
  private readonly attempts = new Map<SessionId, Attempt>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private tail: Promise<void> = Promise.resolve()
  private revision = 0
  /** Withdraw listeners and settle accepted work. */
  readonly dispose: () => Promise<void>

  /**
   * @param ctx - panel context with Workspace, query, and worktree providers.
   * @param retention - authoritative UI creation and directory projection.
   */
  constructor(private readonly ctx: Context, private readonly retention: ProjectionHandle<ForgeWorktreeRetention>) {
    const archive = ctx.on('workspace/session-archived', ({ sessionId }) => this.archive(sessionId))
    const unarchive = ctx.on('workspace/session-unarchiving', async ({ sessionId }) => {
      // A fork can hold the same checkout as the Session whose archive scheduled removal.
      const state = await ctx.sessionQuery.inspectSession(sessionId, session => this.retention.stateOf(session)).catch((error: unknown) => {
        ctx.logger.warn('Cancelling archive cleanup because the restored Session could not be inspected: %s', error)
        return null
      })
      for (const [id, attempt] of this.attempts) {
        if (state === null || id === sessionId || state.state.created?.path === attempt.worktree.path
          || (state.state.cwd !== null && within(attempt.worktree.path, state.state.cwd))) attempt.cancelled = true
      }
      await this.exclusive(async () => {})
      this.attempts.delete(sessionId)
    })
    const directory = ctx.on('working-directory/access', ({ agent, path }, next) => this.exclusive(async () => {
      const state = this.retention.stateOf(agent.session).state
      const current = ctx.workingDirectory.get(agent.session)
      if (path === null && state.created !== null && within(state.created.path, current)
        && (await ctx.fs.stat(await ctx.fs.resolve(current, { signal: this.lifetime.signal }), this.lifetime.signal))?.type !== 'directory') {
        throw new Error('The archived worktree is unavailable; restore it or select a working directory before continuing')
      }
      return await next()
    }))
    const drain = ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Worktree archive cleanup stopped'))
      for (const attempt of this.attempts.values()) attempt.cancelled = true
      await Promise.allSettled(this.pending)
      this.attempts.clear()
    })
    this.dispose = ctx.effect(function* () {
      yield archive
      yield unarchive
      yield directory
      yield drain
    }, 'forge-panel: drain archive cleanup')
  }

  /**
   * Read the most recent archive attempt; waiting never initiates cleanup.
   * @param session - archived Session visible to the Remote caller.
   * @param revision - null reads immediately; a matching revision waits for that attempt.
   * @returns the attempt state, or null when absent or superseded.
   */
  async result(session: Session, revision: number | null): Promise<ForgeWorktreeCleanup | null> {
    const attempt = this.attempts.get(session.id)
    if (attempt === undefined || (revision !== null && revision !== attempt.revision)) return null
    if (revision !== null) await attempt.done
    if (this.lifetime.signal.aborted) return null
    return { revision: attempt.revision, status: attempt.status }
  }

  private async archive(sessionId: SessionId): Promise<void> {
    const ctx = this.ctx
    const worktrees = ctx.worktrees
    const candidate = await this.exclusive(async () => {
      const own = await ctx.sessionQuery.inspectSession(sessionId, session => this.retention.stateOf(session), this.lifetime.signal)
      let worktree = own.state.created
      if (worktree === null && own.state.cwd !== null) {
        for (const record of await ctx.sessionQuery.listSessions(this.lifetime.signal)) {
          const source = await ctx.sessionQuery.inspectSession(
            record.header.id, session => this.retention.stateOf(session), this.lifetime.signal,
          )
          if (source.owned && source.state.created !== null && within(source.state.created.path, own.state.cwd)) {
            worktree = source.state.created
            break
          }
        }
      }
      if (worktree === null) return null
      const policy = await this.unused(worktree)
      if (policy === null) return null
      if (!await worktrees.canRemove(policy, worktree, this.lifetime.signal)) return null
      return worktree
    }).catch((error: unknown) => {
      ctx.logger.warn('Session %s archived; its worktree was retained because inspection failed: %s', sessionId, error)
      return null
    })
    if (candidate === null || this.lifetime.signal.aborted) return
    const attempt: Attempt = {
      worktree: candidate, revision: ++this.revision, status: 'scheduled', cancelled: false, done: Promise.resolve(),
    }
    this.attempts.set(sessionId, attempt)
    attempt.done = this.exclusive(async () => {
      const policy = await this.unused(candidate)
      if (policy === null) {
        attempt.status = 'retained'
        return
      }
      // Inspection is repeated by remove, after the final application-level use check.
      attempt.status = await worktrees.remove(policy, candidate, this.lifetime.signal, () => !attempt.cancelled) ? 'removed' : 'retained'
    }).catch((error: unknown) => {
      attempt.status = 'failed'
      ctx.logger.warn('Session %s archived; cleanup of %s failed and its branch was retained: %s', sessionId, candidate.path, error)
    })
  }

  private async unused(worktree: ForgeSessionWorktree): Promise<SandboxExecutionPolicy | null> {
    const ctx = this.ctx
    this.lifetime.signal.throwIfAborted()
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
    let owners = 0
    let ownerPolicy: SandboxExecutionPolicy | null = null
    const records = await ctx.sessionQuery.listSessions(this.lifetime.signal)
    for (const record of records) {
      const { value, policy } = await ctx.sessionQuery.inspectSession(record.header.id, session => ({
        value: this.retention.stateOf(session), policy: ctx.sandboxPolicy.resolve({ session }),
      }), this.lifetime.signal)
      const created = value.state.created
      const same = created?.path === worktree.path && created.branch === worktree.branch
        && created.repositoryRoot === worktree.repositoryRoot && created.baseCommit === worktree.baseCommit
      if (same && value.state.restoring) return null
      if (same && value.owned) { owners++; ownerPolicy = policy }
      if (!archived.has(record.header.id) && (same || (value.state.cwd !== null && within(worktree.path, value.state.cwd)))) return null
    }
    if (owners !== 1 || ownerPolicy?.mode === 'read-only') return null
    // Processes keep their original cwd after a Session changes directory. An idle PTY
    // or a surviving job is conservatively retained even when its present cwd is unknown.
    for (const agent of ctx.agents.list()) {
      const current = ctx.workingDirectory.get(agent.session)
      const origin = this.retention.stateOf(agent.session).state.created
      const related = within(worktree.path, current) || origin?.path === worktree.path
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: agent.session.id }, () => Promise.resolve([]))
      if ((related && (activity.length > 0 || agent.status === 'running')) || activity.some(item => item.kind === 'job')
        || ctx.get('terminals')?.list(agent).some(terminal => terminal.status.kind === 'running') === true) return null
      if (!archived.has(agent.session.id) && related) return null
    }
    return ownerPolicy
  }

  private exclusive<T>(body: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(() => {
      this.lifetime.signal.throwIfAborted()
      return body()
    })
    this.tail = operation.then(() => {}, () => {})
    this.pending.add(operation)
    void operation.then(() => { this.pending.delete(operation) }, () => { this.pending.delete(operation) })
    return operation
  }
}
