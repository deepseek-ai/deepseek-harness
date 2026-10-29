/** Registered Schedule startup reads real task files without hiding or rewriting failed records. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import ScheduleService from '../src/index.ts'
import { scheduleDomain, type ScheduleTask } from '../src/storage.ts'
import { createAfterScheduleRecord, ScheduleId } from '../src/domain.ts'
import { ScheduleRuntime } from '../src/runtime.ts'
import { agentFor, boundTask, harness, taskTable, storedUnit } from './harness.ts'

const roots: string[] = []
const contexts: Context[] = []
const NOW = '2026-09-16T00:00:00.000Z'
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)) })
afterEach(async () => {
  const errors: unknown[] = []
  for (const ctx of contexts.splice(0)) {
    try { await ctx.fiber.dispose() } catch (error) { errors.push(error) }
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Schedule recovery cleanup failed')
})
/** Create a root whose earlier Host store, one whole-unit file, holds the given tasks or bytes. */
async function rootWith(tasks: Record<string, unknown>, bytes?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-recovery-'))
  roots.push(root)
  const path = join(root, 'schedule.json')
  if (bytes !== undefined || Object.keys(tasks).length > 0) {
    await writeFile(path, bytes ?? encoded(tasks))
  }
  return { root, path }
}
function encoded(tasks: Record<string, unknown>, version = 1) {
  return `${JSON.stringify({ unit: { name: 'schedule', version }, global: null, tables: { tasks } }, null, 2)}\n`
}
/** Read the authoritative whole-unit task table. */
async function savedTasks(root: string): Promise<Record<string, unknown>> {
  return storedUnit(await readFile(join(root, 'schedule.json'), 'utf8')).tables.tasks
}
const oldTask = {
  sessionId: 'original',
  record: {
    id: 'a-good', kind: 'after', title: 'Old due reminder', prompt: 'Old due reminder', afterSeconds: 60,
    scheduledAt: '2026-09-15T23:59:59.000Z',
  },
}
const repairedTask = {
  sessionId: 'original', status: 'inactive',
  record: {
    id: 'z-broken', kind: 'at', title: 'Retained receipt', prompt: 'Retained receipt',
    scheduledAt: '2026-09-15T20:00:00.000Z',
  },
  lastDelivery: {
    scheduledAt: '2026-09-15T20:00:00.000Z', deliveredAt: '2026-09-15T20:00:01.000Z', messageId: 'original-message',
  },
}

it.each([
  ['{broken json', 'malformed-medium'],
  [encoded({ 'a-good': oldTask, 'z-broken': repairedTask }, 3), 'version-mismatch'],
  [encoded({ 'a-good': oldTask, 'z-broken': { invalid: true } }), 'invalid-record'],
])('rejects startup on an invalid store without writes and reads it after repair %#', async (broken, code) => {
  const { root, path } = await rootWith({}, broken)
  let observed: {
    ctx: Context
    facility: DomainFacility
    agent: ReturnType<typeof agentFor>
    resolveCalls: () => number
  } | undefined
  const changed = vi.fn()
  await expect(harness({
    backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx),
    beforeService: async (ctx, facility) => {
      const agent = agentFor(ctx)
      ctx.effect(() => ctx.agents.enter(agent, undefined))
      ctx.on('schedule/changed', changed)
      const resolve = vi.spyOn(ctx.sessionController, 'resolveAgent')
      observed = { ctx, facility, agent, resolveCalls: () => resolve.mock.calls.length }
    },
  }).then(() => 'Schedule activated')).rejects.toMatchObject({ code })
  if (observed === undefined) throw new Error('Schedule dependencies did not initialize')
  const { ctx, facility, agent } = observed
  expect(ctx.get('schedule')).toBeUndefined()
  expect(facility.get(scheduleDomain.name)).toBeUndefined()
  expect(facility.get('schedule')).toBeUndefined()
  expect(ctx.tools.get('schedule_create', agent)).toBeUndefined()
  await vi.advanceTimersByTimeAsync(0)
  expect(observed.resolveCalls()).toBe(0)
  expect(changed).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  expect(await readFile(path, 'utf8')).toBe(broken)
  const repaired = encoded({ 'a-good': oldTask, 'z-broken': repairedTask })
  await writeFile(path, repaired)
  await ctx.plugin(ScheduleService)
  expect(taskTable(ctx).get(ScheduleId('a-good'))).toMatchObject({ status: 'active', record: oldTask.record })
  // A delivered one-shot rule ends; its receipt now names the Session that accepted it.
  expect(taskTable(ctx).get(ScheduleId('z-broken'))).toMatchObject({
    status: 'ended', lastDelivery: { ...repairedTask.lastDelivery, targetSessionId: 'original' },
  })
  expect(await ctx.schedule.catalog()).toHaveLength(2)
  expect(await readFile(path, 'utf8')).toBe(repaired)
})

