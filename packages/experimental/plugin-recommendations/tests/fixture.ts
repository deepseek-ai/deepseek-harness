/** Real Agent, Tools, skills, card service and projections with a controlled profile manager. */
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished, vi } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Skills from '@deepseek-ai/dsh-skill'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import ActionCards from '@deepseek-ai/dsh-action-cards'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BundleInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import * as PluginRecommendations from '../src/index.ts'

export const ACTION = 'enable_official_plugin'

export const bundle: BundleInfo = {
  name: 'official-search', official: true, optional: true, availability: 'installation',
  enabled: false, installed: false, removable: false, updatable: false, rows: [], overrides: [],
  meta: { title: { en: 'Search', zh: '搜索' }, description: 'Search past conversations.' },
}
/** Text of an accepted `enable_official_plugin` call's result. */
export const RESULT_TEXT = 'Card shown below your answer. Do not restate it. End with at most one short invitation in the user’s language to click '
  + 'Enable below; do not say the plugin is already on.'
export const callId = ToolCallId('call-plugin-1')
export const proposal = { title: 'Search', brief: 'Search your conversation history.', details: { name: bundle.name } }

/**
 * Log a successful `propose_action` call, as the card tool would after the skill load.
 * @param ctx - context with the agent registry.
 * @param agent - agent whose Session receives the call.
 * @param id - tool call id of the card.
 * @param args - call arguments besides `action`.
 * @param action - card action.
 * @returns the card's call id.
 */
export function logProposal(ctx: Context, agent: Agent, id = 'call-plugin-1', args: object = proposal, action = ACTION): ToolCallId {
  const turn = Math.max(1, ctx.agents.turnBoundaryOf(agent.session).lastTurn)
  const toolCallId = ToolCallId(id)
  agent.session.append('tool/call', { turn, step: 1, callId: toolCallId, name: 'propose_action', arguments: JSON.stringify({ action, ...args }) })
  agent.session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: toolCallId,
    content: [{ type: 'text', text: RESULT_TEXT }], isError: false }) }, { surfaceOp: 'append' })
  return toolCallId
}

export async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Skills)
  await ctx.plugin(SkillTool)
  await ctx.plugin(ActionCards)
  const manager = {
    listBundles: vi.fn(async (): Promise<BundleInfo[]> => [bundle]),
    setBundleEnabled: vi.fn(async (): Promise<ChangeResult> => ({ application: 'applied', changed: true, stage: 'enable', target: bundle.name, enabled: true })),
  }
  ctx.provide('pluginManager', manager)
  const fiber = await ctx.plugin(PluginRecommendations)
  const handle = await ctx.agents.create({ sessionId: SessionId('recommendations') })
  const agent = handle.agent
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
  const card = (id: ToolCallId = callId, caller: Agent = agent) => {
    const decisions = ctx.actionCards.view(caller.session).decisions
    return Object.hasOwn(decisions, id) ? decisions[id] : undefined
  }
  const propose = (id?: string, args?: object, caller: Agent = agent) => logProposal(ctx, caller, id, args)
  return { ctx, agent, handle, manager, fiber, events, card, propose }
}
