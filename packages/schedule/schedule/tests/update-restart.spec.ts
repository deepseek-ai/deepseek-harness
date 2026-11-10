/** Real JSON task files retain timing edits and unchanged delivery history across Host restarts. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDailyScheduleRecord, ScheduleId } from '../src/domain.ts'
import type { ScheduleTask } from '../src/storage.ts'
import { boundTask, harness, seedTasks, storedUnit } from './harness.ts'

const contexts: Context[] = []
const roots: string[] = []
const NOW = '2026-09-16T00:00:00.000Z'
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup(root: string, task?: ScheduleTask) {
  return harness({
    backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx),
    ...(task === undefined ? {} : { beforeService: (_ctx, facility) => seedTasks(facility, [task]) }),
  })
}

it.each([true, false])('persists same-ID daily edits of a version-1 task with saved history=%s without Session activation', async (withHistory) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-update-'))
  roots.push(root)
  const sessionId = SessionId('cold-original')
  const id = ScheduleId('daily-stable-id')
  const record = createDailyScheduleRecord(id, 'Retained exact prompt\nsecond line', {
    time: '09:00:00.250', time_zone: 'UTC',
  }, Date.now(), 'Retained exact prompt')
  const lastDelivery = {
    scheduledAt: '2026-09-15T09:00:00.250Z', deliveredAt: '2026-09-15T09:00:01.333Z', messageId: MessageId('saved'),
  }
  // The earlier Host store saved each task in one whole-unit JSON file, with optional delivery history.
  const earlierFile = join(root, 'schedule.json')
  const earlierText = `${JSON.stringify({
    unit: { name: 'schedule', version: 1 },
    global: null,
    tables: { tasks: { [id]: {
      sessionId, record, status: 'active', lastDelivery,
      ...(withHistory ? {
        deliveryHistory: { earlierRecordsUnavailable: false, records: [{ ...lastDelivery, prompt: record.prompt }] },
      } : {}),
    } } },
  }, null, 2)}\n`
  await writeFile(earlierFile, earlierText, 'utf8')
  const first = await setup(root)
  const file = join(root, 'schedule.json')
  const result = await first.service.edit({ id, action: 'update', expectedUpdatedAt: null, patch: { timing: { kind: 'daily', daily: { time: '10:00:00.125', time_zone: 'Asia/Shanghai' } } } })
  const updated = { ...record, time: '10:00:00.125', timeZone: 'Asia/Shanghai', scheduledAt: '2026-09-16T02:00:00.125Z' }
  expect(result).toMatchObject(updated)
  const bytes = await readFile(file, 'utf8')
  const receipt = { ...lastDelivery, targetSessionId: sessionId }
  const saved = storedUnit(bytes).tables.tasks[id]!
  expect(saved).toEqual({ record: updated, target: { kind: 'session', sessionId }, involvedSessionIds: [sessionId],
    status: 'active', updatedAt: NOW, lastDelivery: receipt,
    deliveryHistory: withHistory
      ? { records: [{ ...receipt, prompt: record.prompt }], earlierRecordsUnavailable: false, earlierRecordsPruned: false }
      : { records: [receipt], earlierRecordsUnavailable: true, earlierRecordsPruned: false },
  })
  expect(saved).not.toHaveProperty('sessionId')
  expect(first.resolve).not.toHaveBeenCalled()
  expect(first.flush).not.toHaveBeenCalled()
  await first.ctx.fiber.dispose()
  const second = await setup(root)
  expect((await second.service.list({ active: true })).items).toMatchObject([updated])
  expect(await second.service.catalog()).toMatchObject([{ ...updated, target: { kind: 'session', sessionId }, status: 'active', lastDelivery: receipt }])
  expect(await second.service.history({ id, limit: 100 })).toEqual({
    id, records: withHistory ? [{ ...receipt, prompt: record.prompt }] : [receipt],
    earlierRecordsUnavailable: !withHistory, earlierRecordsPruned: false, retention: { days: 30, records: 200 },
  })
  const changed = vi.fn()
  second.ctx.on('schedule/changed', changed)
  vi.setSystemTime(new Date('2026-09-16T01:00:00Z'))
  expect(await second.service.edit({ id, action: 'update', patch: { timing: { kind: 'daily', daily: { time: '10:00:00.125', time_zone: 'Asia/Shanghai' } } } }))
    .toMatchObject(updated)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(storedUnit(await readFile(file, 'utf8')).tables.tasks[id]!.record).toEqual(updated)
  expect(second.resolve).not.toHaveBeenCalled()
  await second.ctx.fiber.dispose()
  expect(storedUnit(await readFile(file, 'utf8')).tables.tasks[id]!.record).toEqual(updated)
})

it('keeps stored IANA alias spelling and a pinned millisecond target byte-identical on a daily no-op', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-update-alias-'))
  roots.push(root)
  const id = ScheduleId('alias')
  const sessionId = SessionId('alias-session')
  const rule = {
    id, kind: 'daily', title: 'Pinned target', prompt: 'Pinned target', time: '09:00:00.100',
    timeZone: 'US/Eastern', scheduledAt: '2026-09-16T14:00:00.321Z',
  } as const
  const test = await setup(root, boundTask(sessionId, rule))
  const file = join(root, 'schedule.json')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  expect(await test.service.edit({ id, action: 'update', patch: { timing: { kind: 'daily', daily: { time: '09:00:00.1', time_zone: 'America/New_York' } } } }))
    .toMatchObject(rule)
  expect(storedUnit(await readFile(file, 'utf8')).tables.tasks[id]!.record).toEqual(rule)
  expect(changed).toHaveBeenCalledTimes(1)
  await test.ctx.fiber.dispose()
  const restarted = await setup(root)
  expect((await restarted.service.list({ active: true })).items).toMatchObject([rule])
  expect(storedUnit(await readFile(file, 'utf8')).tables.tasks[id]!.record).toEqual(rule)
})
