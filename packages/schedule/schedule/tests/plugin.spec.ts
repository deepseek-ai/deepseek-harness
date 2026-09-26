import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { gatedScheduleBackend, harness, agentFor } from './harness.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { scheduleDomain } from '../src/storage.ts'
import { createAfterScheduleRecord, createAtScheduleRecord, createEveryScheduleRecord, ScheduleId } from '../src/domain.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00Z')) })
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.useRealTimers()
})
async function setup() { const test = await harness(); tests.push(test); return test }
/** Build one seeded historical Schedule event, including deliberately unreadable payloads. */
function scheduleEvent(data: unknown, seq: number): SessionEvent {
  return { type: 'schedule/change', seq: SessionSeq(seq), time: Date.now(), data } as SessionEvent
}

describe('shared Schedule management', () => {
  it('initializes a new task with empty known delivery history', async () => {
    const { service, pool } = await setup()
    const sessionId = SessionId('new-history')
    const record = await service.create(sessionId, { prompt: 'Later', after_seconds: 60, title: 'Later' })
    expect(pool.media.get('schedule')!.tables.get('tasks')!.get(record.id)).toEqual({
      record, sessionId, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
    })
  })

  it('returns an empty catalog when the Host has no active reminders', async () => {
    const { service } = await setup()
    expect(await service.catalog()).toEqual([])
  })

  it('ignores the disposal of an Agent it never attached', async () => {
    const { ctx, service } = await setup()
    const sessionId = SessionId('unattached-disposal')
    await service.create(sessionId, { prompt: 'later', after_seconds: 60, title: 'Later' })
    // An Agent the plugin never attached has no detacher, so its disposal returns
    // from the listener without one and leaves the stored task alone.
    ctx.emit('agent/disposed', { agent: agentFor(ctx, 'never-attached') })
    expect((await service.catalog()).map(entry => entry.title)).toEqual(['Later'])
  })

  it('reports a Session its active reminders and deletes them on a stop request', async () => {
    const { ctx, service, fiber } = await setup()
    const sessionId = SessionId('archive-admission')
    const listeners = (event: 'workspace/session-activity' | 'workspace/session-stop') =>
      ctx.events._hooks[event]?.length ?? 0
    const delegated = vi.fn(async () => [{ kind: 'turn' } as const])
    const ask = (next?: typeof delegated) =>
      ctx.waterfall('workspace/session-activity', { sessionId }, next ?? (() => Promise.resolve([])))
    // A Session without a Host task reports nothing of its own and still delegates.
    expect(await ask(delegated)).toEqual([{ kind: 'turn' }])
    expect(delegated).toHaveBeenCalledTimes(1)
    const created = await service.create(sessionId, {
      prompt: 'check the build', after_seconds: 3_600, title: 'Check the build',
    })
    // The armed row is the reason to refuse the archive, and it names what must stop.
    expect(await ask()).toEqual([{ kind: 'schedule', items: [{ id: created.id, label: 'Check the build' }] }])
    expect(await ctx.waterfall(
      'workspace/session-activity', { sessionId: SessionId('archive-cold') }, () => Promise.resolve([]),
    )).toEqual([])
    // A stop request deletes the armed rows, so a second one has nothing left to stop.
    await ctx.parallel('workspace/session-stop', { sessionId })
    expect(await service.catalog()).toEqual([])
    await ctx.parallel('workspace/session-stop', { sessionId })
    expect(await service.catalog()).toEqual([])
    // Disposal withdraws both listeners with the plugin.
    const armedActivity = listeners('workspace/session-activity')
    const armedStop = listeners('workspace/session-stop')
    await fiber.dispose()
    expect(listeners('workspace/session-activity')).toBe(armedActivity - 1)
    expect(listeners('workspace/session-stop')).toBe(armedStop - 1)
    expect(await ask(delegated)).toEqual([{ kind: 'turn' }])
  })

  it('stops a Session whose create write is still in flight', async () => {
    // Real timers: the test observes that the stop has not settled while the
    // create holds the queue, which a fake clock cannot express.
    vi.useRealTimers()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let gated = false
    const pool = new MemoryMediaPool()
    // Hold the first stored row open so the stop request lands while the create
    // that owns it still holds the only queue slot.
    const backend = gatedScheduleBackend(pool, {
      putRecord: async (table) => {
        if (table !== 'tasks' || gated) return
        gated = true
        entered.resolve(undefined)
        await release.promise
      },
    })
    const test = await harness({ pool, backend })
    tests.push(test)
    const { ctx, service } = test
    const sessionId = SessionId('stop-while-creating')
    const creating = service.create(sessionId, {
      prompt: 'check the build', after_seconds: 60, title: 'Check the build',
    })
    await entered.promise
    const stopping = ctx.parallel('workspace/session-stop', { sessionId })
    let settled = false
    void stopping.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 25))
    // A stop that enumerated outside the queue has already returned, having read
    // the table before the row it must delete was committed.
    expect(settled).toBe(false)
    release.resolve(undefined)
    await creating
    await stopping
    // The stop joined the create's queue slot, so it saw the committed row and
    // removed it: nothing stays armed to fire after an unarchive.
    expect(await service.list({ sessionId })).toEqual([])
    expect(await service.catalog()).toEqual([])
  })

  it('notifies observers when a stop removes part of the set before a delete fails', async () => {
    const pool = new MemoryMediaPool()
    let deletes = 0
    // The first row lands durably; the second row's write rejects.
    const backend = gatedScheduleBackend(pool, {
      deleteRecord: async (table) => {
        deletes += 1
        if (table === 'tasks' && deletes === 2) throw new Error('injected delete failure')
      },
    })
    const test = await harness({ pool, backend })
    tests.push(test)
    const { ctx, service } = test
    const sessionId = SessionId('stop-partial')
    await service.create(sessionId, { prompt: 'first', after_seconds: 60, title: 'First' })
    await service.create(sessionId, { prompt: 'second', after_seconds: 60, title: 'Second' })
    const changed = vi.fn()
    ctx.on('schedule/changed', changed)
    // The first row is durably gone, so observers must hear about it even though
    // the second delete failed, and the caller must still receive that failure.
    const failure = await ctx.parallel('workspace/session-stop', { sessionId })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(changed).toHaveBeenCalled()
    expect((await service.catalog()).map(entry => entry.title)).toEqual(['Second'])
  })

  it('reports a stop failure whose rejection reason is not an Error', async () => {
    const pool = new MemoryMediaPool()
    const backend = gatedScheduleBackend(pool, {
      // A reason that is not an Error is still a rejection the caller must see.
      deleteRecord: async (table) => {
        if (table === 'tasks') throw undefined
      },
    })
    const test = await harness({ pool, backend })
    tests.push(test)
    const { ctx, service } = test
    const sessionId = SessionId('stop-undefinable')
    await service.create(sessionId, { prompt: 'first', after_seconds: 60, title: 'First' })
    const changed = vi.fn()
    ctx.on('schedule/changed', changed)
    const failure = await ctx.parallel('workspace/session-stop', { sessionId })
      .then(() => undefined, (error: unknown) => error)
    // Nothing landed, and a reason that carries no Error must not read as success
    // with the reminder still armed.
    expect(failure).toBeInstanceOf(AggregateError)
    expect(changed).not.toHaveBeenCalled()
    expect((await service.catalog()).map(entry => entry.title)).toEqual(['First'])
  })

  it('attempts every row and notifies nothing when the first stop delete fails', async () => {
    const pool = new MemoryMediaPool()
    let deletes = 0
    const backend = gatedScheduleBackend(pool, {
      deleteRecord: async (table) => {
        if (table !== 'tasks') return
        deletes += 1
        throw new Error('injected delete failure')
      },
    })
    const test = await harness({ pool, backend })
    tests.push(test)
    const { ctx, service } = test
    const sessionId = SessionId('stop-failed')
    await service.create(sessionId, { prompt: 'first', after_seconds: 60, title: 'First' })
    await service.create(sessionId, { prompt: 'second', after_seconds: 60, title: 'Second' })
    const changed = vi.fn()
    ctx.on('schedule/changed', changed)
    const failure = await ctx.parallel('workspace/session-stop', { sessionId })
      .then(() => undefined, (error: unknown) => error)
    // Nothing landed, so nothing is announced; every row was still attempted,
    // because a row this stop skipped would stay armed in an archived Session.
    expect(failure).toBeInstanceOf(AggregateError)
    expect(deletes).toBe(2)
    expect(changed).not.toHaveBeenCalled()
    // The catalog sorts by target then id, so compare the surviving set, not its order.
    expect((await service.catalog()).map(entry => entry.title).sort()).toEqual(['First', 'Second'])
  })

  it('catalogs persisted reminders across cold Sessions in target and identity order', async () => {
    const firstSession = SessionId('cold-first')
    const secondSession = SessionId('cold-second')
    const recurring = createEveryScheduleRecord(ScheduleId('schedule-z'), 'Repeat', 300, Date.now(), 'Repeat')
    const delayed = createAfterScheduleRecord(ScheduleId('schedule-first'), 'Soon', 60, Date.now(), 'Soon')
    const absolute = createAtScheduleRecord(
      ScheduleId('schedule-a'), 'At target', '2026-09-16T00:05:00Z', Date.now(), 'At target',
    )
    const test = await harness({ beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(recurring.id, { sessionId: firstSession, record: recurring, status: 'active' })
      await domain.table('tasks').put(delayed.id, { sessionId: secondSession, record: delayed, status: 'active' })
      await domain.table('tasks').put(absolute.id, { sessionId: secondSession, record: absolute, status: 'active' })
      await domain.close()
    } })
    tests.push(test)
    const { ctx, service, resolve, flush } = test
    expect(ctx.sessions.get(firstSession)).toBeUndefined()
    expect(ctx.sessions.get(secondSession)).toBeUndefined()
    const readSession = vi.spyOn(ctx.sessions, 'get')
    const createSession = vi.spyOn(ctx.sessions, 'create')
    const expected = [
      { ...delayed, sessionId: secondSession, status: 'active' },
      { ...absolute, sessionId: secondSession, status: 'active' },
      { ...recurring, sessionId: firstSession, status: 'active' },
    ]
    expect(await service.catalog()).toEqual(expected)
    expect(await service.catalog()).toEqual(expected)
    expect(readSession).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(ctx.agents.roots()).toEqual([])
    expect(ctx.sessions.get(firstSession)).toBeUndefined()
    expect(ctx.sessions.get(secondSession)).toBeUndefined()
  })

  it('lists and deletes a cold Session task without resolving an Agent', async () => {
    const { service, resolve } = await setup()
    const sessionId = SessionId('cold')
    const record = await service.create(sessionId, { prompt: 'Later', after_seconds: 60, title: 'Later' })
    expect(await service.list({ sessionId })).toEqual([record])
    expect(await service.catalog()).toEqual([{ ...record, sessionId, status: 'active' }])
    expect(resolve).not.toHaveBeenCalled()
    expect(await service.delete({ sessionId, id: record.id })).toEqual({ id: record.id, deleted: true })
    expect(await service.list({ sessionId })).toEqual([])
    expect(await service.catalog()).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not delete a task bound to another Session', async () => {
    const { service } = await setup()
    const owner = SessionId('owner')
    const record = await service.create(owner, { prompt: 'Private', every_seconds: 300, title: 'Private' })
    expect(await service.delete({ sessionId: SessionId('other'), id: record.id }))
      .toEqual({ id: record.id, deleted: false, code: 'schedule_not_found' })
    expect(await service.list({ sessionId: owner })).toEqual([record])
    expect(await service.catalog()).toEqual([{ ...record, sessionId: owner, status: 'active' }])
  })

  it('allocates different identities across Sessions and rejects conflicting selectors', async () => {
    const { service } = await setup()
    const a = await service.create(SessionId('a'), { prompt: 'A', after_seconds: 1, title: 'A' })
    const b = await service.create(SessionId('b'), { prompt: 'B', at: '2026-09-17T00:00:00Z', title: 'B' })
    expect(a.id).not.toBe(b.id)
    await expect(service.create(SessionId('a'), {
      prompt: 'invalid', at: '2026-09-17T00:00:00Z', after_seconds: 1, title: 'invalid',
    }))
      .rejects.toThrow('Exactly one')
    expect(await service.delete({ sessionId: SessionId('a'), id: ScheduleId('missing') }))
      .toMatchObject({ deleted: false })
  })

  it.each([
    { after_seconds: 60 }, { at: '2026-09-17T00:00:00Z' }, { every_seconds: 300 },
  ])('rejects daily combined with another selector at the shared service (%j)', async (selector) => {
    const { service, resolve } = await setup()
    const sessionId = SessionId('daily-conflict')
    await expect(service.create(sessionId, {
      prompt: 'Conflicting rule', title: 'Conflicting rule',
      daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' }, ...selector,
    })).rejects.toThrow('Exactly one')
    expect(await service.catalog()).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each([
    { after_seconds: 60 }, { at: '2026-09-17T00:00:00Z' }, { every_seconds: 300 },
    { daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } },
  ])('rejects weekly combined with another selector at the shared service (%j)', async (selector) => {
    const { service, resolve } = await setup()
    const sessionId = SessionId('weekly-conflict')
    await expect(service.create(sessionId, {
      prompt: 'Conflicting rule', title: 'Conflicting rule',
      weekly: { time: '09:00:00', time_zone: 'Asia/Shanghai', weekdays: [1, 3] },
      ...selector,
    })).rejects.toThrow('Exactly one')
    expect(await service.catalog()).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('notifies only successful durable changes and retains state after a failed delete', async () => {
    const { service, ctx, pool } = await setup()
    const changed = vi.fn()
    ctx.on('schedule/changed', changed)
    const sessionId = SessionId('stored')
    const record = await service.create(sessionId, { prompt: 'Keep', after_seconds: 60, title: 'Keep' })
    expect(changed).toHaveBeenCalledTimes(1)
    pool.failNextWrites = 1
    await expect(service.delete({ sessionId, id: record.id })).rejects.toThrow('injected write failure')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(await service.list({ sessionId })).toEqual([record])
  })

  it('contains a throwing change listener but still persists the task and arms the timer', async () => {
    const { service, ctx, pool } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.on('schedule/changed', () => { throw new Error('observer failed') })
    const sessionId = SessionId('throwing-listener')
    const record = await service.create(sessionId, {
      prompt: 'Still stored', after_seconds: 60, title: 'Still stored',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await service.list({ sessionId })).toEqual([record])
    expect(pool.media.get('schedule')!.tables.get('tasks')!.get(record.id))
      .toEqual({ record, sessionId, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } })
    expect(vi.getTimerCount()).toBe(1)
    expect(warn).toHaveBeenCalledWith('schedule: schedule/changed listener failed: Error: observer failed')
  })
})


describe('retained Schedule delivery', () => {
  it('keeps ended tasks through restart without redelivery and deletes only within their Session binding', async () => {
    const first = await setup()
    const sessionId = SessionId('retained')
    const agent = agentFor(first.ctx, sessionId)
    const followup = vi.spyOn(agent, 'followup')
    first.resolve.mockResolvedValue({ agent })
    const record = await first.service.create(sessionId, { prompt: 'Retain me', after_seconds: 1, title: 'Retain me' })
    await vi.advanceTimersByTimeAsync(1000)
    const catalog = await first.service.catalog()
    expect(catalog).toEqual([{
      ...record, sessionId, status: 'inactive',
      lastDelivery: {
        scheduledAt: record.scheduledAt, deliveredAt: '2026-09-16T00:00:01.000Z',
        messageId: followup.mock.calls[0]![0].id,
      },
    }])
    expect(await first.service.list({ sessionId })).toEqual([])
    await first.ctx.fiber.dispose()
    const second = await harness({ pool: first.pool }); tests.push(second)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(await second.service.catalog()).toEqual(catalog)
    expect(await second.service.list({ sessionId })).toEqual([])
    expect(second.resolve).not.toHaveBeenCalled()
    expect(second.flush).not.toHaveBeenCalled()
    expect(await second.service.delete({ sessionId: SessionId('other'), id: record.id }))
      .toEqual({ id: record.id, deleted: false, code: 'schedule_not_found' })
    expect(await second.service.catalog()).toEqual(catalog)
    const delivered = await second.service.history({ sessionId, id: record.id, limit: 100 })
    expect(delivered).toMatchObject({ records: [{ prompt: 'Retain me' }] })
    expect(await second.service.delete({ sessionId, id: record.id })).toEqual({ id: record.id, deleted: true })
    expect(await second.service.catalog()).toEqual([])
    expect(await second.service.history({ sessionId, id: record.id, limit: 100 }))
      .toEqual({ id: record.id, code: 'schedule_not_found' })
    await second.ctx.fiber.dispose()
    const third = await harness({ pool: first.pool }); tests.push(third)
    expect(await third.service.catalog()).toEqual([])
    expect(await third.service.list({ sessionId })).toEqual([])
    expect(await third.service.history({ sessionId, id: record.id, limit: 100 }))
      .toEqual({ id: record.id, code: 'schedule_not_found' })
    expect(third.resolve).not.toHaveBeenCalled()
  })

  it.each(['flush', 'write'] as const)('keeps an active task without a receipt or change notification after %s failure', async (failure) => {
    const test = await setup()
    const sessionId = SessionId('failed-delivery')
    const agent = agentFor(test.ctx, sessionId)
    const followup = vi.spyOn(agent, 'followup')
    test.resolve.mockResolvedValue({ agent })
    const record = await test.service.create(sessionId, { prompt: 'Keep pending', after_seconds: 1, title: 'Keep pending' })
    const changed = vi.fn()
    test.ctx.on('schedule/changed', changed)
    if (failure === 'flush') test.flush.mockRejectedValueOnce(new Error('flush failed'))
    else test.pool.failNextWrites = 1
    await vi.advanceTimersByTimeAsync(1000)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(test.flush).toHaveBeenCalledTimes(1)
    expect(changed).not.toHaveBeenCalled()
    expect(await test.service.catalog()).toEqual([{ ...record, sessionId, status: 'active' }])
    expect(await test.service.list({ sessionId })).toEqual([record])
    expect(test.pool.media.get('schedule')!.tables.get('tasks')!.get(record.id))
      .toEqual({ record, sessionId, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } })
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(followup).toHaveBeenCalledTimes(1)
  })
})


