/** Host timing updates share delivery FIFO and publish only durable task writes. */
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDailyScheduleRecord, createEveryScheduleRecord, ScheduleId } from '../src/domain.ts'
import { scheduleDomain, type ScheduleTask } from '../src/storage.ts'
import type { ScheduleRecord, ScheduleTimingChange, ScheduleUpdateContent } from '../src/types.ts'
import { agentFor, harness } from './harness.ts'

const contexts: Context[] = []
const releases: (() => void)[] = []
const sessionId = SessionId('timing-owner')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00.125Z')) })
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})
async function setup(options: Parameters<typeof harness>[0] = {}) {
  return harness({ ...options, onContext: ctx => contexts.push(ctx) })
}
function table(test: Awaited<ReturnType<typeof setup>>) {
  const domain = test.ctx.storageDomain.get('schedule')
  if (domain === undefined) throw new Error('Schedule domain not initialized')
  // The fixture's Schedule service opens this name with scheduleDomain; registry lookup erases that type.
  return domain.table('tasks') as KvTable<ScheduleRecord['id'], ScheduleTask>
}
function request(expected: ScheduleRecord, change: ScheduleTimingChange = { kind: 'every', every_seconds: 600 }) {
  return { sessionId, id: expected.id, expected, change }
}
function contentRequest(expected: ScheduleRecord, content: ScheduleUpdateContent) {
  return { sessionId, id: expected.id, expected, ...content }
}
function gatePut(test: Awaited<ReturnType<typeof setup>>) {
  const tasks = table(test)
  const put = tasks.put.bind(tasks)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const spy = vi.spyOn(tasks, 'put').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return put(...args)
  })
  return { entered: entered.promise, release: () => { release.resolve(undefined) }, spy }
}

it('updates daily timing in one task write while preserving Session, exact prompt, and all historical receipts', async () => {
  const record = createDailyScheduleRecord(ScheduleId('retained-daily'), 'Exact prompt\n"quoted"', {
    time: '09:00:00.125', time_zone: 'UTC',
  }, Date.now(), 'Exact prompt')
  const lastDelivery = {
    scheduledAt: '2026-09-15T09:00:00.125Z', deliveredAt: '2026-09-15T09:00:01.321Z', messageId: MessageId('last'),
  }
  const task: ScheduleTask = {
    sessionId, record, status: 'active', lastDelivery,
    deliveryHistory: { earlierRecordsUnavailable: true, records: [
      { ...lastDelivery, messageId: MessageId('older'), prompt: 'Older exact prompt' },
      { ...lastDelivery, prompt: record.prompt },
    ] },
  }
  const test = await setup({ beforeService: async (_ctx, facility) => {
    const domain = await facility.open(scheduleDomain)
    await domain.table('tasks').put(record.id, task)
    await domain.close()
  } })
  const read = vi.spyOn(test.ctx.sessions, 'get')
  const create = vi.spyOn(test.ctx.sessions, 'create')
  const put = vi.spyOn(table(test), 'put')
  const changed = vi.fn(() => { expect(table(test).get(record.id)?.record).toMatchObject({ time: '10:30:00.321' }) })
  test.ctx.on('schedule/changed', changed)
  const result = await test.service.update(request(record, {
    kind: 'daily', daily: { time: '10:30:00.321', time_zone: 'Asia/Shanghai' },
  }))
  const updated = { ...record, time: '10:30:00.321', timeZone: 'Asia/Shanghai', scheduledAt: '2026-09-16T02:30:00.321Z' }
  expect(result).toEqual({ id: record.id, updated: true, record: updated })
  expect(put).toHaveBeenCalledExactlyOnceWith(record.id, { ...task, record: updated })
  expect(table(test).get(record.id)).toEqual({ ...task, record: updated })
  expect(changed).toHaveBeenCalledTimes(1)
  expect(await test.service.history({ sessionId, id: record.id, limit: 100 })).toEqual({
    id: record.id, records: [...task.deliveryHistory!.records].reverse(), earlierRecordsUnavailable: true,
    earlierRecordsPruned: false, retention: { days: 30, records: 200 },
  })
  expect(read).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
  expect(test.flush).not.toHaveBeenCalled()
  await test.ctx.fiber.dispose()
  const restarted = await setup({ pool: test.pool })
  expect(table(restarted).get(record.id)).toEqual({ ...task, record: updated })
  expect(restarted.resolve).not.toHaveBeenCalled()
})

