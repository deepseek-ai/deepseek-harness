import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  appendPluginRecord,
  buildForkSeed,
  pluginRecordOf,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PluginRequestFixture } from './plugin-records.type-test.ts'

/** One user turn opening, so a record lands between model-visible events. */
function openTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('plugin records', () => {
  it('commits an ignorable record outside the model-visible surface', () => {
    const session = Session.create(SessionId('record'))
    openTurn(session)
    const messages = session.deriveMessages()
    const nodes = session.surface.nodes
    const data = { count: 1 }

    const seq = appendPluginRecord(session, 'plugin:test/state', data)
    data.count = 2

    expect(seq).toBe(SessionSeq(2))
    const record = session.eventAt(seq)
    expect(record).toEqual({ type: 'plugin:test/state', seq: 2, time: record?.time, data: { count: 1 }, ignorable: true })
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record?.data)).toBe(true)
    expect(session.deriveMessages()).toEqual(messages)
    expect(session.surface.nodes).toEqual(nodes)
  })

  it('reads records back and leaves every other event unread', () => {
    const session = Session.create(SessionId('reader'))
    openTurn(session)
    appendPluginRecord(session, 'plugin:test.bridge/entry_1', ['a', 2])

    const events = session.snapshotEvents()
    expect(events.map(pluginRecordOf)).toEqual([
      undefined,
      undefined,
      { type: 'plugin:test.bridge/entry_1', seq: 2, time: events[2]?.time, data: ['a', 2] },
    ])
  })

  it('snapshots an interface-typed request with readonly messages', () => {
    const session = Session.create(SessionId('typed-request'))
    const request: PluginRequestFixture = {
      config: { provider: 'fixture', model: 'fixture' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Translate this fragment.' }] }],
    }
    const seq = appendPluginRecord(session, 'plugin:test/request', request)
    request.config.model = 'changed'

    const event = session.eventAt(seq)
    expect(event?.data).toEqual({
      config: { provider: 'fixture', model: 'fixture' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Translate this fragment.' }] }],
    })
    expect(Object.isFrozen(event?.data)).toBe(true)
    expect(session.deriveMessages()).toEqual([])
  })

  it('does not read a known event, even one marked ignorable', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 2 }, ignorable: true },
    ]

    expect(events.map(pluginRecordOf)).toEqual([undefined, undefined])
  })

  it.each([
    'plugin:',
    'plugin:Test/state',
    'plugin:/state',
    'plugin:test/',
    'plugin:test//state',
    'plugin:-test',
    'plugin:test state',
    'turn/start',
  ])('rejects the record type %j without changing the log', (type) => {
    const session = Session.create(SessionId('grammar'))
    const name: string = type

    expect(() => {
      // @ts-expect-error -- runtime callers can supply names outside the declared map.
      appendPluginRecord(session, name, {})
    })
      .toThrow(`plugin record type "${type}" must be "plugin:" followed by lowercase slash-separated segments`)
    expect(session.seq).toBe(0)
  })

  it('rejects data that is not losslessly JSON-serializable without changing the log', () => {
    const session = Session.create(SessionId('lossy'))

    expect(() => appendPluginRecord(session, 'plugin:test/number', Number.NaN))
      .toThrow('plugin record "plugin:test/number" carries non-JSON-serializable data')
    expect(session.seq).toBe(0)
  })

  it('publishes a record to session/event observers and contains a reentrant record', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const session = ctx.sessions.create(SessionId('observed-record'))
    const heard: SessionEvent[] = []
    ctx.on('session/event', (observed) => { appendPluginRecord(observed, 'plugin:test/echo', {}) })
    ctx.on('session/event', (_observed, event) => { heard.push(event) })

    appendPluginRecord(session, 'plugin:test/state', { count: 1 })

    expect(heard.map(event => event.type)).toEqual(['plugin:test/state'])
    expect(session.seq).toBe(1)
    expect(warnings).toEqual([
      'session "observed-record": session/event listener threw: Error: session append cannot reenter while another append is being published',
    ])
    await ctx.fiber.dispose()
  })

  it('carries records through a snapshot restore, a storage reopen, and a fork', () => {
    const session = Session.create(SessionId('source'))
    openTurn(session)
    appendPluginRecord(session, 'plugin:test/state', { count: 1 })
    const events = session.snapshotEvents()

    const restored = Session.create(SessionId('restored'), events)
    const reopened = Session.fromRestore(SessionId('source'), events, session.header, SessionLogOffset(0), 'shared-frozen')
    const child = Session.create(SessionId('child'), buildForkSeed(events, SessionSeq(2)))

    for (const copy of [restored, reopened, child]) {
      expect(pluginRecordOf(copy.snapshotEvents()[2] as SessionEvent))
        .toEqual({ type: 'plugin:test/state', seq: 2, time: events[2]?.time, data: { count: 1 } })
      expect(copy.deriveMessages()).toEqual(session.deriveMessages())
    }
  })
})
