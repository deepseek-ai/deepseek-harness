/** Agent Teams service façade over membership, the shared task board, and change waits. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamActivity } from './activity.ts'
import { TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { TeamMembers } from './membership.ts'
import type { TeamMembership } from './membership.ts'
import { teamProjectionDefinition } from './projection.ts'
import { TeamTaskBoard } from './task-board.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  Config,
  CreateTeamTaskRequest,
  TeamTaskView,
  TeamWaitResult,
  UpdateTeamTaskRequest,
} from './types.ts'

export type * from './types.ts'
export type { TeamMembership } from './membership.ts'
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
  static inject = ['agents', 'sessions', 'sessionProjections']

  static Config: z<Config> = z.object({
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
  })

  private readonly activity: TeamActivity
  private readonly journal: TeamJournal
  private readonly members: TeamMembers
  private readonly tasks: TeamTaskBoard

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
    const maxTasks = positiveLimit('maxTasks', config.maxTasks ?? DEFAULT_MAX_TASKS)

    this.activity = new TeamActivity()
    this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) })
    this.members = new TeamMembers(ctx)
    this.tasks = new TeamTaskBoard(this.journal, maxTasks)

    const notifyMember = ({ agent }: { agent: Agent }): void => {
      const membership = this.members.tryMembership(agent)
      if (membership !== undefined) this.activity.notify(membership.id)
    }
    ctx.on('agent/status', notifyMember)
    ctx.on('agent/inbox/inserted', notifyMember)
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(teamProjectionDefinition)
      return () => {
        this.activity.close()
        disposeProjection()
      }
    }, 'agentTeams.runtimeLifecycle()')
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its Lead, Team identity, and role.
   */
  membership(agent: Agent): TeamMembership {
    return this.members.membership(agent)
  }

  /**
   * Resolve a caller without throwing, used by scoped-tool installation and observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for stale identities and children whose parent left the registry.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.members.tryMembership(agent)
  }

  /**
   * Whether another live member of the caller's Team is currently running a turn.
   * @param caller - exact live Team member.
   * @returns whether a peer can still produce a Team change.
   */
  hasActivePeer(caller: Agent): boolean {
    return this.members.hasActivePeer(caller)
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.create(this.members.membership(caller), request)
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param caller - exact live Team member reading the task.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView {
    return this.tasks.get(this.members.membership(caller), id)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param caller - exact live Team member reading the board.
   * @returns detached current task views.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    return this.tasks.list(this.members.membership(caller))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.update(caller, this.members.membership(caller), request)
  }

  /**
   * Wait for the next task change, member status change, or message a member's inbox accepts.
   * @param caller - exact live Team member waiting for activity.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for the wait only.
   * @returns one observed change or a timeout result.
   */
  async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    const membership = this.members.membership(caller)
    return await this.activity.wait(membership.id, timeoutMs, signal)
  }
}

export default TeamService
