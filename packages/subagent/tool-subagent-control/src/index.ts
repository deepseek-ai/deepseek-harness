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
import { ROOT_AGENT_NAME } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerListAgents } from './list-agents.ts'
import { registerWaitAgent } from './wait-agent.ts'

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt']

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
  const interrupt = config.interrupt !== false
  const listAgents = registerListAgents(ctx)
  registerWaitAgent(ctx)
  const sendMessage = defineTool({
    name: 'send_message',
    description:
      'Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. '
      + 'Returns delivery confirmation.',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: 'The name of another agent in your subagent tree, as shown by list_agents.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the agent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `message delivered to agent ${args.agent}`,
      }],
    },
    async execute(args, exec) {
      const sender = exec.agent
      if (!sender) {
        throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      }
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const targetId = await ctx.subagents.resolveName(sender, args.agent, exec.signal)
      const messageId = await ctx.subagents.sendMessage(sender, targetId, message, { signal: exec.signal })
      return { messageId }
    },
  })
  ctx.tools.register(sendMessage)
  ctx.systemPrompt.context({
    name: 'subagent:identity',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    required: true,
    interpolate: false,
    text: ({ agent, scope, toolSet }) => {
      if (agent === undefined) return ''
      try {
        const names = ctx.subagents.namesOf(agent)
        let identity = names.parent === undefined
          ? `You are the root agent. Your name is ${JSON.stringify(names.self)}.`
          : `You are a subagent delegated by agent ${JSON.stringify(names.parent)}.\n`
            + `Your name is ${JSON.stringify(names.self)}.\n`
            + `The root agent of your collaboration tree is ${JSON.stringify(ROOT_AGENT_NAME)}.`
        const guidance: string[] = []
        if (ctx.tools.get(sendMessage.name, scope, toolSet) === sendMessage) {
          guidance.push('To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).')
        }
        if (ctx.tools.get(listAgents.name, scope, toolSet) === listAgents) {
          guidance.push('Use list_agents({}) to find your collaborator agents and their names.')
        }
        if (guidance.length > 0) identity += '\n\n' + guidance.join('\n')
        return identity
      } catch (error: unknown) {
        const rootUnavailable = typeof error === 'object' && error !== null
          && 'name' in error && error.name === 'SubagentError'
          && 'code' in error && error.code === 'UNAUTHORIZED'
        if (!rootUnavailable) throw error
        return `Your agent id is ${JSON.stringify(agent.id)}. Your subagent tree root is unavailable. `
          + 'Continue independent work; subagent discovery and messaging require an active root.'
      }
    },
  })
  if (!interrupt) return
  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      'Ask a subagent to stop its current work. This call returns without waiting for it to stop. '
      + 'You can continue a local subagent\'s conversation later with send_message. '
      + 'External executions stop permanently and cannot receive follow-ups. Subagents it started will keep running.',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: 'The name of an agent created under you: your direct child or a deeper descendant.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `interrupt requested for agent ${args.agent}`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        // Ancestor authority requires an exact live calling agent.
        throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      }
      const targetId = await ctx.subagents.resolveName(caller, args.agent, exec.signal)
      // The service authorizes the exact live caller against the target's
      // recorded lineage; the tool adds no authority of its own.
      ctx.subagents.interrupt(targetId, { kind: 'ancestor', agent: caller })
      return { accepted: true }
    },
  }))
}