it('converts the retained recurrence kind in one task write while preserving identity, status, receipt, and history', async () => {
  const record = createEveryScheduleRecord(
    ScheduleId('kind-change'), 'Exact prompt\n"quoted"', 300, Date.now(), 'Exact prompt',
  )
  const lastDelivery = {
    scheduledAt: '2026-09-15T09:00:00.125Z', deliveredAt: '2026-09-15T09:00:01.321Z', messageId: MessageId('last'),
  }
  const task: ScheduleTask = {
    sessionId, record, status: 'active', lastDelivery,
    deliveryHistory: { earlierRecordsUnavailable: true, records: [
      { ...lastDelivery, messageId: MessageId('older'), prompt: 'Older exact prompt' },
      { ...lastDelivery, prompt: record.prompt },
    ] },
  }
  const test = await setup({ beforeService: async (_ctx, facility) => {
    const domain = await facility.open(scheduleDomain)
    await domain.table('tasks').put(record.id, task)
    await domain.close()
  } })
  const put = vi.spyOn(table(test), 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  const daily = { time: '10:30:00.321', time_zone: 'Asia/Shanghai' }
  const updated: ScheduleRecord = {
    id: record.id, kind: 'daily', title: 'Exact prompt', prompt: record.prompt, time: '10:30:00.321',
    timeZone: 'Asia/Shanghai', scheduledAt: '2026-09-16T02:30:00.321Z',
  }
  expect(await test.service.update(request(record, { kind: 'daily', daily })))
    .toEqual({ id: record.id, updated: true, record: updated })
  expect(put).toHaveBeenCalledExactlyOnceWith(record.id, { ...task, record: updated })
  expect(table(test).get(record.id)).toEqual({ ...task, record: updated })
  expect(changed).toHaveBeenCalledTimes(1)
  expect(await test.service.history({ sessionId, id: record.id, limit: 100 })).toEqual({
    id: record.id, records: [...task.deliveryHistory!.records].reverse(), earlierRecordsUnavailable: true,
    earlierRecordsPruned: false, retention: { days: 30, records: 200 },
  })
  expect(test.resolve).not.toHaveBeenCalled()
  expect(test.flush).not.toHaveBeenCalled()
})

it.each(['after', 'every', 'daily'] as const)('keeps unchanged %s timing after the clock moves without writes or events', async (kind) => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'No-op', title: 'No-op',
    ...(kind === 'after' ? { after_seconds: 60 } : kind === 'every'
      ? { every_seconds: 300 } : { daily: { time: '12:00:00.125', time_zone: 'US/Eastern' } }),
  })
  await vi.advanceTimersByTimeAsync(0)
  const before = structuredClone(table(test).get(record.id))
  const put = vi.spyOn(table(test), 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  vi.setSystemTime(new Date('2026-09-17T00:00:00Z'))
  const change: ScheduleTimingChange = record.kind === 'daily'
    ? { kind: 'daily', daily: { time: '12:00:00.125', time_zone: 'America/New_York' } }
    : record.kind === 'every' ? { kind: 'every', every_seconds: 300 } : { kind: 'at', at: record.scheduledAt }
  expect(await test.service.update(request(record, change))).toEqual({ id: record.id, updated: false, record })
  expect(table(test).get(record.id)).toEqual(before)
  expect(put).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
})

it('returns lookup and ended results without writes, events, or Session activation', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep', every_seconds: 300, title: 'Keep' })
  const tasks = table(test)
  const current = tasks.get(record.id)!
  await tasks.put(record.id, { ...current, status: 'inactive' })
  const put = vi.spyOn(tasks, 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  expect(await test.service.update({ ...request(record), id: ScheduleId('missing') }))
    .toEqual({ id: 'missing', updated: false, code: 'schedule_not_found' })
  expect(await test.service.update({ ...request(record), sessionId: SessionId('other') }))
    .toEqual({ id: record.id, updated: false, code: 'schedule_not_found' })
  expect(await test.service.update(request(record))).toEqual({ id: record.id, updated: false, code: 'schedule_ended' })
  expect(put).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
})

