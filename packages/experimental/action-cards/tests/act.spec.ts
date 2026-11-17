import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ActionCardId, ActionCardProposalOf, ActionCardResult } from '../src/index.ts'
import { ACTION, fixture, proposal, type TestDetails } from './fixture.ts'

const dismissed = (cardId: ActionCardId, data?: object) =>
  ({ status: 'settled', decision: { cardId, action: ACTION, phase: 'dismissed', ...data === undefined ? {} : { data } } })
const invalidDetails = { ...proposal, details: { value: 3 } }

it('refuses unknown cards, closed owners, verbs of removed kinds and undeclared verbs before any handler runs', async () => {
  const f = await fixture()
  expect(await f.ctx.actionCards.act(f.agent, brandString<ActionCardId>('missing'), 'start')).toEqual({ status: 'refused', reason: 'unknown' })
  const cardId = f.offer()
  for (const id of ['toString', 'constructor']) {
    expect(await f.ctx.actionCards.act(f.agent, brandString<ActionCardId>(id), 'dismiss')).toEqual({ status: 'refused', reason: 'unknown' })
  }
  for (const verb of ['toString', 'missing']) {
    expect(await f.ctx.actionCards.act(f.agent, cardId, verb)).toEqual({ status: 'refused', reason: 'unavailable' })
  }
  const liveAgent = vi.spyOn(f.ctx.agents, 'get').mockReturnValue(undefined)
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'start')).toEqual({ status: 'refused', reason: 'not-live-root' })
  liveAgent.mockRestore()
  await f.kindFiber.dispose()
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'start')).toEqual({ status: 'refused', reason: 'unavailable' })
  const service = f.ctx.actionCards
  await f.cards.dispose()
  expect(await service.act(f.agent, cardId, 'dismiss')).toEqual({ status: 'refused', reason: 'closing' })
  expect(f.act).not.toHaveBeenCalled()
})

it('applies the shared access and read-only checks the kind declares, then hands typed details to the kind', async () => {
  const f = await fixture()
  const cardId = f.offer()
  const access = vi.spyOn(f.ctx.remoteAccess, 'allows').mockReturnValue(false)
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'publish')).toEqual({ status: 'refused', reason: 'access-denied' })
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'start', { note: 'x' })).toEqual({ status: 'settled', decision: { cardId, action: ACTION, phase: 'start' } })
  access.mockRestore()
  expect(f.act).toHaveBeenCalledWith(f.agent, { cardId, turn: 1, ...proposal }, 'start', { note: 'x' })
  const resolve = vi.fn(() => ({ mode: 'read-only', workspaceRoot: '/' }))
  f.ctx.provide('sandboxPolicy', { resolve })
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'write')).toEqual({ status: 'refused', reason: 'read-only' })
  expect(resolve).toHaveBeenCalledWith({ session: f.agent.session })
  expect((await f.ctx.actionCards.act(f.agent, cardId, 'publish')).status).toBe('settled')
  resolve.mockReturnValue({ mode: 'workspace-write', workspaceRoot: '/' })
  expect((await f.ctx.actionCards.act(f.agent, cardId, 'write')).status).toBe('settled')
  const invalid = f.offer(invalidDetails, f.agent, 2)
  expect(await f.ctx.actionCards.act(f.agent, invalid, 'start')).toEqual({ status: 'refused', reason: 'unavailable' })
  expect(f.act).toHaveBeenCalledTimes(3)
})

it('records dismissal of an unstarted or open card with the kind data, and settles started or final cards', async () => {
  const f = await fixture({
    openPhases: ['failed'],
    dismissal: (card, payload) => ({ value: card.details.value, ...z.object({ choice: z.string() }).safeParse(payload).data }),
  })
  const cardId = f.offer()
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'dismiss', { choice: 'later' })).toEqual(dismissed(cardId, { value: 'a', choice: 'later' }))
  expect(f.view().decisions[cardId]?.phase).toBe('dismissed')
  for (const verb of ['dismiss', 'start']) {
    expect(await f.ctx.actionCards.act(f.agent, cardId, verb)).toEqual(dismissed(cardId, { value: 'a', choice: 'later' }))
  }
  f.ctx.actionCards.record(f.agent, { cardId, action: ACTION, phase: 'failed' })
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'dismiss')).toEqual(dismissed(cardId, { value: 'a' }))
  f.ctx.actionCards.record(f.agent, { cardId, action: ACTION, phase: 'running', data: { step: 1 } })
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'dismiss')).toEqual({ status: 'settled',
    decision: { cardId, action: ACTION, phase: 'running', data: { step: 1 } } })
  const invalid = f.offer(invalidDetails, f.agent, 2)
  expect(await f.ctx.actionCards.act(f.agent, invalid, 'dismiss')).toEqual(dismissed(invalid))
  expect(f.act).not.toHaveBeenCalled()
})

it('dismisses without data when the kind records none', async () => {
  const f = await fixture()
  const cardId = f.offer()
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'dismiss', { choice: 'later' })).toEqual(dismissed(cardId))
})

it('shares one operation between concurrent actions on a card and drains it on unload', async () => {
  const pending = Promise.withResolvers<ActionCardResult>()
  onTestFinished(() => { pending.resolve({ status: 'accepted' }) })
  const f = await fixture({ act: vi.fn(() => pending.promise) })
  const cardId = f.offer()
  const first = f.ctx.actionCards.act(f.agent, cardId, 'start')
  expect(f.ctx.actionCards.act(f.agent, cardId, 'dismiss')).toBe(first)
  const disposing = f.cards.dispose()
  pending.resolve({ status: 'accepted' })
  expect(await first).toEqual({ status: 'accepted' })
  await disposing
})