it.each([
  ['{broken json', 'malformed-medium'],
  [3, 'version-mismatch'],
  [{ status: 'inactive' }, 'invalid-record'],
] as const)('rejects startup on an invalid task file without rewriting it and starts after repair %#', async (
  broken,
  code,
) => {
  const { root } = await rootWith({})
  const rule = createAfterScheduleRecord(ScheduleId('kept'), 'Keep me', 60, Date.now(), 'Keep me')
  const valid: ScheduleTask = boundTask(SessionId('original'), rule)
  const file = join(root, 'schedule.json')
  const bytes = typeof broken === 'string' ? broken
    : typeof broken === 'number' ? encoded({ kept: valid }, broken) : encoded({ kept: { ...valid, record: undefined, ...broken } })
  await writeFile(file, bytes)
  await expect(harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) }))
    .rejects.toMatchObject({ code })
  expect(vi.getTimerCount()).toBe(0)
  expect(await readFile(file, 'utf8')).toBe(bytes)

  await writeFile(file, encoded({ kept: valid }))
  const repaired = await harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  expect((await repaired.service.list({ active: true })).items).toMatchObject([rule])
})

it.each([
  null, [], {}, { records: [], earlierRecordsUnavailable: 'true' },
  { records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: 'true' },
  { records: [], earlierRecordsUnavailable: false, extra: true },
  { records: [repairedTask.lastDelivery], earlierRecordsUnavailable: undefined },
  { records: [{ ...repairedTask.lastDelivery, prompt: 42 }], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, extra: true }], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, messageId: ' padded ' }], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, deliveredAt: '2026-02-30T00:00:00.000Z' }], earlierRecordsUnavailable: false },
  { records: [repairedTask.lastDelivery, repairedTask.lastDelivery], earlierRecordsUnavailable: false },
  { records: [], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, messageId: 'different' }], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, scheduledAt: '2026-09-15T19:00:00.000Z' }], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, deliveredAt: '2026-09-15T19:00:00.000Z' }], earlierRecordsUnavailable: false },
])('rejects malformed or inconsistent earlier history without rewriting the earlier file %#', async (deliveryHistory) => {
  const bytes = encoded({ 'z-broken': { ...repairedTask, deliveryHistory } })
  const { root, path } = await rootWith({}, bytes)
  await expect(harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) }))
    .rejects.toMatchObject({ code: 'invalid-record', detail: { table: 'tasks', key: 'z-broken' } })
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