it('rejects malformed expected and invalid timing at the service without writes or events', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep', every_seconds: 300, title: 'Keep' })
  const put = vi.spyOn(table(test), 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  const invalidExpected: unknown = { ...record, private: 'private detail' }
  expect(await test.service.update({ ...request(record), expected: invalidExpected as ScheduleRecord }))
    .toEqual({ code: 'invalid_rule', message: 'expected must be a complete valid Schedule record.' })
  expect(await test.service.update(request(record, { kind: 'every', every_seconds: 59 })))
    .toMatchObject({ code: 'frequency_too_high' })
  expect(put).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  expect(await test.service.list({ sessionId })).toEqual([record])
})

it('serializes competing saves and rejects repeated stale snapshots without overwriting the accepted rule', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep', every_seconds: 300, title: 'Keep' })
  const gate = gatePut(test)
  const first = test.service.update(request(record))
  await gate.entered
  let secondSettled = false
  const second = test.service.update(request(record, { kind: 'every', every_seconds: 900 })).then((result) => {
    secondSettled = true
    return result
  })
  expect(secondSettled).toBe(false)
  expect(table(test).get(record.id)?.record).toEqual(record)
  gate.release()
  expect(await first).toMatchObject({ updated: true, record: { everySeconds: 600 } })
  expect(await second).toEqual({ id: record.id, updated: false, code: 'schedule_conflict' })
  expect(await test.service.update(request(record))).toEqual({ id: record.id, updated: false, code: 'schedule_conflict' })
  expect(gate.spy).toHaveBeenCalledTimes(1)
  expect(table(test).get(record.id)?.record).toMatchObject({ everySeconds: 600 })
})

it('uses the fresh queue-time clock after a blocked creation rather than the edit request time', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep', every_seconds: 300, title: 'Keep' })
  const gate = gatePut(test)
  const creation = test.service.create(sessionId, { prompt: 'Blocks queue', after_seconds: 3600, title: 'Blocks queue' })
  await gate.entered
  const edit = test.service.update(request(record))
  vi.setSystemTime(new Date('2026-09-16T00:00:45.321Z'))
  gate.release()
  await creation
  expect(await edit).toMatchObject({ updated: true, record: { scheduledAt: '2026-09-16T00:10:45.321Z' } })
})

it('rejects an absolute edit that became past while waiting behind a write', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep', after_seconds: 3600, title: 'Keep' })
  const gate = gatePut(test)
  const creation = test.service.create(sessionId, { prompt: 'Blocks queue', after_seconds: 3600, title: 'Blocks queue' })
  await gate.entered
  const edit = test.service.update(request(record, { kind: 'at', at: '2026-09-16T00:01:00Z' }))
  vi.setSystemTime(new Date('2026-09-16T00:02:00Z'))
  gate.release()
  await creation
  expect(await edit).toMatchObject({ code: 'not_future' })
  expect(table(test).get(record.id)?.record).toEqual(record)
  expect(gate.spy).toHaveBeenCalledTimes(1)
})

it('observes a deletion ordered before an edit in the same FIFO', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Remove', every_seconds: 300, title: 'Remove' })
  const gate = gatePut(test)
  const creation = test.service.create(sessionId, { prompt: 'Blocks queue', after_seconds: 3600, title: 'Blocks queue' })
  await gate.entered
  const deletion = test.service.delete({ sessionId, id: record.id })
  const edit = test.service.update(request(record))
  gate.release()
  await creation
  expect(await deletion).toEqual({ id: record.id, deleted: true })
  expect(await edit).toEqual({ id: record.id, updated: false, code: 'schedule_not_found' })
  // Deletion removes the row instead of publishing it, so only the admission write passes the gate.
  expect(gate.spy).toHaveBeenCalledTimes(1)
  expect(table(test).get(record.id)).toBeUndefined()
})

