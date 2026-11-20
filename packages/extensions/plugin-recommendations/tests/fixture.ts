/** Real Agent, skills, card service and projections with a controlled profile manager. */
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Skills from '@deepseek-ai/dsh-skill'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import ActionCards, { type ActionCardId } from '@deepseek-ai/dsh-action-cards'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BundleInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import * as PluginRecommendations from '../src/index.ts'

export const ACTION = 'enable_official_plugin'

export const bundle: BundleInfo = {
  name: 'official-search', official: true, optional: true, availability: 'installation',
  enabled: false, installed: false, removable: false, rows: [], overrides: [],
  meta: { title: { en: 'Search', zh: '搜索' }, description: 'Search past conversations.' },
}
export const cardId = brandString<ActionCardId>('card-plugin-1')
export const proposal = { title: 'Search', brief: 'Search your conversation history.', details: { name: bundle.name } }

/**
 * Answer text that ends with one card block.
 * @param args - block fields besides `action`.
 * @param action - card action.
 * @returns the text.
 */
export function cardAnswer(args: object = proposal, action = ACTION): string {
  return `Search covers that.\n\n\`\`\`action-card\n${JSON.stringify({ action, ...args })}\n\`\`\`\n`
}

/**
 * Log an answer that ends with a card block, as the loop does after the model responds.
 * @param ctx - context with the agent registry.
 * @param agent - agent whose Session receives the answer.
 * @param id - id of the answer message, which names the card.
 * @param args - block fields besides `action`.
 * @param action - card action.
 * @returns the card id.
 */
export function logProposal(ctx: Context, agent: Agent, id = 'card-plugin-1', args: object = proposal, action = ACTION): ActionCardId {
  const turn = Math.max(1, ctx.agents.turnBoundaryOf(agent.session).lastTurn)
  agent.session.append('assistant/message', { turn, step: 1, stream: [], message: { id: brandString<MessageId>(id), role: 'assistant',
    content: [{ type: 'text', text: cardAnswer(args, action) }], source: { kind: 'model', provider: 'test', model: 'test' } } }, { surfaceOp: 'append' })
  return brandString<ActionCardId>(id)
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
  const handle = await ctx.agents.create({ sessionId: brandString<SessionId>('recommendations') })
  const agent = handle.agent
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
  const card = (id: ActionCardId = cardId, caller: Agent = agent) => {
    const decisions = ctx.actionCards.view(caller.session).decisions
    return Object.hasOwn(decisions, id) ? decisions[id] : undefined
  }
  const propose = (id?: string, args?: object, caller: Agent = agent) => logProposal(ctx, caller, id, args)
  return { ctx, agent, handle, manager, fiber, events, card, propose }
}
