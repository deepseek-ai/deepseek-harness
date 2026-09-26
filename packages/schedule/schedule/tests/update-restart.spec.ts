/** Real JSON task files retain timing edits and unchanged delivery history across Host restarts. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDailyScheduleRecord, ScheduleId } from '../src/domain.ts'
import { scheduleDomain, type ScheduleTask } from '../src/storage.ts'
import { harness } from './harness.ts'

const contexts: Context[] = []
const roots: string[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00Z')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup(root: string, task?: ScheduleTask) {
  return harness({
    backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx),
    beforeService: async (_ctx, facility) => {
      if (task === undefined) return
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(task.record.id, task)
      await domain.close()
    },
  })
}

it.each([true, false])('persists same-ID daily edits with saved history=%s without Session activation', async (withHistory) => {
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
  const task: ScheduleTask = {
    sessionId, record, status: 'active', lastDelivery,
    ...(withHistory ? {
      deliveryHistory: { earlierRecordsUnavailable: false, records: [{ ...lastDelivery, prompt: record.prompt }] },
    } : {}),
  }
  const first = await setup(root, task)
  const file = join(root, 'schedule.json')
  const result = await first.service.update({
    sessionId, id, expected: record, change: { kind: 'daily', daily: { time: '10:00:00.125', time_zone: 'Asia/Shanghai' } },
  })
  const updated = { ...record, time: '10:00:00.125', timeZone: 'Asia/Shanghai', scheduledAt: '2026-09-16T02:00:00.125Z' }
  expect(result).toEqual({ id, updated: true, record: updated })
  const bytes = await readFile(file, 'utf8')
  expect(JSON.parse(bytes)).toEqual({
    unit: { name: 'schedule', version: 1 },
    global: null,
    tables: { tasks: { [id]: { ...task, record: updated } } },
  })
  expect(first.resolve).not.toHaveBeenCalled()
  expect(first.flush).not.toHaveBeenCalled()
  await first.ctx.fiber.dispose()
  const second = await setup(root)
  expect(await second.service.list({ sessionId })).toEqual([updated])
  expect(await second.service.catalog()).toEqual([{ ...updated, sessionId, status: 'active', lastDelivery }])
  expect(await second.service.history({ sessionId, id, limit: 100 })).toEqual({
    id, records: withHistory ? [{ ...lastDelivery, prompt: record.prompt }] : [lastDelivery],
    earlierRecordsUnavailable: !withHistory, earlierRecordsPruned: false, retention: { days: 30, records: 200 },
  })
  const changed = vi.fn()
  second.ctx.on('schedule/changed', changed)
  vi.setSystemTime(new Date('2026-09-16T01:00:00Z'))
  expect(await second.service.update({
    sessionId, id, expected: updated, change: { kind: 'daily', daily: { time: '10:00:00.125', time_zone: 'Asia/Shanghai' } },
  })).toEqual({ id, updated: false, record: updated })
  expect(changed).not.toHaveBeenCalled()
  expect(await readFile(file, 'utf8')).toBe(bytes)
  expect(second.resolve).not.toHaveBeenCalled()
  await second.ctx.fiber.dispose()
  expect(await readFile(file, 'utf8')).toBe(bytes)
})

it('keeps stored IANA alias spelling and a pinned millisecond target byte-identical on a daily no-op', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-update-alias-'))
  roots.push(root)
  const id = ScheduleId('alias')
  const sessionId = SessionId('alias-session')
  const task: ScheduleTask = {
    sessionId, status: 'active',
    record: { id, kind: 'daily', title: 'Pinned target', prompt: 'Pinned target', time: '09:00:00.100',
      timeZone: 'US/Eastern', scheduledAt: '2026-09-16T14:00:00.321Z' },
  }
  const test = await setup(root, task)
  const file = join(root, 'schedule.json')
  const bytes = await readFile(file, 'utf8')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  expect(await test.service.update({
    sessionId, id, expected: task.record, change: { kind: 'daily', daily: { time: '09:00:00.1', time_zone: 'America/New_York' } },
  })).toEqual({ id, updated: false, record: task.record })
  expect(await readFile(file, 'utf8')).toBe(bytes)
  expect(changed).not.toHaveBeenCalled()
  await test.ctx.fiber.dispose()
  const restarted = await setup(root)
  expect(await restarted.service.list({ sessionId })).toEqual([task.record])
  expect(await readFile(file, 'utf8')).toBe(bytes)
})
