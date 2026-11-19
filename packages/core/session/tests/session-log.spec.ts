/** Session-log validation, header construction, and inherited-marker rules shared with Session construction. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  buildSessionHeader, needsInheritedSeedMarker, Session, SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq, validateSessionLog,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionMessageProjection } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/session-log-project': { seq: SessionSeq }
  }
}

const id = brandString<SessionId>('checked-log')
const turnStart = (seq = 0): SessionEvent => ({ type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn: 1 } })
const inheritedMarker = (seq: number): SessionEvent => ({ type: 'session/end-seed', seq: SessionSeq(seq), time: 0, data: { inherited: true } })

const modes = [undefined, 'detached', 'shared-frozen'] as const
type Mode = typeof modes[number]

/** Construct a Session with the entry point that matches a validation mode. */
function construct(mode: Mode, header: SessionHeader, events: readonly SessionEvent[], cut: SessionLogOffset): Session {
  return mode === undefined
    ? Session.create(header.id, events, header, cut)
    : Session.fromRestore(header.id, events, header, cut, mode)
}

interface InvalidLog {
  name: string
  header?: Partial<SessionHeader>
  events?: SessionEvent[]
  cut?: number
  message: string
}

const invalidLogs: InvalidLog[] = [
  { name: 'negative createdAt', header: { createdAt: -1 }, message: 'session header createdAt must be a non-negative safe integer' },
  { name: 'relative cwd', header: { cwd: 'relative' }, message: 'session header cwd must be an absolute path, got "relative"' },
  { name: 'sequence gap', events: [turnStart(2)], message: 'seed event at index 0 has seq 2 (expected 0); seed must be contiguous from 0' },
  {
    name: 'missing event type',
    events: JSON.parse('[{"seq":0,"time":0,"data":{}}]') as SessionEvent[],
    message: 'seed event at index 0 has an invalid event envelope',
  },
  {
    name: 'unknown surface event',
    events: JSON.parse('[{"type":"fixture/unknown","seq":0,"time":0,"data":{},"surfaceOp":"append"}]') as SessionEvent[],
    message: 'invalid seed event at index 0',
  },
  { name: 'unseeded nonzero cut', cut: 1, message: 'unseeded session inherited event count must be 0' },
  { name: 'cut beyond the log', header: { isSeeded: true }, cut: 2, message: 'session inherited event count exceeds its event log' },
  {
    name: 'cut before the final inherited marker',
    header: { isSeeded: true },
    events: [inheritedMarker(0), inheritedMarker(1)],
    cut: 0,
    message: 'session inherited event count must identify the final inherited marker',
  },
]

