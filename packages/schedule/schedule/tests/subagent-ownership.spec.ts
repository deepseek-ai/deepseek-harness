/** Host Schedule refuses to arm delivery for a Session a delegated child owns. */
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAfterScheduleRecord, ScheduleId } from '../src/domain.ts'
import { scheduleDomain, type ScheduleTask } from '../src/storage.ts'
import type { ScheduleRecord } from '../src/types.ts'
import { agentFor, harness } from './harness.ts'

const contexts: Context[] = []
const childId = SessionId('subagent-child')
const parentId = SessionId('top-level-parent')

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(task?: ScheduleTask) {
  return harness({
    ...task === undefined ? {} : { beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(task.record.id, task)
      await domain.close()
    } },
    onContext: ctx => contexts.push(ctx),
  })
}

function table(test: Awaited<ReturnType<typeof setup>>) {
  const domain = test.ctx.storageDomain.get('schedule')
  if (domain === undefined) throw new Error('Schedule domain not initialized')
  return domain.table('tasks') as KvTable<ScheduleRecord['id'], ScheduleTask>
}

function childTask(record: ScheduleRecord): ScheduleTask {
  return { sessionId: childId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } }
}

it('refuses to create a reminder for a live subagent Session and stores nothing', async () => {
  const test = await setup()
  const child = agentFor(test.ctx, childId, { origin: 'subagent', parentSession: parentId, delegationDepth: 1 })
  await test.ctx.agents.register(child)
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)

  await expect(test.service.create(child.session.id, { prompt: 'Check', title: 'Check', after_seconds: 60 }))
    .rejects.toMatchObject({ code: 'subagent_session' })

  expect([...table(test).entries()]).toEqual([])
  expect(changed).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
})

it('refuses to create for a Session whose live Agent a delegating parent owns', async () => {
  const test = await setup()
  const parent = agentFor(test.ctx, parentId)
  await test.ctx.agents.register(parent)
  const child = agentFor(test.ctx, childId, { parentSession: parentId, delegationDepth: 1 })
  test.ctx.agents.enter(child, parent)

  await expect(test.service.create(childId, { prompt: 'Check', title: 'Check', after_seconds: 60 }))
    .rejects.toMatchObject({ code: 'subagent_session' })

  expect([...table(test).entries()]).toEqual([])
})

it('refuses to update a stored reminder bound to a delegated child Session', async () => {
  const record = createAfterScheduleRecord(ScheduleId('subagent-task'), 'Exact prompt', 60, Date.now(), 'Child task')
  const task = childTask(record)
  const test = await setup(task)
  const child = agentFor(test.ctx, childId, { origin: 'subagent', delegationDepth: 1 })
  await test.ctx.agents.register(child)
  const put = vi.spyOn(table(test), 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)

  // The refusal travels the ordinary non-mutating result so the Web editor renders
  // `timing.subagentSession` instead of a generic Remote failure.
  await expect(test.service.update({
    sessionId: childId, id: record.id, expected: record, change: { kind: 'every', every_seconds: 600 },
  })).resolves.toEqual({
    code: 'subagent_session',
    message: 'This Session belongs to subagent routing, which never receives reminder delivery.',
  })

  expect(put).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  expect(table(test).get(record.id)).toEqual(task)
  expect(test.resolve).not.toHaveBeenCalled()
})

it('refuses a delegated child recorded only by its delegation depth', async () => {
  const test = await setup()
  // No `origin`/ownership link: the persisted header's delegation depth is the only
  // record, which is the accounting the delegation cap itself reads.
  const child = agentFor(test.ctx, childId, { delegationDepth: 1 })
  await test.ctx.agents.register(child)

  await expect(test.service.create(child.session.id, { prompt: 'Check', title: 'Check', after_seconds: 60 }))
    .rejects.toMatchObject({ code: 'subagent_session' })

  expect([...table(test).entries()]).toEqual([])
})

it('still creates a reminder for a top-level Agent', async () => {
  const test = await setup()
  const owner = agentFor(test.ctx, parentId)
  await test.ctx.agents.register(owner)

  const record = await test.service.create(parentId, { prompt: 'Check', title: 'Check', after_seconds: 60 })

  expect(record.title).toBe('Check')
  expect(await test.service.list({ sessionId: parentId })).toEqual([record])
})

it('still lists and deletes a stored reminder bound to a delegated child Session', async () => {
  const record = createAfterScheduleRecord(ScheduleId('legacy-subagent-task'), 'Exact prompt', 60, Date.now(), 'Legacy task')
  const test = await setup(childTask(record))
  const child = agentFor(test.ctx, childId, { origin: 'subagent', delegationDepth: 1 })
  await test.ctx.agents.register(child)

  expect(await test.service.list({ sessionId: childId })).toEqual([record])
  expect((await test.service.catalog()).map(entry => entry.id)).toEqual([record.id])
  expect(await test.service.delete({ sessionId: childId, id: record.id })).toEqual({ id: record.id, deleted: true })
  expect(table(test).get(record.id)).toBeUndefined()
})
