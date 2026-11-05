/** Real Agent, Tools, skills and projections with the card service and one scripted test kind. */
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Skills, { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ActionCards from '../src/index.ts'
import type { ActionCardFields, ActionCardKind, ActionCardProposalOf, ActionCardResult } from '../src/index.ts'

export const ACTION = 'test_action'
export const SKILL = 'test-skill'
export const INVITATION = 'Invite the user to try the card in one sentence.'
export const callId = ToolCallId('call-card-1')
export const proposal = { action: ACTION, title: 'Counter', brief: 'Keep a counter visible.', details: { value: 'a' } }

/** Details of the test kind. */
export interface TestDetails { readonly value: string }

/** Provide one model-invocable skill per name. */
export function provideSkills(ctx: Context, ...names: string[]): void {
  ctx.skills.registerProvider(() => ({
    name: 'card-skills',
    list: () => Promise.resolve(names.map(name => ({
      name, description: `Use ${name}.`, provider: 'card-skills', source: 'bundled' as const, rank: BUNDLED_SKILL_RANK, locator: null,
      invocation: { modelInvocable: true, userInvocable: false },
    }))),
    get: candidate => Promise.resolve({ name: candidate.name, description: candidate.description, provider: 'card-skills', source: 'bundled' as const,
      invocation: candidate.invocation, content: `Call propose_action for ${candidate.name}.` }),
  }))
}

/** Mount the card service with one registered kind whose handler is a spy. */
export async function fixture(kind: Partial<ActionCardKind<TestDetails>> = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Skills)
  await ctx.plugin(SkillTool)
  provideSkills(ctx, SKILL, 'other-skill')
  const cards = await ctx.plugin(ActionCards)
  type Handler = (
    agent: Agent, card: ActionCardProposalOf<TestDetails>, verb: string, payload: ActionCardFields | undefined,
  ) => Promise<ActionCardResult>
  const act = vi.fn<Handler>(async (_agent, card, verb) =>
    ({ status: 'settled', decision: { callId: card.callId, action: ACTION, phase: verb } }))
  const kindFiber = await ctx.plugin({ name: 'test-kind', inject: ['actionCards'], apply: (inner: Context) => {
    inner.actionCards.register({
      action: ACTION, skill: SKILL, invitation: INVITATION, details: z.object({ value: z.string() }),
      verbs: { start: {}, publish: { global: true }, write: { writes: true } },
      act, ...kind,
    })
  } })
  const agentHandle = await ctx.agents.create({ sessionId: SessionId('cards-root') })
  const agent = agentHandle.agent
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
  let step = 0
  /** Log a successful `propose_action` call, as the loop does after the tool accepts it. */
  const propose = (id: ToolCallId = callId, args: object = proposal, caller = agent, turn = 1) => {
    caller.session.append('tool/call', { turn, step: ++step, callId: id, name: 'propose_action', arguments: JSON.stringify(args) })
    caller.session.append('tool/result', { turn, step, message: createToolResultMessage({ callId: id, content: [], isError: false }) }, { surfaceOp: 'append' })
    return id
  }
  const view = (caller = agent) => ctx.actionCards.view(caller.session)
  return { ctx, harness, cards, kindFiber, agent, agentHandle, events, act, propose, view }
}
