import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  appendPluginRecord, Session, SESSION_FORMAT_VERSION, type SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { PluginRecordMap } from '@deepseek-ai/dsh-session/types'
import { actionCardProjection, type ActionCardState } from '../src/projection.ts'
import type { ActionCardId } from '../src/types.ts'

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

function records(...data: PluginRecordMap['plugin:action-cards/decision'][]): readonly SessionEvent[] {
  const session = Session.create(brandString<SessionId>('records'))
  for (const value of data) appendPluginRecord(session, 'plugin:action-cards/decision', value)
  return session.snapshotEvents()
}

const fold = (events: readonly SessionEvent[], state = init()) => events.reduce(projection.apply, state)
const card = (id: string) => brandString<ActionCardId>(id)
const notice = (through: number): SessionEvent<'user/message'> => ({ type: 'user/message', seq: SessionSeq(99), time: 0, surfaceOp: 'append',
  data: createUserMessage({ content: [{ type: 'text', text: 'status' }],
    source: { kind: 'action-cards', through: SessionSeq(through), form: 'notice', summary: 'status' } }) })

it('admits the first valid action-card block of an answer as a card named by the answer message id', () => {
  const offered = answer(`Here is an option.\n\n${block()}\n`)
  expect(fold([turn(1), offered]).view.proposals).toEqual({ [idOf(offered)]: { cardId: idOf(offered), turn: 1, ...args } })
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

it('keeps the first card of a turn across steps, and replaces only unstarted earlier cards', () => {
  const firstAnswer = answer(block())
  const first = fold([turn(1), firstAnswer])
  const a = idOf(firstAnswer)
  expect(fold([answer(block({ ...args, title: 'Late' }))], first)).toEqual(first)
  const nextAnswer = answer(block(args), 2)
  const next = fold([turn(2), nextAnswer], first)
  expect(Object.keys(next.view.proposals)).toEqual([a, idOf(nextAnswer)])
  expect(next.view.decisions).toEqual({ [a]: { cardId: a, action: 'test_action', phase: 'replaced' } })
  const started = fold(records({ cardId: a, action: 'test_action', phase: 'creating' }), first)
  const laterAnswer = answer(block(args), 2)
  const afterStart = fold([turn(2), laterAnswer], started)
  expect(afterStart.view.decisions[a]?.phase).toBe('creating')
  expect(afterStart.view.decisions[idOf(laterAnswer)]).toBeUndefined()
  // Replacement crosses kinds: a card of another action replaces the unstarted one too.
  const otherAnswer = answer(block({ ...args, action: 'other_action' }), 2)
  expect(fold([turn(2), otherAnswer], first).view.decisions).toEqual({ [a]: { cardId: a, action: 'test_action', phase: 'replaced' } })
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

it('publishes proposals and decisions as one view reused across internal state changes', () => {
  const state = fold([turn(1), answer(block())])
  const view = projection.wire.view(state)
  expect(view).toBe(state.view)
  expect(projection.wire.viewSchema.parse(view)).toEqual(view)
  expect(projection.wire.view(projection.apply(state, notice(0)))).toBe(view)
  expect(projection.stateSchema.parse(state)).toEqual(state)
})
