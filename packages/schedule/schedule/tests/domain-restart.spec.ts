/** Schedule survives closing all domain handles independently of Session activation. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { scheduleDomain, scheduleTaskSchema, type ScheduleTask } from '../src/storage.ts'
import {
  createAfterScheduleRecord, createAtScheduleRecord, createDailyScheduleRecord, createEveryScheduleRecord,
  decodeScheduleRecord, ScheduleId, resolveDailyOccurrence, resolveEveryOccurrence, resolveWeeklyOccurrence,
} from '../src/domain.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { boundTask } from './harness.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function open(root: string) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const domain = await facility.open(scheduleDomain)
  ctx.effect(() => async () => { await domain.close(); await backend.close() })
  return { ctx, domain }
}

/** One saved delivery receipt of the Session-bound task in `sessionId`. */
function receipt(sessionId: string, scheduledAt: string, deliveredAt: string, messageId: string) {
  return { scheduledAt, deliveredAt, messageId: MessageId(messageId), targetSessionId: SessionId(sessionId) }
}

it('reopens persisted task bindings and coalesces an overdue recurring schedule', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-domain-')); roots.push(root)
  const createdAt = Date.parse('2026-09-16T00:00:00Z')
  const rule = createEveryScheduleRecord(ScheduleId('persisted'), 'Check progress', 300, createdAt, 'Check progress')
  const task = boundTask(SessionId('cold-session'), rule)
  const first = await open(root)
  await first.domain.table('tasks').put(rule.id, task)
  await first.ctx.fiber.dispose()
  const second = await open(root)
  const stored = second.domain.table('tasks').get(rule.id)
  expect(stored).toEqual(task)
  if (stored?.record.kind !== 'every') throw new Error('Expected recurring task')
  expect(resolveEveryOccurrence(stored.record, createdAt + 3_600_000)).toEqual({
    occurrenceAt: '2026-09-16T01:00:00.000Z', nextScheduledAt: '2026-09-16T01:05:00.000Z',
  })
  await second.domain.table('tasks').delete(rule.id)
  await second.ctx.fiber.dispose()
  const third = await open(root)
  expect([...third.domain.table('tasks').entries()]).toEqual([])
})

it('retains an ended task and receipt in JSON storage until explicit deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-ended-')); roots.push(root)
  const rule = createAfterScheduleRecord(ScheduleId('ended'), 'Delivered', 1, Date.parse('2026-09-16T00:00:00Z'), 'Delivered')
  const delivered = receipt('original', rule.scheduledAt, '2026-09-16T00:00:02.000Z', 'delivered-message')
  const task = boundTask(SessionId('original'), rule, {
    status: 'ended', lastDelivery: delivered,
    deliveryHistory: { earlierRecordsUnavailable: false, earlierRecordsPruned: false, records: [{ ...delivered, prompt: 'Delivered' }] },
  })
  const first = await open(root)
  await first.domain.table('tasks').put(rule.id, task)
  await first.ctx.fiber.dispose()
  const second = await open(root)
  expect(second.domain.table('tasks').get(rule.id)).toEqual(task)
  await second.domain.table('tasks').delete(rule.id)
  await second.ctx.fiber.dispose()
  const third = await open(root)
  expect([...third.domain.table('tasks').entries()]).toEqual([])
})

