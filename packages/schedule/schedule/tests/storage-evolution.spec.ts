/** Existing Host rows and current rows share one versioned store without a startup migration. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  ScheduleId, createAfterScheduleRecord, createAtScheduleRecord, createEveryScheduleRecord,
  createDailyScheduleRecord, createWeeklyScheduleRecord, createCronScheduleRecord, createRRuleScheduleRecord,
} from '../src/domain.ts'
import { agentFor, harness, storedUnit } from './harness.ts'

const roots: string[] = []
const contexts: Context[] = []
const NOW = Date.parse('2026-09-16T00:00:00.000Z')
const id = ScheduleId('retained')
const cron = createCronScheduleRecord(id, 'Audit', { expression: '0 9 1 * 1', time_zone: 'UTC' }, NOW, 'Audit')

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function store(task: unknown, version = 1) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-evolution-'))
  roots.push(root)
  const file = join(root, 'schedule.json')
  const bytes = JSON.stringify({ unit: { name: 'schedule', version }, global: null, tables: { tasks: { [id]: task } } }, null, 2)
  await writeFile(file, bytes)
  const open = () => harness({ direct: true, backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  return { root, file, bytes, open }
}

it.each([
  createAfterScheduleRecord(id, 'Audit', 3600, NOW, 'Audit'),
  createAtScheduleRecord(id, 'Audit', '2026-09-16T01:00:00Z', NOW, 'Audit'),
  createEveryScheduleRecord(id, 'Audit', 61, NOW, 'Audit'),
  createDailyScheduleRecord(id, 'Audit', { time: '09:00:00.123', time_zone: 'Asia/Shanghai' }, NOW, 'Audit'),
  createWeeklyScheduleRecord(id, 'Audit', { time: '09:00:01', time_zone: 'UTC', weekdays: [1, 5] }, NOW, 'Audit'),
  cron,
  createRRuleScheduleRecord(id, 'Audit', 'Audit', 'DTSTART:20260916T090000Z\nRRULE:FREQ=DAILY', NOW),
])('reads $kind unchanged and writes the current row shape on an equivalent edit', async (record) => {
  const saved = await store({ record, sessionId: 'original' })
  const first = await saved.open()
  expect(await first.service.view({ id })).toMatchObject({ ...record, target: { kind: 'session', sessionId: 'original' }, status: 'active' })
  expect(await readFile(saved.file, 'utf8')).toBe(saved.bytes)
  expect(first.stat).not.toHaveBeenCalled()
  const edited = await first.service.edit({ id, action: 'update', patch: { title: record.title }, expectedUpdatedAt: null })
  expect(edited).toMatchObject(record)
  const document = storedUnit(await readFile(saved.file, 'utf8'))
  expect(document.unit).toEqual({ name: 'schedule', version: 2 })
  expect(document.global).toBeNull()
  const row = document.tables.tasks[id]!
  expect(row.record).toEqual(record)
  expect(row.target).toEqual({ kind: 'session', sessionId: 'original' })
  expect(row).not.toHaveProperty('sessionId')
  expect(row).not.toHaveProperty('legacyRule')
  expect(row).not.toHaveProperty('createdAt')
  expect(await readdir(saved.root)).toEqual(['schedule.json'])
  await expect(first.service.edit({ id, action: 'update', patch: { title: 'Stale' }, expectedUpdatedAt: null }))
    .resolves.toEqual({ id, code: 'schedule_conflict' })
  await first.ctx.fiber.dispose()
  const second = await saved.open()
  expect(await second.service.view({ id })).toEqual(edited)
  expect(second.resolve).not.toHaveBeenCalled()
})

it('ignores a former Session binding when an explicit target exists', async () => {
  const saved = await store({ record: cron, sessionId: { ignored: true }, target: { kind: 'session', sessionId: 'chosen' } })
  const test = await saved.open()
  expect(await test.service.view({ id })).toMatchObject({ target: { kind: 'session', sessionId: 'chosen' } })
  expect(await readFile(saved.file, 'utf8')).toBe(saved.bytes)
  await test.service.edit({ id, action: 'update', patch: { title: 'Edited' } })
  expect(storedUnit(await readFile(saved.file, 'utf8')).tables.tasks[id]!).not.toHaveProperty('sessionId')
})

it('reserves one stable default destination across reads, restart, creation, and reuse', async () => {
  const saved = await store({ record: cron })
  const first = await saved.open()
  const before = await first.service.view({ id })
  if ('code' in before || before.target.kind !== 'new_once') throw new Error('expected a create-once target')
  const reserved = before.target.sessionId
  expect((await first.service.view({ id }))).toEqual(before)
  await first.ctx.fiber.dispose()
  const second = await saved.open()
  expect(await second.service.view({ id })).toEqual(before)
  expect(await readFile(saved.file, 'utf8')).toBe(saved.bytes)
  const agent = agentFor(second.ctx, reserved)
  second.resolve.mockResolvedValueOnce({ error: new RemoteError('session/not-found', 'missing Session', { sessionId: reserved }) }).mockResolvedValue({ agent })
  expect(await second.service.run({ id })).toMatchObject({ target: { kind: 'session', sessionId: reserved } })
  expect(second.createSession).toHaveBeenCalledTimes(1)
  expect(second.createSession.mock.calls[0]?.[0]).toMatchObject({ sessionId: reserved })
  await vi.advanceTimersByTimeAsync(60_000)
  await second.service.run({ id })
  expect(second.createSession).toHaveBeenCalledTimes(1)
  expect(agent.followup).toHaveBeenCalledTimes(2)
})

it('retains the original destinations and unavailable-history flag before retargeting an old receipt', async () => {
  const receipt = { scheduledAt: '2026-09-15T09:00:00.000Z', deliveredAt: '2026-09-15T09:00:01.000Z', messageId: 'old-delivery' }
  const saved = await store({ record: cron, sessionId: 'original', lastDelivery: receipt })
  const test = await saved.open()
  await test.service.edit({ id, action: 'update', patch: { target: { kind: 'new' } } })
  expect(await test.service.history({ id, limit: 10 })).toMatchObject({
    records: [{ ...receipt, targetSessionId: 'original' }], earlierRecordsUnavailable: true, earlierRecordsPruned: false,
  })
  const row = storedUnit(await readFile(saved.file, 'utf8')).tables.tasks[id]!
  expect(row.lastDelivery).toEqual({ ...receipt, targetSessionId: 'original' })
  expect(row.deliveryHistory.records).toEqual([{ ...receipt, targetSessionId: 'original' }])
})

it('delivers an existing Cron rule normally with Vixie day-of-month/day-of-week OR semantics', async () => {
  const saved = await store({ record: { ...cron, scheduledAt: '2026-10-01T09:00:00.000Z' }, sessionId: 'original' })
  const test = await saved.open()
  const agent = agentFor(test.ctx, 'original')
  test.resolve.mockResolvedValue({ agent })
  await vi.advanceTimersByTimeAsync(Date.parse('2026-10-01T09:00:00Z') - NOW)
  expect(agent.followup).toHaveBeenCalledTimes(1)
  await vi.waitFor(async () => {
    expect(await test.service.view({ id })).toMatchObject({ kind: 'cron', expression: cron.expression, timeZone: 'UTC', scheduledAt: '2026-10-05T09:00:00.000Z' })
  })
  const document = storedUnit(await readFile(saved.file, 'utf8'))
  expect(document.unit).toEqual({ name: 'schedule', version: 2 })
  expect(document.tables.tasks[id]).not.toHaveProperty('sessionId')
  expect(document.tables.tasks[id]?.record.kind).toBe('cron')
})

it('keeps v1 bytes after an invalid timing replacement and upgrades on a valid Save', async () => {
  const saved = await store({ record: cron })
  const test = await saved.open()
  for (const timing of [
    { kind: 'cron', cron: { expression: '', time_zone: 'UTC' } } as const,
    { kind: 'rrule', rrule: '' } as const,
    { kind: 'rrule', rrule: 'DTSTART:20260916T090000Z\nRRULE:FREQ=SECONDLY' } as const,
  ]) {
    await expect(test.service.edit({ id, action: 'update', patch: { timing } })).rejects.toThrow()
    expect(await readFile(saved.file, 'utf8')).toBe(saved.bytes)
  }
  await test.service.edit({ id, action: 'update', patch: { title: cron.title }, expectedUpdatedAt: null })
  const document = storedUnit(await readFile(saved.file, 'utf8'))
  expect(document.unit).toEqual({ name: 'schedule', version: 2 })
  expect(document.tables.tasks[id]?.record).toEqual(cron)
})

it('recognizes inactive rows as ended and resumes Cron through its normal evaluator', async () => {
  const saved = await store({ record: cron, sessionId: 'original', status: 'inactive' })
  const test = await saved.open()
  expect(await test.service.view({ id })).toMatchObject({ status: 'ended' })
  vi.setSystemTime('2026-10-02T00:00:00Z')
  expect(await test.service.edit({ id, action: 'update', patch: { active: true } }))
    .toMatchObject({ kind: 'cron', status: 'active', expression: cron.expression, scheduledAt: '2026-10-05T09:00:00.000Z' })
})

it.each([0, 3])('rejects an unsupported envelope version %s without modifying the old store', async (version) => {
  const saved = await store({ record: cron, sessionId: 'original' }, version)
  await expect(saved.open()).rejects.toThrow()
  expect(await readFile(saved.file, 'utf8')).toBe(saved.bytes)
})

it('rejects a corrupt Session binding without changing storage', async () => {
  const saved = await store({ record: cron, sessionId: '' })
  await expect(saved.open()).rejects.toThrow()
  expect(await readFile(saved.file, 'utf8')).toBe(saved.bytes)
})

it.each([undefined, { kind: 'new_once' }, { kind: 'new' }])('refuses to invent a historical receipt destination for %j', async (target) => {
  const saved = await store({ record: cron, ...(target === undefined ? {} : { target }), lastDelivery: {
    scheduledAt: '2026-09-15T09:00:00.000Z', deliveredAt: '2026-09-15T09:00:01.000Z', messageId: 'unknown-destination',
  } })
  await expect(saved.open()).rejects.toThrow()
  expect(await readFile(saved.file, 'utf8')).toBe(saved.bytes)
})

it('normalizes the edited row while leaving another old row untouched in the same envelope', async () => {
  const first = { record: cron, sessionId: 'original' }
  const second = { record: { ...cron, id: 'untouched' }, sessionId: 'other' }
  const saved = await store(first)
  await writeFile(saved.file, JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null,
    tables: { tasks: { [id]: first, untouched: second } } }))
  const test = await saved.open()
  await test.service.edit({ id, action: 'update', patch: { title: 'Edited' } })
  const rows = storedUnit(await readFile(saved.file, 'utf8')).tables.tasks
  expect(rows[id]).not.toHaveProperty('sessionId')
  expect(rows.untouched).toEqual(second)
  await test.ctx.fiber.dispose()
  const reopened = await saved.open()
  expect(await reopened.service.view({ id: ScheduleId('untouched') })).toMatchObject({
    ...second.record, target: { kind: 'session', sessionId: 'other' },
  })
  await reopened.service.edit({ id: ScheduleId('untouched'), action: 'update', patch: { title: 'Now edited' } })
  const current = storedUnit(await readFile(saved.file, 'utf8'))
  expect(current.unit).toEqual({ name: 'schedule', version: 2 })
  expect(current.tables.tasks.untouched).not.toHaveProperty('sessionId')
  expect(current.tables.tasks.untouched?.target).toEqual({ kind: 'session', sessionId: 'other' })
})

it.each([cron, createRRuleScheduleRecord(id, 'Audit', 'Audit', 'DTSTART:20260916T090000Z\nRRULE:FREQ=DAILY', NOW)]
  .flatMap(record => [{ record, target: { kind: 'new_once' } as const }, { record, target: { kind: 'new' } as const }]))(
  'reads and edits a v2 $record.kind row with $target.kind without changing its timing type', async ({ record, target }) => {
    const saved = await store({ record, target }, 2)
    const test = await saved.open()
    expect(await test.service.view({ id })).toMatchObject({ ...record, target: { kind: target.kind },
      involvedSessionIds: target.kind === 'new' ? [] : [expect.any(String)] })
    expect(await readFile(saved.file, 'utf8')).toBe(saved.bytes)
    await test.service.edit({ id, action: 'update', patch: { title: 'Current' } })
    expect(storedUnit(await readFile(saved.file, 'utf8')).tables.tasks[id]?.record).toEqual({ ...record, title: 'Current' })
  },
)
