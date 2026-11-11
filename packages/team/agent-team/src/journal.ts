/** Serialized Team transactions over the exact live Lead Session log. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamProjectionState, TeamState } from './projection.ts'

import { brandString } from '@deepseek-ai/dsh-brand'
import type { TeamId } from './types.ts'
import { TeamError } from './error.ts'
import type { TeamTaskSnapshot } from './types.ts'

/** Owns per-Lead transaction order and committed Team event publication. */
export class TeamJournal {
  private readonly tails = new Map<SessionId, Promise<void>>()

  /**
   * @param ctx - Team service context with the injected Session service.
   * @param teamProjectionHandle - Team state registration owned by the Team service.
   */
  constructor(
    private readonly ctx: Context,
    private readonly teamProjectionHandle: ProjectionHandle<TeamProjectionState>,
  ) {}

  /**
   * Read authoritative Team state for one exact live Lead.
   * @param root - exact live Team Lead.
   * @returns current projected state selected by the Lead Team id.
   * @throws {TeamError} `TEAM_STATE_CORRUPT` when the durable Team projection has failed.
   */
  state(root: Agent): TeamState {
    const projection = this.teamProjectionHandle.stateOf(root.session)
    if (projection.failure !== undefined) throw new TeamError(projection.failure, 'TEAM_STATE_CORRUPT')
    return projection
  }

  /**
   * Serialize one Lead's asynchronous mutation operation.
   * @param rootId - Lead Session identity selecting the transaction queue.
   * @param operation - complete read-check-append operation.
   * @returns the operation result.
   */
  async transact<T>(rootId: SessionId, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(rootId) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(rootId, tail)
    try {
      return await run
    } finally {
      if (this.tails.get(rootId) === tail) this.tails.delete(rootId)
    }
  }

  /**
   * Append and flush one task revision.
   * @param root - live tree root whose Session stores the task.
   * @param task - complete committed task revision.
   * @throws TEAM_TASK_PERSISTENCE_UNCONFIRMED after append when flush fails or has no listener; read the task before retrying.
   */
  async appendAndFlush(root: Agent, task: TeamTaskSnapshot): Promise<void> {
    root.session.append('team/task', { version: 2, teamId: brandString<TeamId>(root.id), task })
    try {
      const participated = await this.ctx.sessions.flush(root.session)
      if (!participated) throw new Error('No session durability listener participated')
    } catch (error: unknown) {
      throw new TeamError(
        `task "${task.id}" revision ${task.revision} is visible, but persistence was not confirmed; read the task before retrying`,
        'TEAM_TASK_PERSISTENCE_UNCONFIRMED',
        { cause: error },
      )
    }
  }
}
