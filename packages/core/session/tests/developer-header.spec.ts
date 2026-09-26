/** Tool additions bind to one historical request header across Session lifecycle paths. */
import { describe, expect, it } from 'vitest'
import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { foldSurface } from '../src/surface.ts'

const first: ToolSchema = { name: 'search', description: 'First', parameters: { type: 'object' } }
const second: ToolSchema = { name: 'search', description: 'Second', parameters: { properties: { query: { type: 'string' } } } }
const addition = () => createDeveloperMessage({ source: { kind: 'test' }, content: [{ type: 'tool-addition', toolName: 'search' }] })

function opened(tools: ToolSchema[] = [first]) {
  const session = Session.create(SessionId('developer-header'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const headerSeq = session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools } }).seq
  return { session, headerSeq }
}

describe('developer request-header references', () => {
  it('keeps an older header binding through compound changes, replacement, restore, and fork', () => {
    const { session, headerSeq } = opened([first, { name: 'other', description: 'Other', parameters: {} }])
    session.append('request/header', { reason: 'change', header: { config: { provider: 'test', model: 'test' }, tools: [second] } })
    const message = createDeveloperMessage({ source: { kind: 'test' }, content: [
      { type: 'tool-removal', toolName: 'search' },
      { type: 'tool-addition', toolName: 'search' },
      { type: 'tool-addition', toolName: 'other' },
    ] })
    const initial = session.append('developer/message', { turn: 1, step: 1, headerSeq, message }, { surfaceOp: 'append' })
    const replacement = session.append('developer/message', { turn: 1, step: 1, headerSeq, message: addition() }, {
      surfaceOp: { op: 'replace', startSeq: initial.seq, endSeq: initial.seq }, sourceEventSeqs: [initial.seq],
    })
    const events = session.snapshotEvents()
    expect(events[headerSeq]).toMatchObject({ data: { header: { tools: [first, { name: 'other', description: 'Other', parameters: {} }] } } })
    expect(replacement.data.message.content).toEqual([{ type: 'tool-addition', toolName: 'search' }])
    expect(foldSurface(events).nodes).toEqual([replacement.seq])
    const restored = Session.fromRestore(session.id, events, session.header, SessionLogOffset(0), 'shared-frozen')
    expect(restored.deriveMessages()).toEqual([replacement.data.message])
    const childId = SessionId('developer-header-child')
    const child = Session.create(childId, buildForkSeed(events, replacement.seq), {
      ...session.header, id: childId, parentSession: session.id, isSeeded: true,
    }, SessionLogOffset(replacement.seq + 1))
    expect(child.snapshotEvents()[replacement.seq]).toEqual(replacement)
    expect(child.snapshotEvents()[headerSeq]).toEqual(events[headerSeq])
  })

  it.each([0, 3, 100])('refuses a non-header or non-earlier reference %s before append', (reference) => {
    const { session } = opened()
    const before = session.snapshotEvents()
    expect(() => session.append('developer/message', {
      turn: 1, step: 1, headerSeq: SessionSeq(reference), message: addition(),
    }, { surfaceOp: 'append' })).toThrow('earlier request/header')
    expect(session.snapshotEvents()).toBe(before)
  })

  it.each([{ tools: [{ ...first, name: 'different' }] }, { tools: [first, second] }])('refuses missing or ambiguous historical tool names %#', ({ tools }) => {
    const { session, headerSeq } = opened(tools)
    expect(() => session.append('developer/message', { turn: 1, step: 1, headerSeq, message: addition() }, { surfaceOp: 'append' }))
      .toThrow('exactly one tool')
  })

  it('refuses an addition bound to a tool-less header', () => {
    const session = Session.create(SessionId('without-tools'))
    const headerSeq = session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' } } }).seq
    expect(() => session.append('developer/message', { turn: 1, step: 1, headerSeq, message: addition() }, { surfaceOp: 'append' }))
      .toThrow('exactly one tool')
  })

  it('requires a header exactly for additions and rejects inline definitions', () => {
    const { session, headerSeq } = opened()
    expect(() => session.append('developer/message', { turn: 1, step: 1, message: addition() }, { surfaceOp: 'append' })).toThrow('requires headerSeq')
    const removal = createDeveloperMessage({ source: { kind: 'test' }, content: [{ type: 'tool-removal', toolName: 'search' }] })
    expect(() => session.append('developer/message', { turn: 1, step: 1, headerSeq, message: removal }, { surfaceOp: 'append' })).toThrow('requires headerSeq')
    // @ts-expect-error -- legacy inline definitions are rejected at Session admission.
    const inline = createDeveloperMessage({ source: { kind: 'test' }, content: [{ type: 'tool-addition', toolName: 'search', tool: first }] })
    expect(() => session.append('developer/message', { turn: 1, step: 1, headerSeq, message: inline }, { surfaceOp: 'append' })).toThrow('omit inline')
    const unnamed = createDeveloperMessage({ source: { kind: 'test' }, content: [{ type: 'tool-addition', toolName: '' }] })
    expect(() => session.append('developer/message', { turn: 1, step: 1, headerSeq, message: unnamed }, { surfaceOp: 'append' })).toThrow('nonempty toolName')
  })

  it.each([
    { name: 'search' },
    { name: 'search', description: null, parameters: {} },
    { name: 'search', description: '', parameters: [] },
    { name: 'search', description: '', parameters: {}, deferLoading: false },
  ])('refuses an incomplete referenced definition in imported history %#', (tool) => {
    const { session, headerSeq } = opened()
    const source = session.snapshotEvents()[headerSeq]!
    const events = JSON.parse(JSON.stringify([
      ...session.snapshotEvents().slice(0, headerSeq),
      { ...source, data: { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [tool] } } },
      { type: 'developer/message', seq: 3, time: 4, surfaceOp: 'append', data: { turn: 1, step: 1, headerSeq, message: addition() } },
    ])) as SessionEvent[]
    expect(() => Session.create(SessionId('incomplete-tool'), events)).toThrow(/complete tool definition|deferLoading/)
  })

  it('applies the same binding check to imported events and full-log surface folds', () => {
    const { session } = opened()
    const invalid: SessionEvent<'developer/message'> = {
      type: 'developer/message', seq: SessionSeq(3), time: 4, surfaceOp: 'append',
      data: { turn: 1, step: 1, headerSeq: SessionSeq(0), message: addition() },
    }
    const events = [...session.snapshotEvents(), invalid]
    expect(() => Session.create(SessionId('bad-import'), events)).toThrow('earlier request/header')
    expect(() => foldSurface(events)).toThrow('earlier request/header')
  })
})
