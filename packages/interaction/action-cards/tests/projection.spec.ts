import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  appendPluginRecord, Session, SESSION_FORMAT_VERSION, type SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { actionCardProjection, type ActionCardState } from '../src/projection.ts'
import type { ActionCardDecision, ActionCardId } from '../src/types.ts'
import { ACTION, fixture, proposal } from './fixture.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** The record that held decisions before the `action-cards/decision` event. */
    'plugin:action-cards/decision': ActionCardDecision
  }
}

const projection = actionCardProjection
const args = { action: 'test_action', title: 'Counter', brief: 'Keep count visible', details: { value: 'a' } }
let seq = 0

function init(inherited = 0, origin?: 'subagent'): ActionCardState {
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: brandString<SessionId>('cards'), createdAt: 0, isSeeded: inherited > 0,
    ...origin === undefined ? {} : { origin } }
  return projection.init(header, SessionLogOffset(inherited))
}

function turn(value: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: SessionSeq(seq++), time: 0, data: { turn: value } }
}

/** A fenced block of the given language holding the JSON of `value`, or the string as written. */
function block(value: object | string = args, language = 'action-card'): string {
  return `\`\`\`${language}\n${typeof value === 'string' ? value : JSON.stringify(value)}\n\`\`\``
}

function answer(content: readonly ContentBlock[] | string, turnNumber = 1, interrupted = false): SessionEvent<'assistant/message'> {
  const message = createAssistantMessage({ content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    source: { provider: 'test', model: 'test' } })
  return { type: 'assistant/message', seq: SessionSeq(seq++), time: 0, surfaceOp: 'append',
    data: { turn: turnNumber, step: 1, stream: [], message, ...interrupted ? { interrupted: true } : {} } }
}

function idOf(event: SessionEvent<'assistant/message'>): ActionCardId {
  return brandString<ActionCardId>(event.data.message.id)
}

function records(...data: ActionCardDecision[]): readonly SessionEvent[] {
  const session = Session.create(brandString<SessionId>('records'))
  for (const value of data) session.append('action-cards/decision', value)
  return session.snapshotEvents()
}

const fold = (events: readonly SessionEvent[], state = init()) => events.reduce(projection.apply, state)
const card = (id: string) => brandString<ActionCardId>(id)
const notice = (through: number): SessionEvent<'user/message'> => ({ type: 'user/message', seq: SessionSeq(99), time: 0, surfaceOp: 'append',
  data: createUserMessage({ content: [{ type: 'text', text: 'status' }],
    source: { kind: 'action-cards', through: SessionSeq(through), form: 'notice', summary: 'status' } }) })

it('admits only the first valid block across the answers of a turn, named by its message id', () => {
  const offered = answer(`Here is an option.\n\n${block()}\n`)
  expect(fold([offered, answer(block())]).view.proposals).toEqual({ [idOf(offered)]: { cardId: idOf(offered), turn: 1, ...args } })
  const second = answer(`${block('{broken')}\n${block({ ...args, title: ' ' })}\n${block({ ...args, title: '  Second  ' })}\n${block()}`)
  expect(fold([second]).view.proposals[idOf(second)]?.title).toBe('Second')
  const split = answer([{ type: 'text', text: 'No card yet.' }, { type: 'text', text: block({ ...args, title: 'Later block' }) }])
  expect(fold([split]).view.proposals[idOf(split)]?.title).toBe('Later block')
  for (const content of [
    'Plain answer.',
    block(args, 'json'),
    block({ ...args, details: 'text' }),
    block({ ...args, brief: '' }),
    block({ title: 'Counter', brief: 'b', details: {} }),
  ]) {
    const state = init()
    expect(fold([answer(content)], state)).toBe(state)
  }
  const reasoning = answer([{ type: 'reasoning', text: block() }, { type: 'text', text: 'Answer without a card.' }])
  expect(fold([reasoning]).view.proposals).toEqual({})
})

