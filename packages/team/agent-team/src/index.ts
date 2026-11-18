/** Shared task boards owned by subagent tree roots. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subagent'
import { TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { teamProjectionDefinition, type TeamProjectionState } from './projection.ts'
import { TeamTaskBoard } from './task-board.ts'
import type { TeamTaskId } from './types.ts'
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
export class TeamService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

  static Config: z<Config> = z.object({
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    defaultEnabled: z.boolean().default(false),
  })

  private projection!: ProjectionHandle<TeamProjectionState>
  private readonly maxTasks: number
  private readonly defaultEnabled: boolean
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
    this.defaultEnabled = config.defaultEnabled ?? false
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    this.projection = await ctx.sessionProjections.register(teamProjectionDefinition)
    this.journal = new TeamJournal(ctx, this.projection)
    this.tasks = new TeamTaskBoard(ctx, this.journal, this.maxTasks)
    if (this.defaultEnabled) {
      ctx.on('agent/created', async ({ agent, source, signal }) => {
        // Child activation ownership is registered after agent/created settles.
        if (source !== 'startup' || agent.session.header.origin === 'subagent') return
        if (this.projection.stateOf(agent.session).enabled !== undefined) return
        await this.setEnabled(agent, true, signal)
      })
    }
  }

  /**
   * Read the Team selection shared by the caller's subagent tree.
   * @param caller - exact live root or descendant.
   * @returns whether Team tools and guidance are enabled.
   */
  isEnabled(caller: Agent): boolean {
    const root = this.ctx.subagents.rootOf(caller)
    return this.projection.stateOf(root.session).enabled === true
  }

  /**
   * Save a root Session's Team selection without stopping children or deleting tasks.
   * The selection takes effect before awaiting persistence. Tools resolve availability at
   * step preparation; prompt providers read the selection when evaluated. Task mutations
   * check the current mode when their queued operation starts; admitted operations finish.
   * @param agent - exact live root whose tree receives the selection.
   * @param enabled - selected Team mode.
   * @param signal - cancellation checked before changing the selection.
   * @returns fulfillment after the selection flushes.
   * @throws when called by a descendant or persistence fails. An appended selection remains active;
   * retrying the same selection flushes without a duplicate event.
   */
  @Remote
  async setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void> {
    const root = this.ctx.subagents.rootOf(agent)
    if (root !== agent) throw new TeamError('change Team mode from the root Session', 'TEAM_LEAD_REQUIRED')
    signal?.throwIfAborted()
    if (this.isEnabled(root) !== enabled) root.session.append('team/mode', { enabled })
    await this.ctx.sessions.flush(root.session)
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
