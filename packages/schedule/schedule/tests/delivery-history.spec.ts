/** Saved delivery queries use task storage, never Session history or Agent activation. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ScheduleId, ScheduleInputError, createAfterScheduleRecord } from '../src/domain.ts'
import { scheduleDomain, type ScheduleTask } from '../src/storage.ts'
import { appendDelivery } from '../src/delivery-history.ts'
import type { ScheduleDeliveryRecord } from '../src/types.ts'
import { agentFor, harness } from './harness.ts'

const contexts: Context[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})
async function setup(options: Parameters<typeof harness>[0] = {}) {
  return harness({ ...options, onContext: ctx => contexts.push(ctx) })
}
const sessionId = SessionId('history-owner')
const id = ScheduleId('history-task')
const metadata = { earlierRecordsPruned: false, retention: { days: 30, records: 200 } }
function receipt(index: number): ScheduleDeliveryRecord {
  return {
    messageId: MessageId(`message-${index}`), prompt: `Sent prompt ${index}`,
    scheduledAt: '2026-09-15T00:00:00.000Z',
    deliveredAt: index % 2 === 0 ? '2026-09-15T00:00:01.000Z' : '2026-09-14T00:00:01.000Z',
  }
}
function stored(records: ScheduleDeliveryRecord[]): ScheduleTask {
  const latest = records.at(-1)
  return {
    sessionId, status: 'inactive', record: createAfterScheduleRecord(id, 'Current task prompt', 1, Date.now(), 'Current task prompt'),
    ...(latest === undefined ? {} : { lastDelivery: {
      scheduledAt: latest.scheduledAt, deliveredAt: latest.deliveredAt, messageId: latest.messageId,
    } }),
    deliveryHistory: { records, earlierRecordsUnavailable: false },
  }
}

it('paginates more than one full page by identity across appended arrivals and clock rollback', async () => {
  const records = Array.from({ length: 103 }, (_, index) => receipt(index))
  const test = await setup({ beforeService: async (_ctx, facility) => {
    const domain = await facility.open(scheduleDomain)
    await domain.table('tasks').put(id, stored(records))
    await domain.close()
  } })
  const read = vi.spyOn(test.ctx.sessions, 'get')
  const create = vi.spyOn(test.ctx.sessions, 'create')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  const first = await test.service.history({ sessionId, id, limit: 100 })
  expect(first).toEqual({ id, records: records.slice(3).reverse(), ...metadata, earlierRecordsUnavailable: false, nextBefore: MessageId('message-3') })
  if ('code' in first || first.nextBefore === undefined) throw new Error('Expected delivery page with an older cursor')
  const table = test.ctx.storageDomain.get('schedule')!.table('tasks')
  const arrival = receipt(103)
  await table.put(id, stored([...records, arrival]))
  const second = await test.service.history({ sessionId, id, limit: 100, before: first.nextBefore })
  expect(second).toEqual({ id, records: records.slice(0, 3).reverse(), ...metadata, earlierRecordsUnavailable: false })
  if ('code' in second) throw new Error('Expected delivery page')
  expect(new Set([...first.records, ...second.records].map(record => record.messageId)).size).toBe(103)
  expect(await test.service.history({ sessionId, id, limit: 1 })).toEqual({
    id, records: [arrival], ...metadata, earlierRecordsUnavailable: false, nextBefore: arrival.messageId,
  })
  expect(await test.service.history({ sessionId, id, limit: 1, before: records[0]!.messageId })).toEqual({
    id, records: [], ...metadata, earlierRecordsUnavailable: false,
  })
  Object.assign(first.records[0]!, { prompt: 'Mutated response copy' })
  first.records.splice(0)
  expect(await test.service.history({ sessionId, id, limit: 100 })).toMatchObject({ records: [...records, arrival].slice(4).reverse() })
  expect(await test.service.catalog()).toEqual([{
    ...stored(records).record, sessionId, status: 'inactive', lastDelivery: {
      scheduledAt: arrival.scheduledAt, deliveredAt: arrival.deliveredAt, messageId: arrival.messageId,
    },
  }])
  expect(await test.service.list({ sessionId })).toEqual([])
  expect(read).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
  expect(test.flush).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})

it('returns explicit missing task, wrong binding, and unknown cursor results', async () => {
  const test = await setup()
  const record = await test.service.create(sessionId, { prompt: 'Pending', after_seconds: 60, title: 'Pending' })
  expect(await test.service.history({ sessionId, id: record.id, limit: 1 })).toEqual({
    id: record.id, records: [], ...metadata, earlierRecordsUnavailable: false,
  })
  expect(await test.service.history({ sessionId, id, limit: 1 })).toEqual({ id, code: 'schedule_not_found' })
  expect(await test.service.history({ sessionId: SessionId('wrong'), id: record.id, limit: 1 })).toEqual({
    id: record.id, code: 'schedule_not_found',
  })
  expect(await test.service.history({ sessionId, id: record.id, limit: 1, before: MessageId('unknown') })).toEqual({
    id: record.id, code: 'delivery_cursor_not_found',
  })
  expect(test.resolve).not.toHaveBeenCalled()
})

it.each([0, -1, 101, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid explicit history limit %s', async (limit) => {
  const test = await setup()
  const request = { sessionId, id, limit }
  await expect(test.service.history(request)).rejects.toBeInstanceOf(ScheduleInputError)
  await expect(test.service.history(request)).rejects.toMatchObject({ code: 'invalid_rule' })
  expect(test.resolve).not.toHaveBeenCalled()
})

it.each<[unknown]>([[undefined], [null], ['1']])('does not default or coerce an invalid remote limit %s', async (limit) => {
  const test = await setup()
  // Remote JSON can omit the required limit or supply a value outside its declared number type.
  await expect(test.service.history({ sessionId, id, limit: limit as number }))
    .rejects.toMatchObject({ code: 'invalid_rule' })
})

it.each(['every', 'daily'] as const)('retains real %s receipts and immutable prompt snapshots across restart and catchup', async (kind) => {
  const first = await setup()
  const agent = agentFor(first.ctx, sessionId)
  const followup = vi.spyOn(agent, 'followup')
  first.resolve.mockResolvedValue({ agent })
  const record = await first.service.create(sessionId, {
    prompt: 'Original prompt', title: 'Original prompt',
    ...(kind === 'every' ? { every_seconds: 300 } : { daily: { time: '00:05:00', time_zone: 'UTC' } }),
  })
  await vi.advanceTimersByTimeAsync(300_000)
  const firstReceipt = {
    scheduledAt: '2026-09-16T00:05:00.000Z', deliveredAt: '2026-09-16T00:05:00.000Z',
    messageId: followup.mock.calls[0]![0].id, prompt: 'Original prompt',
  }
  expect(JSON.stringify(followup.mock.calls[0]![0].content)).toContain(firstReceipt.prompt)
  const table = first.ctx.storageDomain.get('schedule')!.table('tasks')
  const task = table.get(record.id) as ScheduleTask
  // Timing edits cannot change prompts; direct storage mutation exercises retention of older prompt snapshots.
  await table.put(record.id, { ...task, record: { ...task.record, prompt: 'Next prompt' } })
  await first.ctx.fiber.dispose()
  vi.setSystemTime(new Date('2026-09-19T00:06:00.000Z'))
  let restartedAgent: ReturnType<typeof agentFor> | undefined
  const second = await setup({ pool: first.pool, beforeService: async (ctx) => {
    restartedAgent = agentFor(ctx, sessionId)
    vi.spyOn(ctx.sessionController, 'resolveAgent').mockResolvedValue({ agent: restartedAgent })
  } })
  await vi.advanceTimersByTimeAsync(0)
  if (restartedAgent === undefined) throw new Error('Expected restored Agent')
  const deliveries = vi.mocked(restartedAgent.followup)
  expect(deliveries).toHaveBeenCalledTimes(1)
  const secondReceipt = {
    scheduledAt: '2026-09-19T00:05:00.000Z', deliveredAt: '2026-09-19T00:06:00.000Z',
    messageId: deliveries.mock.calls[0]![0].id, prompt: 'Next prompt',
  }
  expect(secondReceipt.messageId).not.toBe(firstReceipt.messageId)
  expect(JSON.stringify(deliveries.mock.calls[0]![0].content)).toContain(secondReceipt.prompt)
  expect(await second.service.history({ sessionId, id: record.id, limit: 100 })).toEqual({
    id: record.id, records: [secondReceipt, firstReceipt], ...metadata, earlierRecordsUnavailable: false,
  })
  expect(second.pool.media.get('schedule')!.tables.get('tasks')!.get(record.id)).toMatchObject({
    deliveryHistory: { records: [firstReceipt, secondReceipt], earlierRecordsUnavailable: false },
  })
  await second.ctx.fiber.dispose()
  const third = await setup({ pool: first.pool })
  expect(await third.service.history({ sessionId, id: record.id, limit: 100 })).toEqual({
    id: record.id, records: [secondReceipt, firstReceipt], ...metadata, earlierRecordsUnavailable: false,
  })
})

it.each(['flush-false', 'flush-reject', 'put'] as const)('publishes no additional history or notification after %s failure', async (failure) => {
  const test = await setup()
  const agent = agentFor(test.ctx, sessionId)
  const followup = vi.spyOn(agent, 'followup')
  test.resolve.mockResolvedValue({ agent })
  const record = await test.service.create(sessionId, { prompt: 'Keep first receipt', every_seconds: 300, title: 'Keep first receipt' })
  await vi.advanceTimersByTimeAsync(300_000)
  const before = await test.service.history({ sessionId, id: record.id, limit: 100 })
  const catalog = await test.service.catalog()
  const disk = structuredClone(test.pool.media.get('schedule')!.tables.get('tasks')!.get(record.id))
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  if (failure === 'flush-false') vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
  else if (failure === 'flush-reject') test.flush.mockRejectedValueOnce(new Error('flush failed'))
  else test.pool.failNextWrites = 1
  await vi.advanceTimersByTimeAsync(300_000)
  expect(followup).toHaveBeenCalledTimes(2)
  expect(await test.service.history({ sessionId, id: record.id, limit: 100 })).toEqual(before)
  expect(await test.service.catalog()).toEqual(catalog)
  expect(test.pool.media.get('schedule')!.tables.get('tasks')!.get(record.id)).toEqual(disk)
  expect(changed).not.toHaveBeenCalled()
})

it('deletes an ended task together with its complete history', async () => {
  const test = await setup()
  const agent = agentFor(test.ctx, sessionId)
  test.resolve.mockResolvedValue({ agent })
  const record = await test.service.create(sessionId, { prompt: 'Only once', after_seconds: 1, title: 'Only once' })
  await vi.advanceTimersByTimeAsync(1000)
  const history = await test.service.history({ sessionId, id: record.id, limit: 100 })
  expect(history).toMatchObject({ records: [{ prompt: 'Only once' }], earlierRecordsUnavailable: false })
  await vi.advanceTimersByTimeAsync(86_400_000)
  expect(agent.followup).toHaveBeenCalledTimes(1)
  expect(await test.service.history({ sessionId, id: record.id, limit: 100 })).toEqual(history)
  const events = agent.session.snapshotEvents()
  expect(await test.service.delete({ sessionId, id: record.id })).toEqual({ id: record.id, deleted: true })
  // The row is gone, so the saved records go with it and the listing is empty.
  expect(await test.service.history({ sessionId, id: record.id, limit: 100 }))
    .toEqual({ id: record.id, code: 'schedule_not_found' })
  expect(await test.service.list({ sessionId })).toEqual([])
  expect(await test.service.catalog()).toEqual([])
  expect(test.pool.media.get('schedule')!.tables.get('tasks')!.get(record.id)).toBeUndefined()
  expect(await test.service.delete({ sessionId, id: record.id }))
    .toEqual({ id: record.id, deleted: false, code: 'schedule_not_found' })
  expect(test.ctx.sessions.get(sessionId)).toBe(agent.session)
  expect(agent.session.snapshotEvents()).toEqual(events)
})

it('removes the row across restart while the task stops running and leaves both listings', async () => {
  const first = await setup()
  const agent = agentFor(first.ctx, sessionId)
  const followup = vi.spyOn(agent, 'followup')
  first.resolve.mockResolvedValue({ agent })
  const record = await first.service.create(sessionId, { prompt: 'Keep records', every_seconds: 300, title: 'Keep records' })
  await vi.advanceTimersByTimeAsync(300_000)
  expect(followup).toHaveBeenCalledTimes(1)
  const retained = await first.service.history({ sessionId, id: record.id, limit: 100 })
  expect(retained).toMatchObject({ records: [{ prompt: 'Keep records' }] })
  expect(await first.service.delete({ sessionId, id: record.id })).toEqual({ id: record.id, deleted: true })
  // The removed row leaves the timer and both listings, and its records are gone.
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(followup).toHaveBeenCalledTimes(1)
  expect(await first.service.list({ sessionId })).toEqual([])
  expect(await first.service.catalog()).toEqual([])
  expect(await first.service.history({ sessionId, id: record.id, limit: 100 }))
    .toEqual({ id: record.id, code: 'schedule_not_found' })
  await first.ctx.fiber.dispose()
  const second = await setup({ pool: first.pool })
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(second.resolve).not.toHaveBeenCalled()
  expect(await second.service.list({ sessionId })).toEqual([])
  expect(await second.service.catalog()).toEqual([])
  expect(await second.pool.media.get('schedule')!.tables.get('tasks')!.get(record.id)).toBeUndefined()
  expect(await second.service.history({ sessionId, id: record.id, limit: 100 }))
    .toEqual({ id: record.id, code: 'schedule_not_found' })
})

it('retains the configured window and cap when an acknowledgment is appended', () => {
  const task = stored([receipt(1), receipt(2)])
  const appended = appendDelivery(task, receipt(3), { days: 30, records: 200 })
  expect(appended.deliveryHistory?.records.map(record => record.messageId)).toEqual(['message-1', 'message-2', 'message-3'])
  expect(appended.deliveryHistory?.earlierRecordsUnavailable).toBe(false)
  expect(appended.deliveryHistory?.earlierRecordsPruned).toBe(false)
  expect(appended.lastDelivery).toEqual(receipt(3))
})

it('does not infer pruning from legacy unavailability when appending a receipt', () => {
  const task = stored([receipt(1)])
  task.deliveryHistory = { records: [receipt(1)], earlierRecordsUnavailable: true }
  const appended = appendDelivery(task, receipt(2), { days: 30, records: 200 })
  expect(appended.deliveryHistory?.earlierRecordsUnavailable).toBe(true)
  expect(appended.deliveryHistory?.earlierRecordsPruned).toBe(false)
})

it('publishes confirmed pruning and the configured policy across restart', async () => {
  const first = await setup({ config: { deliveryHistoryDays: 7, deliveryHistoryRecords: 2 } })
  const agent = agentFor(first.ctx, sessionId)
  first.resolve.mockResolvedValue({ agent })
  const record = await first.service.create(sessionId, { prompt: 'Retained history', title: 'Retained history', every_seconds: 300 })
  await vi.advanceTimersByTimeAsync(600_000)
  expect(await first.service.history({ sessionId, id: record.id, limit: 20 })).toMatchObject({
    earlierRecordsPruned: false, retention: { days: 7, records: 2 },
  })
  await vi.advanceTimersByTimeAsync(300_000)
  const page = await first.service.history({ sessionId, id: record.id, limit: 20 })
  expect(page).toMatchObject({ earlierRecordsPruned: true, retention: { days: 7, records: 2 } })
  if ('code' in page) throw new Error('Expected retained records')
  expect(page.records).toHaveLength(2)
  await first.ctx.fiber.dispose()
  const second = await setup({ pool: first.pool, config: { deliveryHistoryDays: 14, deliveryHistoryRecords: 10 } })
  expect(await second.service.history({ sessionId, id: record.id, limit: 20 })).toEqual({
    ...page, retention: { days: 14, records: 10 },
  })
})

it('drops the oldest records past the cap and marks earlier records unavailable', () => {
  const appended = appendDelivery(stored([receipt(1), receipt(2)]), receipt(3), { days: 30, records: 2 })
  expect(appended.deliveryHistory?.records.map(record => record.messageId)).toEqual(['message-2', 'message-3'])
  expect(appended.deliveryHistory?.earlierRecordsUnavailable).toBe(true)
  expect(appended.deliveryHistory?.earlierRecordsPruned).toBe(true)
})

it('drops records outside the day window and keeps the flag once it is set', () => {
  const fresh = { ...receipt(9), deliveredAt: '2026-09-16T00:00:00.000Z' }
  const task = stored([receipt(1), receipt(2)])
  const appended = appendDelivery(task, fresh, { days: 1, records: 200 })
  // The clock is 2026-09-16; receipt(1) is dated 2026-09-14 and falls outside one day.
  expect(appended.deliveryHistory?.records.map(record => record.messageId)).toEqual(['message-2', 'message-9'])
  expect(appended.deliveryHistory?.earlierRecordsUnavailable).toBe(true)
  expect(appended.deliveryHistory?.earlierRecordsPruned).toBe(true)
  const retained = appended.deliveryHistory?.records ?? []
  const already = { ...task, deliveryHistory: { records: retained, earlierRecordsUnavailable: true, earlierRecordsPruned: true } }
  expect(appendDelivery(already, { ...fresh, messageId: MessageId('message-10') }, { days: 30, records: 200 })
    .deliveryHistory?.earlierRecordsPruned).toBe(true)
})
