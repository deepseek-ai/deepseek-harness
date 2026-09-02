import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as scheduleInvariant from '../src/invariant.ts'
import { ScheduleId } from '../src/domain.ts'
import type { ScheduleChange } from '../src/types.ts'

function event(data: unknown, seq: SessionSeq): SessionEvent {
  return { type: 'schedule/change', seq, time: 1, data } as SessionEvent
}

function create(id: string): ScheduleChange {
  return {
    version: 1,
    operation: 'create',
    schedule: {
      id: ScheduleId(id),
      kind: 'after',
      prompt: 'check logs',
      afterSeconds: 1,
      scheduledAt: '2026-08-05T12:00:01.000Z',
    },
  }
}

function createEvery(id: string): ScheduleChange {
  return {
    version: 1,
    operation: 'create',
    schedule: {
      id: ScheduleId(id),
      kind: 'every',
      prompt: 'check metrics',
      everySeconds: 300,
      scheduledAt: '2026-08-05T12:05:00.000Z',
    },
  }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  const fiber = await ctx.plugin(scheduleInvariant)
  return { ctx, fiber }
}

describe('Schedule package invariant', () => {
  it('accepts valid candidates and rejects invalid transitions before append', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('schedule-invariant'))
    session.append('turn/start', { turn: 1 })
    session.append('schedule/change', create('schedule-1'))
    expect(session.snapshotEvents()).toHaveLength(2)

    expect(() => session.append('schedule/change', {
      version: 1,
      operation: 'delete',
      id: ScheduleId('missing'),
    })).toThrow(InvariantError)
    expect(session.snapshotEvents()).toHaveLength(2)

    session.append('schedule/change', { version: 1, operation: 'dispatch', id: ScheduleId('schedule-1') })
    expect(session.snapshotEvents()).toHaveLength(3)
    await ctx.fiber.dispose()
  })

  it('requires a decision time for Every dispatch and advances the live stream', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('schedule-every-invariant'))
    session.append('schedule/change', createEvery('schedule-every'))
    expect(() => session.append('schedule/change', {
      version: 1,
      operation: 'dispatch',
      id: ScheduleId('schedule-every'),
    })).toThrow(InvariantError)
    session.append('schedule/change', {
      version: 1,
      operation: 'dispatch',
      id: ScheduleId('schedule-every'),
      acceptedAt: '2026-08-05T12:17:34.000Z',
    })
    expect(session.snapshotEvents()).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('rejects a malformed existing owned stream during companion setup', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    ctx.sessions.create(SessionId('schedule-invalid-seed'), {
      seed: [event({ version: 9, operation: 'delete', id: 'schedule-1' }, SessionSeq(0))],
    })
    await expect(ctx.plugin(scheduleInvariant).then(() => undefined)).rejects.toThrow(InvariantError)
    await ctx.fiber.dispose()
  })

  it('rejects a malformed seeded session created after companion setup', async () => {
    const { ctx } = await harness()
    const id = SessionId('schedule-invalid-future-seed')
    expect(() => ctx.sessions.create(id, {
      seed: [event({ version: 9, operation: 'delete', id: 'schedule-1' }, SessionSeq(0))],
    })).toThrow(InvariantError)
    expect(ctx.sessions.get(id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('ignores inherited Schedule events before a fork seed boundary', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    const child = ctx.sessions.create(SessionId('schedule-fork'), {
      seed: [event({ version: 9, operation: 'delete', id: 'parent' }, SessionSeq(0))],
      inheritedEventCount: SessionLogOffset(1),
      meta: { parentSession: SessionId('parent'), isSeeded: true },
    })
    const fiber = await ctx.plugin(scheduleInvariant)
    child.append('schedule/change', create('child'))
    expect(child.snapshotEvents().at(-1)?.data).toMatchObject({ operation: 'create' })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
