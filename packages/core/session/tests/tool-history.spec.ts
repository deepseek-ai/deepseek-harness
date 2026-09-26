/** Capability-independent tool history folded from committed headers and developer messages. */
import { describe, expect, it } from 'vitest'
import { createDeveloperMessage, projectToolUpdates } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolHistoryProjection } from '../src/tool-history.ts'

const search: ToolSchema = { name: 'search', description: 'Search', parameters: {} }
const fetch: ToolSchema = { name: 'fetch', description: 'Fetch', parameters: {} }
const config = { provider: 'test', model: 'test' }

function opened(tools: ToolSchema[]) {
  const session = Session.create(SessionId('tool-history'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { reason: 'initial', header: { config, tools } })
  return session
}

function header(session: Session, tools: ToolSchema[], extra: { reason?: 'change' | 'series'; startsSeries?: true } = {}) {
  return session.append('request/header', {
    reason: extra.reason ?? 'change',
    header: { config, ...tools.length === 0 ? {} : { tools } },
    ...extra.startsSeries === undefined ? {} : { startsSeries: true },
  }).seq
}

function update(session: Session, content: ContentBlock[], headerSeq?: SessionSeq) {
  const message = createDeveloperMessage({ source: { kind: 'test' }, content })
  session.append('developer/message', {
    turn: 1, step: 1, message, ...headerSeq === undefined ? {} : { headerSeq },
  }, { surfaceOp: 'append' })
  return message
}

const add = (name: string): ContentBlock => ({ type: 'tool-addition', toolName: name })
const remove = (name: string): ContentBlock => ({ type: 'tool-removal', toolName: name })

describe('Session.toolHistory', () => {
  it('returns frozen active declarations with no updates for an initial header', () => {
    const session = opened([search])
    const history = session.toolHistory()
    expect(history).toEqual({ tools: [search], updates: [] })
    expect(Object.isFrozen(history)).toBe(true)
    expect(Object.isFrozen(history.tools)).toBe(true)
    expect(session.toolHistory()).toBe(history)
  })

  it('resolves additions from their referenced header and keeps earlier snapshots unchanged', () => {
    const session = opened([search])
    const initial = session.toolHistory()
    const headerSeq = header(session, [search, fetch])
    const added = update(session, [add('fetch')], headerSeq)
    const afterAddition = session.toolHistory()
    expect(afterAddition).toEqual({ tools: [search], updates: [{ messageId: added.id, additions: [fetch] }] })
    header(session, [search])
    const removed = update(session, [remove('fetch'), { type: 'text', text: 'fetch is disabled' }])
    expect(session.toolHistory()).toEqual({ tools: [search], updates: [
      { messageId: added.id, additions: [fetch] },
      { messageId: removed.id, additions: [] },
    ] })
    expect(initial).toEqual({ tools: [search], updates: [] })
    expect(afterAddition.updates).toHaveLength(1)
  })

  it.each([
    { reason: 'series' as const },
    { startsSeries: true as const },
  ])('restarts declarations at an explicit series start %#', (extra) => {
    const session = opened([search])
    const headerSeq = header(session, [search, fetch])
    update(session, [add('fetch')], headerSeq)
    const restart = header(session, [search, fetch], extra)
    expect(session.toolHistory()).toEqual({ tools: [search, fetch], updates: [] })
    const added = update(session, [add('fetch')], restart)
    expect(session.toolHistory()).toEqual({ tools: [search, fetch], updates: [
      { messageId: added.id, additions: [fetch] },
    ] })
    expect(projectToolUpdates([added], [search, fetch], 'in-history', session.toolHistory()).messages).toEqual([])
  })

  it('restarts declarations when a retained name returns with a changed definition', () => {
    const session = opened([search, fetch])
    header(session, [search])
    update(session, [remove('fetch')])
    const changed = { ...fetch, description: 'Fetch v2' }
    const headerSeq = header(session, [search, changed])
    const added = update(session, [add('fetch')], headerSeq)
    expect(session.toolHistory()).toEqual({ tools: [search, changed], updates: [
      { messageId: added.id, additions: [changed] },
    ] })
  })

  it.each(['addition-only', 'in-history'] as const)('activates deferred baseline tools through folded history on %s routes', (mode) => {
    const deferred: ToolSchema = { ...fetch, deferLoading: true }
    const tools = [search, deferred]
    const session = opened(tools)
    const baseline = session.snapshotEvents().find(event => event.type === 'request/header')!
    const added = update(session, [add('search'), add('fetch')], baseline.seq)
    const duplicate = update(session, [add('fetch')], baseline.seq)
    const history = session.toolHistory()

    expect(history.updates).toEqual([
      { messageId: added.id, additions: [search, deferred] },
      { messageId: duplicate.id, additions: [deferred] },
    ])
    const projected = projectToolUpdates([added, duplicate], tools, mode, history)
    expect(projected.tools).toEqual(tools)
    expect(projected.messages).toEqual([{ ...added, content: [add('fetch')] }])
  })

  it('continues the series when a retained name is restored unchanged', () => {
    const session = opened([search, fetch])
    header(session, [search])
    const removed = update(session, [remove('fetch')])
    const headerSeq = header(session, [search, fetch])
    const restored = update(session, [add('fetch')], headerSeq)
    expect(session.toolHistory()).toEqual({ tools: [search, fetch], updates: [
      { messageId: removed.id, additions: [] },
      { messageId: restored.id, additions: [fetch] },
    ] })
  })

  it('falls back to complete active declarations while a header lacks its update record', () => {
    const session = opened([search])
    const headerSeq = header(session, [search, fetch])
    expect(session.toolHistory()).toEqual({ tools: [search, fetch], updates: [] })
    const added = update(session, [add('fetch')], headerSeq)
    expect(session.toolHistory()).toEqual({ tools: [search], updates: [{ messageId: added.id, additions: [fetch] }] })
    header(session, [search])
    expect(session.toolHistory()).toEqual({ tools: [search], updates: [] })
  })

  it('reconstructs inherited history on restore and continues from live events', () => {
    const session = opened([search])
    const headerSeq = header(session, [search, fetch])
    update(session, [add('fetch')], headerSeq)
    const events = session.snapshotEvents()
    const restored = Session.fromRestore(session.id, events, session.header, SessionLogOffset(0), 'shared-frozen')
    expect(restored.toolHistory()).toEqual(session.toolHistory())
    header(restored, [search])
    const removed = update(restored, [remove('fetch')])
    expect(restored.toolHistory().updates.at(-1)).toEqual({ messageId: removed.id, additions: [] })
    expect(session.toolHistory().updates).toHaveLength(1)
  })

  it('refuses an addition whose referenced header lacks the definition', () => {
    const projection = new ToolHistoryProjection()
    const headerEvent = (seq: number, reason: 'initial' | 'change'): SessionEvent<'request/header'> => ({
      seq: SessionSeq(seq), time: 0, type: 'request/header', data: { reason, header: { config, tools: [search] } },
    })
    const message = createDeveloperMessage({ source: { kind: 'test' }, content: [add('fetch')] })
    const developerEvent: SessionEvent<'developer/message'> = {
      seq: SessionSeq(2), time: 0, type: 'developer/message', surfaceOp: 'append',
      data: { turn: 1, step: 1, message, headerSeq: SessionSeq(1) },
    }
    projection.apply(headerEvent(0, 'initial'))
    projection.apply(headerEvent(1, 'change'))
    expect(() => { projection.apply(developerEvent) }).toThrow('tool history: missing definition for fetch')
  })
})
