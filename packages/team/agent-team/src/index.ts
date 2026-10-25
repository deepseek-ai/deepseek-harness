/** Shared task boards owned by subagent tree roots. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-commands'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { teamProjectionDefinition, type TeamProjectionState } from './projection.ts'
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
  interface Events {
    /**
     * Synchronize scoped consumers with the root's current Team selection, including retries.
     * @mode parallel
     * @param root - exact live root whose current selection consumers must read.
     */
    'team/mode-changed'(root: Agent): void
  }
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
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

  static Config: z<Config> = z.object({
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
  })

  private projection!: ProjectionHandle<TeamProjectionState>
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
    this.projection = await ctx.sessionProjections.register(teamProjectionDefinition)
    this.journal = new TeamJournal(ctx, this.projection, (root) => { this.notifyWaits(root) })
    this.tasks = new TeamTaskBoard(ctx, this.journal, this.maxTasks)
    ctx.inject(['commands'], (scope) => {
      scope.commands.register({
        definitionId: CommandDefinitionId('@deepseek-ai/dsh-agent-team'),
        name: 'team',
        description: 'Enable or disable Agent Teams for this Session',
        input: { hint: 'on|off', attachments: false },
        handler: async ({ agent, rawInput, signal }) => {
          const selection = rawInput.trim()
          if (selection !== 'on' && selection !== 'off') {
            return { kind: 'error', text: 'Use /team on or /team off.' }
          }
          await this.setEnabled(agent, selection === 'on', signal)
          return { kind: 'success', text: selection === 'on' ? 'Agent Teams enabled.' : 'Agent Teams disabled.' }
        },
      })
    })
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
   * The selection takes effect before awaiting consumers or persistence. Task mutations
   * check the current mode when their queued operation starts; admitted operations finish.
   * Current waits end after the selection is flushed.
   * @param caller - exact live root whose tree receives the selection.
   * @param enabled - selected Team mode.
   * @param signal - cancellation checked before changing the selection.
   * @returns fulfillment after the selection flushes and scoped consumers update.
   * @throws when called by a descendant, a consumer fails, or persistence fails. An appended selection remains active;
   * retrying the same selection synchronizes consumers and flushes without a duplicate event.
   */
  async setEnabled(caller: Agent, enabled: boolean, signal?: AbortSignal): Promise<void> {
    const root = this.ctx.subagents.rootOf(caller)
    if (root !== caller) throw new TeamError('change Team mode from the root Session', 'TEAM_LEAD_REQUIRED')
    signal?.throwIfAborted()
    if (this.isEnabled(root) !== enabled) root.session.append('team/mode', { enabled })
    await this.ctx.parallel('team/mode-changed', root)
    await this.ctx.sessions.flush(root.session)
    this.notifyWaits(root)
  }

  private notifyWaits(root: Agent): void {
    for (const agent of this.ctx.agents.list()) {
      let agentRoot: Agent
      try {
        agentRoot = this.ctx.subagents.rootOf(agent)
      } catch (error: unknown) {
        if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') continue
        throw error
      }
      if (agentRoot === root) emitAgentEvent(this.ctx, agent, 'agent/wait-notified', {})
    }
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
