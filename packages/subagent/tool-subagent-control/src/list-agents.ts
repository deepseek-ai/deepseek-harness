/** Discover the caller's entire subagent tree; the control plugin owns registration. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent-names'


type ListAgentsEntry = ({ readonly id: SessionId } | { readonly name: string }) & (
  | {
    readonly kind: 'root'
    readonly status: 'running' | 'inactive'
  }
  | {
    readonly kind: 'child'
    readonly label: string
    readonly status: 'running' | 'inactive'
    readonly parent?: string
    readonly depth?: number
  }
  | {
    readonly kind: 'diagnostic'
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    readonly parent?: string
    readonly depth?: number
  }
)

/** Report turn activity without exposing whether the child is loaded. */
function statusOf(agents: { get(id: SessionId): Agent | undefined }, id: SessionId): 'running' | 'inactive' {
  return agents.get(id)?.status === 'running' ? 'running' : 'inactive'
}

/** Project one service row into the model-facing entry, or omit a one-shot child. */
function project(
  agents: { get(id: SessionId): Agent | undefined },
  entry: SubagentDescendantListEntry & { readonly path?: string },
): ListAgentsEntry | undefined {
  const name = entry.path === undefined ? undefined : `lead/${entry.path}`
  const address = name === undefined ? { id: entry.id } : { name }
  const at = { parent: name === undefined ? entry.parentId : name.slice(0, name.lastIndexOf('/')), depth: entry.depth }
  if (entry.kind === 'diagnostic') {
    return { kind: 'diagnostic', ...address, reason: entry.reason, ...at }
  }
  // One-shot children cannot be continued by send_message, so the model
  // never selects them; discovery still traversed them for descendants.
  if (entry.mode !== 'continuable') return undefined
  return {
    kind: 'child',
    ...address,
    label: entry.label,
    status: statusOf(agents, entry.id),
    ...at,
  }
}

/**
 * Register the `list_agents` tool.
 * @param ctx - context carrying the tool registry, subagent service, and live Agent registry.
 * @returns the registration disposer.
 */
export function registerListAgents(ctx: Context): () => void {
  const names = ctx.get('subagentNames')
  const parameter = names === undefined ? 'id' : 'name'
  return ctx.tools.register(defineTool({
    name: 'list_agents',
    description:
      'List your entire subagent tree: the root agent and all reachable continuable descendants, including yourself. '
      + (names === undefined
        ? 'Rows carry ids, descriptions, and status; descendant rows carry parent ids and depth from the root. '
        : 'Rows carry full agent paths, descriptions, and status; descendant rows carry parent paths and depth from the root. ')
      + 'You can message any other agent in the subagent tree listed as running or inactive. '
      + 'running means it is working; inactive means it is not currently working. '
      + 'While you remain active, you will be notified when a direct child finishes; there is no need to keep checking its status. '
      + 'Use send_message to continue the conversation.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['root'] },
                [parameter]: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['running', 'inactive'] },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['child'] },
                [parameter]: { type: 'string', required: true },
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
                [parameter]: { type: 'string', required: true },
                reason: { type: 'string', required: true, enum: ['corrupt', 'unsupported', 'unavailable'] },
                parent: { type: 'string' },
                depth: { type: 'number' },
              },
            },
          ],
        },
      },
      render: (_args, entries) => {
        return [{
          type: 'text',
          text: entries.map((entry) => {
            const address = 'name' in entry ? entry.name : entry.id
            if (entry.kind === 'root') return `${address} [${entry.status}] — root agent`
            const at = ` parent=${String(entry.parent)} depth=${String(entry.depth)}`
            return entry.kind === 'diagnostic'
              ? `${address} [diagnostic: ${entry.reason}]${at}`
              : `${address} [${entry.status}]${at} — ${entry.label}`
          }).join('\n'),
        }]
      },
    },
    async execute(_args, exec) {
      const parent = exec.agent
      if (!parent) {
        // Non-agent callers have no session whose children could be listed.
        throw new Error('list_agents requires a calling agent (exec.agent was undefined)')
      }
      const root = ctx.subagents.rootOf(parent)
      const entries = await (names ?? ctx.subagents).listDescendants(root.id, exec.signal)
      return [
        { kind: 'root' as const, ...names === undefined ? { id: root.id } : { name: 'lead' }, status: statusOf(ctx.agents, root.id) },
        ...entries
          .map(entry => project(ctx.agents, entry))
          .filter(entry => entry !== undefined),
      ]
    },
  }))
}
