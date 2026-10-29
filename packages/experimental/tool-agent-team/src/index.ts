/** Scoped model-facing task-board tools for the opt-in Agent Teams runtime. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent-names'
import { TeamTaskId, type TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'subagents', 'subagentNames', 'tools', 'systemPrompt']

/** The Team tool plugin takes no configuration. */
export type Config = Record<never, never>

/** Loader schema for the opt-in Team tool plugin. */
export const Config: z<Config> = z.object({})

/** Configuration keys removed when Team reused subagent creation and messaging. */
const REMOVED_CONFIG_KEYS = ['interrupt', 'freshProvider', 'forkProvider'] as const

/** Model-facing collaboration guidance shared by Lead and teammates. */
const TEAM_POLICY = `A shared task board is available to every agent in your subagent tree. Task owners use agent names from list_agents, or Session ids when no name is bound. The root can reassign tasks to itself or any continuable descendant; other agents claim ready tasks themselves.

Read tasks with team_task_list or team_task_get, claim with the current revision, perform the work, then complete the task. Dependencies determine readiness; write scopes describe expected edits and overlapping scopes are advisory, not locks. Task readiness does not start an agent.

Task changes do not end wait_agent calls, add inbox messages, or start idle agents. Use send_message when an agent needs to act on a task update.`

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    ownerName: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * Team result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

type NamedTaskView = Omit<TeamTaskView, 'ownerId'> & { readonly ownerName?: string }

/** Capture owner display names before a mutation or for the requested result rows. */
function taskOwnerNames(
  ctx: Context, caller: Agent, owners: readonly (SessionId | undefined)[],
): ReadonlyMap<SessionId, string> {
  const rootSession = ctx.subagents.rootOf(caller).session
  const names = new Map<SessionId, string>()
  for (const ownerId of owners) {
    if (ownerId !== undefined && !names.has(ownerId)) names.set(ownerId, ctx.subagentNames.nameOf(rootSession, ownerId))
  }
  return names
}

/** Format a task from names captured for each possible result owner before its commit. */
function namedTask({ ownerId, ...view }: TeamTaskView, names: ReadonlyMap<SessionId, string>): NamedTaskView {
  return {
    ...view,
    ...ownerId === undefined ? {} : { ownerName: names.get(ownerId) as string },
  }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  try {
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: TEAM_POLICY,
    }))
    register(scoped.systemPrompt.context({
      name: 'team:identity',
      order: scoped.systemPrompt.getContextOrder('TEAM_IDENTITY'),
      required: true,
      interpolate: false,
      text: () => {
        try {
          const root = ctx.subagents.rootOf(agent)
          return root === agent
            ? 'You are the Team Lead. Your name is lead.'
            : 'You are a teammate in the Team led by "lead".'
        } catch (error: unknown) {
          if (!(error instanceof SubagentError) || error.code !== 'UNAUTHORIZED') throw error
          return 'Your Team root agent is unavailable. Continue independent work; shared tasks, subagent discovery, and messaging require an active root.'
        }
      },
    }))
    register(scoped.tools.register(defineTool({
      name: 'team_task_create',
      description: 'Create one unowned pending task on the shared Team task board.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.',
        },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_create')
        const task = await ctx.agentTeams.createTask(caller, {
          subject: args.subject,
          description: args.description,
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
        }, exec.signal)
        return namedTask(task, new Map())
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Optional exact status filter.',
        },
        owner: { type: 'string', description: 'Optional exact ownerName filter; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        const caller = callingAgent(exec.agent, 'team_task_list')
        let filtered = ctx.agentTeams.listTasks(caller).filter(task =>
          (args.status === undefined || task.status === args.status)
          && (args.owner !== 'unowned' || task.ownerId === undefined)
          && (args.ready === undefined || task.ready === args.ready))
        const filterOwner = args.owner !== undefined && args.owner !== 'unowned'
        const candidates = filterOwner ? filtered : filtered.slice(cursor, cursor + limit)
        const names = taskOwnerNames(ctx, caller, candidates.map(task => task.ownerId))
        if (filterOwner) filtered = filtered.filter(task => namedTask(task, names).ownerName === args.owner)
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit).map(task => namedTask(task, names)),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_get')
        const task = ctx.agentTeams.getTask(caller, TeamTaskId(args.task_id))
        const names = taskOwnerNames(ctx, caller, [task.ownerId])
        return Promise.resolve(namedTask(task, names))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'],
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory write scopes for edit.' },
        owner: { type: 'string', description: 'Agent name or Session id of the root or any continuable descendant for root-only reassign; omit to unassign.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_update')
        const taskId = TeamTaskId(args.task_id)
        const current = ctx.agentTeams.getTask(caller, taskId)
        const owner = args.owner === undefined ? undefined
          : ctx.subagentNames.resolveName(ctx.subagents.rootOf(caller).session, args.owner)
        const keepsOwner = !['claim', 'release', 'reopen', 'reassign'].includes(args.action)
        // Names are immutable; the service still checks the revision and authority after these reads.
        const names = taskOwnerNames(ctx, caller, [
          caller.id, owner, keepsOwner ? current.ownerId : undefined,
        ])
        const task = await ctx.agentTeams.updateTask(caller, {
          taskId,
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          ...owner === undefined ? {} : { owner },
        }, exec.signal)
        return namedTask(task, names)
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/**
 * Install Team tools in every live or subsequently published Team member scope.
 * @param ctx - context carrying the Agent registry, Team and subagent services, tools, and system prompt.
 * @param config - the empty plugin configuration; removed keys fail at load.
 */
export function apply(ctx: Context, config: Config = {}): void {
  for (const key of REMOVED_CONFIG_KEYS) {
    if (Object.hasOwn(config, key)) {
      throw new Error(`tool-agent-team: ${key} is no longer supported; create teammates with a subagent tool`)
    }
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent)) return
    installed.set(agent, install(agent, ctx))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team.scopedTools()')
}
