/**
 * Shared messaging, inbox waiting, interruption, and child discovery tools.
 * They perform no lifecycle routing of their own —
 * residency, cold resume, and interrupt authorization belong to the subagent
 * service — and they live apart from the provider-bound
 * `@deepseek-ai/dsh-tool-subagent` instances so multiple delegation tools share
 * one control API.
 * @module @deepseek-ai/dsh-tool-subagent-control
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent-names'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerListAgents } from './list-agents.ts'
import { registerWaitAgent } from './wait-agent.ts'

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagents', 'subagentNames', 'agents', 'systemPrompt']

/** Optional subagent control tools. */
export interface Config {
  /** Register `interrupt_agent`. Defaults to true; false leaves the service API available. */
  interrupt?: boolean
}

/** Loader schema for optional subagent control tools. */
export const Config: z<Config> = z.object({
  interrupt: z.boolean().default(true),
})

/**
 * Register the shared subagent control and discovery tools.
 * @param ctx - context carrying tools, subagents, live Agents, and prompt assembly.
 * @param config - optional tool registration settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  registerWaitAgent(ctx)
  registerListAgents(ctx)
  const listAgents = ctx.tools.get('list_agents')
  const sendMessage = defineTool({
    name: 'send_message',
    description:
      'Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. '
      + 'Returns delivery confirmation.',
    parameters: {
      name: {
        type: 'string', required: true,
        description: 'The full agent path (such as lead/reviewer) or Session id of another member of your subagent tree.',
      },
      message: { type: 'string', required: true, description: 'The message to deliver to the agent.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { messageId: { type: 'string', required: true } },
      },
      render: (args, _value) => [{ type: 'text', text: `message delivered to agent ${args.name}` }],
    },
    async execute(args, exec) {
      const sender = exec.agent
      if (!sender) throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const target = ctx.subagentNames.resolveName(ctx.subagents.rootOf(sender).session, args.name)
      const messageId = await ctx.subagents.sendMessage(sender, target, message, { signal: exec.signal })
      return { messageId }
    },
  })
  ctx.tools.register(sendMessage)
  ctx.systemPrompt.context({
    name: 'subagent:identity',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    required: true,
    interpolate: false,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      try {
        const root = ctx.subagents.rootOf(agent)
        if (root === agent) return 'You are the root agent named "lead".'
        const name = ctx.subagentNames.nameOf(root.session, agent.id)
        const parent = ctx.subagentNames.nameOf(root.session, agent.session.header.parentSession ?? agent.id)
        const self = name === agent.id ? `Your agent address is ${JSON.stringify(name)}.`
          : `Your name is ${JSON.stringify(name)}.`
        return `${self} Your parent agent is ${JSON.stringify(parent)}. Your root agent is "lead".`
      } catch (error: unknown) {
        if (!(error instanceof SubagentError) || error.code !== 'UNAUTHORIZED') throw error
        return `Your agent address is ${JSON.stringify(agent.id)}. Your subagent tree root is unavailable. `
          + 'Continue independent work; subagent discovery and messaging require an active root.'
      }
    },
  })
  ctx.systemPrompt.context({
    name: 'subagent:communication',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    required: true,
    interpolate: false,
    text: ({ agent, scope, toolSet }) => {
      if (agent === undefined) return ''
      const guidance: string[] = []
      if (ctx.tools.get('list_agents', scope, toolSet) === listAgents) {
        guidance.push('Use list_agents({}) to find agents in your tree and their full names.')
      }
      if (ctx.tools.get(sendMessage.name, scope, toolSet) === sendMessage) {
        guidance.push('Use send_message({ name: "<full agent path>", message: "..." }) to message another agent.')
        if (agent.session.header.origin === 'subagent') {
          guidance.push('Message your parent when a finding changes what it should do next; sending a message does not end your turn.')
        }
      }
      return guidance.join('\n')
    },
  })
  if (config.interrupt !== false) ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      'Ask a subagent to stop its current work. This call returns without waiting for it to stop. '
      + 'You can continue a local subagent\'s conversation later with send_message. '
      + 'External executions stop permanently and cannot receive follow-ups. Subagents it started will keep running.',
    parameters: {
      name: {
        type: 'string', required: true,
        description: 'The full agent path or Session id of an agent created under you: your direct child or a deeper descendant.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true } },
      },
      render: (args, _value) => [{ type: 'text', text: `interrupt requested for agent ${args.name}` }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      const target = ctx.subagentNames.resolveName(ctx.subagents.rootOf(caller).session, args.name)
      exec.signal.throwIfAborted()
      ctx.subagents.interrupt(target, { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))
}
