/** Shared subagent coordination instructions and durable runtime identity. */

import type { Context } from '@deepseek-ai/cordis'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'

const COLLABORATION_POLICY = `Your Team is the subagent tree rooted at the root agent. Use list_agents to discover agents and send_message with an agent id to contact another listed agent. A working agent receives the message at its next step; an idle agent starts a new turn. Successful delivery does not mean the recipient has processed the message. A delegated agent's final answer is returned automatically while its parent is online.

Continue independent work while other agents run. When you need more input, use wait_agent to wait for your own inbox. Pending input returns immediately; new messages, completion notifications, and user steering end the wait. The tool does not consume messages or start agents, and queued next-turn messages stay queued. After a wakeup or timeout, assess what work remains. Obtain the results needed for your assigned work before answering; unrelated agents need not finish.

Agents may share files even when their working directories differ. Coordinate overlapping edits. If a file operation returns FS_STALE_VERSION, read the current file, apply your intended change to the updated content, and retry. Coordinate formatters, generators, and shell writes explicitly, then review the combined diff and run relevant checks.`

/**
 * Add collaboration policy and identity that survives optional-context suppression.
 * @param ctx - control-plugin context carrying subagents and prompt assembly.
 */
export function registerCollaborationPrompt(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'subagent:policy',
    order: ctx.systemPrompt.getSectionOrder('SUBAGENT_POLICY'),
    text: COLLABORATION_POLICY,
  })
  ctx.systemPrompt.context({
    name: 'subagent:identity',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_IDENTITY'),
    required: true,
    interpolate: false,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      const parentId = agent.session.header.parentSession
      const self = `Your agent id is ${JSON.stringify(agent.id)}.`
      const parent = parentId === undefined ? '' : ` Your parent agent id is ${JSON.stringify(parentId)}.`
      try {
        const root = ctx.subagents.rootOf(agent)
        return `${self} Your Team root agent id is ${JSON.stringify(root.id)}.`
          + (root === agent ? ' You are the root agent.' : parent)
      } catch (error: unknown) {
        if (!(error instanceof SubagentError) || error.code !== 'UNAUTHORIZED') throw error
        return `${self} Your Team root agent is unavailable.${parent} Continue independent work; Team discovery and messaging require an active root.`
      }
    },
  })
}
