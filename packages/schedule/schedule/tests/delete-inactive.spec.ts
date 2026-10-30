/** Host-wide removal of every ended task shares per-row deletion's durability rules. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAfterScheduleRecord, createEveryScheduleRecord, ScheduleId } from '../src/domain.ts'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { scheduleDomain, scheduleTaskSchema, type ScheduleTask } from '../src/storage.ts'
import { StorageError } from '@deepseek-ai/dsh-storage'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { agentFor, gatedScheduleBackend, harness } from './harness.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-16T00:00:00Z'))
})
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.useRealTimers()
})

/**
 * Build one ended task carrying one saved delivery.
 * @param sessionId - Session the task was created in.
 * @param id - stored task identity.
 * @param title - stored task name.
 * @returns the row a delivered one-shot leaves behind.
 */
function endedRow(sessionId: SessionId, id: string, title: string): ScheduleTask {
  const receipt = {
    scheduledAt: '2026-09-15T23:59:00.000Z',
    deliveredAt: '2026-09-15T23:59:01.000Z',
    messageId: MessageId(`${id}-delivery`),
  }
  return scheduleTaskSchema.parse({
    target: { kind: 'session', sessionId },
    record: createAfterScheduleRecord(ScheduleId(id), title, 60, Date.now(), title),
    status: 'ended',
    lastDelivery: receipt,
    deliveryHistory: { records: [receipt], earlierRecordsUnavailable: false },
  })
}

/**
 * Boot a service whose store already holds the given rows.
 * @param rows - task rows present before activation.
 * @returns the started harness with its storage pool.
 */
async function seeded(rows: readonly ScheduleTask[]) {
  const test = await harness({ beforeService: async (_ctx, facility) => {
    const domain = await facility.open(scheduleDomain)
    for (const row of rows) await domain.table('tasks').put(row.record.id, row)
    await domain.close()
  } })
  tests.push(test)
  return test
}

it('removes ended tasks across Sessions with their saved deliveries and keeps active and paused ones', async () => {
  const firstSession = SessionId('ended-first')
  const secondSession = SessionId('ended-second')
  const armedSession = SessionId('still-armed')
  const endedFirst = endedRow(firstSession, 'ended-a', 'Ended first')
  const endedSecond = endedRow(secondSession, 'ended-b', 'Ended second')
  const armed = createAfterScheduleRecord(ScheduleId('armed'), 'Still armed', 3_600, Date.now(), 'Still armed')
  const paused = { ...endedRow(armedSession, 'paused', 'Paused'), status: 'paused' as const }
  const test = await seeded([endedFirst, endedSecond, paused, scheduleTaskSchema.parse({
    target: { kind: 'session', sessionId: armedSession }, record: armed, status: 'active',
  })])
  const { ctx, service, resolve } = test
  const agents = [agentFor(ctx, firstSession), agentFor(ctx, secondSession)]
  for (const agent of agents) await ctx.agents.register(agent)
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  expect(await service.deleteInactive()).toEqual({ deleted: 2 })

  expect((await service.catalog()).map(entry => entry.title).sort()).toEqual(['Paused', 'Still armed'])
  expect((await service.list({ active: false })).items.map(entry => entry.id)).toEqual([paused.record.id])
  // The saved delivery records went with their rows, so history no longer resolves them.
  expect(await service.history({ id: endedFirst.record.id, limit: 20 }))
    .toEqual({ id: endedFirst.record.id, code: 'schedule_not_found' })
  expect(await service.history({ id: endedSecond.record.id, limit: 20 }))
    .toEqual({ id: endedSecond.record.id, code: 'schedule_not_found' })
  expect(changed).toHaveBeenCalledTimes(1)
  expect(resolve).not.toHaveBeenCalled()
  expect(ctx.agents.roots()).toEqual(agents)
  await test.fiber.dispose()
  for (const agent of agents) expect(agent.inject).not.toHaveBeenCalled()
})

it('reports zero and announces nothing when the Host holds no ended task', async () => {
  const sessionId = SessionId('only-active')
  const test = await seeded([scheduleTaskSchema.parse({
    target: { kind: 'session', sessionId },
    record: createAfterScheduleRecord(ScheduleId('armed'), 'Still armed', 3_600, Date.now(), 'Still armed'),
    status: 'active',
  })])
  const { ctx, service } = test
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  expect(await service.deleteInactive()).toEqual({ deleted: 0 })
  expect(changed).not.toHaveBeenCalled()
  expect(await service.catalog()).toHaveLength(1)
})

