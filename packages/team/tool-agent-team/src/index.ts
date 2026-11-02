/** Conditionally available task-board tools and guidance for Agent Teams. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ROOT_AGENT_NAME, SubagentError } from '@deepseek-ai/dsh-subagent'
import { TeamTaskId } from '@deepseek-ai/dsh-agent-team'
import type { TeamTaskView } from '@deepseek-ai/dsh-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agentTeams', 'subagents', 'tools', 'systemPrompt']

/** The Team tool plugin takes no configuration. */
export type Config = Record<never, never>

/** Loader schema for the opt-in Team tool plugin. */
export const Config: z<Config> = z.object({})

/** Configuration keys removed when Team reused subagent creation and messaging. */
const REMOVED_CONFIG_KEYS = ['interrupt', 'freshProvider', 'forkProvider'] as const

/** Model-facing collaboration guidance shared by Lead and teammates. */
const TEAM_POLICY = `A shared task board is available in this session. Task owners are agent names from list_agents. The root can reassign tasks to itself or any continuable descendant; other agents claim ready tasks themselves.

Read tasks with team_task_list or team_task_get, claim with the current revision, perform the work, then complete the task. Dependencies determine readiness; write scopes describe expected edits and overlapping scopes are advisory, not locks. Task readiness does not start an agent.

Task changes do not end wait_agent calls, add inbox messages, or start idle agents. Use send_message when another agent needs to act on a task.`

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
    owner: { type: 'string' },
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

/** One task as the model sees it: the owner's Session id is replaced by its agent name. */
type NamedTaskView = Omit<TeamTaskView, 'ownerId'> & { readonly owner?: string }

/** Recover the exact caller guaranteed by conditional Team-tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- The Team condition rejects callers without an Agent before execution. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/**
 * Register Team tools and guidance selected by each caller's root Session mode.
 * @param ctx - context carrying Team, subagent, tool, and system prompt services.
 * @param config - the empty plugin configuration; removed keys fail at load.
 */
export function apply(ctx: Context, config: Config = {}): void {
  for (const key of REMOVED_CONFIG_KEYS) {
    if (Object.hasOwn(config, key)) {
      throw new Error(`tool-agent-team: ${key} is no longer supported; create teammates with a subagent tool`)
    }
  }
  /** Map tree members to the names list_agents reports; the root is `lead`, unnamed history keeps its Session id. */
  const memberNames = async (caller: Agent, signal: AbortSignal): Promise<ReadonlyMap<SessionId, string>> => {
    const root = ctx.subagents.rootOf(caller)
    const names = new Map<SessionId, string>([[root.id, ROOT_AGENT_NAME]])
    for (const entry of await ctx.subagents.listDescendants(root.id, signal)) {
      if (entry.path !== undefined) names.set(entry.id, entry.path)
    }
    return names
  }
  /** Read names only when a result names an owner. */
  const ownerNamesFor = (caller: Agent, tasks: readonly TeamTaskView[], signal: AbortSignal): Promise<ReadonlyMap<SessionId, string>> =>
    tasks.some(task => task.ownerId !== undefined) ? memberNames(caller, signal) : Promise.resolve(new Map())
  const withOwnerName = (names: ReadonlyMap<SessionId, string>, { ownerId, ...task }: TeamTaskView): NamedTaskView =>
    ownerId === undefined ? task : { ...task, owner: names.get(ownerId) ?? ownerId }
  const enabled = (agent: Agent | undefined): boolean => {
    if (agent === undefined) return false
    try {
      return ctx.agentTeams.isEnabled(agent)
    } catch (error: unknown) {
      if (!(error instanceof SubagentError) || error.code !== 'UNAUTHORIZED') throw error
      // An independently resumed child has no active root to supply Team mode.
      return false
    }
  }
  ctx.systemPrompt.section({
    name: 'team:policy',
    order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
    text: ({ agent }) => enabled(agent) ? TEAM_POLICY : '',
  })
  ctx.tools.register(defineTool({
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
      // New tasks have no owner.
      return withOwnerName(new Map(), task)
    },
  }), { when: ({ agent }) => enabled(agent) })

  ctx.tools.register(defineTool({
    name: 'team_task_list',
    description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
    parameters: {
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'Optional exact status filter.',
      },
      owner: { type: 'string', description: 'Optional owner agent name filter; use unowned for tasks without an owner.' },
      ready: { type: 'boolean', description: 'Optional readiness filter.' },
      cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
      limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
    },
    output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
    async execute(args, exec) {
      const cursor = args.cursor ?? 0
      const limit = args.limit ?? 50
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
      const caller = callingAgent(exec.agent, 'team_task_list')
      const owner = args.owner === undefined || args.owner === 'unowned'
        ? args.owner
        : await ctx.subagents.resolveName(caller, args.owner, exec.signal)
      const filtered = ctx.agentTeams.listTasks(caller).filter(task =>
        (args.status === undefined || task.status === args.status)
        && (owner === undefined || (owner === 'unowned' ? task.ownerId === undefined : task.ownerId === owner))
        && (args.ready === undefined || task.ready === args.ready))
      const page = filtered.slice(cursor, cursor + limit)
      const names = await ownerNamesFor(caller, page, exec.signal)
      return {
        tasks: page.map(task => withOwnerName(names, task)),
        ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
      }
    },
  }), { when: ({ agent }) => enabled(agent) })

  ctx.tools.register(defineTool({
    name: 'team_task_get',
    description: 'Read the complete latest value of one shared task before changing or executing it.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Shared task id.' },
    },
    output: jsonOutput(TASK_VIEW_SCHEMA),
    async execute(args, exec) {
      const caller = callingAgent(exec.agent, 'team_task_get')
      const task = ctx.agentTeams.getTask(caller, TeamTaskId(args.task_id))
      return withOwnerName(await ownerNamesFor(caller, [task], exec.signal), task)
    },
  }), { when: ({ agent }) => enabled(agent) })

  ctx.tools.register(defineTool({
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
      owner: { type: 'string', description: 'Agent name of the root or any continuable descendant for root-only reassign; omit to unassign.' },
    },
    output: jsonOutput(TASK_VIEW_SCHEMA),
    async execute(args, exec) {
      const caller = callingAgent(exec.agent, 'team_task_update')
      const taskId = TeamTaskId(args.task_id)
      // Read names before the change commits, so a failed read never reports a committed update as failed.
      const names = await memberNames(caller, exec.signal)
      const task = await ctx.agentTeams.updateTask(caller, {
        taskId,
        expectedRevision: args.expected_revision,
        action: args.action,
        ...args.subject === undefined ? {} : { subject: args.subject },
        ...args.description === undefined ? {} : { description: args.description },
        ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
        ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
        ...args.owner === undefined ? {} : { owner: await ctx.subagents.resolveName(caller, args.owner, exec.signal) },
      }, exec.signal)
      return withOwnerName(names, task)
    },
  }), { when: ({ agent }) => enabled(agent) })
}
