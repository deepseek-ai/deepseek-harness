import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply as applySchedule } from '../src/index.ts'
import { foldScheduleEvents, ScheduleId, ScheduleLogError } from '../src/domain.ts'
import { scheduleProjectionDefinition, type ScheduleProjectionState } from '../src/projection.ts'
import type { ScheduleRecord } from '../src/types.ts'

const contexts: Context[] = []
const RESTORE_HEADER: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('schedule-projection'),
  createdAt: 0,
  isSeeded: false,
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function afterRecord(id: string, prompt = id): ScheduleRecord {
  return {
    id: ScheduleId(id),
    kind: 'after',
    prompt,
    afterSeconds: 30,
    scheduledAt: '2026-08-25T12:00:00.000Z',
  }
}

function atRecord(id: string): ScheduleRecord {
  return {
    id: ScheduleId(id),
    kind: 'at',
    prompt: id,
    scheduledAt: '2026-08-25T13:00:00.000Z',
  }
}

function everyRecord(id: string): ScheduleRecord {
  return {
    id: ScheduleId(id),
    kind: 'every',
    prompt: id,
    everySeconds: 300,
    scheduledAt: '2026-08-25T14:00:00.000Z',
  }
}

function change(data: unknown, seq: SessionSeq): SessionEvent {
  return { type: 'schedule/change', seq, time: seq, data } as SessionEvent
}

function created(record: ScheduleRecord, seq: SessionSeq): SessionEvent {
  return change({ version: 1, operation: 'create', schedule: record }, seq)
}

describe('Schedule Session projection', () => {
  it('matches an empty replay, preserves creation order, and applies every terminal transition', () => {
    let projected: ScheduleProjectionState = scheduleProjectionDefinition.init(RESTORE_HEADER, SessionLogOffset(0))
    expect(projected).toEqual({ inheritedEventCount: 0, active: [], seenIds: [] })
    expect(scheduleProjectionDefinition.wire.view(projected)).toEqual(foldScheduleEvents([]).active)

    const events: SessionEvent[] = [
      created(afterRecord('after'), SessionSeq(0)),
      created(atRecord('at'), SessionSeq(1)),
      created(everyRecord('every'), SessionSeq(2)),
      change({ version: 1, operation: 'delete', id: 'at' }, SessionSeq(3)),
      change({ version: 1, operation: 'dispatch', id: 'after' }, SessionSeq(4)),
      change({
        version: 1,
        operation: 'dispatch',
        id: 'every',
        acceptedAt: '2026-08-25T14:02:00.000Z',
      }, SessionSeq(5)),
    ]
    for (const event of events.slice(0, 3)) {
      projected = scheduleProjectionDefinition.apply(projected, event)
    }
    expect(projected.active.map(record => record.id)).toEqual(['after', 'at', 'every'])
    for (const event of events.slice(3)) {
      projected = scheduleProjectionDefinition.apply(projected, event)
    }

    expect(projected).toEqual({ inheritedEventCount: 0, ...foldScheduleEvents(events) })
    expect(projected.active).toEqual([{ ...everyRecord('every'), scheduledAt: '2026-08-25T14:05:00.000Z' }])
  })

  it('shares strict transitions with full replay and excludes the inherited fork prefix', () => {
    const events: SessionEvent[] = [
      created(afterRecord('parent'), SessionSeq(0)),
      created(atRecord('child-at'), SessionSeq(1)),
      created(everyRecord('child-every'), SessionSeq(2)),
      change({
        version: 1,
        operation: 'dispatch',
        id: 'child-every',
        acceptedAt: '2026-08-25T14:02:00.000Z',
      }, SessionSeq(3)),
    ]
    let projected: ScheduleProjectionState = scheduleProjectionDefinition.init(
      { ...RESTORE_HEADER, isSeeded: true },
      SessionLogOffset(1),
    )
    for (const event of events) projected = scheduleProjectionDefinition.apply(projected, event)
    const beforeUnrelated = projected
    const unrelated = { type: 'turn/start', seq: SessionSeq(4), time: 4, data: { turn: 1 } } as SessionEvent
    projected = scheduleProjectionDefinition.apply(projected, unrelated)

    expect(projected).toBe(beforeUnrelated)
    expect(projected).toEqual({
      inheritedEventCount: 1,
      ...foldScheduleEvents([...events, unrelated], SessionLogOffset(1)),
    })
    expect(scheduleProjectionDefinition.wire.view(projected)).toEqual(projected.active)
    expect(projected.active.map(record => record.id)).toEqual(['child-at', 'child-every'])
  })

  it('restores checkpoints, folds a bounded tail, and fails loud on damaged durable data', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(scheduleProjectionDefinition)

    const first = created(afterRecord('one'), SessionSeq(0))
    const second = created(atRecord('two'), SessionSeq(1))
    const initial = ctx.sessionProjections.restore(
      {}, [first, second], SessionLogOffset(0), RESTORE_HEADER, SessionLogOffset(0),
    )
    expect(initial.snapshot.values.schedule?.map(record => record.id)).toEqual(['one', 'two'])

    const removed = change({ version: 1, operation: 'delete', id: 'one' }, SessionSeq(2))
    const resumed = ctx.sessionProjections.restore(
      initial.checkpoint,
      [second, removed],
      SessionLogOffset(1),
      RESTORE_HEADER,
      SessionLogOffset(0),
    )
    expect(resumed.snapshot.values.schedule?.map(record => record.id)).toEqual(['two'])
    expect(resumed.checkpoint.schedule).toMatchObject({ ver: 2, seq: 2 })

    expect(() => ctx.sessionProjections.restore(
      {},
      [change({ version: 1, operation: 'delete', id: 'missing' }, SessionSeq(0))],
      SessionLogOffset(0),
      RESTORE_HEADER,
      SessionLogOffset(0),
    )).toThrow(ScheduleLogError)
  })

  it('rejects malformed or internally inconsistent checkpoint states', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(scheduleProjectionDefinition)
    const row = (val: unknown) => ({ schedule: { ver: 2, seq: SessionSeq(0), val } })

    expect(ctx.sessionProjections.viewCheckpoint(row({
      inheritedEventCount: 0,
      active: [{ ...afterRecord('bad-time'), scheduledAt: 'not-an-instant' }],
      seenIds: ['bad-time'],
    }))).toEqual({})
    expect(ctx.sessionProjections.viewCheckpoint(row({
      inheritedEventCount: 0,
      active: [afterRecord('missing')],
      seenIds: [],
    }))).toEqual({})
    expect(ctx.sessionProjections.viewCheckpoint(row({
      inheritedEventCount: 0,
      active: [afterRecord('duplicate'), afterRecord('duplicate')],
      seenIds: ['duplicate', 'duplicate'],
    }))).toEqual({})
    expect(ctx.sessionProjections.viewCheckpoint(row({
      inheritedEventCount: 0,
      active: [],
      seenIds: [' bad-id'],
    }))).toEqual({})
  })

  it('registers only while the Schedule plugin fiber is live', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = ctx.plugin({ apply: applySchedule })
    await fiber.await()

    const session = ctx.sessions.create()
    session.append('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: afterRecord('live'),
    })
    expect(ctx.sessionProjections.snapshot(session).values.schedule).toHaveLength(1)

    await fiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })
})
