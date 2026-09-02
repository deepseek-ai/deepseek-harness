import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type OptionalSessionSeq,
  type SessionLogOffset as SessionLogOffsetType,
  type SessionHeader,
  type SessionSeq as SessionSeqType,
  type SessionSeqCursor,
} from '@deepseek-ai/dsh-session'

describe('Session log positions', () => {
  it('admits non-negative safe integers into distinct sequence roles', () => {
    const seq = SessionSeq(3)
    const offset = SessionLogOffset(4)

    expect(seq).toBe(3)
    expect(offset).toBe(4)
    expectTypeOf(seq).toEqualTypeOf<SessionSeqType>()
    expectTypeOf(offset).toEqualTypeOf<SessionLogOffsetType>()
    expectTypeOf(seq).not.toEqualTypeOf<SessionLogOffsetType>()
    expectTypeOf<SessionSeqCursor>().toEqualTypeOf<SessionSeqType | -1>()
    expectTypeOf<OptionalSessionSeq>().toEqualTypeOf<SessionSeqType | null>()
  })

  it.each([-1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects invalid Session sequence positions (%s)',
    (value) => {
      expect(() => SessionSeq(value)).toThrow(/SessionSeq must be a non-negative safe integer/)
      expect(() => SessionLogOffset(value)).toThrow(/SessionLogOffset must be a non-negative safe integer/)
    },
  )

  it('keeps event identities separate from log offsets', () => {
    const session = Session.create(SessionId('typed-positions'))
    const event = session.append('turn/start', { turn: 1 })

    expect(event.seq).toBe(0)
    expect(session.firstLiveSeq).toBe(0)
    expect(session.seq).toBe(1)
    expectTypeOf(event.seq).toEqualTypeOf<SessionSeqType>()
    expectTypeOf(session.firstLiveSeq).toEqualTypeOf<SessionLogOffsetType>()
    expectTypeOf(session.seq).toEqualTypeOf<SessionLogOffsetType>()
  })

  it('rejects a negative-zero seq at the restored event boundary', () => {
    const id = SessionId('negative-zero-event')
    expect(() => Session.fromRestore(id, [{
      type: 'turn/start', seq: -0, time: 1, data: { turn: 1 },
    }] as never, {
      version: 0, id, createdAt: 1, isSeeded: false,
    }, SessionLogOffset(0))).toThrow(/invalid event envelope/)
  })

  it('keeps fork lineage outside the logical header integer fields', () => {
    const source = Session.create(SessionId('source'))
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const id = SessionId('child')
    const header: SessionHeader = {
      version: 0,
      id,
      createdAt: 1,
      isSeeded: true,
    }

    const child = Session.create(id, source.snapshotEvents(), header, source.seq)

    expect(child.header.isSeeded).toBe(true)
    expect('seedLength' in child.header).toBe(false)
    expect(child.inheritedEventCount).toBe(2)
    expect(child.ownEvents().map(event => event.type)).toEqual(['session/end-seed'])
    expect(child.isOwnSeq(SessionSeq(1))).toBe(false)
    expect(child.isOwnSeq(SessionSeq(2))).toBe(true)
    expect(child.isOwnSeq(SessionSeq(3))).toBe(false)

    const fresh = Session.create(SessionId('fresh'))
    expect(fresh.header.isSeeded).toBe(false)
    expect(fresh.inheritedEventCount).toBe(0)
  })

  it('retains a child-owned constructor-seed suffix after the inherited cut', () => {
    const parent = Session.create(SessionId('suffix-parent'))
    parent.append('turn/start', { turn: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const assembled = Session.create(SessionId('assembled-seed'), parent.snapshotEvents())
    assembled.append('request/context', { provider: 'provider', model: 'model' })
    const id = SessionId('suffix-child')

    const child = Session.create(id, assembled.snapshotEvents(), {
      version: 0,
      id,
      createdAt: 1,
      isSeeded: true,
    }, parent.seq)

    expect(child.ownEvents().map(event => event.type)).toEqual([
      'session/end-seed',
      'request/context',
      'session/end-seed',
    ])
    expect(child.isOwnSeq(SessionSeq(1))).toBe(false)
    expect(child.isOwnSeq(SessionSeq(2))).toBe(true)
    expect(child.isOwnSeq(SessionSeq(3))).toBe(true)
  })

  it('requires a separately supplied inherited cut for a seeded header', () => {
    const id = SessionId('missing-cut')
    expect(() => Session.create(id, [], {
      version: 0,
      id,
      createdAt: 1,
      isSeeded: true,
    })).toThrow(/seeded session requires an inherited event count/)
  })

  it('requires an explicit constructor seed for seeded lineage', () => {
    const id = SessionId('missing-seed')
    expect(() => Session.create(id, undefined, {
      version: 0,
      id,
      createdAt: 1,
      isSeeded: true,
    }, SessionLogOffset(0))).toThrow(/seeded session requires an explicit constructor seed/)
  })

  it('requires the exact cut to agree with lineage and log length', () => {
    const unseededId = SessionId('unseeded-nonzero-cut')
    expect(() => Session.create(unseededId, [], {
      version: 0, id: unseededId, createdAt: 1, isSeeded: false,
    }, SessionLogOffset(1))).toThrow(/unseeded session inherited event count must be 0/)

    const seededId = SessionId('seeded-oversized-cut')
    expect(() => Session.create(seededId, [], {
      version: 0, id: seededId, createdAt: 1, isSeeded: true,
    }, SessionLogOffset(1))).toThrow(/inherited event count exceeds its event log/)
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'revalidates a supplied inherited event count (%s)',
    (value) => {
      const id = SessionId(`bad-inherited-count-${value}`)
      expect(() => Session.create(id, [], {
        version: 0,
        id,
        createdAt: 1,
        isSeeded: true,
      }, value as SessionLogOffsetType)).toThrow(/SessionLogOffset must be a non-negative safe integer/)
    },
  )
})