it.each(['every', 'after', 'daily'] as const)('waits for %s delivery then observes the advanced target or ended status', async (kind) => {
  const test = await setup()
  const agent = agentFor(test.ctx, sessionId)
  test.resolve.mockResolvedValue({ agent })
  const record = await test.service.create(sessionId, { prompt: 'Deliver first', title: 'Deliver first',
    ...(kind === 'every' ? { every_seconds: 300 } : kind === 'after'
      ? { after_seconds: 300 } : { daily: { time: '00:05:00.125', time_zone: 'UTC' } }),
  })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  test.flush.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const timer = vi.advanceTimersByTimeAsync(300_000)
  await entered.promise
  const put = vi.spyOn(table(test), 'put')
  const edit = test.service.update(request(record, kind === 'every'
    ? { kind: 'every', every_seconds: 600 } : kind === 'after'
      ? { kind: 'at', at: '2026-09-17T00:00:00Z' } : { kind: 'daily', daily: { time: '00:10:00.125', time_zone: 'UTC' } }))
  expect(put).not.toHaveBeenCalled()
  release.resolve(undefined)
  await timer
  expect(await edit).toEqual({ id: record.id, updated: false,
    code: kind === 'after' ? 'schedule_ended' : 'schedule_conflict',
  })
  expect(put).toHaveBeenCalledTimes(1)
  expect(agent.followup).toHaveBeenCalledTimes(1)
  expect(table(test).get(record.id)?.deliveryHistory?.records).toHaveLength(1)
})

it.each(['before', 'queued', 'writing'] as const)('honors cancellation %s with no rollback after writing begins', async (when) => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep', every_seconds: 300, title: 'Keep' })
  const controller = new AbortController()
  const reason = new Error('Cancel edit')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  if (when === 'before') {
    controller.abort(reason)
    const put = vi.spyOn(table(test), 'put')
    await expect(test.service.update(request(record), controller.signal)).rejects.toBe(reason)
    expect(put).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    return
  }
  const gate = gatePut(test)
  const ahead = when === 'queued'
    ? test.service.create(sessionId, {
      prompt: 'Blocks queue', after_seconds: 3600, title: 'Blocks queue',
    }) : undefined
  if (ahead !== undefined) await gate.entered
  const edit = test.service.update(request(record), controller.signal)
  const outcome = edit.then(value => ({ value }), (error: unknown) => ({ error }))
  if (when === 'writing') await gate.entered
  controller.abort(reason)
  gate.release()
  await ahead
  if (when === 'queued') {
    expect(await outcome).toEqual({ error: reason })
    expect(table(test).get(record.id)?.record).toEqual(record)
  } else {
    expect(await outcome).toMatchObject({ value: { updated: true, record: { everySeconds: 600 } } })
    expect(table(test).get(record.id)?.record).toMatchObject({ everySeconds: 600 })
  }
  expect(gate.spy).toHaveBeenCalledTimes(1)
  expect(changed).toHaveBeenCalledTimes(1)
})

it('rejects persistence failures without publishing the new rule and permits a later save', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep', every_seconds: 300, title: 'Keep' })
  const before = structuredClone(table(test).get(record.id))
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  test.pool.failNextWrites = 1
  await expect(test.service.update(request(record))).rejects.toThrow('injected write failure')
  expect(table(test).get(record.id)).toEqual(before)
  expect(test.pool.media.get('schedule')?.tables.get('tasks')?.get(record.id)).toEqual(before)
  expect(changed).not.toHaveBeenCalled()
  expect(await test.service.update(request(record))).toMatchObject({ updated: true })
  expect(changed).toHaveBeenCalledTimes(1)
  await test.ctx.fiber.dispose()
  await expect(test.service.update(request(record))).rejects.toThrow('Schedule service is stopping')
})

it('does not append historical Session events and exposes the in-place update tool', async () => {
  const test = await setup()
  const agent = agentFor(test.ctx, sessionId)
  await test.ctx.agents.register(agent)
  const record = await test.service.create(sessionId, { prompt: 'Keep', every_seconds: 300, title: 'Keep' })
  const events = agent.session.snapshotEvents()
  expect(await test.service.update(request(record))).toMatchObject({ updated: true })
  expect(agent.session.snapshotEvents()).toEqual(events)
  expect(test.ctx.tools.get('schedule_update', agent)).toBeDefined()
  expect(test.ctx.tools.get('schedule_create', agent)).toBeDefined()
  expect(test.resolve).not.toHaveBeenCalled()
})