describe('validateSessionLog', () => {
  describe.each(modes)('with event state %s', (mode) => {
    it.each(invalidLogs)('rejects $name with the Session construction error', (invalid) => {
      const header = () => ({ ...buildSessionHeader(id), ...invalid.header })
      const events = invalid.events ?? [turnStart()]
      const cut = SessionLogOffset(invalid.cut ?? 0)
      expect(() => { validateSessionLog(header(), events, cut, mode) }).toThrow(invalid.message)
      expect(() => construct(mode, header(), events, cut)).toThrow(invalid.message)
    })

    it.each([
      { name: 'unseeded log', header: {}, events: [turnStart()], cut: 0 },
      { name: 'seeded log ending at its cut', header: { isSeeded: true }, events: [turnStart()], cut: 1 },
      { name: 'seeded log with a marked cut', header: { isSeeded: true }, events: [turnStart(), inheritedMarker(1)], cut: 1 },
    ])('accepts a valid $name that Session construction accepts', (valid) => {
      const cut = SessionLogOffset(valid.cut)
      expect(() => { validateSessionLog({ ...buildSessionHeader(id), ...valid.header }, valid.events, cut, mode) }).not.toThrow()
      expect(() => construct(mode, { ...buildSessionHeader(id), ...valid.header }, valid.events, cut)).not.toThrow()
    })
  })

  it('checks events before the header without an event state and the header first with one', () => {
    const header = () => ({ ...buildSessionHeader(id), createdAt: -1 })
    const events = [turnStart(2)]
    expect(() => { validateSessionLog(header(), events) }).toThrow('seed event at index 0 has seq 2')
    expect(() => { validateSessionLog(header(), events, SessionLogOffset(0), 'detached') }).toThrow('session header createdAt')
  })

  it('requires an explicit seed and cut for a seeded header', () => {
    const header = buildSessionHeader(id, { isSeeded: true })
    expect(() => { validateSessionLog(header) }).toThrow('seeded session requires an explicit constructor seed')
    expect(() => { validateSessionLog(header, []) }).toThrow('seeded session requires an inherited event count')
    expect(() => { validateSessionLog(header, [turnStart(), turnStart(1)], SessionLogOffset(1)) })
      .toThrow('seeded session constructor seed must equal its inherited prefix or mark its inherited cut')
  })

  it('takes the Session identity from the header', () => {
    const header = buildSessionHeader(brandString<SessionId>('other'))
    expect(() => { validateSessionLog(header, [turnStart()]) }).not.toThrow()
    expect(() => Session.create(id, [turnStart()], header))
      .toThrow('session header id "other" does not match session id "checked-log"')
  })

  it('leaves borrowed inputs unchanged where construction appends an inherited marker', () => {
    const header = buildSessionHeader(id, { isSeeded: true })
    const events = [turnStart()]
    validateSessionLog(header, events, SessionLogOffset(1))
    expect(events).toEqual([turnStart()])
    expect(Object.isFrozen(header)).toBe(false)
    expect(Object.isFrozen(events[0])).toBe(false)
    expect(Session.create(id, events, header, SessionLogOffset(1)).snapshotEvents().map(event => event.type))
      .toEqual(['turn/start', 'session/end-seed'])
  })

  it('freezes a restored header in place and leaves restored events uncopied', () => {
    for (const mode of ['detached', 'shared-frozen'] as const) {
      const header = buildSessionHeader(id)
      const events = [turnStart()]
      validateSessionLog(header, events, SessionLogOffset(0), mode)
      expect(Object.isFrozen(header)).toBe(true)
      expect(Object.isFrozen(events[0])).toBe(false)
    }
  })

  it('interprets plugin-owned message events through the supplied projections', () => {
    const projection: SessionMessageProjection<'test/session-log-project'> = {
      type: 'test/session-log-project',
      project: () => { throw new Error('rejected decision') },
    }
    const header = buildSessionHeader(id)
    const events: SessionEvent[] = [
      {
        type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append',
        data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      },
      { type: 'test/session-log-project', seq: SessionSeq(1), time: 0, data: { seq: SessionSeq(0) } },
    ]
    expect(() => { validateSessionLog(header, events) }).not.toThrow()
    expect(() => { validateSessionLog(header, events, undefined, undefined, [projection]) })
      .toThrow('invalid seed event at index 1: rejected decision')
    expect(() => Session.create(id, events, header, undefined, [projection]))
      .toThrow('invalid seed event at index 1: rejected decision')
  })
})

describe('buildSessionHeader', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stamps the format version, the current time, and an unseeded flag by default', () => {
    vi.useFakeTimers({ now: 1234 })
    const header = buildSessionHeader(id)
    expect(header).toEqual({ version: SESSION_FORMAT_VERSION, id, createdAt: 1234, isSeeded: false })
    expect(Object.isFrozen(header)).toBe(false)
  })

  it('copies every supplied field and omits the absent ones', () => {
    const parent = brandString<SessionId>('parent')
    const meta = { cwd: '/work', parentSession: parent, createdAt: 5, isSeeded: true, origin: 'subagent', delegationDepth: 2, agentPreset: 'general' } as const
    expect(buildSessionHeader(id, meta)).toEqual({ version: SESSION_FORMAT_VERSION, id, ...meta })
    expect(Object.keys(buildSessionHeader(id, { createdAt: 5, cwd: '/work' })).sort())
      .toEqual(['createdAt', 'cwd', 'id', 'isSeeded', 'version'])
  })

  it('produces a header that Session construction accepts', () => {
    const header = buildSessionHeader(id, { cwd: '/work', createdAt: 5 })
    expect(Session.create(id, undefined, header).header).toEqual(header)
  })
})

describe('needsInheritedSeedMarker', () => {
  it('requires a marker only for a seeded header whose cut does not hold the inherited marker', () => {
    const seeded = buildSessionHeader(id, { isSeeded: true })
    const unseeded = buildSessionHeader(id)
    expect(needsInheritedSeedMarker(seeded, [turnStart()], SessionLogOffset(1))).toBe(true)
    expect(needsInheritedSeedMarker(seeded, [turnStart(), inheritedMarker(1)], SessionLogOffset(1))).toBe(false)
    expect(needsInheritedSeedMarker(unseeded, [turnStart()], SessionLogOffset(0))).toBe(false)
  })

  it('ignores an ancestor marker earlier in the inherited prefix', () => {
    const seeded = buildSessionHeader(id, { isSeeded: true })
    expect(needsInheritedSeedMarker(seeded, [inheritedMarker(0), turnStart(1)], SessionLogOffset(2))).toBe(true)
  })

  it('ignores an untagged seed marker at the cut', () => {
    const seeded = buildSessionHeader(id, { isSeeded: true })
    const untagged: SessionEvent = { type: 'session/end-seed', seq: SessionSeq(1), time: 0, data: {} }
    expect(needsInheritedSeedMarker(seeded, [turnStart(), untagged], SessionLogOffset(1))).toBe(true)
  })
})
