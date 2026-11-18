/** Real Agent and projections with the card service and one scripted test kind. */
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ActionCards from '../src/index.ts'
import type { ActionCardFields, ActionCardId, ActionCardKind, ActionCardProposalOf, ActionCardResult } from '../src/index.ts'

export const ACTION = 'test_action'
export const proposal = { action: ACTION, title: 'Counter', brief: 'Keep a counter visible.', details: { value: 'a' } }

/** Details of the test kind. */
export interface TestDetails { readonly value: string }

/**
 * Answer text that ends with one card block.
 * @param fields - the block's JSON object.
 * @returns the text.
 */
export function cardAnswer(fields: object = proposal): string {
  return `Here is an option.\n\n\`\`\`action-card\n${JSON.stringify(fields)}\n\`\`\`\n`
}

/** Mount the card service with one registered kind whose handler is a spy. */
export async function fixture(kind: Partial<ActionCardKind<TestDetails>> = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(RemoteAccess)
  const cards = await ctx.plugin(ActionCards)
  type Handler = (
    agent: Agent, card: ActionCardProposalOf<TestDetails>, verb: string, payload: ActionCardFields | undefined,
  ) => Promise<ActionCardResult>
  const act = vi.fn<Handler>(async (_agent, card, verb) =>
    ({ status: 'settled', decision: { cardId: card.cardId, action: ACTION, phase: verb } }))
  const kindFiber = await ctx.plugin({ name: 'test-kind', inject: ['actionCards'], apply: (inner: Context) => {
    inner.actionCards.register({
      action: ACTION, details: z.object({ value: z.string() }),
      verbs: { start: {}, publish: { global: true }, write: { writes: true } },
      act, ...kind,
    })
  } })
  const agentHandle = await ctx.agents.create({ sessionId: brandString<SessionId>('cards-root') })
  const agent = agentHandle.agent
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
  let step = 0
  /** Log an answer that ends with a card block, as the loop does after the model responds. */
  const offer = (fields: object = proposal, caller = agent, turn = 1): ActionCardId => {
    const message = createAssistantMessage({ content: [{ type: 'text', text: cardAnswer(fields) }], source: { provider: 'test', model: 'test' } })
    caller.session.append('assistant/message', { turn, step: ++step, stream: [], message }, { surfaceOp: 'append' })
    return brandString<ActionCardId>(message.id)
  }
  const view = (caller = agent) => ctx.actionCards.view(caller.session)
  return { ctx, harness, cards, kindFiber, agent, agentHandle, events, act, offer, view }
}