it('clears a large ended set in one batch and stays idempotent across repeated cleanups', async () => {
  const pool = new MemoryMediaPool()
  const batches: string[][] = []
  const backend = gatedScheduleBackend(pool, {
    deleteRecords: async (table, keys) => {
      if (table === 'tasks') batches.push([...keys])
    },
  })
  // Half the rows are ended one-shots and half stay armed, so the scan has to
  // separate them and the batch has to leave the active rows untouched.
  const endedCount = 5_000
  const activeCount = 5_000
  let facilityRef: DomainFacility | undefined
  const test = await harness({
    pool,
    backend,
    beforeService: async (_ctx, facility) => {
      facilityRef = facility
      const domain = await facility.open(scheduleDomain)
      const tasks = domain.table('tasks')
      const now = Date.now()
      for (let index = 0; index < endedCount; index += 1) {
        const id = `ended-${index}`
        await tasks.put(ScheduleId(id), endedRow(SessionId(`ended-session-${index}`), id, `Ended ${index}`))
      }
      for (let index = 0; index < activeCount; index += 1) {
        const id = `active-${index}`
        await tasks.put(ScheduleId(id), scheduleTaskSchema.parse({
          target: { kind: 'session', sessionId: SessionId(`active-session-${index}`) },
          record: createEveryScheduleRecord(ScheduleId(id), `Active ${index}`, 3_600, now, `Active ${index}`),
          status: 'active',
        }))
      }
      await domain.close()
    },
  })
  tests.push(test)
  const { ctx, service } = test
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  expect(await service.deleteInactive()).toEqual({ deleted: endedCount })
  expect(batches).toHaveLength(1)
  expect(batches[0]).toHaveLength(endedCount)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(await service.catalog()).toHaveLength(activeCount)
  expect((await service.catalog()).every(entry => entry.status === 'active')).toBe(true)

  // Repeated cleanups reseed a small ended set through the live domain table,
  // so each round exercises the same single-batch path without a growing file.
  const reseeded = 100
  const rounds = 24
  const table = facilityRef?.get('schedule')?.table('tasks')
  expect(table).toBeDefined()
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < reseeded; index += 1) {
      const id = `again-${round}-${index}`
      await table!.put(ScheduleId(id), endedRow(SessionId(`again-session-${round}-${index}`), id, `Again ${round}-${index}`))
    }
    expect(await service.deleteInactive()).toEqual({ deleted: reseeded })
    expect(await service.catalog()).toHaveLength(activeCount)
  }
  expect(batches).toHaveLength(rounds + 1)
  expect(batches.every((keys, index) => keys.length === (index === 0 ? endedCount : reseeded))).toBe(true)
  expect(changed).toHaveBeenCalledTimes(rounds + 1)
})

it('reports the batch failure', async () => {
  const pool = new MemoryMediaPool()
  const batches: string[][] = []
  const backend = gatedScheduleBackend(pool, {
    deleteRecords: async (table, keys) => {
      if (table !== 'tasks') return
      batches.push([...keys])
      throw new Error('injected batch failure')
    },
  })
  const test = await harness({
    pool,
    backend,
    beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(ScheduleId('ended-a'), endedRow(SessionId('partial-a'), 'ended-a', 'Partial first'))
      await domain.table('tasks').put(ScheduleId('ended-b'), endedRow(SessionId('partial-b'), 'ended-b', 'Partial second'))
      await domain.close()
    },
  })
  tests.push(test)
  const { ctx, service } = test
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  const failure = await service.deleteInactive().then(() => undefined, (error: unknown) => error)

  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain('injected batch failure')
  // One write carried both rows; the rejection may have landed some of them, so
  // observers are told to re-read even though both rows remain in this catalog.
  expect(batches).toEqual([['ended-a', 'ended-b']])
  expect(changed).toHaveBeenCalledTimes(1)
  expect((await service.catalog()).map(entry => entry.title).sort())
    .toEqual(['Partial first', 'Partial second'])
})

it('quarantines the Host domain when the backend reports unknown-state', async () => {
  const pool = new MemoryMediaPool()
  let batches = 0
  const backend = gatedScheduleBackend(pool, {
    deleteRecords: async (table) => {
      if (table !== 'tasks') return
      batches += 1
      throw new StorageError('unknown-state', 'injected unknown-state')
    },
  })
  const test = await harness({
    pool,
    backend,
    beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(ScheduleId('ended-a'), endedRow(SessionId('quarantine-a'), 'ended-a', 'Quarantine first'))
      await domain.table('tasks').put(ScheduleId('ended-b'), endedRow(SessionId('quarantine-b'), 'ended-b', 'Quarantine second'))
      await domain.close()
    },
  })
  tests.push(test)
  const { ctx, service } = test
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  const failure = await service.deleteInactive().then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ name: 'StorageError', code: 'unknown-state' })
  expect(batches).toBe(1)
  expect(changed).toHaveBeenCalledTimes(1)
  // The quarantined domain rejects reads instead of serving stale rows.
  await expect(service.catalog()).rejects.toMatchObject({ code: 'unknown-state' })
  // Later batches are rejected before reaching the backend again.
  await expect(service.deleteInactive()).rejects.toMatchObject({ code: 'unknown-state' })
  expect(batches).toBe(1)
  // The durable rows are still there; only the in-process domain is quarantined.
  expect(pool.media.get('schedule')?.tables.get('tasks')?.size).toBe(2)
})

it('reports a rejection reason that carries no Error as a labeled Error', async () => {
  const pool = new MemoryMediaPool()
  let batches = 0
  const backend = gatedScheduleBackend(pool, {
    deleteRecords: async (table) => {
      if (table !== 'tasks') return
      batches += 1
      throw undefined
    },
  })
  const test = await harness({
    pool,
    backend,
    beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(ScheduleId('ended-a'), endedRow(SessionId('unreportable-a'), 'ended-a', 'Unreportable first'))
      await domain.table('tasks').put(ScheduleId('ended-b'), endedRow(SessionId('unreportable-b'), 'ended-b', 'Unreportable second'))
      await domain.close()
    },
  })
  tests.push(test)
  const { ctx, service } = test
  const changed = vi.fn()
  ctx.on('schedule/changed', changed)

  const failure = await service.deleteInactive().then(() => undefined, (error: unknown) => error)

  // A reason that carries no Error must not read as a successful removal.
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain('schedule ended-task removal failed')
  expect(batches).toBe(1)
  expect(changed).toHaveBeenCalledTimes(1)
  expect((await service.catalog()).map(entry => entry.title).sort())
    .toEqual(['Unreportable first', 'Unreportable second'])
})