it('rejects a second kind for the same action and releases a kind through its disposer', async () => {
  const f = await fixture()
  const kind = (action: string) => ({ action, details: z.object({}), verbs: { start: {} },
    act: () => Promise.resolve<ActionCardResult>({ status: 'accepted' }) })
  expect(() => f.ctx.actionCards.register(kind(ACTION))).toThrow('action-cards: action "test_action" is already registered')
  const unregister = f.ctx.actionCards.register(kind('other_action'))
  const other = f.offer({ action: 'other_action', title: 'Other', brief: 'Other card.', details: {} })
  expect(await f.ctx.actionCards.act(f.agent, other, 'start')).toEqual({ status: 'accepted' })
  unregister()
  expect(await f.ctx.actionCards.act(f.agent, other, 'start')).toEqual({ status: 'refused', reason: 'unavailable' })
})

it('lets the kind reconcile before every action, so a card that is no longer open settles instead of being dismissed', async () => {
  let finished = false
  const reconcile = vi.fn(async (agent: Agent, card: ActionCardProposalOf<TestDetails>) => {
    if (finished) f.ctx.actionCards.record(agent, { cardId: card.cardId, action: ACTION, phase: 'installed' })
  })
  const f = await fixture({ openPhases: ['unconfirmed'], reconcile })
  const cardId = f.offer()
  f.ctx.actionCards.record(f.agent, { cardId, action: ACTION, phase: 'unconfirmed' })
  finished = true
  const installed = { status: 'settled', decision: { cardId, action: ACTION, phase: 'installed' } }
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'dismiss')).toEqual(installed)
  expect(reconcile).toHaveBeenCalledWith(f.agent, { cardId, turn: 1, ...proposal })
  expect(f.view().decisions[cardId]?.phase).toBe('installed')
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'start')).toEqual({ status: 'settled', decision: { cardId, action: ACTION, phase: 'start' } })
  expect(reconcile).toHaveBeenCalledTimes(2)
  const invalid = f.offer(invalidDetails, f.agent, 2)
  expect((await f.ctx.actionCards.act(f.agent, invalid, 'dismiss')).status).toBe('settled')
  expect(reconcile).toHaveBeenCalledTimes(2)
})

it('refuses the action when reconciliation fails or the root closes meanwhile', async () => {
  const reconcile = vi.fn<(agent: Agent) => Promise<void>>(async () => { throw new Error('profile read failed') })
  const f = await fixture({ reconcile })
  const cardId = f.offer()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'dismiss')).toEqual({ status: 'refused', reason: 'unavailable' })
  expect(warn).toHaveBeenCalledWith('Cannot reconcile action card %s before %s: %s', cardId, 'dismiss', 'Error: profile read failed')
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'start')).toEqual({ status: 'refused', reason: 'unavailable' })
  expect(warn).toHaveBeenLastCalledWith('Cannot reconcile action card %s before %s: %s', cardId, 'start', 'Error: profile read failed')
  expect(f.view().decisions).toEqual({})
  reconcile.mockImplementationOnce(async () => { await f.agentHandle.dispose() })
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'dismiss')).toEqual({ status: 'refused', reason: 'not-live-root' })
  expect(f.act).not.toHaveBeenCalled()
})

it('refuses to record decisions of actions no kind registered or of phases the projection derives', async () => {
  const f = await fixture()
  const cardId = f.offer()
  expect(() => { f.ctx.actionCards.record(f.agent, { cardId, action: 'other_action', phase: 'done' }) })
    .toThrow('action-cards: cannot record a decision for unregistered action "other_action"')
  expect(() => { f.ctx.actionCards.record(f.agent, { cardId, action: ACTION, phase: 'replaced' }) })
    .toThrow('action-cards: phase "replaced" is derived from the log and cannot be recorded')
  expect(f.view().decisions).toEqual({})
  // An unloading kind still records the outcome of work it had started.
  await f.kindFiber.dispose()
  f.ctx.actionCards.record(f.agent, { cardId, action: ACTION, phase: 'interrupted' })
  expect(f.view().decisions[cardId]?.phase).toBe('interrupted')
})

it('dismisses an unstarted card whose kind is no longer registered, without data, and settles recorded ones', async () => {
  const f = await fixture({ openPhases: ['failed'], dismissal: () => ({ value: 'kind data' }) })
  const failed = f.offer(proposal, f.agent, 1)
  f.ctx.actionCards.record(f.agent, { cardId: failed, action: ACTION, phase: 'failed' })
  const done = f.offer(proposal, f.agent, 2)
  f.ctx.actionCards.record(f.agent, { cardId: done, action: ACTION, phase: 'dismissed' })
  const cardId = f.offer(proposal, f.agent, 3)
  await f.kindFiber.dispose()
  expect(await f.ctx.actionCards.act(f.agent, cardId, 'dismiss', { choice: 'later' })).toEqual(dismissed(cardId))
  expect(f.view().decisions[cardId]).toEqual({ cardId, action: ACTION, phase: 'dismissed' })
  // The kind may return and act on its recorded phases, so they stay as they are.
  expect(await f.ctx.actionCards.act(f.agent, failed, 'dismiss')).toEqual({ status: 'settled',
    decision: { cardId: failed, action: ACTION, phase: 'failed' } })
  expect(await f.ctx.actionCards.act(f.agent, done, 'dismiss')).toEqual({ status: 'settled',
    decision: { cardId: done, action: ACTION, phase: 'dismissed' } })
  expect(f.act).not.toHaveBeenCalled()
})
