/** Shared task boards owned by subagent tree roots. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { teamProjectionDefinition } from './projection.ts'
import { TeamTaskBoard } from './task-board.ts'
import { TeamTaskId } from './types.ts'
import type {
  Config,
  CreateTeamTaskRequest,
  TeamTaskView,
  UpdateTeamTaskRequest,
} from './types.ts'

export type * from './types.ts'
export { TeamId, TeamMessageId, TeamTaskId } from './types.ts'
export { TeamError } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
  }
}

const DEFAULT_MAX_TASKS = 256

/** Configuration keys removed when Team reused subagent creation and messaging. */
const REMOVED_CONFIG_KEYS = ['maxMembers', 'maxMessageBytes', 'disposalTimeoutMs'] as const

/** Validate one positive safe-integer deployment limit. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends Service {
  static inject = ['agents', 'sessions', 'sessionProjections', 'subagents']

  static Config: z<Config> = z.object({
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
  })

  private readonly maxTasks: number
  private journal!: TeamJournal
  private tasks!: TeamTaskBoard

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentTeams')
    for (const key of REMOVED_CONFIG_KEYS) {
      if (Object.hasOwn(config, key)) {
        throw new TeamError(
          `agent-team: ${key} is no longer supported; teammates are subagents, so subagent limits and inbox delivery apply`,
          'TEAM_INVALID_CONFIG',
        )
      }
    }
    this.maxTasks = positiveLimit('maxTasks', config.maxTasks ?? DEFAULT_MAX_TASKS)
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const teamProjectionHandle = await ctx.sessionProjections.register(teamProjectionDefinition)
    this.journal = new TeamJournal(ctx, teamProjectionHandle, (root) => {
      for (const agent of ctx.agents.list()) {
        if (agent === root || ctx.agents.isOwnedBy(agent.id, root)) {
          emitAgentEvent(ctx, agent, 'agent/wait-notified', {})
        }
      }
    })
    this.tasks = new TeamTaskBoard(ctx, this.journal, this.maxTasks)
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @param signal - cancellation before the task event is appended; omitted means no cancellation.
   * @returns the revision-one task view.
   * @throws TEAM_TASK_PERSISTENCE_UNCONFIRMED when the task is visible but durability is unknown; read it before retrying.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest, signal?: AbortSignal): Promise<TeamTaskView> {
    return await this.tasks.create(caller, this.ctx.subagents.rootOf(caller), request, signal)
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param caller - exact live Team member reading the task.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView {
    return this.tasks.get(this.ctx.subagents.rootOf(caller), id)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param caller - exact live Team member reading the board.
   * @returns detached current task views.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    return this.tasks.list(this.ctx.subagents.rootOf(caller))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @param signal - cancellation before the task event is appended; omitted means no cancellation.
   * @returns the committed next task revision.
   * @throws TEAM_TASK_PERSISTENCE_UNCONFIRMED when the task is visible but durability is unknown; read it before retrying.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest, signal?: AbortSignal): Promise<TeamTaskView> {
    return await this.tasks.update(caller, this.ctx.subagents.rootOf(caller), request, signal)
  }

}

export default TeamService
