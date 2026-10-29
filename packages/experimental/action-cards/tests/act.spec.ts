import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ActionCardProposalOf, ActionCardResult } from '../src/index.ts'
import { ACTION, callId, fixture, proposal, type TestDetails } from './fixture.ts'

const dismissed = (data?: object) => ({ status: 'settled', decision: { callId, action: ACTION, phase: 'dismissed', ...data === undefined ? {} : { data } } })

it('refuses unknown cards, closed owners, verbs of removed kinds and undeclared verbs before any handler runs', async () => {
  const f = await fixture()
  expect(await f.ctx.actionCards.act(f.agent, callId, 'start')).toEqual({ status: 'refused', reason: 'unknown' })
  f.propose()
  for (const id of ['toString', 'constructor']) {
    expect(await f.ctx.actionCards.act(f.agent, ToolCallId(id), 'dismiss')).toEqual({ status: 'refused', reason: 'unknown' })
  }
  for (const verb of ['toString', 'missing']) {
    expect(await f.ctx.actionCards.act(f.agent, callId, verb)).toEqual({ status: 'refused', reason: 'unavailable' })
  }
  const roots = vi.spyOn(f.ctx.agents, 'roots').mockReturnValue([])
  expect(await f.ctx.actionCards.act(f.agent, callId, 'start')).toEqual({ status: 'refused', reason: 'not-live-root' })
  roots.mockRestore()
  await f.kindFiber.dispose()
  expect(await f.ctx.actionCards.act(f.agent, callId, 'start')).toEqual({ status: 'refused', reason: 'unavailable' })
  const service = f.ctx.actionCards
  await f.cards.dispose()
  expect(await service.act(f.agent, callId, 'dismiss')).toEqual({ status: 'refused', reason: 'closing' })
  expect(f.act).not.toHaveBeenCalled()
})

it('applies the shared access and read-only checks the kind declares, then hands typed details to the kind', async () => {
  const f = await fixture()
  f.propose()
  const access = vi.spyOn(f.ctx.remoteAccess, 'allows').mockReturnValue(false)
  expect(await f.ctx.actionCards.act(f.agent, callId, 'publish')).toEqual({ status: 'refused', reason: 'access-denied' })
  expect(await f.ctx.actionCards.act(f.agent, callId, 'start', { note: 'x' })).toEqual({ status: 'settled', decision: { callId, action: ACTION, phase: 'start' } })
  access.mockRestore()
  expect(f.act).toHaveBeenCalledWith(f.agent, { callId, turn: 1, ...proposal }, 'start', { note: 'x' })
  const resolve = vi.fn(() => ({ mode: 'read-only', workspaceRoot: '/' }))
  f.ctx.provide('sandboxPolicy', { resolve })
  expect(await f.ctx.actionCards.act(f.agent, callId, 'write')).toEqual({ status: 'refused', reason: 'read-only' })
  expect(resolve).toHaveBeenCalledWith({ session: f.agent.session })
  expect((await f.ctx.actionCards.act(f.agent, callId, 'publish')).status).toBe('settled')
  resolve.mockReturnValue({ mode: 'workspace-write', workspaceRoot: '/' })
  expect((await f.ctx.actionCards.act(f.agent, callId, 'write')).status).toBe('settled')
  f.propose(ToolCallId('call-invalid'), { ...proposal, details: { value: 3 } }, f.agent, 2)
  expect(await f.ctx.actionCards.act(f.agent, ToolCallId('call-invalid'), 'start')).toEqual({ status: 'refused', reason: 'unavailable' })
  expect(f.act).toHaveBeenCalledTimes(3)
})

it('records dismissal of an unstarted or open card with the kind data, and settles started or final cards', async () => {
  const f = await fixture({
    openPhases: ['failed'],
    dismissal: (card, payload) => ({ value: card.details.value, ...z.object({ choice: z.string() }).safeParse(payload).data }),
  })
  f.propose()
  expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss', { choice: 'later' })).toEqual(dismissed({ value: 'a', choice: 'later' }))
  expect(f.view().decisions[callId]?.phase).toBe('dismissed')
  for (const verb of ['dismiss', 'start']) expect(await f.ctx.actionCards.act(f.agent, callId, verb)).toEqual(dismissed({ value: 'a', choice: 'later' }))
  f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'failed' })
  expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss')).toEqual(dismissed({ value: 'a' }))
  f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'running', data: { step: 1 } })
  expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss')).toEqual({ status: 'settled',
    decision: { callId, action: ACTION, phase: 'running', data: { step: 1 } } })
  f.propose(ToolCallId('call-invalid'), { ...proposal, details: { value: 3 } }, f.agent, 2)
  expect(await f.ctx.actionCards.act(f.agent, ToolCallId('call-invalid'), 'dismiss')).toEqual({ status: 'settled',
    decision: { callId: 'call-invalid', action: ACTION, phase: 'dismissed' } })
  expect(f.act).not.toHaveBeenCalled()
})

it('dismisses without data when the kind records none', async () => {
  const f = await fixture()
  f.propose()
  expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss', { choice: 'later' })).toEqual(dismissed())
})

it('shares one operation between concurrent actions on a card and drains it on unload', async () => {
  const pending = Promise.withResolvers<ActionCardResult>()
  onTestFinished(() => { pending.resolve({ status: 'accepted' }) })
  const f = await fixture({ act: vi.fn(() => pending.promise) })
  f.propose()
  const first = f.ctx.actionCards.act(f.agent, callId, 'start')
  expect(f.ctx.actionCards.act(f.agent, callId, 'dismiss')).toBe(first)
  const disposing = f.cards.dispose()
  pending.resolve({ status: 'accepted' })
  expect(await first).toEqual({ status: 'accepted' })
  await disposing
})

