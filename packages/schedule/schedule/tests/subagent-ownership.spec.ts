/** Host Schedule refuses to arm delivery for a Session a delegated child owns. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAfterScheduleRecord, ScheduleId } from '../src/domain.ts'
import type { ScheduleTask } from '../src/storage.ts'
import type { ScheduleRecord } from '../src/types.ts'
import { agentFor, boundTask, harness, storedSession, seedTasks, taskTable } from './harness.ts'

const contexts: Context[] = []
const childId = SessionId('subagent-child')
const parentId = SessionId('top-level-parent')
const RRULE = 'DTSTART:20260917T000000Z\nRRULE:FREQ=DAILY'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(task?: ScheduleTask) {
  return harness({
    onContext: ctx => contexts.push(ctx),
    ...(task === undefined ? {} : { beforeService: (_ctx, facility) => seedTasks(facility, [task]) }),
  })
}

function childTask(record: ScheduleRecord): ScheduleTask {
  return boundTask(childId, record)
}

it('refuses to create a reminder for a live subagent Session and stores nothing', async () => {
  const test = await setup()
  const child = agentFor(test.ctx, childId, { origin: 'subagent', parentSession: parentId, delegationDepth: 1 })
  await test.ctx.agents.register(child)
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)

  await expect(test.service.create({ prompt: 'Check', title: 'Check', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: child.session.id } }, child.session.id))
    .rejects.toMatchObject({ code: 'subagent_session' })

  expect([...taskTable(test.ctx).entries()]).toEqual([])
  expect(changed).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
})

it('refuses to create for a Session whose live Agent a delegating parent owns', async () => {
  const test = await setup()
  const parent = agentFor(test.ctx, parentId)
  await test.ctx.agents.register(parent)
  const child = agentFor(test.ctx, childId, { parentSession: parentId, delegationDepth: 1 })
  test.ctx.agents.enter(child, parent)

  await expect(test.service.create({ prompt: 'Check', title: 'Check', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: childId } }, childId))
    .rejects.toMatchObject({ code: 'subagent_session' })

  expect([...taskTable(test.ctx).entries()]).toEqual([])
})

it('refuses to update a stored reminder bound to a delegated child Session', async () => {
  const record = createAfterScheduleRecord(ScheduleId('subagent-task'), 'Exact prompt', 60, Date.now(), 'Child task')
  const task = childTask(record)
  const test = await setup(task)
  const child = agentFor(test.ctx, childId, { origin: 'subagent', delegationDepth: 1 })
  await test.ctx.agents.register(child)
  const put = vi.spyOn(taskTable(test.ctx), 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)

  // The refusal travels the ordinary non-mutating result so the Web editor renders
  // `timing.subagentSession` instead of a generic Remote failure.
  await expect(test.service.edit({ id: record.id, action: 'update', patch: { timing: { kind: 'every', every_seconds: 600 } } }))
    .rejects.toMatchObject({ code: 'subagent_session' })

  expect(put).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  expect(taskTable(test.ctx).get(record.id)).toEqual(task)
  expect(test.resolve).not.toHaveBeenCalled()
})

it('refuses a delegated child recorded only by its delegation depth', async () => {
  const test = await setup()
  // No `origin`/ownership link: the persisted header's delegation depth is the only
  // record, which is the accounting the delegation cap itself reads.
  const child = agentFor(test.ctx, childId, { delegationDepth: 1 })
  await test.ctx.agents.register(child)

  await expect(test.service.create({ prompt: 'Check', title: 'Check', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: child.session.id } }, child.session.id))
    .rejects.toMatchObject({ code: 'subagent_session' })

  expect([...taskTable(test.ctx).entries()]).toEqual([])
})

it('still creates a reminder for a top-level Agent', async () => {
  const test = await setup()
  const owner = agentFor(test.ctx, parentId)
  await test.ctx.agents.register(owner)

  const record = await test.service.create({ prompt: 'Check', title: 'Check', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId: parentId } }, parentId)

  expect(record.title).toBe('Check')
  expect((await test.service.list({ active: true })).items).toMatchObject([record])
})

it('still lists and deletes a stored reminder bound to a delegated child Session', async () => {
  const record = createAfterScheduleRecord(ScheduleId('legacy-subagent-task'), 'Exact prompt', 60, Date.now(), 'Legacy task')
  const test = await setup(childTask(record))
  const child = agentFor(test.ctx, childId, { origin: 'subagent', delegationDepth: 1 })
  await test.ctx.agents.register(child)

  expect((await test.service.list({ active: true })).items).toMatchObject([record])
  expect((await test.service.catalog()).map(entry => entry.id)).toEqual([record.id])
  expect(await test.service.edit({ action: 'delete', id: record.id })).toEqual({ id: record.id, deleted: true })
  expect(taskTable(test.ctx).get(record.id)).toBeUndefined()
})

it('refuses a task targeting a live subagent Session without reading its saved header', async () => {
  const test = await setup()
  await test.ctx.agents.register(agentFor(test.ctx, childId, { origin: 'subagent', delegationDepth: 1 }))
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)

  await expect(test.service.remoteCreate({
    title: 'Check', prompt: 'Check', timing: { kind: 'rrule', rrule: RRULE }, target: { kind: 'session', sessionId: childId },
  })).rejects.toMatchObject({ code: 'schedule/input-invalid', details: { code: 'subagent_session' } })

  expect(test.stat).not.toHaveBeenCalled()
  expect([...taskTable(test.ctx).entries()]).toEqual([])
  expect(changed).not.toHaveBeenCalled()
})

it('refuses a task targeting a stored Session whose saved header records a delegated child', async () => {
  const test = await setup()
  test.stat.mockResolvedValueOnce(storedSession(childId, 1))

  await expect(test.service.remoteCreate({
    title: 'Check', prompt: 'Check', timing: { kind: 'rrule', rrule: RRULE }, target: { kind: 'session', sessionId: childId },
  })).rejects.toMatchObject({ code: 'schedule/input-invalid', details: { code: 'subagent_session' } })

  expect(test.stat).toHaveBeenCalledWith(childId, undefined)
  expect(test.resolve).not.toHaveBeenCalled()
  expect([...taskTable(test.ctx).entries()]).toEqual([])
})

it('refuses to retarget a task to a stored delegated child Session and keeps the stored target', async () => {
  const test = await setup()
  const created = await test.service.remoteCreate({
    title: 'Check', prompt: 'Check', timing: { kind: 'rrule', rrule: RRULE }, target: { kind: 'session', sessionId: parentId },
  })
  const stored = taskTable(test.ctx).get(created.id)
  test.stat.mockResolvedValueOnce(storedSession(childId, 1))
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)

  await expect(test.service.remoteEdit({
    id: created.id, action: 'update', patch: { target: { kind: 'session', sessionId: childId } },
  })).rejects.toMatchObject({ code: 'schedule/input-invalid', details: { code: 'subagent_session' } })

  expect(taskTable(test.ctx).get(created.id)).toEqual(stored)
  expect(changed).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
})

it('still creates a task targeting a stored top-level Session without activating it', async () => {
  const test = await setup()

  const created = await test.service.remoteCreate({
    title: 'Check', prompt: 'Check', timing: { kind: 'rrule', rrule: RRULE }, target: { kind: 'session', sessionId: parentId },
  })

  expect(created.target).toEqual({ kind: 'session', sessionId: parentId })
  expect(test.stat).toHaveBeenCalledWith(parentId, undefined)
  expect(test.resolve).not.toHaveBeenCalled()
})