it.each([true, false])('reads earlier history with receipt=%s without rewriting the earlier file', async (hasReceipt) => {
  const legacy = hasReceipt ? repairedTask : { ...oldTask, status: 'inactive' }
  const taskId = ScheduleId(legacy.record.id)
  const bytes = encoded({ [taskId]: legacy })
  const { root, path } = await rootWith({}, bytes)
  const test = await harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  expect(await test.service.history({ id: taskId, limit: 100 })).toEqual({
    id: taskId, records: hasReceipt ? [{ ...repairedTask.lastDelivery, targetSessionId: 'original' }] : [], earlierRecordsUnavailable: true,
    earlierRecordsPruned: false, retention: { days: 30, records: 200 },
  })
  // Only a delivered one-shot rule ends; an inactive rule without a delivery pauses.
  expect(taskTable(test.ctx).get(taskId)?.status).toBe('ended')
  expect(changed).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe(bytes)
  await test.ctx.fiber.dispose()
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

it.each(['create', 'delete'] as const)('returns the durable %s result when an ancestor unloads before dispatch admission', async (operation) => {
  const future = { ...oldTask, record: { ...oldTask.record, scheduledAt: '2026-09-17T00:00:00.000Z' } }
  const { root, path } = await rootWith(operation === 'delete' ? { 'a-good': future } : {})
  const test = await harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  await vi.advanceTimersByTimeAsync(0)
  const admission = vi.spyOn(test.ctx.agents, 'withoutInitiator')
  const warning = vi.spyOn(test.ctx.logger, 'warn')
  const stop = vi.spyOn(ScheduleRuntime.prototype, 'dispose')
  let unloading: Promise<void> | undefined
  let cleanupHadStarted: boolean | undefined
  test.ctx.on('schedule/changed', () => {
    unloading = test.ctx.fiber.dispose()
    cleanupHadStarted = stop.mock.calls.length !== 0
  })
  const mutation = operation === 'create'
    ? test.service.create({ prompt: 'Accepted before unload', title: 'Accepted before unload', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: SessionId('original') } }, SessionId('original'))
    : test.service.edit({ action: 'delete', id: ScheduleId('a-good') })
  const outcome = await mutation.then(value => ({ value }), (error: unknown) => ({ error }))
  await unloading
  expect(cleanupHadStarted).toBe(false)
  const stored = await savedTasks(root)
  if (operation === 'create') {
    expect(outcome).not.toHaveProperty('error')
    if (!('value' in outcome) || !('kind' in outcome.value)) throw new Error('Accepted creation did not return its record')
    expect(outcome.value).toMatchObject({ prompt: 'Accepted before unload', kind: 'after' })
    expect(Object.keys(stored)).toEqual([outcome.value.id])
    expect(stored[outcome.value.id]).toMatchObject({ record: { id: outcome.value.id, kind: 'after', title: outcome.value.title, prompt: outcome.value.prompt },
      target: { kind: 'session', sessionId: 'original' }, status: 'active' })

  } else {
    expect(stored).toEqual({})
    expect(outcome).toEqual({ value: { id: 'a-good', deleted: true } })
    // Deleting the imported copy leaves the earlier store unchanged.
    expect(storedUnit(await readFile(path, 'utf8')).tables.tasks).toEqual({})
  }
  expect(admission).toHaveBeenCalledTimes(1)
  expect(admission.mock.results[0]).toMatchObject({ type: 'throw' })
  expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('agent initiator scope is disposed'))
  expect(test.resolve).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(86_400_000)
  expect(admission).toHaveBeenCalledTimes(1)
  expect(test.resolve).not.toHaveBeenCalled()
})

