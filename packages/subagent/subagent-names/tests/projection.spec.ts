import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { subagentNamesProjection } from '../src/projection.ts'

const header: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('parent'),
  createdAt: 0,
  isSeeded: false,
}

function bound(seq: number, childId = 'child', name = 'lead/worker'): SessionEvent<'subagent-name/bound'> {
  return {
    type: 'subagent-name/bound', seq: SessionSeq(seq), time: seq,
    data: { version: 1, childId: SessionId(childId), name },
  }
}

async function registry() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.sessionProjections.register(subagentNamesProjection)
  return ctx.sessionProjections
}

describe('subagent names projection', () => {
  it('keeps each child binding immutable without mutating earlier states', () => {
    const initial = subagentNamesProjection.init(header, SessionLogOffset(0))
    const first = subagentNamesProjection.apply(initial, bound(0))
    const second = subagentNamesProjection.apply(first, bound(1, 'other-child', 'lead/reviewer'))

    expect(initial.bindings).toEqual([])
    expect(first.bindings).toEqual([{ childId: 'child', name: 'lead/worker' }])
    expect(second.bindings).toEqual([
      { childId: 'child', name: 'lead/worker' },
      { childId: 'other-child', name: 'lead/reviewer' },
    ])
    expect(() => subagentNamesProjection.apply(second, bound(2, 'child', 'lead/renamed')))
      .toThrow('one immutable binding')
    expect(() => subagentNamesProjection.apply(second, bound(2, 'different-child', 'lead/worker')))
      .toThrow('one immutable binding')
    expect(second.bindings).toEqual([
      { childId: 'child', name: 'lead/worker' },
      { childId: 'other-child', name: 'lead/reviewer' },
    ])
  })

  it('preserves state and view references for repeated bindings and unrelated events', () => {
    const state = subagentNamesProjection.apply(
      subagentNamesProjection.init(header, SessionLogOffset(0)), bound(0),
    )
    const duplicate = subagentNamesProjection.apply(state, bound(1))
    const unrelated = subagentNamesProjection.apply(state, {
      type: 'turn/start', seq: SessionSeq(2), time: 2, data: { turn: 1 },
    })

    expect(duplicate).toBe(state)
    expect(unrelated).toBe(state)
    expect(subagentNamesProjection.wire.view(duplicate)).toBe(state.bindings)
    expect(subagentNamesProjection.wire.view(unrelated)).toBe(state.bindings)
  })

  it('excludes inherited bindings and admits the event at the exact inherited cut', () => {
    const initial = subagentNamesProjection.init(header, SessionLogOffset(2))
    expect(subagentNamesProjection.apply(initial, bound(0, 'child', 'lead/inherited'))).toBe(initial)
    expect(subagentNamesProjection.apply(initial, bound(1, 'other-child', 'lead/inherited-too'))).toBe(initial)
    const own = subagentNamesProjection.apply(initial, bound(2))

    expect(own.bindings).toEqual([{ childId: 'child', name: 'lead/worker' }])
    expect(own.inheritedEventCount).toBe(2)
  })

  it.each([
    { version: 2, childId: 'child', name: 'lead/worker' },
    { childId: 'child', name: 'lead/worker' },
    { version: 1, childId: 1, name: 'lead/worker' },
    { version: 1, name: 'lead/worker' },
    { version: 1, childId: 'child' },
    { version: 1, childId: 'child', name: 1 },
    { version: 1, childId: 'child', name: 'lead/worker', extra: true },
    ...['', 'Worker', '1worker', 'parent/worker', 'legacy:child', 'worker name'].map(name => ({
      version: 1, childId: 'child', name,
    })),
  ])('rejects malformed persisted binding data %j', (data) => {
    const initial = subagentNamesProjection.init(header, SessionLogOffset(0))
    // Persisted events can violate the declared event fields before replay validation.
    const event = { ...bound(0), data } as SessionEvent<'subagent-name/bound'>
    expect(() => subagentNamesProjection.apply(initial, event)).toThrow()
    expect(initial.bindings).toEqual([])
  })

  it.each([
    {},
    { inheritedEventCount: -1, bindings: [] },
    { inheritedEventCount: 0.5, bindings: [] },
    { inheritedEventCount: '0', bindings: [] },
    { inheritedEventCount: 0, bindings: {} },
    { inheritedEventCount: 0, bindings: [{ childId: 'child' }] },
    { inheritedEventCount: 0, bindings: [{ childId: 1, name: 'lead/worker' }] },
    { inheritedEventCount: 0, bindings: [{ childId: 'child', name: 'parent/worker' }] },
    { inheritedEventCount: 0, bindings: [{ childId: 'child', name: 'lead/worker', version: 1 }] },
    { inheritedEventCount: 0, bindings: [{ childId: 'child', name: 'lead/worker' }, { childId: 'child', name: 'lead/reviewer' }] },
    { inheritedEventCount: 0, bindings: [{ childId: 'child', name: 'lead/worker' }, { childId: 'other', name: 'lead/worker' }] },
    { inheritedEventCount: 0, bindings: [], extra: true },
  ])('rejects malformed checkpoint state %j', (state) => {
    expect(subagentNamesProjection.stateSchema.safeParse(state).success).toBe(false)
  })

  it('restores a versioned checkpoint and suffix to the same state as complete replay', async () => {
    const projections = await registry()
    const inheritedEventCount = SessionLogOffset(1)
    const events: SessionEvent[] = [
      bound(0, 'ancestor-child', 'lead/inherited'),
      bound(1),
      bound(2),
      bound(3, 'other-child', 'lead/reviewer'),
      { type: 'turn/start', seq: SessionSeq(4), time: 4, data: { turn: 1 } },
    ]
    const prefix = projections.restore({}, events.slice(0, 2), SessionLogOffset(0), header, inheritedEventCount)
    expect(prefix.checkpoint.subagentNames).toEqual({
      ver: 1, seq: 1,
      val: { inheritedEventCount: 1, bindings: [{ childId: 'child', name: 'lead/worker' }] },
    })
    const resumed = projections.restore(
      prefix.checkpoint, events.slice(2), SessionLogOffset(2), header, inheritedEventCount,
    )
    const replayed = projections.restore({}, events, SessionLogOffset(0), header, inheritedEventCount)

    expect(resumed).toEqual(replayed)
    expect(resumed.snapshot).toEqual({
      asOfSeq: 4,
      values: { subagentNames: [
        { childId: 'child', name: 'lead/worker' },
        { childId: 'other-child', name: 'lead/reviewer' },
      ] },
    })
    expect(projections.viewCheckpoint(resumed.checkpoint)).toEqual(resumed.snapshot.values)
    expect(projections.restore(
      resumed.checkpoint, [], SessionLogOffset(5), header, inheritedEventCount,
    )).toEqual(resumed)
  })

  it('replays from the log when the checkpoint version is incompatible', async () => {
    const projections = await registry()
    const incompatible = {
      subagentNames: { ver: 2, seq: SessionSeq(0), val: { unsupported: true } },
    }

    expect(projections.viewCheckpoint(incompatible)).toEqual({})
    expect(() => projections.restore(
      incompatible, [bound(1, 'other-child', 'lead/reviewer')], SessionLogOffset(1), header, SessionLogOffset(0),
    )).toThrow(/re-read from seq 0/)
    expect(projections.restore(
      incompatible, [bound(0)], SessionLogOffset(0), header, SessionLogOffset(0),
    ).snapshot.values.subagentNames).toEqual([{ childId: 'child', name: 'lead/worker' }])
  })

  it('rejects a version-matching checkpoint with invalid binding fields', async () => {
    const projections = await registry()
    const invalid = {
      subagentNames: {
        ver: 1, seq: SessionSeq(0),
        val: { inheritedEventCount: 0, bindings: [{ childId: 'child', name: 'Invalid' }] },
      },
    }

    expect(projections.viewCheckpoint(invalid)).toEqual({})
    expect(() => projections.restore(
      invalid, [], SessionLogOffset(1), header, SessionLogOffset(0),
    )).toThrow()
  })
})