it('reopens active and ended daily tasks with their rules and receipts alongside all three existing kinds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-daily-')); roots.push(root)
  const createdAt = Date.parse('2026-09-16T00:00:00.000Z')
  const daily = createDailyScheduleRecord(ScheduleId('daily-active'), 'Daily check', {
    time: '08:30:00.125', time_zone: 'Asia/Shanghai',
  }, createdAt, 'Daily check')
  const previous = receipt('daily-session', '2026-09-15T00:30:00.125Z', '2026-09-15T00:30:02.000Z', 'previous-daily')
  const final = receipt('ended-session', '9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z', 'final-daily')
  const history = (latest: typeof previous) => ({ records: [latest], earlierRecordsUnavailable: true, earlierRecordsPruned: false })
  const records: ScheduleTask[] = [
    boundTask(SessionId('daily-session'), daily, { lastDelivery: previous, deliveryHistory: history(previous) }),
    boundTask(SessionId('ended-session'), createDailyScheduleRecord(ScheduleId('daily-ended'), 'Final daily', {
      time: '23:59:59.999', time_zone: 'UTC',
    }, Date.parse('9999-12-31T00:00:00.000Z'), 'Final daily'), {
      status: 'ended', lastDelivery: final, deliveryHistory: history(final),
    }),
    boundTask(SessionId('after-session'), createAfterScheduleRecord(ScheduleId('old-after'), 'Delay', 60, createdAt, 'Delay')),
    boundTask(SessionId('at-session'),
      createAtScheduleRecord(ScheduleId('old-at'), 'Absolute', '2026-09-16T01:00:00Z', createdAt, 'Absolute')),
    boundTask(SessionId('every-session'),
      createEveryScheduleRecord(ScheduleId('old-every'), 'Fixed rate', 300, createdAt, 'Fixed rate')),
  ]
  const first = await open(root)
  for (const task of records) await first.domain.table('tasks').put(task.record.id, task)
  await first.ctx.fiber.dispose()
  const second = await open(root)
  expect([...second.domain.table('tasks').entries()]).toHaveLength(records.length)
  for (const task of records) expect(second.domain.table('tasks').get(task.record.id)).toEqual(task)
  const stored = second.domain.table('tasks').get(daily.id)
  if (stored?.record.kind !== 'daily') throw new Error('Expected daily task')
  expect(resolveDailyOccurrence(stored.record, Date.parse('2026-09-18T02:00:00.000Z'))).toEqual({
    occurrenceAt: '2026-09-18T00:30:00.125Z', nextScheduledAt: '2026-09-19T00:30:00.125Z',
  })
  expect(second.domain.table('tasks').get(daily.id)).toEqual(records[0])
})

it('preserves a stored daily zone alias and pinned UTC target across JSON reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-daily-alias-')); roots.push(root)
  const latest = receipt('alias-session', '2026-09-15T14:00:00.000Z', '2026-09-15T14:00:03.000Z', 'alias-receipt')
  const task = boundTask(SessionId('alias-session'), {
    id: ScheduleId('daily-alias'), kind: 'daily', title: 'Preserve stored rule', prompt: 'Preserve stored rule',
    // A stored target need not match the current time-zone database's resolution of the rule.
    time: '09:00:00.000', timeZone: 'US/Eastern', scheduledAt: '2026-09-16T14:00:00.000Z',
  }, { lastDelivery: latest, deliveryHistory: { records: [latest], earlierRecordsUnavailable: true, earlierRecordsPruned: false } })
  const first = await open(root)
  await first.domain.table('tasks').put(task.record.id, task)
  await first.ctx.fiber.dispose()
  const second = await open(root)
  expect(second.domain.table('tasks').get(task.record.id)).toEqual(task)
  await second.ctx.fiber.dispose()
  const third = await open(root)
  expect(third.domain.table('tasks').get(task.record.id)).toEqual(task)
})

it('reopens a weekly task with its stored zone alias, weekday set, receipts, and history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-weekly-alias-')); roots.push(root)
  const previous = receipt('weekly-session', '2026-09-14T12:30:00.125Z', '2026-09-14T12:30:02.000Z', 'previous-weekly')
  const task = boundTask(SessionId('weekly-session'), {
    id: ScheduleId('weekly-alias'), kind: 'weekly', title: 'Weekly check', prompt: 'Weekly check',
    // A stored target need not match the current time-zone database's resolution of the rule.
    time: '08:30:00.125', timeZone: 'US/Eastern', weekdays: [1, 5],
    scheduledAt: '2026-09-18T12:30:00.125Z',
  }, {
    lastDelivery: previous,
    deliveryHistory: { earlierRecordsUnavailable: false, earlierRecordsPruned: false, records: [{ ...previous, prompt: 'Weekly check' }] },
  })
  const first = await open(root)
  await first.domain.table('tasks').put(task.record.id, task)
  await first.ctx.fiber.dispose()
  const second = await open(root)
  expect(second.domain.table('tasks').get(task.record.id)).toEqual(task)
  const stored = second.domain.table('tasks').get(task.record.id)
  if (stored?.record.kind !== 'weekly') throw new Error('Expected weekly task')
  expect(stored.record.timeZone).toBe('US/Eastern')
  expect(stored.record.weekdays).toEqual([1, 5])
  expect(stored.record.scheduledAt).toBe('2026-09-18T12:30:00.125Z')
  expect(resolveWeeklyOccurrence(stored.record, Date.parse('2026-09-18T13:00:00.000Z'))).toEqual({
    occurrenceAt: stored.record.scheduledAt, nextScheduledAt: '2026-09-21T12:30:00.125Z',
  })
  await second.ctx.fiber.dispose()
  const third = await open(root)
  expect(third.domain.table('tasks').get(task.record.id)).toEqual(task)
})

