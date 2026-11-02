/** Shared management edits remain atomic and ordered against delivery, cancellation, and persistence. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { agentFor, gatedScheduleBackend, harness, taskTable } from './harness.ts'
import type { ScheduleCatalogEntry } from '../src/types.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
const releases: (() => void)[] = []
const timing = { kind: 'every', every_seconds: 300 } as const
const target = { kind: 'session', sessionId: SessionId('owner') } as const
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-09-16T00:00:00Z') })
afterEach(async () => {
  releases.splice(0).forEach((release) =>{  release() })
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.restoreAllMocks(); vi.useRealTimers()
})

function gate() {
  const pending = Promise.withResolvers<undefined>()
  releases.push(() =>{  pending.resolve(undefined) })
  return pending
}

async function setup() {
  const pool = new MemoryMediaPool()
  let block: Promise<void> | undefined
  let failure: Error | undefined
  let writes = 0
  const test = await harness({ pool, backend: gatedScheduleBackend(pool, {
    putRecord: () => { writes++; if (failure !== undefined) return Promise.reject(failure); return block },
  }) })
  tests.push(test)
  const created = await test.service.create({ title: 'Task', prompt: 'Prompt', timing, target })
  return { ...test, created, block: (promise?: Promise<void>) => { block = promise },
    fail: (error?: Error) => { failure = error }, writes: () => writes }
}

it('commits name, prompt, timing, and target in one write without changing receipts', async () => {
  const test = await setup()
  const before = test.writes()
  const edited = await test.service.edit({ id: test.created.id, action: 'update', expectedUpdatedAt: test.created.updatedAt ?? null,
    patch: { title: 'Renamed', prompt: 'New prompt', timing: { kind: 'cron', cron: { expression: '0 9 * * *', time_zone: 'UTC' } }, target: { kind: 'new' } } })
  expect(edited).toMatchObject({ id: test.created.id, kind: 'cron', title: 'Renamed', prompt: 'New prompt', expression: '0 9 * * *', target: { kind: 'new' } })
  expect(test.writes() - before).toBe(1)
  expect(test.resolve).not.toHaveBeenCalled()
  expect(test.createSession).not.toHaveBeenCalled()
  expect(taskTable(test.ctx).get(test.created.id)?.deliveryHistory.records).toEqual([])
})

it('serializes competing revisions and refuses stale saves and deletes', async () => {
  const test = await setup()
  const request = { id: test.created.id, action: 'update', expectedUpdatedAt: test.created.updatedAt ?? null, patch: { title: 'First' } } as const
  const first = test.service.edit(request)
  const second = test.service.edit({ ...request, patch: { title: 'Second' } })
  expect(await first).toMatchObject({ title: 'First' })
  expect(await second).toEqual({ id: test.created.id, code: 'schedule_conflict' })
  expect(await test.service.edit({ id: test.created.id, action: 'delete', expectedUpdatedAt: test.created.updatedAt ?? null }))
    .toEqual({ id: test.created.id, code: 'schedule_conflict' })
})

it('evaluates changed timing at queue acceptance after a blocked write', async () => {
  const test = await setup()
  const pending = gate()
  test.block(pending.promise)
  const first = test.service.edit({ id: test.created.id, action: 'update', patch: { title: 'Blocks queue' } })
  await vi.waitFor(() =>{  expect(test.writes()).toBe(2) })
  const second = test.service.edit({ id: test.created.id, action: 'update', patch: { timing: { kind: 'every', every_seconds: 600 } } })
  vi.setSystemTime('2026-09-16T01:00:00Z')
  test.block(); pending.resolve(undefined)
  await first
  expect(await second).toMatchObject({ scheduledAt: '2026-09-16T01:10:00.000Z', everySeconds: 600 })
})

it('refuses an absolute target that became past in the queue', async () => {
  const test = await setup()
  const pending = gate(); test.block(pending.promise)
  const first = test.service.edit({ id: test.created.id, action: 'update', patch: { title: 'Blocks queue' } })
  await vi.waitFor(() =>{  expect(test.writes()).toBe(2) })
  const second = test.service.edit({ id: test.created.id, action: 'update', patch: { timing: { kind: 'at', at: '2026-09-16T00:30:00Z' } } })
  const refused = expect(second).rejects.toMatchObject({ code: 'not_future' })
  vi.setSystemTime('2026-09-16T01:00:00Z'); test.block(); pending.resolve(undefined)
  await first; await refused
})

it.each(['before', 'queued', 'writing'] as const)('checks cancellation %s without rolling back a started write', async (stage) => {
  const test = await setup()
  const controller = new AbortController()
  const pending = gate()
  let preceding: Promise<unknown> | undefined
  if (stage === 'before') controller.abort()
  else if (stage === 'queued') {
    test.block(pending.promise)
    preceding = test.service.edit({ id: test.created.id, action: 'update', patch: { title: 'Preceding' } })
    await vi.waitFor(() =>{  expect(test.writes()).toBe(2) })
  } else test.block(pending.promise)
  const saving = test.service.edit({ id: test.created.id, action: 'update', patch: { title: 'Saved' } }, undefined, controller.signal)
  const outcome = stage === 'writing' ? expect(saving).resolves.toMatchObject({ title: 'Saved' }) : expect(saving).rejects.toThrow()
  if (stage === 'writing') await vi.waitFor(() =>{  expect(test.writes()).toBe(2) })
  controller.abort(); test.block(); pending.resolve(undefined)
  await preceding; await outcome
  expect((await test.service.view({ id: test.created.id })) as ScheduleCatalogEntry).toMatchObject({ title: stage === 'writing' ? 'Saved' : stage === 'queued' ? 'Preceding' : 'Task' })
})

it('publishes no update after a failed write and permits a later save', async () => {
  const test = await setup()
  const changed = vi.fn(); test.ctx.on('schedule/changed', changed)
  test.fail(new Error('write failed'))
  await expect(test.service.edit({ id: test.created.id, action: 'update', patch: { title: 'Lost' } })).rejects.toThrow('write failed')
  expect(changed).not.toHaveBeenCalled()
  expect(await test.service.view({ id: test.created.id })).toEqual(test.created)
  test.fail()
  expect(await test.service.edit({ id: test.created.id, action: 'update', patch: { title: 'Saved' } })).toMatchObject({ title: 'Saved' })
  expect(changed).toHaveBeenCalledTimes(1)
})

it('orders an edit after the complete delivery commit and observes its changed revision', async () => {
  const test = await setup()
  const agent = agentFor(test.ctx, 'owner'); test.resolve.mockResolvedValue({ agent })
  const pending = gate(); test.flush.mockImplementationOnce(() => pending.promise)
  await vi.advanceTimersByTimeAsync(300_000)
  expect(agent.followup).toHaveBeenCalledTimes(1)
  const editing = test.service.edit({ id: test.created.id, action: 'update', expectedUpdatedAt: test.created.updatedAt ?? null, patch: { title: 'Stale' } })
  pending.resolve(undefined)
  expect(await editing).toEqual({ id: test.created.id, code: 'schedule_conflict' })
  expect(await test.service.view({ id: test.created.id })).toMatchObject({ title: 'Task', scheduledAt: '2026-09-16T00:10:00.000Z' })
})

it('normalizes an equivalent edit without re-anchoring the stored target', async () => {
  const test = await setup()
  vi.setSystemTime('2026-09-16T00:01:00Z')
  expect(await test.service.edit({ id: test.created.id, action: 'update', patch: { timing } }))
    .toMatchObject({ ...test.created, updatedAt: '2026-09-16T00:01:00.000Z' })
})