it('keeps the future committed target on a no-op after a smaller clock advance', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Fixed anchor', every_seconds: 300, title: 'Fixed anchor' })
  vi.setSystemTime(new Date('2026-09-16T00:01:00.999Z'))
  expect(await test.service.update(request(record, { kind: 'every', every_seconds: 300 })))
    .toEqual({ id: record.id, updated: false, record })
  expect(table(test).get(record.id)?.record.scheduledAt).toBe('2026-09-16T00:05:00.125Z')
})

it('checks cancellation after the task domain finishes opening', async () => {
  const entered = Promise.withResolvers<Context>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const startup = setup({ direct: true, beforeService: async (ctx, facility) => {
    const open = facility.open.bind(facility)
    vi.spyOn(facility, 'open').mockImplementationOnce(async (spec) => {
      entered.resolve(ctx)
      await release.promise
      return open(spec)
    })
  } })
  const ctx = await entered.promise
  const controller = new AbortController()
  const expected = createDailyScheduleRecord(
    ScheduleId('waiting'), 'Waiting', { time: '12:00:00', time_zone: 'UTC' }, Date.now(), 'Waiting',
  )
  const outcome = ctx.schedule.update(request(expected), controller.signal)
    .then(value => ({ value }), (error: unknown) => ({ error }))
  const reason = new Error('Cancelled during domain readiness')
  controller.abort(reason)
  release.resolve(undefined)
  const test = await startup
  expect(await outcome).toEqual({ error: reason })
  expect(await test.service.catalog()).toEqual([])
  expect(test.resolve).not.toHaveBeenCalled()
})

it('does not emit until the accepted update write completes', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep', every_seconds: 300, title: 'Keep' })
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  const gate = gatePut(test)
  const edit = test.service.update(request(record))
  await gate.entered
  expect(changed).not.toHaveBeenCalled()
  expect(table(test).get(record.id)?.record).toEqual(record)
  gate.release()
  await edit
  expect(changed).toHaveBeenCalledTimes(1)
})