it('reads version-1 tasks without status as active without writing', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Storage)
  const rule = createAfterScheduleRecord(ScheduleId('legacy-task'), 'Pending', 1, Date.parse('2026-09-16T00:00:00Z'), 'Pending')
  const pool = new MemoryMediaPool()
  pool.versions.set('schedule', 1)
  pool.media.set('schedule', {
    tables: new Map([['tasks', new Map([[rule.id, { sessionId: 'original', record: rule }]])]]), global: null,
  })
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  const domain = await facility.open(scheduleDomain)
  ctx.effect(() => () => domain.close())
  expect(domain.table('tasks').get(rule.id)).toMatchObject({
    status: 'active', target: { kind: 'session', sessionId: 'original' }, record: rule,
  })
  expect(pool.versions.get('schedule')).toBe(1)
  expect(pool.media.get('schedule')?.tables.get('tasks')?.get(rule.id)).toEqual({ sessionId: 'original', record: rule })
})

const rule = createAfterScheduleRecord(ScheduleId('validation'), 'Validate', 1, Date.parse('2026-09-16T00:00:00Z'), 'Validate')
const lastDelivery = {
  scheduledAt: rule.scheduledAt, deliveredAt: '2026-09-16T00:00:02.000Z', messageId: 'receipt-message', targetSessionId: 'cold',
}
const stored = boundTask(SessionId('cold'), rule)
const delivered = (latest: unknown) => ({
  ...stored, lastDelivery: latest, deliveryHistory: { records: [latest], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
})

it('accepts every retained status and optional rigorously decoded delivery receipts', () => {
  expect(scheduleTaskSchema.parse(stored)).toEqual(stored)
  for (const status of ['active', 'paused', 'ended']) {
    expect(scheduleTaskSchema.parse({ ...delivered(lastDelivery), status })).toEqual({ ...delivered(lastDelivery), status })
  }
})

it.each([
  null, [], {}, { ...lastDelivery, scheduledAt: undefined }, { ...lastDelivery, deliveredAt: undefined },
  { ...lastDelivery, messageId: undefined }, { ...lastDelivery, messageId: '' },
  { ...lastDelivery, messageId: '  ' }, { ...lastDelivery, messageId: ' message' },
  { ...lastDelivery, messageId: 42 }, { ...lastDelivery, completion: 'done' },
  { ...lastDelivery, targetSessionId: '' },
])('rejects malformed stored delivery receipt %#', (latest) => {
  expect(scheduleTaskSchema.safeParse(delivered(latest)).success).toBe(false)
})

it.each([
  '2026-09-16T00:00:02Z', '2026-09-16T00:00:02.000+00:00', '2026-09-16', 'invalid',
  '0000-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', '2026-02-29T00:00:00.000Z',
  '2026-04-31T00:00:00.000Z', '2026-09-16T24:00:00.000Z', '2026-09-16T00:00:60.000Z',
])('rejects noncanonical or nonexistent stored instant %s', (instant) => {
  for (const key of ['scheduledAt', 'deliveredAt']) {
    expect(scheduleTaskSchema.safeParse(delivered({ ...lastDelivery, [key]: instant })).success).toBe(false)
  }
  for (const key of ['createdAt', 'updatedAt']) {
    expect(scheduleTaskSchema.safeParse({ ...stored, [key]: instant }).success).toBe(false)
  }
})

it('requires the latest saved receipt as the last delivery and accepts empty known history', () => {
  expect(scheduleTaskSchema.safeParse({ ...delivered(lastDelivery), lastDelivery: undefined }).success).toBe(false)
  expect(scheduleTaskSchema.safeParse({ ...stored, lastDelivery }).success).toBe(false)
  expect(scheduleTaskSchema.safeParse({ ...delivered(lastDelivery), lastDelivery: { ...lastDelivery, targetSessionId: 'other' } }).success)
    .toBe(false)
  expect(scheduleTaskSchema.parse(stored).deliveryHistory)
    .toEqual({ records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false })
})

it('accepts append-ordered history despite scheduled and delivered wall-clock rollback', () => {
  const earlier = { ...lastDelivery, scheduledAt: '2026-09-17T00:00:00.000Z', deliveredAt: '2026-09-18T00:00:00.000Z', messageId: 'earlier' }
  const task = { ...stored, status: 'ended', lastDelivery,
    deliveryHistory: { records: [earlier, { ...lastDelivery, prompt: 'Sent prompt' }], earlierRecordsUnavailable: true, earlierRecordsPruned: false } }
  expect(scheduleTaskSchema.parse(task)).toEqual(task)
})

it('rejects malformed persisted schedule values rather than opening a partial task', () => {
  expect(scheduleTaskSchema.safeParse({ ...stored, record: { id: 'invalid' } }).success).toBe(false)
  expect(scheduleTaskSchema.safeParse({ ...stored, target: { kind: 'session', sessionId: '' } }).success).toBe(false)
  for (const status of ['completed', null]) {
    expect(scheduleTaskSchema.safeParse({ ...stored, status }).success).toBe(false)
  }
})

const dailyRecord = {
  id: 'daily-validation', kind: 'daily', title: 'Validate daily', prompt: 'Validate daily',
  time: '08:30:00.125', timeZone: 'Asia/Shanghai', scheduledAt: '2026-09-16T00:30:00.125Z',
}
const ruleSchema = {
  parse: (record: unknown) => scheduleTaskSchema.parse({ record }).record,
  safeParse: (record: unknown) => scheduleTaskSchema.safeParse({ record }),
}

it('accepts the canonical stored daily rule', () => {
  expect(ruleSchema.parse(dailyRecord)).toEqual(dailyRecord)
})

it.each(['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'scheduledAt'])('rejects a stored daily record missing %s', (key) => {
  const incomplete = Object.fromEntries(Object.entries(dailyRecord).filter(([field]) => field !== key))
  expect(ruleSchema.safeParse(incomplete).success).toBe(false)
})

it.each([
  { id: '' }, { id: ' daily' }, { title: '' }, { title: ' untrimmed' }, { prompt: '' }, { prompt: ' untrimmed' },
  { time: null }, { time: 830 }, { timeZone: null }, { timeZone: 8 },
  { scheduledAt: undefined }, { scheduledAt: '2026-09-16T00:30:00Z' },
  { scheduledAt: '2026-02-30T00:30:00.125Z' }, { scheduledAt: '+010000-01-01T00:00:00.000Z' },
  { everySeconds: 300 }, { time_zone: 'Asia/Shanghai' }, { date: '2026-09-16' },
])('rejects malformed or extra durable daily fields %#', (fields) => {
  expect(ruleSchema.safeParse({ ...dailyRecord, ...fields }).success).toBe(false)
})

it.each([
  '', '08:30', '8:30:00.125', '08:30:00', '08:30:00.1', '08:30:00.12', '08:30:00.1234',
  '24:00:00.000', '08:60:00.000', '08:30:60.000', '08:30:00.000Z', ' 08:30:00.125',
])('rejects a noncanonical or nonexistent stored daily time %s', (time) => {
  expect(ruleSchema.safeParse({ ...dailyRecord, time }).success).toBe(false)
})

it.each(['', 'UTC ', ' Asia/Shanghai', 'Not/A_Zone', '+08:00', 'CST'])('rejects an invalid stored daily zone %s', (timeZone) => {
  expect(ruleSchema.safeParse({ ...dailyRecord, timeZone }).success).toBe(false)
})

it.each([
  {},
  // Otherwise-valid record written before titles existed: the domain open rejects the whole table.
  Object.fromEntries(Object.entries(dailyRecord).filter(([field]) => field !== 'title')),
  { ...dailyRecord, time: '24:00:00.000' },
  { ...dailyRecord, timeZone: 'Not/A_Zone' },
  { ...dailyRecord, time_zone: 'Asia/Shanghai' },
])('rejects an invalid durable task while opening the domain %#', async (invalidRule) => {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  const first = await facility.open(scheduleDomain)
  await first.close()
  const valid = boundTask(SessionId('cold'), decodeScheduleRecord(dailyRecord))
  pool.media.get(scheduleDomain.name)!.tables.set('tasks', new Map([['broken', { ...valid, record: invalidRule }]]))
  const reopened = new DomainFacility(ctx, { backend: 'memory' })
  await expect(reopened.open(scheduleDomain)).rejects.toMatchObject({ code: 'invalid-record', detail: { key: 'broken' } })
})