it('rejects a second kind for the same action and releases a kind through its disposer', async () => {
  const f = await fixture()
  const kind = (action: string) => ({ action, skill: 'other-skill', invitation: 'Invite the user.', details: z.object({}), verbs: { start: {} },
    act: () => Promise.resolve<ActionCardResult>({ status: 'accepted' }) })
  expect(() => f.ctx.actionCards.register(kind(ACTION))).toThrow('action-cards: action "test_action" is already registered')
  const unregister = f.ctx.actionCards.register(kind('other_action'))
  f.propose(ToolCallId('call-other'), { action: 'other_action', title: 'Other', brief: 'Other card.', details: {} })
  expect(await f.ctx.actionCards.act(f.agent, ToolCallId('call-other'), 'start')).toEqual({ status: 'accepted' })
  unregister()
  expect(await f.ctx.actionCards.act(f.agent, ToolCallId('call-other'), 'start')).toEqual({ status: 'refused', reason: 'unavailable' })
})

it('lets the kind reconcile before every action, so a card that is no longer open settles instead of being dismissed', async () => {
  let finished = false
  const reconcile = vi.fn(async (agent: Agent, card: ActionCardProposalOf<TestDetails>) => {
    if (finished) f.ctx.actionCards.record(agent, { callId: card.callId, action: ACTION, phase: 'installed' })
  })
  const f = await fixture({ openPhases: ['unconfirmed'], reconcile })
  f.propose()
  f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'unconfirmed' })
  finished = true
  const installed = { status: 'settled', decision: { callId, action: ACTION, phase: 'installed' } }
  expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss')).toEqual(installed)
  expect(reconcile).toHaveBeenCalledWith(f.agent, { callId, turn: 1, ...proposal })
  expect(f.view().decisions[callId]?.phase).toBe('installed')
  expect(await f.ctx.actionCards.act(f.agent, callId, 'start')).toEqual({ status: 'settled', decision: { callId, action: ACTION, phase: 'start' } })
  expect(reconcile).toHaveBeenCalledTimes(2)
  f.propose(ToolCallId('call-invalid'), { ...proposal, details: { value: 3 } }, f.agent, 2)
  expect((await f.ctx.actionCards.act(f.agent, ToolCallId('call-invalid'), 'dismiss')).status).toBe('settled')
  expect(reconcile).toHaveBeenCalledTimes(2)
})

it('refuses the action when reconciliation fails or the root closes meanwhile', async () => {
  const reconcile = vi.fn<(agent: Agent) => Promise<void>>(async () => { throw new Error('profile read failed') })
  const f = await fixture({ reconcile })
  f.propose()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss')).toEqual({ status: 'refused', reason: 'unavailable' })
  expect(warn).toHaveBeenCalledWith('Cannot reconcile action card %s before %s: %s', callId, 'dismiss', 'Error: profile read failed')
  expect(await f.ctx.actionCards.act(f.agent, callId, 'start')).toEqual({ status: 'refused', reason: 'unavailable' })
  expect(warn).toHaveBeenLastCalledWith('Cannot reconcile action card %s before %s: %s', callId, 'start', 'Error: profile read failed')
  expect(f.view().decisions).toEqual({})
  reconcile.mockImplementationOnce(async () => { await f.agentHandle.dispose() })
  expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss')).toEqual({ status: 'refused', reason: 'not-live-root' })
  expect(f.act).not.toHaveBeenCalled()
})

it('refuses to record decisions of actions no kind registered or of phases the projection derives', async () => {
  const f = await fixture()
  f.propose()
  expect(() => { f.ctx.actionCards.record(f.agent, { callId, action: 'other_action', phase: 'done' }) })
    .toThrow('action-cards: cannot record a decision for unregistered action "other_action"')
  expect(() => { f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'replaced' }) })
    .toThrow('action-cards: phase "replaced" is derived from the log and cannot be recorded')
  expect(f.view().decisions).toEqual({})
  // An unloading kind still records the outcome of work it had started.
  await f.kindFiber.dispose()
  f.ctx.actionCards.record(f.agent, { callId, action: ACTION, phase: 'interrupted' })
  expect(f.view().decisions[callId]?.phase).toBe('interrupted')
})

it('dismisses an unstarted card whose kind is no longer registered, without data, and settles recorded ones', async () => {
  const f = await fixture({ openPhases: ['failed'], dismissal: () => ({ value: 'kind data' }) })
  f.propose(ToolCallId('call-failed'), proposal, f.agent, 1)
  f.ctx.actionCards.record(f.agent, { callId: ToolCallId('call-failed'), action: ACTION, phase: 'failed' })
  f.propose(ToolCallId('call-done'), proposal, f.agent, 2)
  f.ctx.actionCards.record(f.agent, { callId: ToolCallId('call-done'), action: ACTION, phase: 'dismissed' })
  f.propose(callId, proposal, f.agent, 3)
  await f.kindFiber.dispose()
  expect(await f.ctx.actionCards.act(f.agent, callId, 'dismiss', { choice: 'later' })).toEqual(dismissed())
  expect(f.view().decisions[callId]).toEqual({ callId, action: ACTION, phase: 'dismissed' })
  // The kind may return and act on its recorded phases, so they stay as they are.
  expect(await f.ctx.actionCards.act(f.agent, ToolCallId('call-failed'), 'dismiss')).toEqual({ status: 'settled',
    decision: { callId: 'call-failed', action: ACTION, phase: 'failed' } })
  expect(await f.ctx.actionCards.act(f.agent, ToolCallId('call-done'), 'dismiss')).toEqual({ status: 'settled',
    decision: { callId: 'call-done', action: ACTION, phase: 'dismissed' } })
  expect(f.act).not.toHaveBeenCalled()
})
