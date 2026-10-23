import { expect, it, vi } from 'vitest'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { fixture, callId, proposal, recordCard, ACTION } from './fixture.ts'
import * as CreationRecommendations from '../src/index.ts'

async function prepare(
  f: Awaited<ReturnType<typeof fixture>>, agent: Agent = f.agent,
  signal = new AbortController().signal, admitted?: () => void | Promise<void>,
) {
  const decision = await agentEvents(f.ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 2, step: 1, signal, modelSelection: { provider: 'mock', model: 'mock' } },
    async (): Promise<PreStepDecision> => { await admitted?.(); return { kind: 'enter', messages: [] } })
  return decision.kind === 'reject' ? decision : {
    ...decision, messages: decision.messages.filter(message => message.source.kind === 'action-cards'),
  }
}

function enter(agent: Agent, decision: PreStepDecision) {
  if (decision.kind === 'enter') for (const message of decision.messages) {
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
}

it('reports the latest card status on the next request without waking the conversation', async () => {
  const f = await fixture()
  const followup = vi.spyOn(f.agent, 'followup')
  const steer = vi.spyOn(f.agent, 'steer')
  const inject = vi.spyOn(f.agent, 'inject')
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
  await f.propose()
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
  await f.act('create')
  await f.entered.promise
  await f.act('cancel')
  expect(f.current()?.phase).toBe('cancelled')
  expect(f.agent.status).toBe('idle')
  const decision = await prepare(f)
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') throw new Error('request was rejected')
  expect(decision.messages).toHaveLength(1)
  expect(decision.messages[0]!.content).toMatchSnapshot('cancelled page status')
  expect(decision.messages[0]!.source.kind).toBe('action-cards')
  enter(f.agent, decision)
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
  expect(followup).not.toHaveBeenCalled()
  expect(steer).not.toHaveBeenCalled()
  expect(inject).not.toHaveBeenCalled()
})

it('retains undelivered page status across a plugin reload and Session reopen', async () => {
  const f = await fixture()
  await f.propose()
  await f.act('dismiss')
  await f.fiber.dispose()
  await f.ctx.plugin(CreationRecommendations)
  await f.agentHandle.dispose()
  const reopened = await f.ctx.agents.create({ sessionId: f.agent.id, seed: [...f.events] })
  const decision = await prepare(f, reopened.agent)
  if (decision.kind !== 'enter') throw new Error('request was rejected')
  expect(decision.messages).toHaveLength(1)
  expect(JSON.stringify(decision.messages[0]!.content)).toContain('dismissed')
  enter(reopened.agent, decision)
  expect(await prepare(f, reopened.agent)).toEqual({ kind: 'enter', messages: [] })
})

it('keeps a later state update pending when an earlier status message enters the log', async () => {
  const f = await fixture()
  await f.propose()
  await f.act('create')
  await f.entered.promise
  const creating = await prepare(f)
  await f.act('cancel')
  enter(f.agent, creating)
  const cancelled = await prepare(f)
  if (cancelled.kind !== 'enter') throw new Error('request was rejected')
  expect(cancelled.messages).toHaveLength(1)
  expect(JSON.stringify(cancelled.messages[0]!.content)).toContain('cancelled')
  enter(f.agent, cancelled)
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
})

it('reports installed and removed outcomes, including application errors, without starting another Creator', async () => {
  const f = await fixture()
  await f.propose()
  await f.act('create')
  await f.complete()
  const installed = await prepare(f)
  if (installed.kind !== 'enter') throw new Error('request was rejected')
  expect(JSON.stringify(installed.messages[0]!.content)).toContain('installed')
  enter(f.agent, installed)
  await f.act('undo')
  const removed = await prepare(f)
  if (removed.kind !== 'enter') throw new Error('request was rejected')
  expect(JSON.stringify(removed.messages[0]!.content)).toContain('removed')
  enter(f.agent, removed)
  recordCard(f.agent.session, { callId: ToolCallId('older-card'), slot: 'page', phase: 'installed', application: 'failed' })
  const failedApplication = await prepare(f)
  if (failedApplication.kind !== 'enter') throw new Error('request was rejected')
  expect(JSON.stringify(failedApplication.messages[0]!.content)).toContain('failed')
  expect(JSON.stringify(failedApplication.messages[0]!.content)).not.toContain(callId)
  expect(f.startActivation).toHaveBeenCalledOnce()
})

it('keeps an unstarted proposal across later human messages and lets the next proposal replace it', async () => {
  const f = await fixture()
  await f.propose()
  const human = createUserMessage({ content: [{ type: 'text', text: 'Let us discuss something else.' }], source: { kind: 'user' } })
  f.agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [human] })
  f.agent.session.append('user/message', human, { surfaceOp: 'append' })
  expect(f.current()).toBeUndefined()
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
  f.agent.session.append('turn/start', { turn: 2 })
  await f.propose('call-creation-2', { ...proposal, title: 'Checklist' })
  expect(f.current()).toEqual({ callId, phase: 'replaced' })
  // Replacement is the model's own choice, so no status notice is queued for it.
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
  expect(await f.act('create')).toEqual({
    status: 'settled', decision: { callId, action: ACTION, phase: 'replaced' },
  })
  await f.agentHandle.dispose()
  const reopened = await f.ctx.agents.create({ sessionId: f.agent.id, seed: [...f.events] })
  expect(await f.act('create', 'page', undefined, reopened.agent)).toEqual({
    status: 'settled', decision: { callId, action: ACTION, phase: 'replaced' },
  })
  expect(f.startActivation).not.toHaveBeenCalled()
  expect(f.manager.installBundle).not.toHaveBeenCalled()
})

it('keeps accepted work and its retry available across later user messages', async () => {
  const f = await fixture()
  await f.propose()
  await f.act('create')
  await f.entered.promise
  const message = createUserMessage({ content: [{ type: 'text', text: 'What is next?' }], source: { kind: 'user' } })
  f.agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  expect(f.current()?.phase).toBe('creating')
  await f.act('cancel')
  f.agent.session.append('user/message', message, { surfaceOp: 'append' })
  expect(f.current()?.phase).toBe('cancelled')
  expect(await f.act('create')).toEqual({ status: 'accepted' })
  await vi.waitFor(() => { expect(f.startActivation).toHaveBeenCalledTimes(2) })
})
