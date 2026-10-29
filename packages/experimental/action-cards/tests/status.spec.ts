import { expect, it, vi } from 'vitest'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import ActionCards from '../src/index.ts'
import { ACTION, callId, fixture } from './fixture.ts'

type Fixture = Awaited<ReturnType<typeof fixture>>

async function prepare(f: Fixture, agent: Agent = f.agent, signal = new AbortController().signal, admitted?: () => void | Promise<void>) {
  const decision = await agentEvents(f.ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 2, step: 1, signal, modelSelection: { provider: 'mock', model: 'mock' } },
    async (): Promise<PreStepDecision> => { await admitted?.(); return { kind: 'enter', messages: [] } })
  return decision.kind === 'reject' ? decision : { ...decision, messages: decision.messages.filter(message => message.source.kind === 'action-cards') }
}

function enter(agent: Agent, decision: PreStepDecision): void {
  if (decision.kind === 'enter') for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
}

it('reports recorded decisions once on the next request, with each kind guidance once, without waking the conversation', async () => {
  const f = await fixture({ statusGuidance: 'Failed runs can be retried from their card.', statusFields: ['reason'] })
  const followup = vi.spyOn(f.agent, 'followup')
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
  f.propose()
  f.propose(ToolCallId('call-card-2'), { action: ACTION, title: 'Second', brief: 'Another card.', details: { value: 'b' } }, f.agent, 2)
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
  f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'failed', data: { reason: 'timeout', internal: 'x' } })
  f.ctx.actionCards.record(f.agent, { callId: ToolCallId('call-card-2'), action: ACTION, phase: 'dismissed' })
  // A decision logged by a kind that is no longer registered is still reported.
  appendPluginRecord(f.agent.session, 'plugin:action-cards/decision', { callId: ToolCallId('call-orphan'), action: 'retired_action', phase: 'done' })
  const decision = await prepare(f)
  if (decision.kind !== 'enter') throw new Error('request was rejected')
  expect(decision.messages).toHaveLength(1)
  expect(decision.messages[0]!.source).toMatchObject({ kind: 'action-cards', form: 'notice', summary: 'Action card status updated' })
  expect(decision.messages[0]!.content).toMatchSnapshot('status notice')
  enter(f.agent, decision)
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
  expect(followup).not.toHaveBeenCalled()
})

it('keeps undelivered status through rejection, cancellation and plugin reload', async () => {
  const f = await fixture()
  f.propose()
  await f.ctx.actionCards.act(f.agent, callId, 'dismiss')
  const cancelled = new AbortController()
  await expect(prepare(f, f.agent, cancelled.signal, () => { cancelled.abort() })).rejects.toThrow()
  const rejected = f.ctx.on('agent/pre-step', async (): Promise<PreStepDecision> => ({ kind: 'reject' }))
  expect((await prepare(f)).kind).toBe('reject')
  rejected()
  expect(await prepare(f, f.agent, undefined, async () => { await f.cards.dispose() })).toEqual({ kind: 'enter', messages: [] })
  await f.ctx.plugin(ActionCards, { queuedMessageLimit: 3 })
  const decision = await prepare(f)
  if (decision.kind !== 'enter') throw new Error('request was rejected')
  expect(JSON.stringify(decision.messages[0]!.content)).toContain('dismissed')
})

it('adds nothing when cancellation arrives after downstream preparation', async () => {
  const f = await fixture()
  f.propose()
  await f.ctx.actionCards.act(f.agent, callId, 'dismiss')
  await f.cards.dispose()
  const controller = new AbortController()
  // Prepended before the card service returns, so it runs right after the service's own listener.
  f.ctx.on('agent/pre-step', async (_event, next) => {
    const decision = await next()
    controller.abort()
    return decision
  }, { prepend: true })
  await f.ctx.plugin(ActionCards)
  expect(await prepare(f, f.agent, controller.signal)).toEqual({ kind: 'enter', messages: [] })
})