it('applies a combined name, instruction, and timing save in one task write preserving binding, status, receipt, and history', async () => {
  const record = createEveryScheduleRecord(ScheduleId('combined'), 'Exact prompt\n"quoted"', 300, Date.now(), 'Exact prompt')
  const lastDelivery = {
    scheduledAt: '2026-09-15T09:00:00.125Z', deliveredAt: '2026-09-15T09:00:01.321Z', messageId: MessageId('last'),
  }
  const task: ScheduleTask = {
    sessionId, record, status: 'active', lastDelivery,
    deliveryHistory: { earlierRecordsUnavailable: true, records: [
      { ...lastDelivery, messageId: MessageId('older'), prompt: 'Older exact prompt' },
      { ...lastDelivery, prompt: record.prompt },
    ] },
  }
  const test = await setup({ beforeService: async (_ctx, facility) => {
    const domain = await facility.open(scheduleDomain)
    await domain.table('tasks').put(record.id, task)
    await domain.close()
  } })
  const put = vi.spyOn(table(test), 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  const updated: ScheduleRecord = {
    id: record.id, kind: 'daily', title: 'Renamed task', prompt: 'New instruction', time: '10:30:00.321',
    timeZone: 'Asia/Shanghai', scheduledAt: '2026-09-16T02:30:00.321Z',
  }
  expect(await test.service.update({
    sessionId, id: record.id, expected: record, title: 'Renamed task', prompt: 'New instruction',
    change: { kind: 'daily', daily: { time: '10:30:00.321', time_zone: 'Asia/Shanghai' } },
  })).toEqual({ id: record.id, updated: true, record: updated })
  expect(put).toHaveBeenCalledExactlyOnceWith(record.id, { ...task, record: updated })
  expect(table(test).get(record.id)).toEqual({ ...task, record: updated })
  expect(changed).toHaveBeenCalledTimes(1)
  expect(await test.service.history({ sessionId, id: record.id, limit: 100 })).toEqual({
    id: record.id, records: [...task.deliveryHistory!.records].reverse(), earlierRecordsUnavailable: true,
    earlierRecordsPruned: false, retention: { days: 30, records: 200 },
  })
  expect(test.resolve).not.toHaveBeenCalled()
  expect(test.flush).not.toHaveBeenCalled()
  await test.ctx.fiber.dispose()
  const restarted = await setup({ pool: test.pool })
  expect(table(restarted).get(record.id)).toEqual({ ...task, record: updated })
})

it('renames then re-instructs a task without resetting its target, binding, status, or saved deliveries', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep prompt', every_seconds: 300, title: 'Keep prompt' })
  const tasks = table(test)
  const before = structuredClone(tasks.get(record.id))!
  const put = vi.spyOn(tasks, 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  expect(await test.service.update(contentRequest(record, { title: 'Renamed' })))
    .toEqual({ id: record.id, updated: true, record: { ...record, title: 'Renamed' } })
  expect(put).toHaveBeenCalledExactlyOnceWith(record.id, { ...before, record: { ...record, title: 'Renamed' } })
  expect(tasks.get(record.id)?.record.scheduledAt).toBe(record.scheduledAt)
  const renamed = tasks.get(record.id)!.record
  put.mockClear()
  expect(await test.service.update(contentRequest(renamed, { prompt: 'New instruction' })))
    .toEqual({ id: record.id, updated: true, record: { ...renamed, prompt: 'New instruction' } })
  expect(put).toHaveBeenCalledExactlyOnceWith(record.id, { ...before, record: { ...renamed, prompt: 'New instruction' } })
  expect(tasks.get(record.id)?.record.scheduledAt).toBe(record.scheduledAt)
  expect(tasks.get(record.id)?.deliveryHistory).toEqual(before.deliveryHistory)
  expect(changed).toHaveBeenCalledTimes(2)
  expect(test.resolve).not.toHaveBeenCalled()
})

it.each<[string, ScheduleUpdateContent]>([
  ['blank title', { title: '   ' }],
  ['over-long title', { title: 'x'.repeat(121) }],
  ['blank prompt', { prompt: ' \n ' }],
])('rejects a %s without writing or notifying', async (_label, content) => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep', every_seconds: 300, title: 'Keep' })
  const put = vi.spyOn(table(test), 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  expect(await test.service.update(contentRequest(record, content))).toMatchObject({ code: 'invalid_prompt' })
  expect(put).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  expect(table(test).get(record.id)?.record).toEqual(record)
})

it('keeps conflict, ended, and binding results for a name or instruction payload', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Keep', every_seconds: 300, title: 'Keep' })
  const tasks = table(test)
  expect(await test.service.update({
    sessionId, id: record.id, expected: { ...record, prompt: 'Other' }, title: 'Renamed',
  })).toEqual({ id: record.id, updated: false, code: 'schedule_conflict' })
  await tasks.put(record.id, { ...tasks.get(record.id)!, status: 'inactive' })
  const put = vi.spyOn(tasks, 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  expect(await test.service.update(contentRequest(record, { title: 'Renamed' })))
    .toEqual({ id: record.id, updated: false, code: 'schedule_ended' })
  expect(await test.service.update({ sessionId: SessionId('other'), id: record.id, expected: record, prompt: 'New' }))
    .toEqual({ id: record.id, updated: false, code: 'schedule_not_found' })
  expect(await test.service.update({ sessionId, id: ScheduleId('missing'), expected: record, title: 'Renamed' }))
    .toEqual({ id: 'missing', updated: false, code: 'schedule_not_found' })
  expect(put).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})

it('reports a deleted task as not found for update and repeated delete', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Gone', every_seconds: 300, title: 'Gone' })
  expect(await test.service.delete({ sessionId, id: record.id })).toEqual({ id: record.id, deleted: true })
  const put = vi.spyOn(table(test), 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  expect(await test.service.update(contentRequest(record, { title: 'Renamed' })))
    .toEqual({ id: record.id, updated: false, code: 'schedule_not_found' })
  expect(await test.service.delete({ sessionId, id: record.id }))
    .toEqual({ id: record.id, deleted: false, code: 'schedule_not_found' })
  expect(put).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})
