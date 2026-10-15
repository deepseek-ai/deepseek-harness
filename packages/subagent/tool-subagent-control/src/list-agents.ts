/**
 * The globally named `list_agents` tool: a thin model-facing adapter over
 * the continuable projection of `ctx.subagents.listChildren()` and, for the
 * `descendants` scope, `ctx.subagents.listDescendants()`. A continuable child
 * also sees its live parent and, the other continuable children of that
 * parent. It stays separately loadable from the root `send_message` plugin so
 * a deployment can register continuation delivery without exposing discovery.
 * @module @deepseek-ai/dsh-tool-subagent-control/list-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentCatalogEntry, SubagentDescendantListEntry, SubagentListEntry,
} from '@deepseek-ai/dsh-subagent'
import { assertNever } from '@deepseek-ai/dsh-util-values'

export const name = 'tool-subagent-list-agents'
export const inject = ['tools', 'subagents', 'agents']

type ListAgentsScope = 'children' | 'descendants'

interface ListAgentsRequest {
  readonly scope?: ListAgentsScope
}

interface ListAgentsSpec {
  readonly scope: ListAgentsScope
}

type ListAgentsEntry =
  | {
    readonly kind: 'parent'
    readonly id: SessionId
    readonly status: 'running' | 'inactive'
  }
  | {
    readonly kind: 'child' | 'sibling'
    readonly id: SessionId
    readonly label: string
    readonly status: 'running' | 'inactive'
    readonly parent?: SessionId
    readonly depth?: number
  }
  | {
    readonly kind: 'diagnostic'
    readonly id: SessionId
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    readonly parent?: SessionId
    readonly depth?: number
  }

/** Resolve the optional model request into an internal required-scope spec. */
function resolveListAgentsRequest(request: ListAgentsRequest): ListAgentsSpec {
  return { scope: request.scope ?? 'children' }
}

/** Report turn activity without exposing whether the child is loaded. */
function statusOf(agents: { get(id: SessionId): Agent | undefined }, id: SessionId): 'running' | 'inactive' {
  return agents.get(id)?.status === 'running' ? 'running' : 'inactive'
}

/** Project one service row into the model-facing entry, or omit a one-shot child. */
function project(
  agents: { get(id: SessionId): Agent | undefined },
  entry: SubagentCatalogEntry | SubagentListEntry,
  position?: Pick<SubagentDescendantListEntry, 'parentId' | 'depth'>,
): ListAgentsEntry | undefined {
  const at = position === undefined ? {} : { parent: position.parentId, depth: position.depth }
  if ('kind' in entry && entry.kind === 'diagnostic') {
    return { kind: 'diagnostic', id: entry.id, reason: entry.reason, ...at }
  }
  // One-shot children cannot be continued by send_message, so the model
  // never selects them; discovery still traversed them for descendants.
  if (entry.mode !== 'continuable') return undefined
  return {
    kind: 'child',
    id: entry.id,
    label: entry.label,
    status: statusOf(agents, entry.id),
    ...at,
  }
}

/**
 * List a continuable child's live parent and continuable siblings.
 * @param ctx - context carrying the subagent service and live Agent registry.
 * @param caller - exact calling Agent.
 * @param signal - cancellation forwarded to the parent catalog read.
 * @returns the parent row followed by sibling rows, or nothing for roots and offline parents.
 */
async function family(ctx: Context, caller: Agent, signal: AbortSignal): Promise<ListAgentsEntry[]> {
  const header = caller.session.header
  const parent = header.origin === 'subagent' && header.parentSession !== undefined
    ? ctx.agents.get(header.parentSession)
    : undefined
  if (parent === undefined) return []
  const rows: ListAgentsEntry[] = [{ kind: 'parent', id: parent.id, status: statusOf(ctx.agents, parent.id) }]
  const children = await ctx.subagents.listChildren(parent.id, signal)
  const own = children.find(entry => entry.id === caller.id)
  if (own?.mode !== 'continuable') return []
  for (const entry of children) {
    if (entry.id === caller.id || entry.mode !== 'continuable') continue
    rows.push({ kind: 'sibling', id: entry.id, label: entry.label, status: statusOf(ctx.agents, entry.id) })
  }
  return rows
}

/**
 * Register the `list_agents` tool.
 * @param ctx - context carrying the tool registry, subagent service, and live Agent registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'list_agents',
    description:
      'List agents you can message: subagents you started and, when you are a subagent, your parent and your continuable siblings. '
      + 'Rows carry ids, descriptions, and status. '
      + 'running means it is working; inactive means it is not currently working. '
      + 'You will be notified when a subagent finishes; there is no need to keep checking its status. '
      + 'Use send_message to continue the conversation.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['children', 'descendants'],
        description: 'children (default) lists your parent, continuable siblings, and direct children; each accepts send_message in any status. '
          + 'descendants lists the whole tree below you with each entry\'s parent session id and depth; entries deeper than 1 accept only interrupt_agent.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['parent'] },
                id: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['running', 'inactive'] },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['child', 'sibling'] },
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['running', 'inactive'] },
                parent: { type: 'string' },
                depth: { type: 'number' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['diagnostic'] },
                id: { type: 'string', required: true },
                reason: { type: 'string', required: true, enum: ['corrupt', 'unsupported', 'unavailable'] },
                parent: { type: 'string' },
                depth: { type: 'number' },
              },
            },
          ],
        },
      },
      render: (args, entries) => {
        const request = resolveListAgentsRequest(args)
        return [{
          type: 'text',
          text: entries.length === 0
            ? '(no subagents)'
            : entries.map((entry) => {
              // A descendants row always carries its position; children rows
              // never render it. String() spans the schema-optional shape
              // without a dead fallback branch.
              if (entry.kind === 'parent') return `${entry.id} [${entry.status}] — your parent`
              if (entry.kind === 'sibling') return `${entry.id} [${entry.status}] — sibling: ${entry.label}`
              const at = request.scope === 'descendants'
                ? ` parent=${String(entry.parent)} depth=${String(entry.depth)}`
                : ''
              return entry.kind === 'diagnostic'
                ? `${entry.id} [diagnostic: ${entry.reason}]${at}`
                : `${entry.id} [${entry.status}]${at} — ${entry.label}`
            }).join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // Non-agent callers have no session whose children could be listed.
        throw new Error('list_agents requires a calling agent (exec.agent was undefined)')
      }
      const request = resolveListAgentsRequest(args)
      switch (request.scope) {
        case 'children': {
          const adjacent = await family(ctx, parent, exec.signal)
          const entries = await ctx.subagents.listChildren(parent.id, exec.signal)
          return [
            ...adjacent,
            ...entries
              .map(entry => project(ctx.agents, entry))
              .filter(entry => entry !== undefined),
          ]
        }
        case 'descendants': {
          const entries = await ctx.subagents.listDescendants(parent.id, exec.signal)
          return entries
            .map(entry => project(ctx.agents, entry, entry))
            .filter(entry => entry !== undefined)
        }
        /* v8 ignore next 2 -- the resolver normalizes the schema-validated closed scope before dispatch. */
        default:
          return assertNever(request.scope, 'list_agents scope')
      }
    },
  }))
}