it('replays v3 replacements from the log and restores a current checkpoint with its suffix', async () => {
  const f = await fixture()
  const { session } = f.agent
  const registry = f.ctx.sessionProjections
  const open = f.offer()
  const started = f.offer(proposal, f.agent, 2)
  const creating = { cardId: started, action: ACTION, phase: 'creating' }
  f.ctx.actionCards.record(f.agent, creating)
  const dismissed = f.offer(proposal, f.agent, 3)
  const dismissal = { cardId: dismissed, action: ACTION, phase: 'dismissed' }
  f.ctx.actionCards.record(f.agent, dismissal)
  const prefix = registry.checkpoint(session)
  const row = prefix['actionCards']!
  const legacy = projection.stateSchema.parse(row.val)
  legacy.view.decisions[open] = { cardId: open, action: ACTION, phase: 'replaced' }
  const stale = { ...prefix, actionCards: { ...row, ver: 3, val: legacy } }
  const example = f.offer({ ...proposal, action: 'my_example' }, f.agent, 4)
  const events = session.snapshotEvents()
  const restore = (checkpoint: typeof prefix, offset: number) => registry.restore(
    checkpoint, events.slice(offset), SessionLogOffset(offset), session.header, session.inheritedEventCount,
  )
  const full = restore({}, 0)
  expect(registry.restoreFloor(stale)).toBe(0)
  expect(restore(stale, 0)).toEqual(full)
  expect(restore(prefix, row.seq + 1)).toEqual(full)
  const recovered = projection.stateSchema.parse(full.checkpoint['actionCards']!.val)
  expect(Object.keys(recovered.view.proposals)).toEqual([open, started, dismissed, example])
  expect(recovered.view.decisions).toEqual({ [started]: creating, [dismissed]: dismissal })
  expect(Object.keys(recovered.pendingStatus)).toEqual([started, dismissed])
})

it('creates no card from an interrupted answer or in a subagent Session', () => {
  const state = init()
  expect(fold([answer(block(), 1, true)], state)).toBe(state)
  const offered = answer(block(), 2)
  expect(Object.keys(fold([answer(block(), 1, true), offered]).view.proposals)).toEqual([idOf(offered)])
  const subagent = init(0, 'subagent')
  expect(fold([turn(1), answer(block())], subagent)).toBe(subagent)
})

it('ignores the events a forked Session inherits from its parent', () => {
  const parent = [turn(1), answer(block())]
  // Every event created so far precedes the fork point.
  const inherited = init(seq)
  expect(fold(parent, inherited)).toBe(inherited)
  const own = answer(block(), 2)
  const forked = fold([turn(2), own], inherited)
  expect(Object.keys(forked.view.proposals)).toEqual([idOf(own)])
  expect(forked.view.decisions).toEqual({})
})

it('records valid decisions as pending status until a status notice acknowledges them', () => {
  const [created, malformed, dismissed] = records(
    { cardId: card('a'), action: 'test_action', phase: 'creating', data: { value: 1 } },
    { cardId: card('a'), action: 'test_action', phase: '' },
    { cardId: card('b'), action: 'test_action', phase: 'dismissed' },
  )
  const state = fold([created!, malformed!, dismissed!])
  expect(state.view.decisions).toEqual({
    a: { cardId: 'a', action: 'test_action', phase: 'creating', data: { value: 1 } },
    b: { cardId: 'b', action: 'test_action', phase: 'dismissed' },
  })
  expect(state.pendingStatus).toEqual({ a: created!.seq, b: dismissed!.seq })
  expect(projection.apply(state, notice(created!.seq)).pendingStatus).toEqual({ b: dismissed!.seq })
  const user: SessionEvent<'user/message'> = { type: 'user/message', seq: SessionSeq(100), time: 0, surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }) }
  expect(projection.apply(state, user)).toBe(state)
})

it('reads decisions that earlier builds recorded as plugin records', () => {
  const session = Session.create(brandString<SessionId>('legacy'))
  appendPluginRecord(session, 'plugin:action-cards/decision', { cardId: card('a'), action: 'test_action', phase: 'dismissed' })
  const [legacy] = session.snapshotEvents()
  const state = fold([legacy!])
  expect(state.view.decisions).toEqual({ a: { cardId: 'a', action: 'test_action', phase: 'dismissed' } })
  expect(state.pendingStatus).toEqual({ a: legacy!.seq })
})

it('publishes proposals and decisions as one view reused across internal state changes', () => {
  const state = fold([turn(1), answer(block())])
  const view = projection.wire.view(state)
  expect(view).toBe(state.view)
  expect(projection.wire.viewSchema.parse(view)).toEqual(view)
  expect(projection.wire.view(projection.apply(state, notice(0)))).toBe(view)
  expect(projection.stateSchema.parse(state)).toEqual(state)
})