describe('Schedule activation and shutdown', () => {
  it('reads pre-existing bindings and retains delivery receipts for one-shot and recurring tasks', async () => {
    const sessionId = SessionId('restored')
    const pending = createAfterScheduleRecord(ScheduleId('persisted'), 'Restored', 1, Date.now(), 'Restored')
    const test = await harness({ beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(pending.id, { sessionId, record: pending, status: 'active' })
      await domain.close()
    } })
    tests.push(test)
    const agent = agentFor(test.ctx, 'restored')
    const followup = vi.spyOn(agent, 'followup')
    test.resolve.mockResolvedValue({ agent })
    await test.service.create(sessionId, { prompt: 'Recurring', every_seconds: 300, title: 'Recurring' })
    const changed = vi.fn()
    test.ctx.on('schedule/changed', changed)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(followup).toHaveBeenCalledTimes(2)
    const remaining = await test.service.list({ sessionId })
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ kind: 'every', scheduledAt: '2026-09-16T00:10:00.000Z' })
    expect(await test.service.catalog()).toEqual([
      { ...pending, sessionId, status: 'inactive', lastDelivery: {
        scheduledAt: pending.scheduledAt, deliveredAt: '2026-09-16T00:00:01.000Z',
        messageId: followup.mock.calls[0]![0].id,
      } },
      { ...remaining[0], sessionId, status: 'active', lastDelivery: {
        scheduledAt: '2026-09-16T00:05:00.000Z', deliveredAt: '2026-09-16T00:05:00.000Z',
        messageId: followup.mock.calls[1]![0].id,
      } },
    ])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('rejects a persisted task whose table key disagrees with its record identity', async () => {
    let cleanup: (() => Promise<void>) | undefined
    try {
      await expect(harness({ beforeService: async (ctx, facility) => {
        cleanup = () => ctx.fiber.dispose()
        const domain = await facility.open(scheduleDomain)
        const record = createAfterScheduleRecord(ScheduleId('actual'), 'Mismatch', 60, Date.now(), 'Mismatch')
        await domain.table('tasks').put(ScheduleId('different'), { sessionId: SessionId('bound'), record, status: 'active' })
        await domain.close()
      } }).then(() => 'Schedule activated')).rejects.toThrow('differs from record id')
    } finally {
      await cleanup?.()
    }
  })

  it('keeps the key mismatch diagnostic when closing the mismatched domain fails', async () => {
    let cleanup: (() => Promise<void>) | undefined
    let warning: MockInstance | undefined
    try {
      await expect(harness({ beforeService: async (ctx, facility) => {
        cleanup = () => ctx.fiber.dispose()
        const domain = await facility.open(scheduleDomain)
        const record = createAfterScheduleRecord(ScheduleId('actual'), 'Mismatch', 60, Date.now(), 'Mismatch')
        await domain.table('tasks').put(ScheduleId('different'), { sessionId: SessionId('bound'), record, status: 'active' })
        await domain.close()
        // Installed after seeding: opening the seeded row already warns through the
        // storage-domain change listener, and only the Schedule warning is under test.
        warning = vi.spyOn(ctx.logger, 'warn')
        const openDomain = facility.open.bind(facility)
        // The reopening domain releases its backend unit only after the mismatch throw,
        // so a rejected close must not replace the mismatch that Service.init reports.
        facility.open = async (definition: Parameters<typeof openDomain>[0]) => {
          const opened = await openDomain(definition)
          // Same object through the prototype chain, with only close replaced, so
          // the reopening domain keeps the table access the key check needs.
          const reopened = Object.create(opened) as typeof opened
          reopened.close = async (): Promise<void> => { throw new Error('fixture close failure') }
          return reopened
        }
      } }).then(() => 'Schedule activated')).rejects.toThrow('differs from record id')
    } finally {
      await cleanup?.()
    }
    expect(warning).toHaveBeenCalledTimes(1)
    const warnings = (warning?.mock.calls ?? []).map(call => String(call[0]))
    expect(warnings).toEqual([expect.stringContaining('fixture close failure')])
  })

  it('attaches existing roots once and leaves owned children without a new registration', async () => {
    const test = await harness({ beforeService: async (ctx) => {
      const parent = agentFor(ctx, 'existing-root')
      ctx.effect(() => ctx.agents.enter(parent, undefined))
    } })
    tests.push(test)
    const parent = test.ctx.agents.get(SessionId('existing-root'))!
    expect(test.ctx.tools.get('schedule_create', parent)).toBeDefined()
    await agentEvents(test.ctx, parent).serial('agent/created', { source: 'startup' })
    const child = agentFor(test.ctx, 'owned-child')
    test.ctx.effect(() => test.ctx.agents.enter(child, parent))
    await agentEvents(test.ctx, child).serial('agent/created', { source: 'startup' })
    expect(test.ctx.agents.roots()).toEqual([parent])
    expect(test.ctx.tools.get('schedule_create', parent)).toBeDefined()
  })

  it('registers tools for a new root and rejects management after service teardown', async () => {
    const test = await setup()
    const agent = agentFor(test.ctx, 'new-root')
    await test.ctx.agents.register(agent)
    expect(test.ctx.tools.get('schedule_create', agent)).toBeDefined()
    await test.ctx.fiber.dispose()
    await expect(test.service.delete({ sessionId: agent.session.id, id: ScheduleId('gone') }))
      .rejects.toThrow('Schedule service is stopping')
  })

  it('releases a disposed root Agent from the plugin scope', async () => {
    const test = await setup()
    const baseline = test.fiber.getEffects().length
    const agent = agentFor(test.ctx, 'released-root')
    const disposeAgent = await test.ctx.agents.register(agent)
    expect(test.fiber.getEffects().length).toBe(baseline + 1)
    expect(test.ctx.tools.get('schedule_create', agent)).toBeDefined()
    await disposeAgent()
    expect(test.fiber.getEffects().length).toBe(baseline)
    expect(test.ctx.tools.get('schedule_create', agent)).toBeUndefined()
    await test.ctx.fiber.dispose()
    expect(test.fiber.getEffects()).toEqual([])
  })

  it('rejects a missing creation selector at the shared service entry', async () => {
    const test = await setup()
    await expect(test.service.create(SessionId('caller'), { prompt: 'Missing schedule', title: 'Missing schedule' }))
      .rejects.toMatchObject({ code: 'invalid_selector', message: 'Exactly one reminder selector is required.' })
    await expect(test.service.create(SessionId('caller'), {
      prompt: 'Conflicting selectors', title: 'Conflicting selectors', after_seconds: 60, at: new Date(Date.now() + 60_000).toISOString(),
    })).rejects.toMatchObject({ code: 'invalid_selector', message: 'Exactly one reminder selector is required.' })
  })

  it('warns for loaded active legacy reminders but not completed history', async () => {
    const test = await setup()
    const warning = vi.spyOn(test.ctx.logger, 'warn')
    const record = createAfterScheduleRecord(ScheduleId('legacy'), 'Old task', 60, Date.now(), 'Old task')
    const creation = { type: 'schedule/change' as const, seq: SessionSeq(0), time: Date.now(),
      data: { version: 1 as const, operation: 'create' as const, schedule: record } }
    test.ctx.sessions.create(SessionId('legacy-active'), { seed: [creation] })
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('recreate active reminders'))
    warning.mockClear()
    test.ctx.sessions.create(SessionId('legacy-completed'), { seed: [creation, {
      type: 'schedule/change', seq: SessionSeq(1), time: Date.now(),
      data: { version: 1, operation: 'dispatch', id: record.id },
    }] })
    expect(warning).not.toHaveBeenCalled()
    expect(await test.service.list({ sessionId: SessionId('legacy-active') })).toEqual([])
  })

  it('warns that a readable legacy stream must be recreated', async () => {
    const test = await setup()
    const warning = vi.spyOn(test.ctx.logger, 'warn')
    const sessionId = SessionId('legacy-readable')
    const record = createAfterScheduleRecord(ScheduleId('legacy-readable-task'), 'Old task', 60, Date.now(), 'Old task')
    test.ctx.sessions.create(sessionId, {
      seed: [scheduleEvent({ version: 1, operation: 'create', schedule: record }, 0)],
    })
    expect(warning).toHaveBeenCalledWith(
      `schedule: Session "${sessionId}" contains legacy reminders; recreate active reminders with schedule_create.`,
    )
    expect(await test.service.list({ sessionId })).toEqual([])
  })
})
