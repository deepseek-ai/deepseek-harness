import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { agentFor, boundTask, gatedScheduleBackend, harness, recordOf, seededTask, seedTasks } from './harness.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { scheduleDomain } from '../src/storage.ts'
import { createRRuleScheduleRecord } from '../src/domain.ts'
import type { ScheduleCatalogEntry } from '../src/types.ts'
import { createAfterScheduleRecord, createAtScheduleRecord, createEveryScheduleRecord, ScheduleId } from '../src/domain.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const tests: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)) })
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.useRealTimers()
})
async function setup() { const test = await harness(); tests.push(test); return test }
/** Stored value of a task that the shared management API created at the test clock and never delivered. */
function createdValue(sessionId: SessionId, rule: ScheduleCatalogEntry) {
  return {
    record: recordOf(rule), target: { kind: 'session', sessionId }, involvedSessionIds: [sessionId],
    status: 'active', createdAt: NOW, updatedAt: NOW,
    deliveryHistory: { records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
  }
}
function storedValue(pool: MemoryMediaPool, id: string) {
  return pool.media.get(scheduleDomain.name)?.tables.get('tasks')?.get(id)
}

describe('shared Schedule management', () => {
  it('validates unloaded targets and refuses new destinations without a creation provider', async () => {
    const test = await harness({ sessionController: false })
    tests.push(test)
    const request = { title: 'Independent', prompt: 'Check later', timing: { kind: 'after', after_seconds: 60 } } as const
    test.stat.mockResolvedValueOnce(undefined)
    await expect(test.service.create({ ...request, target: { kind: 'session', sessionId: SessionId('unloaded') } }))
      .rejects.toThrow('does not exist')
    for (const target of [undefined, { kind: 'new_once' }, { kind: 'new' }] as const) {
      await expect(test.service.create({ ...request, ...(target === undefined ? {} : { target }) }))
        .rejects.toMatchObject({ code: 'invalid_rule', message: expect.stringContaining('choose an existing Session target') as string })
    }
    expect(await test.service.catalog()).toEqual([])
    const created = await test.service.create({ ...request, target: { kind: 'session', sessionId: SessionId('existing') } })
    expect(created.target).toEqual({ kind: 'session', sessionId: SessionId('existing') })
  })

  it('delivers overdue tasks when the Web controller mounts and remounts', async () => {
    const test = await harness({ sessionController: false })
    tests.push(test)
    const agent = agentFor(test.ctx)
    await test.ctx.agents.register(agent)
    test.resolve.mockResolvedValue({ agent })
    const warn = vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
    const controller = {
      apply(ctx: typeof test.ctx) {
        ctx.provide('sessionController', { resolveAgent: test.resolve } as never)
      },
    }
    try {
      await test.service.create({ prompt: 'First', title: 'First', timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'session', sessionId: agent.session.id } }, agent.session.id)
      await vi.advanceTimersByTimeAsync(2000)
      expect(agent.followup).not.toHaveBeenCalled()
      const first = await test.ctx.plugin(controller)
      await vi.advanceTimersByTimeAsync(0)
      expect(agent.followup).toHaveBeenCalledOnce()
      expect((await test.service.list({ active: true })).items).toEqual([])

      await first.dispose()
      await test.service.create({ prompt: 'Second', title: 'Second', timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'session', sessionId: agent.session.id } }, agent.session.id)
      await vi.advanceTimersByTimeAsync(2000)
      expect(agent.followup).toHaveBeenCalledOnce()
      await test.ctx.plugin(controller)
      await vi.advanceTimersByTimeAsync(0)
      expect(agent.followup).toHaveBeenCalledTimes(2)
      expect((await test.service.list({ active: true })).items).toEqual([])
    } finally { warn.mockRestore() }
  })

  it('does not resume delivery after Schedule unload when the Web controller arrives', async () => {
    const test = await harness({ sessionController: false })
    tests.push(test)
    const agent = agentFor(test.ctx)
    await test.ctx.agents.register(agent)
    test.resolve.mockResolvedValue({ agent })
    await test.service.create({ prompt: 'Stopped', title: 'Stopped', timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'session', sessionId: agent.session.id } }, agent.session.id)
    await test.fiber.dispose()
    await test.ctx.plugin({
      apply(ctx: typeof test.ctx) {
        ctx.provide('sessionController', { resolveAgent: test.resolve } as never)
      },
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.resolve).not.toHaveBeenCalled()
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('keeps an active task when the injected Web controller refuses restoration', async () => {
    const test = await setup()
    const warn = vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
    test.resolve.mockResolvedValueOnce({ error: new Error('Web restoration unavailable') } as never)
    try {
      const sessionId = SessionId('refused-web-restoration')
      const record = await test.service.create({ prompt: 'Keep', title: 'Keep', timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'session', sessionId } }, sessionId)
      await vi.advanceTimersByTimeAsync(1000)
      expect(test.resolve).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Web restoration unavailable'))
      expect((await test.service.list({ active: true })).items.map(task => task.id)).toEqual([record.id])
    } finally { warn.mockRestore() }
  })

  it('initializes a new task with empty known delivery history', async () => {
    const { service, pool } = await setup()
    const sessionId = SessionId('new-history')
    const record = await service.create({ prompt: 'Later', title: 'Later', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    expect(storedValue(pool, record.id)).toEqual(createdValue(sessionId, record))
  })

  it('returns an empty catalog when the Host has no active reminders', async () => {
    const { service } = await setup()
    expect(await service.catalog()).toEqual([])
  })

  it.each(['session', 'new_once'] as const)('reports and stops active reminders targeting an existing %s Session', async (kind) => {
    const { ctx, service, fiber, resolve, createSession } = await setup()
    let sessionId = SessionId('archive-admission')
    const listeners = (event: 'workspace/session-activity' | 'workspace/session-stop') =>
      ctx.events._hooks[event]?.length ?? 0
    const delegated = vi.fn(async () => [{ kind: 'turn' } as const])
    const ask = (next?: typeof delegated) =>
      ctx.waterfall('workspace/session-activity', { sessionId }, next ?? (() => Promise.resolve([])))
    // A Session without a Host task reports nothing of its own and still delegates.
    expect(await ask(delegated)).toEqual([{ kind: 'turn' }])
    expect(delegated).toHaveBeenCalledTimes(1)
    const created = await service.create({ prompt: 'check the build', title: 'Check the build',
      timing: { kind: 'after', after_seconds: 3_600 }, target: kind === 'session' ? { kind, sessionId } : { kind },
    }, sessionId)
    if (created.target.kind === 'new') throw new Error('expected a stable target')
    sessionId = created.target.sessionId
    ctx.sessions.create(sessionId)
    expect(created.target.kind).toBe(kind)
    // The armed row is the reason to refuse the archive, and it names what must stop.
    expect(await ask()).toEqual([{ kind: 'schedule', items: [{ id: created.id, label: 'Check the build' }] }])
    expect(await ctx.waterfall(
      'workspace/session-activity', { sessionId: SessionId('archive-cold') }, () => Promise.resolve([]),
    )).toEqual([])
    // A stop request deletes the armed rows, so a second one has nothing left to stop.
    await ctx.parallel('workspace/session-stop', { sessionId })
    expect(await service.catalog()).toEqual([])
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(resolve).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
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
    const creating = service.create({ prompt: 'check the build', title: 'Check the build', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
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
    expect((await service.list({ active: true })).items).toEqual([])
    expect(await service.catalog()).toEqual([])
  })

  it('announces a stop failure so observers read the catalog again', async () => {
    const pool = new MemoryMediaPool()
    let batches = 0
    const backend = gatedScheduleBackend(pool, {
      deleteRecords: async (table) => {
        if (table !== 'tasks') return
        batches += 1
        throw new Error('injected batch failure')
      },
    })
    const test = await harness({ pool, backend })
    tests.push(test)
    const { ctx, service } = test
    const sessionId = SessionId('stop-partial')
    await service.create({ prompt: 'first', title: 'First', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    await service.create({ prompt: 'second', title: 'Second', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    const changed = vi.fn()
    ctx.on('schedule/changed', changed)
    const failure = await ctx.parallel('workspace/session-stop', { sessionId })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(batches).toBe(1)
    // The batch may have landed some rows under unknown-state, so the service
    // announces the change before the rejection reaches the caller.
    expect(changed).toHaveBeenCalledTimes(1)
    expect((await service.catalog()).map(entry => entry.title).sort()).toEqual(['First', 'Second'])
  })

  it('reports a stop failure whose rejection reason is not an Error', async () => {
    const pool = new MemoryMediaPool()
    let batches = 0
    const backend = gatedScheduleBackend(pool, {
      // A reason that is not an Error is still a rejection the caller must see.
      deleteRecords: async (table) => {
        if (table !== 'tasks') return
        batches += 1
        throw undefined
      },
    })
    const test = await harness({ pool, backend })
    tests.push(test)
    const { ctx, service } = test
    const sessionId = SessionId('stop-undefinable')
    await service.create({ prompt: 'first', title: 'First', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    const changed = vi.fn()
    ctx.on('schedule/changed', changed)
    const failure = await ctx.parallel('workspace/session-stop', { sessionId })
      .then(() => undefined, (error: unknown) => error)
    // Nothing landed, and a reason that carries no Error must not read as success
    // with the reminder still armed.
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map(String).some(text => text.includes('schedule stop failed'))).toBe(true)
    expect(batches).toBe(1)
    expect(changed).toHaveBeenCalledTimes(1)
    expect((await service.catalog()).map(entry => entry.title)).toEqual(['First'])
  })

  it('removes the whole stop set in one batch write', async () => {
    const pool = new MemoryMediaPool()
    const batches: string[][] = []
    const backend = gatedScheduleBackend(pool, {
      deleteRecords: async (table, keys) => {
        if (table === 'tasks') batches.push([...keys])
      },
    })
    const test = await harness({ pool, backend })
    tests.push(test)
    const { ctx, service } = test
    const sessionId = SessionId('stop-one-batch')
    await service.create({ prompt: 'first', title: 'First', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId } }, sessionId)
    await service.create({ prompt: 'second', title: 'Second', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId } }, sessionId)
    await ctx.parallel('workspace/session-stop', { sessionId })
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
    expect(await service.catalog()).toEqual([])
  })

  it('catalogs persisted reminders across cold Sessions in target and identity order', async () => {
    const firstSession = SessionId('cold-first')
    const secondSession = SessionId('cold-second')
    const recurring = createEveryScheduleRecord(ScheduleId('schedule-z'), 'Repeat', 300, Date.now(), 'Repeat')
    const delayed = createAfterScheduleRecord(ScheduleId('schedule-first'), 'Soon', 60, Date.now(), 'Soon')
    const absolute = createAtScheduleRecord(
      ScheduleId('schedule-a'), 'At target', '2026-09-16T00:05:00Z', Date.now(), 'At target',
    )
    // A task without a Session-bound rule stays out of the Session-bound reads even when it targets a listed Session.
    const rrule = createRRuleScheduleRecord(
      ScheduleId('schedule-0'), 'Standalone', 'Standalone', 'DTSTART:20260916T000100Z\nRRULE:FREQ=DAILY', Date.now(),
    )
    const test = await harness({ beforeService: (_ctx, facility) => seedTasks(facility, [
      boundTask(firstSession, recurring), boundTask(secondSession, delayed), boundTask(secondSession, absolute),
      seededTask(rrule, { kind: 'session', sessionId: firstSession }),
    ]) })
    tests.push(test)
    const { ctx, service, resolve, flush, stat } = test
    expect(ctx.sessions.get(firstSession)).toBeUndefined()
    expect(ctx.sessions.get(secondSession)).toBeUndefined()
    const readSession = vi.spyOn(ctx.sessions, 'get')
    const createSession = vi.spyOn(ctx.sessions, 'create')
    const expected = [rrule, delayed, absolute, recurring]
    expect((await service.catalog()).map(recordOf)).toEqual(expected)
    expect((await service.list({ active: true })).items.map(recordOf)).toEqual(expected)
    expect(readSession).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(ctx.agents.roots()).toEqual([])
    expect(ctx.sessions.get(firstSession)).toBeUndefined()
    expect(ctx.sessions.get(secondSession)).toBeUndefined()
  })

  it('lists and deletes a cold Session task without resolving an Agent', async () => {
    const { service, resolve } = await setup()
    const sessionId = SessionId('cold')
    const record = await service.create({ prompt: 'Later', title: 'Later', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    expect((await service.list({ active: true })).items).toEqual([record])
    expect(await service.catalog()).toEqual([record])
    expect(resolve).not.toHaveBeenCalled()
    expect(await service.edit({ action: 'delete', id: record.id })).toEqual({ id: record.id, deleted: true })
    expect((await service.list({ active: true })).items).toEqual([])
    expect(await service.catalog()).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('deletes a task globally by id regardless of its target Session', async () => {
    const { service } = await setup()
    const record = await service.create({ title: 'Shared', prompt: 'Shared', timing: { kind: 'every', every_seconds: 300 }, target: { kind: 'session', sessionId: SessionId('owner') } })
    expect(await service.edit({ action: 'delete', id: record.id })).toEqual({ id: record.id, deleted: true })
    expect(await service.catalog()).toEqual([])
  })

  it('allocates different identities across Sessions and rejects conflicting selectors', async () => {
    const { service } = await setup()
    const a = await service.create({ prompt: 'A', title: 'A', timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'session', sessionId: SessionId('a') } }, SessionId('a'))
    const b = await service.create({ prompt: 'B', title: 'B', timing: { kind: 'at', at: '2026-09-17T00:00:00Z' }, target: { kind: 'session', sessionId: SessionId('b') } }, SessionId('b'))
    expect(a.id).not.toBe(b.id)
    await expect(service.create({ prompt: 'invalid', title: 'invalid', timing: { kind: 'at', at: '2026-09-17T00:00:00Z', after_seconds: 1 } as never, target: { kind: 'session', sessionId: SessionId('a') } }, SessionId('a')))
      .rejects.toThrow('timing must contain exactly')
    expect(await service.edit({ action: 'delete', id: ScheduleId('missing') }))
      .toMatchObject({ code: 'schedule_not_found' })
  })

  it.each([
    { kind: 'weekly', selector: { weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1, 5] } }, at: '2026-09-18T09:00:00.000Z' },
    { kind: 'cron', selector: { cron: { expression: '0 9 * * 1-5', time_zone: 'UTC' } }, at: '2026-09-16T09:00:00.000Z' },
  ])('stores a $kind reminder for the Session that creates it', async ({ kind, selector, at }) => {
    const { service } = await setup()
    const sessionId = SessionId('calendar')
    const record = await service.create({ prompt: 'Standup', title: 'Standup', timing: { kind, ...selector } as never, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    expect(record).toMatchObject({ kind, scheduledAt: at })
    expect((await service.list({ active: true })).items).toEqual([record])
  })

  it.each([
    { after_seconds: 60 }, { at: '2026-09-17T00:00:00Z' }, { every_seconds: 300 },
  ])('rejects daily combined with another selector at the shared service (%j)', async (selector) => {
    const { service, resolve } = await setup()
    const sessionId = SessionId('daily-conflict')
    await expect(service.create({ prompt: 'Conflicting rule', title: 'Conflicting rule', timing: { ...selector, kind: 'daily', daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } } as never, target: { kind: 'session', sessionId: sessionId } }, sessionId)).rejects.toThrow('timing must contain exactly')
    expect(await service.catalog()).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each([
    { after_seconds: 60 }, { at: '2026-09-17T00:00:00Z' }, { every_seconds: 300 },
    { daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } },
  ])('rejects weekly combined with another selector at the shared service (%j)', async (selector) => {
    const { service, resolve } = await setup()
    const sessionId = SessionId('weekly-conflict')
    await expect(service.create({ prompt: 'Conflicting rule', title: 'Conflicting rule', timing: { ...selector, kind: 'weekly', weekly: { time: '09:00:00', time_zone: 'Asia/Shanghai', weekdays: [1, 3] } } as never, target: { kind: 'session', sessionId: sessionId } }, sessionId)).rejects.toThrow('timing must contain exactly')
    expect(await service.catalog()).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('notifies only successful durable changes and retains state after a failed delete', async () => {
    const { service, ctx, pool } = await setup()
    const changed = vi.fn()
    ctx.on('schedule/changed', changed)
    const sessionId = SessionId('stored')
    const record = await service.create({ prompt: 'Keep', title: 'Keep', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    expect(changed).toHaveBeenCalledTimes(1)
    pool.failNextWrites = 1
    await expect(service.edit({ action: 'delete', id: record.id })).rejects.toThrow('injected write failure')
    expect(changed).toHaveBeenCalledTimes(1)
    expect((await service.list({ active: true })).items).toEqual([record])
  })

  it('contains a throwing change listener but still persists the task and arms the timer', async () => {
    const { service, ctx, pool } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.on('schedule/changed', () => { throw new Error('observer failed') })
    const sessionId = SessionId('throwing-listener')
    const record = await service.create({ prompt: 'Still stored', title: 'Still stored', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    await vi.advanceTimersByTimeAsync(0)
    expect((await service.list({ active: true })).items).toEqual([record])
    expect(storedValue(pool, record.id)).toEqual(createdValue(sessionId, record))
    expect(vi.getTimerCount()).toBe(1)
    expect(warn).toHaveBeenCalledWith('schedule: schedule/changed listener failed: Error: observer failed')
  })

  it('contains a throwing change listener when a delivered execution finishes and still delivers the next occurrence', async () => {
    const test = await setup()
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    test.ctx.on('schedule/changed', () => { throw new Error('observer failed') })
    const sessionId = SessionId('throwing-finish')
    const agent = agentFor(test.ctx, sessionId)
    test.resolve.mockResolvedValue({ agent })
    await test.service.create({ prompt: 'Recurring', title: 'Recurring', timing: { kind: 'every', every_seconds: 300 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    // The creation, the receipt write, and the end of the target Agent's execution each reach the listener.
    expect(warn.mock.calls).toEqual(Array.from({ length: 3 }, () => ['schedule: schedule/changed listener failed: Error: observer failed']))
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(agent.followup).toHaveBeenCalledTimes(2)
  })
})


describe('retained Schedule delivery', () => {
  it('keeps ended tasks through restart without redelivery and deletes only within their Session binding', async () => {
    const first = await setup()
    const sessionId = SessionId('retained')
    const agent = agentFor(first.ctx, sessionId)
    const followup = vi.spyOn(agent, 'followup')
    first.resolve.mockResolvedValue({ agent })
    const record = await first.service.create({ prompt: 'Retain me', title: 'Retain me', timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    await vi.advanceTimersByTimeAsync(1000)
    const catalog = await first.service.catalog()
    expect(catalog).toMatchObject([{
      ...recordOf(record), target: { kind: 'session', sessionId }, status: 'ended',
      lastDelivery: {
        scheduledAt: record.scheduledAt, deliveredAt: '2026-09-16T00:00:01.000Z',
        messageId: followup.mock.calls[0]![0].id,
      },
    }])
    expect((await first.service.list({ active: true })).items).toEqual([])
    await first.ctx.fiber.dispose()
    const second = await harness({ pool: first.pool }); tests.push(second)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(await second.service.catalog())
      .toEqual(catalog.map(({ deliveryFloorEndsAt: _floor, executionActive: _execution, ...entry }) => entry))
    expect((await second.service.list({ active: true })).items).toEqual([])
    expect(second.resolve).not.toHaveBeenCalled()
    expect(second.flush).not.toHaveBeenCalled()
    const delivered = await second.service.history({ id: record.id, limit: 100 })
    expect(delivered).toMatchObject({ records: [{ prompt: 'Retain me' }] })
    expect(await second.service.edit({ action: 'delete', id: record.id })).toEqual({ id: record.id, deleted: true })
    expect(await second.service.catalog()).toEqual([])
    expect(await second.service.history({ id: record.id, limit: 100 }))
      .toEqual({ id: record.id, code: 'schedule_not_found' })
    await second.ctx.fiber.dispose()
    const third = await harness({ pool: first.pool }); tests.push(third)
    expect(await third.service.catalog()).toEqual([])
    expect((await third.service.list({ active: true })).items).toEqual([])
    expect(await third.service.history({ id: record.id, limit: 100 }))
      .toEqual({ id: record.id, code: 'schedule_not_found' })
    expect(third.resolve).not.toHaveBeenCalled()
  })

  it.each(['flush', 'write'] as const)('keeps an active task without a receipt or change notification after %s failure', async (failure) => {
    const test = await setup()
    const sessionId = SessionId('failed-delivery')
    const agent = agentFor(test.ctx, sessionId)
    const followup = vi.spyOn(agent, 'followup')
    test.resolve.mockResolvedValue({ agent })
    const record = await test.service.create({ prompt: 'Keep pending', title: 'Keep pending', timing: { kind: 'after', after_seconds: 1 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    const changed = vi.fn()
    test.ctx.on('schedule/changed', changed)
    if (failure === 'flush') test.flush.mockRejectedValueOnce(new Error('flush failed'))
    else test.pool.failNextWrites = 1
    await vi.advanceTimersByTimeAsync(1000)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(test.flush).toHaveBeenCalledTimes(1)
    expect(changed).not.toHaveBeenCalled()
    expect(await test.service.catalog()).toEqual([record])
    expect((await test.service.list({ active: true })).items).toEqual([record])
    expect(storedValue(test.pool, record.id)).toEqual(createdValue(sessionId, record))
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(followup).toHaveBeenCalledTimes(1)
  })
})


describe('Schedule activation and shutdown', () => {
  it('reads pre-existing bindings and retains delivery receipts for one-shot and recurring tasks', async () => {
    const sessionId = SessionId('restored')
    const pending = createAfterScheduleRecord(ScheduleId('persisted'), 'Restored', 1, Date.now(), 'Restored')
    const test = await harness({ beforeService: (_ctx, facility) => seedTasks(facility, [boundTask(sessionId, pending)]) })
    tests.push(test)
    const agent = agentFor(test.ctx, 'restored')
    const followup = vi.spyOn(agent, 'followup')
    test.resolve.mockResolvedValue({ agent })
    await test.service.create({ prompt: 'Recurring', title: 'Recurring', timing: { kind: 'every', every_seconds: 300 }, target: { kind: 'session', sessionId: sessionId } }, sessionId)
    const changed = vi.fn()
    test.ctx.on('schedule/changed', changed)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(followup).toHaveBeenCalledTimes(2)
    const remaining = (await test.service.list({ active: true })).items
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ kind: 'every', scheduledAt: '2026-09-16T00:10:00.000Z' })
    expect(await test.service.catalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...pending, target: { kind: 'session', sessionId }, status: 'ended', lastDelivery: {
        scheduledAt: pending.scheduledAt, deliveredAt: '2026-09-16T00:00:01.000Z',
        messageId: followup.mock.calls[0]![0].id, targetSessionId: sessionId,
      } }),
      expect.objectContaining({ ...remaining[0], status: 'active', lastDelivery: {
        scheduledAt: '2026-09-16T00:05:00.000Z', deliveredAt: '2026-09-16T00:05:00.000Z',
        messageId: followup.mock.calls[1]![0].id, targetSessionId: sessionId,
      } }),
    ]))
    // Each delivery announces its receipt write and then the end of the target Agent's execution.
    expect(changed).toHaveBeenCalledTimes(4)
  })

  it('rejects a persisted task whose table key disagrees with its record identity', async () => {
    let cleanup: (() => Promise<void>) | undefined
    try {
      await expect(harness({ beforeService: async (ctx, facility) => {
        cleanup = () => ctx.fiber.dispose()
        const domain = await facility.open(scheduleDomain)
        const record = createAfterScheduleRecord(ScheduleId('actual'), 'Mismatch', 60, Date.now(), 'Mismatch')
        await domain.table('tasks').put(ScheduleId('different'), boundTask(SessionId('bound'), record))
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
        await domain.table('tasks').put(ScheduleId('different'), boundTask(SessionId('bound'), record))
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

  it('registers no tools for existing roots or their owned children', async () => {
    const test = await harness({ beforeService: async (ctx) => {
      const parent = agentFor(ctx, 'existing-root')
      ctx.effect(() => ctx.agents.enter(parent, undefined))
    } })
    tests.push(test)
    const parent = test.ctx.agents.get(SessionId('existing-root'))!
    const child = agentFor(test.ctx, 'owned-child')
    test.ctx.effect(() => test.ctx.agents.enter(child, parent))
    expect(test.ctx.agents.roots()).toEqual([parent])
    for (const name of ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']) {
      expect(test.ctx.tools.get(name, parent)).toBeUndefined()
      expect(test.ctx.tools.get(name, child)).toBeUndefined()
      expect(test.ctx.tools.get(name)).toBeUndefined()
    }
  })

  it('registers no tools for a new root and rejects management after service teardown', async () => {
    const test = await setup()
    const agent = agentFor(test.ctx, 'new-root')
    await test.ctx.agents.register(agent)
    expect(test.ctx.tools.get('schedule_create', agent)).toBeUndefined()
    await test.ctx.fiber.dispose()
    await expect(test.service.edit({ action: 'delete', id: ScheduleId('gone') }))
      .rejects.toThrow('Schedule service is stopping')
  })

  it('rejects a missing creation selector at the shared service entry', async () => {
    const test = await setup()
    await expect(test.service.create({ prompt: 'Missing schedule', title: 'Missing schedule', timing: { kind: 'invalid'  } as never, target: { kind: 'session', sessionId: SessionId('caller') } }, SessionId('caller')))
      .rejects.toMatchObject({ code: 'invalid_rule', message: 'timing must contain exactly kind and its matching selector.' })
    await expect(test.service.create({ prompt: 'Conflicting selectors', title: 'Conflicting selectors', timing: { kind: 'after', after_seconds: 60, at: new Date(Date.now() + 60_000).toISOString() } as never, target: { kind: 'session', sessionId: SessionId('caller') } }, SessionId('caller'))).rejects.toMatchObject({ code: 'invalid_rule', message: 'timing must contain exactly kind and its matching selector.' })
  })

  it('keeps historical Session events inert without importing reminders or activating a target', async () => {
    const test = await setup()
    const warning = vi.spyOn(test.ctx.logger, 'warn')
    const record = createAfterScheduleRecord(ScheduleId('historical'), 'Old task', 60, Date.now(), 'Old task')
    const creation = {
      type: 'schedule/change' as const, seq: SessionSeq(0), time: Date.now(),
      data: { version: 1 as const, operation: 'create' as const, schedule: record },
    }
    const session = test.ctx.sessions.create(SessionId('historical-session'), { seed: [creation] })
    expect(session.ownEvents()).toContainEqual(creation)
    expect((await test.service.list({ active: true })).items).toEqual([])
    expect(test.resolve).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
  })
})