it('supports explicit initialization of a directly constructed service', async () => {
  const { root } = await rootWith({})
  const test = await harness({ direct: true, backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  expect(await test.service.catalog()).toEqual([])
  expect(test.resolve).not.toHaveBeenCalled()
})

it('logs startup dispatch admission failure without rejecting initialized storage', async () => {
  const { root } = await rootWith({})
  let facility: DomainFacility | undefined
  let admission: MockInstance<Context['agents']['withoutInitiator']> | undefined
  const test = await harness({
    backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx),
    beforeService: async (ctx, storage) => {
      facility = storage
      vi.spyOn(ctx.logger, 'warn')
      admission = vi.spyOn(ctx.agents, 'withoutInitiator').mockImplementationOnce(() => { throw new Error('startup dispatch failed') })
    },
  })
  expect(test.ctx.logger.warn).toHaveBeenCalledExactlyOnceWith('schedule: dispatch stopped: Error: startup dispatch failed')
  expect(await test.service.catalog()).toEqual([])
  expect(facility?.get(scheduleDomain.name)).toBeDefined()
  expect(vi.getTimerCount()).toBe(0)
  await test.service.create({ prompt: 'Explicit later wake', title: 'Explicit later wake', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: SessionId('original') } }, SessionId('original'))
  await vi.advanceTimersByTimeAsync(0)
  expect(admission).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
  await test.ctx.fiber.dispose()
  expect(facility?.get(scheduleDomain.name)).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not start dispatch when storage opens after its owner begins unloading', async () => {
  const { root, path } = await rootWith({ 'a-good': oldTask })
  const acquired = Promise.withResolvers<{
    ctx: Context
    facility: DomainFacility
    launches: () => number
    unload: () => Promise<void>
  }>()
  const release = Promise.withResolvers<undefined>()
  const startup = harness({
    backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx),
    beforeService: async (ctx, facility) => {
      const launch = vi.spyOn(ctx.agents, 'withoutInitiator')
      const install = vi.spyOn(ctx, 'plugin')
      const open = facility.open.bind(facility)
      vi.spyOn(facility, 'open').mockImplementationOnce(async (spec) => {
        const domain = await open(spec)
        acquired.resolve({
          ctx, facility, launches: () => launch.mock.calls.length,
          unload: async () => {
            const result = install.mock.results[0]
            if (result?.type !== 'return') throw new Error('Schedule registration did not return a plugin handle')
            await result.value.dispose()
          },
        })
        await release.promise
        return domain
      })
    },
  })
  let startupFailure = ''
  const settled = startup.then(() => undefined, (error: unknown) => { startupFailure = String(error) })
  try {
    const { ctx, facility, launches, unload } = await acquired.promise
    const disposed = unload()
    release.resolve(undefined)
    await disposed
    await settled
    expect(ctx.get('storageDomain') === facility).toBe(true)
    expect(launches()).toBe(0)
    expect(startupFailure).toBe('')
    expect(facility.get(scheduleDomain.name)).toBeUndefined()
    expect(facility.get('schedule')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    // The import finished before activation failed; the next startup reads the copied task.
    const reopened = await facility.open(scheduleDomain)
    expect(reopened.table('tasks').get(ScheduleId('a-good'))).toMatchObject({ status: 'active', record: oldTask.record })
    await reopened.close()
    expect(await readFile(path, 'utf8')).toBe(encoded({ 'a-good': oldTask }))
  } finally {
    release.resolve(undefined)
    await settled
  }
})

it('reads a hand-authored earlier daily alias, pinned target, and receipt without rewriting bytes', async () => {
  const daily = {
    sessionId: 'daily-session', status: 'active',
    record: {
      id: 'daily', kind: 'daily', title: 'Keep the committed target', prompt: 'Keep the committed target',
      time: '12:00:00.250', timeZone: 'US/Eastern', scheduledAt: '2026-12-01T13:30:00.125Z',
    },
    lastDelivery: {
      scheduledAt: '2026-09-15T16:00:00.250Z', deliveredAt: '2026-09-15T16:00:01.000Z', messageId: 'daily-message',
    },
  }
  const bytes = encoded({ daily })
  const { root, path } = await rootWith({}, bytes)
  const test = await harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  const expected = [{
    ...daily.record, target: { kind: 'session', sessionId: daily.sessionId }, status: daily.status, lastDelivery: { ...daily.lastDelivery, targetSessionId: daily.sessionId },
  }]
  expect(await test.service.catalog()).toMatchObject(expected)
  expect(test.resolve).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe(bytes)
  const file = path
  const imported = await readFile(file, 'utf8')
  await test.ctx.fiber.dispose()
  const reopened = await harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  expect(await reopened.service.catalog()).toMatchObject(expected)
  expect(await readFile(path, 'utf8')).toBe(bytes)
  expect(await readFile(file, 'utf8')).toBe(imported)
})
