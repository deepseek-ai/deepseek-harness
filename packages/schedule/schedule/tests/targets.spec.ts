/**
 * Host timer and manual delivery of Host tasks to an existing Session, a reserved Session, or a fresh Session per
 * occurrence, the minimum interval between deliveries of one task, archived target Sessions, and the Workspace and title
 * of each Session that a delivery creates.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ScheduleId } from '../src/domain.ts'
import { createRRuleScheduleRecord } from '../src/domain.ts'
import { ScheduleRuntime, type ScheduleRuntimeLimits } from '../src/runtime.ts'
import type { ScheduleTask } from '../src/storage.ts'
import { agentFor, harness, seededTask, type HarnessAgent } from './harness.ts'

const LIMITS: ScheduleRuntimeLimits = { retention: { days: 30, records: 200 }, newSessionIntervalMs: 3_600_000 }
const active: Awaited<ReturnType<typeof harness>>[] = []
const runtimes: ScheduleRuntime[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-09-16T00:00:00Z') })
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await Promise.all(active.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function task(
  target: ScheduleTask['target'],
  rrule = 'DTSTART:20260916T000001Z\nRRULE:FREQ=DAILY;COUNT=1',
  fields: Partial<ScheduleTask> = {},
): ScheduleTask {
  return seededTask(createRRuleScheduleRecord(ScheduleId('task'), 'Task', 'Do work', rrule, Date.now()), target, fields)
}

async function setup(tasks: ScheduleTask[], limits = LIMITS, options: Parameters<typeof harness>[0] = {}) {
  const test = await harness(options)
  active.push(test)
  const agents = new Map<string, HarnessAgent>()
  test.resolve.mockImplementation(async (id) => {
    const agent = agents.get(id)
    return agent === undefined ? { error: new RemoteError('session/not-found', `missing ${id}`, { sessionId: id }) } : { agent }
  })
  test.createSession.mockImplementation(async (request) => {
    if (request.sessionId === undefined) throw new Error('expected reserved Session id')
    agents.set(request.sessionId, agentFor(test.ctx, request.sessionId))
    return { sessionId: request.sessionId }
  })
  const commit = vi.fn(async (next: ScheduleTask) => {
    const index = tasks.findIndex(item => item.record.id === next.record.id)
    tasks[index] = next
  })
  const runtime = new ScheduleRuntime(test.ctx, () => tasks, work => work(), commit, () => {}, limits, test.resolveAgent)
  runtimes.push(runtime)
  return { ...test, agents, commit, runtime }
}

/**
 * Mount the title service and a Workspace registry whose only Workspace is at `/work`; `/missing` does not resolve.
 * @param test - Runtime fixture whose created Sessions the services observe.
 * @returns Registry observations and a reader of each Session's current title.
 */
async function placement(test: Awaited<ReturnType<typeof setup>>) {
  await test.ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  const attachSession = vi.fn<(sessionId: SessionId) => Promise<void>>(async () => {})
  const resolveByPath = vi.fn(async (path: string) => {
    if (path === '/missing') throw new Error(`ENOENT: ${path}`)
    return path === '/work' ? { attachSession } : undefined
  })
  test.ctx.provide('workspaceRegistry', { resolveByPath, archivedSessionIds: [] })
  const title = (id: SessionId): string | undefined => test.ctx.sessionTitle.get(test.agents.get(id)!.session)?.title
  return { attachSession, resolveByPath, title }
}

/**
 * Mount a Workspace registry whose archive set starts with `sessionIds`.
 * @param test - Runtime fixture that reads the archive set.
 * @param sessionIds - Initially archived Sessions.
 * @returns The live archive set; removing an id unarchives that Session.
 */
function archive(test: Awaited<ReturnType<typeof setup>>, ...sessionIds: SessionId[]): SessionId[] {
  const archived = [...sessionIds]
  test.ctx.provide('workspaceRegistry', { archivedSessionIds: archived })
  return archived
}

/**
 * Keep each Session that a delivery creates busy: its Agent runs, keeps the reminder in its inbox, and never reaches
 * whole-agent idle.
 * @param test - Runtime fixture whose created Sessions stay busy.
 */
function keepCreatedSessionsBusy(test: Awaited<ReturnType<typeof setup>>): void {
  const create = test.createSession.getMockImplementation()!
  test.createSession.mockImplementation(async (request) => {
    const created = await create(request)
    const agent = test.agents.get(created.sessionId)!
    const nextTurn: UserMessage[] = []
    agent.followup.mockImplementation((message) => { nextTurn.push(message) })
    Object.assign(agent, { status: 'running', inbox: { ...agent.inbox, nextTurn }, whenIdle: () => new Promise<void>(() => {}) })
    return created
  })
}

it('delivers to a designated Session and retains an ended receipt', async () => {
  const tasks = [task({ kind: 'session', sessionId: SessionId('target') })]
  const test = await setup(tasks)
  const agent = agentFor(test.ctx, 'target')
  test.agents.set('target', agent)
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(agent.followup).toHaveBeenCalledOnce()
  expect(tasks[0]).toMatchObject({
    status: 'ended', involvedSessionIds: [SessionId('target')],
    lastDelivery: { targetSessionId: SessionId('target'), scheduledAt: '2026-09-16T00:00:01.000Z' },
  })
})

it.each(['Web', 'persistence'] as const)('creates a new-once Session when %s reports that its reserved id is absent', async (source) => {
  const reserved = SessionId('reserved')
  const tasks = [task({ kind: 'new_once', sessionId: reserved, create: { cwd: '/work' } })]
  const test = await setup(tasks)
  test.resolve.mockRejectedValueOnce(source === 'Web'
    ? new RemoteError('session/not-found', 'missing reserved Session', { sessionId: reserved })
    : new SessionPersistenceNotFoundError(reserved))
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.createSession).toHaveBeenCalledWith({ sessionId: reserved, cwd: '/work' })
  expect(tasks[0]).toMatchObject({ target: { kind: 'session', sessionId: reserved }, involvedSessionIds: [reserved] })
})

it.each(['new_once', 'new'] as const)('keeps a stored %s task and reports failure when its Host cannot create Sessions', async (kind) => {
  const reserved = SessionId('reserved')
  const original = task(kind === 'new' ? { kind, create: {} } : { kind, sessionId: reserved, create: {} })
  const tasks = [original]
  const test = await setup(tasks, LIMITS, { sessionController: false })
  test.ctx.on('schedule/resolve-agent', async (sessionId) => { throw new SessionPersistenceNotFoundError(sessionId) })
  const warn = vi.spyOn(test.ctx.logger, 'warn')
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(warn).toHaveBeenCalledExactlyOnceWith('schedule: reminders ["task"] were not acknowledged: Error: schedule: no Session creation provider')
  expect(test.createSession).not.toHaveBeenCalled()
  expect(test.agents.size).toBe(0)
  expect(tasks[0]).toMatchObject({ record: original.record, target: original.target, status: 'active' })
  expect(tasks[0]?.lastDelivery).toBeUndefined()
  if (kind === 'new') {
    expect(tasks[0]?.pendingDelivery?.targetSessionId).toBeDefined()
    expect(test.commit).toHaveBeenCalledOnce()
  } else {
    expect(tasks).toEqual([original])
    expect(test.commit).not.toHaveBeenCalled()
  }
})

it('persists a pending identity before creating a new Session for an occurrence', async () => {
  const tasks = [task({ kind: 'new', create: {} })]
  const test = await setup(tasks)
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  const reserved = test.commit.mock.calls[0]?.[0].pendingDelivery?.targetSessionId
  expect(reserved).toBeDefined()
  expect(test.createSession).toHaveBeenCalledExactlyOnceWith({ sessionId: reserved })
  expect(tasks[0]?.pendingDelivery).toBeUndefined()
  expect(tasks[0]?.lastDelivery?.targetSessionId).toBe(reserved)
  // A Session created for one occurrence is not told about later changes of the task.
  expect(tasks[0]?.involvedSessionIds).toEqual([])
})

it('runs per-occurrence tasks immediately in fresh Sessions without moving their timer', async () => {
  const tasks = [task({ kind: 'new', create: {} }, 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY')]
  const test = await setup(tasks)
  const initial = tasks[0]!
  const first = await test.runtime.runNow(initial.record.id)
  expect(first).toMatchObject({ admitted: true })
  vi.setSystemTime('2026-09-16T00:59:59Z')
  expect(await test.runtime.runNow(initial.record.id)).toMatchObject({ admitted: false })
  expect(test.runtime.deliveryFloorEnd(tasks[0]!)).toBe(Date.parse('2026-09-16T01:00:00Z'))
  vi.setSystemTime('2026-09-16T01:00:00Z')
  expect(await test.runtime.runNow(initial.record.id)).toMatchObject({ admitted: true })
  expect(tasks[0]).toMatchObject({ status: 'active', record: { scheduledAt: initial.record.scheduledAt }, involvedSessionIds: [] })
  const targets = tasks[0]!.deliveryHistory.records.map(record => record.targetSessionId)
  expect(targets).toHaveLength(2)
  expect(new Set(targets).size).toBe(2)
})

it('delivers the latest missed occurrence once and keeps the next occurrence on its time', async () => {
  const target = SessionId('target')
  const tasks = [task({ kind: 'session', sessionId: target }, 'DTSTART:20260916T000001Z\nRRULE:FREQ=MINUTELY;COUNT=5')]
  const test = await setup(tasks)
  const agent = agentFor(test.ctx, target)
  test.agents.set(target, agent)
  vi.setSystemTime('2026-09-16T00:02:30Z')
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(0)
  expect(agent.followup).toHaveBeenCalledOnce()
  expect(tasks[0]).toMatchObject({
    status: 'active', record: { scheduledAt: '2026-09-16T00:03:01.000Z' },
    lastDelivery: { scheduledAt: '2026-09-16T00:02:01.000Z' },
  })
  // The interval counts from the delivered 00:02:01 occurrence, so the late 00:02:30 delivery does not hold 00:03:01.
  await vi.advanceTimersByTimeAsync(30_000)
  expect(agent.followup).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(agent.followup).toHaveBeenCalledTimes(2)
  expect(tasks[0]?.lastDelivery?.scheduledAt).toBe('2026-09-16T00:03:01.000Z')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(agent.followup).toHaveBeenCalledTimes(3)
  expect(tasks[0]).toMatchObject({ status: 'ended', lastDelivery: { scheduledAt: '2026-09-16T00:04:01.000Z' } })
})

it('keeps minutely occurrences on time when each Session flush takes time', async () => {
  const target = SessionId('target')
  const tasks = [task({ kind: 'session', sessionId: target }, 'DTSTART:20260916T000001Z\nRRULE:FREQ=MINUTELY;COUNT=4')]
  const test = await setup(tasks)
  const agent = agentFor(test.ctx, target)
  test.agents.set(target, agent)
  const enqueuedAt: string[] = []
  agent.followup.mockImplementation(() => { enqueuedAt.push(new Date(Date.now()).toISOString()) })
  test.flush.mockImplementation(async () => { vi.setSystemTime(Date.now() + 20) })
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(181_000)
  expect(enqueuedAt).toEqual([
    '2026-09-16T00:00:01.000Z', '2026-09-16T00:01:01.000Z', '2026-09-16T00:02:01.000Z', '2026-09-16T00:03:01.000Z',
  ])
  expect(tasks[0]?.lastDelivery?.deliveredAt).toBe('2026-09-16T00:03:01.020Z')
})

it('holds only the occurrence that falls inside the interval of a manual run', async () => {
  const target = SessionId('target')
  const tasks = [task({ kind: 'session', sessionId: target }, 'DTSTART:20260916T000101Z\nRRULE:FREQ=MINUTELY;COUNT=3')]
  const test = await setup(tasks)
  const agent = agentFor(test.ctx, target)
  test.agents.set(target, agent)
  const enqueuedAt: string[] = []
  agent.followup.mockImplementation(() => { enqueuedAt.push(new Date(Date.now()).toISOString()) })
  vi.setSystemTime('2026-09-16T00:00:31Z')
  expect(await test.runtime.runNow(tasks[0]!.record.id)).toMatchObject({ admitted: true })
  await vi.advanceTimersByTimeAsync(150_000)
  // 00:01:01 waits until 60 seconds after the run; 00:02:01 and 00:03:01 keep their times.
  expect(enqueuedAt).toEqual([
    '2026-09-16T00:00:31.000Z', '2026-09-16T00:01:31.000Z', '2026-09-16T00:02:01.000Z', '2026-09-16T00:03:01.000Z',
  ])
  expect(tasks[0]).toMatchObject({ status: 'ended', lastDelivery: { scheduledAt: '2026-09-16T00:03:01.000Z' } })
})

it('delivers two tasks of one Session in one message again after a manual run held one of them', async () => {
  const target = SessionId('target')
  const rrule = 'DTSTART:20260916T000101Z\nRRULE:FREQ=MINUTELY;COUNT=2'
  const tasks = ['first', 'second'].map(id => seededTask(
    createRRuleScheduleRecord(ScheduleId(id), id, 'Do work', rrule, Date.now()), { kind: 'session', sessionId: target },
  ))
  const test = await setup(tasks)
  const agent = agentFor(test.ctx, target)
  test.agents.set(target, agent)
  vi.setSystemTime('2026-09-16T00:00:46Z')
  expect(await test.runtime.runNow(ScheduleId('first'))).toMatchObject({ admitted: true })
  await vi.advanceTimersByTimeAsync(15_000)
  // At 00:01:01 only the second task is outside its interval; the first follows at 00:01:46.
  expect(agent.followup).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(45_000)
  expect(agent.followup).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(agent.followup).toHaveBeenCalledTimes(4)
  expect(tasks.map(item => item.lastDelivery?.scheduledAt)).toEqual(['2026-09-16T00:02:01.000Z', '2026-09-16T00:02:01.000Z'])
  expect(tasks[0]?.lastDelivery?.messageId).toBe(tasks[1]?.lastDelivery?.messageId)
})

it('limits a frequent recurring new-Session task to one creation per configured interval', async () => {
  const tasks = [task({ kind: 'new', create: {} }, 'DTSTART:20260916T000001Z\nRRULE:FREQ=MINUTELY')]
  const test = await setup(tasks, { ...LIMITS, newSessionIntervalMs: 7_200_000 })
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.createSession).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(7_199_000)
  expect(test.createSession).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.createSession).toHaveBeenCalledTimes(2)
  expect(tasks[0]).toMatchObject({ status: 'active', lastDelivery: { scheduledAt: '2026-09-16T02:00:01.000Z' } })
})

it('launches each occurrence of a new-Session task while the earlier launches still run', async () => {
  const tasks = [task({ kind: 'new', create: {} }, 'DTSTART:20260916T000001Z\nRRULE:FREQ=MINUTELY;COUNT=3')]
  const test = await setup(tasks, { ...LIMITS, newSessionIntervalMs: 60_000 })
  keepCreatedSessionsBusy(test)
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(121_000)
  expect(test.createSession).toHaveBeenCalledTimes(3)
  expect(new Set(tasks[0]!.deliveryHistory.records.map(record => record.targetSessionId)).size).toBe(3)
  expect(test.runtime.isExecutionActive(tasks[0]!.record.id)).toBe(false)
  expect(tasks[0]).toMatchObject({ status: 'ended', lastDelivery: { scheduledAt: '2026-09-16T00:02:01.000Z' } })
})

it('admits a manual run of a new-Session task while its earlier launch still runs', async () => {
  const tasks = [task({ kind: 'new', create: {} }, 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY')]
  const test = await setup(tasks, { ...LIMITS, newSessionIntervalMs: 60_000 })
  keepCreatedSessionsBusy(test)
  const id = tasks[0]!.record.id
  expect(await test.runtime.runNow(id)).toMatchObject({ admitted: true })
  expect(test.runtime.isExecutionActive(id)).toBe(false)
  vi.setSystemTime('2026-09-16T00:01:00Z')
  expect(await test.runtime.runNow(id)).toMatchObject({ admitted: true })
  expect(test.createSession).toHaveBeenCalledTimes(2)
})

it('wakes the idle earlier Session of a new-Session task and still launches the due occurrence', async () => {
  const previous = SessionId('previous')
  const earlier = createUserMessage({ content: [{ type: 'text', text: 'Do work' }], source: { kind: 'schedule' } })
  const receipt = {
    scheduledAt: '2026-09-15T23:59:01.000Z', deliveredAt: '2026-09-15T23:59:01.000Z',
    messageId: earlier.id, targetSessionId: previous,
  }
  const tasks = [task({ kind: 'new', create: {} }, 'DTSTART:20260916T000001Z\nRRULE:FREQ=MINUTELY', {
    lastDelivery: receipt,
    deliveryHistory: { records: [{ ...receipt, prompt: 'Do work' }], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
  })]
  const test = await setup(tasks, { ...LIMITS, newSessionIntervalMs: 60_000 })
  const waiting = agentFor(test.ctx, previous)
  const remove = vi.fn()
  Object.assign(waiting, { inbox: { ...waiting.inbox, nextTurn: [earlier], remove } })
  test.agents.set(previous, waiting)
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(remove).toHaveBeenCalledExactlyOnceWith(earlier.id)
  expect(waiting.followup).toHaveBeenCalledExactlyOnceWith(earlier)
  expect(test.createSession).toHaveBeenCalledOnce()
  expect(tasks[0]?.lastDelivery?.targetSessionId).not.toBe(previous)
  expect(test.runtime.isExecutionActive(tasks[0]!.record.id)).toBe(false)
})

it('falls through from an unavailable restart receipt to a fresh execution', async () => {
  const target = SessionId('target')
  const receipt = {
    scheduledAt: '2026-09-15T23:59:00.000Z', deliveredAt: '2026-09-15T23:59:00.000Z',
    messageId: MessageId('unavailable-receipt'), targetSessionId: target,
  }
  const recovering = task({ kind: 'session', sessionId: target }, undefined, {
    lastDelivery: receipt,
    deliveryHistory: { records: [{ ...receipt, prompt: 'Do work' }], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
  })
  const test = await setup([recovering])
  const agent = agentFor(test.ctx, target)
  test.agents.set(target, agent)
  test.resolve.mockResolvedValueOnce({ error: new Error('unavailable') } as never)
  expect(await test.runtime.runNow(recovering.record.id)).toMatchObject({ admitted: true })
  expect(agent.followup).toHaveBeenCalledOnce()
})

it('refuses a manual execution whose target Session resolves after shutdown starts', async () => {
  const target = SessionId('target')
  const tasks = [task({ kind: 'session', sessionId: target }, 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY')]
  const test = await setup(tasks)
  const agent = agentFor(test.ctx, target)
  const resolved = Promise.withResolvers<{ agent: Agent }>()
  test.resolve.mockReturnValueOnce(resolved.promise)
  const run = test.runtime.runNow(tasks[0]!.record.id)
  await vi.waitFor(() => { expect(test.resolve).toHaveBeenCalledOnce() })
  await test.runtime.dispose()
  resolved.resolve({ agent })
  await expect(run).rejects.toThrow('Schedule runtime is stopping')
  expect(agent.followup).not.toHaveBeenCalled()
  expect(test.commit).not.toHaveBeenCalled()
})

it.each(['session', 'new_once', 'new'] as const)('refuses a manual execution whose %s target Session is archived', async (kind) => {
  const target = SessionId('target')
  const tasks = [task(kind === 'new' ? { kind, create: {} }
    : kind === 'new_once' ? { kind, sessionId: target, create: {} } : { kind, sessionId: target },
  'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY', {
    status: 'paused', ...(kind === 'new' ? { pendingDelivery: { targetSessionId: target } } : {}),
  })]
  const test = await setup(tasks)
  const agent = agentFor(test.ctx, target)
  test.agents.set(target, agent)
  archive(test, target)
  await expect(test.runtime.runNow(tasks[0]!.record.id)).rejects.toMatchObject({
    code: 'schedule/target-archived', details: { sessionId: target },
  })
  expect(test.resolve).not.toHaveBeenCalled()
  expect(test.createSession).not.toHaveBeenCalled()
  expect(agent.followup).not.toHaveBeenCalled()
  expect(test.commit).not.toHaveBeenCalled()
  expect(test.runtime.isExecutionActive(tasks[0]!.record.id)).toBe(false)
})

it.each(['session', 'new_once', 'new'] as const)('keeps a due %s task while its target Session is archived and delivers after unarchiving', async (kind) => {
  const target = SessionId('target')
  const tasks = [task(kind === 'new' ? { kind, create: {} }
    : kind === 'new_once' ? { kind, sessionId: target, create: {} } : { kind, sessionId: target }, undefined,
  kind === 'new' ? { pendingDelivery: { targetSessionId: target } } : {})]
  const test = await setup(tasks)
  const agent = agentFor(test.ctx, target)
  test.agents.set(target, agent)
  const archived = archive(test, target)
  const warn = vi.spyOn(test.ctx.logger, 'warn')
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(warn).toHaveBeenCalledExactlyOnceWith('schedule: reminders ["task"] were not acknowledged: RemoteError: Session target is archived')
  expect(agent.followup).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
  expect(test.createSession).not.toHaveBeenCalled()
  expect(tasks[0]?.status).toBe('active')
  expect(tasks[0]?.lastDelivery).toBeUndefined()
  archived.splice(0)
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(0)
  expect(agent.followup).toHaveBeenCalledOnce()
  expect(tasks[0]).toMatchObject({ status: 'ended', lastDelivery: { targetSessionId: target } })
})

it('runs a per-occurrence task in a fresh Session while its earlier reminder waits in an archived Session', async () => {
  const previous = SessionId('previous')
  const earlier = createUserMessage({ content: [{ type: 'text', text: 'Do work' }], source: { kind: 'schedule' } })
  const receipt = {
    scheduledAt: '2026-09-15T22:00:00.000Z', deliveredAt: '2026-09-15T22:00:00.000Z',
    messageId: earlier.id, targetSessionId: previous,
  }
  const tasks = [task({ kind: 'new', create: {} }, 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY', {
    lastDelivery: receipt,
    deliveryHistory: { records: [{ ...receipt, prompt: 'Do work' }], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
  })]
  const test = await setup(tasks)
  const waiting = agentFor(test.ctx, previous)
  Object.assign(waiting, { status: 'running', inbox: { ...waiting.inbox, nextTurn: [earlier] } })
  test.agents.set(previous, waiting)
  archive(test, previous)
  expect(await test.runtime.runNow(tasks[0]!.record.id)).toMatchObject({ admitted: true })
  expect(test.resolve).not.toHaveBeenCalledWith(previous)
  expect(test.createSession).toHaveBeenCalledOnce()
  expect(tasks[0]?.lastDelivery?.targetSessionId).not.toBe(previous)
})

it('reuses a pending per-run identity and forwards both optional creation fields', async () => {
  const reserved = SessionId('pending')
  const tasks = [task({ kind: 'new', create: { cwd: '/work', agentPreset: 'minimal' } }, undefined, {
    pendingDelivery: { targetSessionId: reserved },
  })]
  const test = await setup(tasks)
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.createSession).toHaveBeenCalledExactlyOnceWith({ sessionId: reserved, cwd: '/work', agentPreset: 'minimal' })
  expect(test.commit).toHaveBeenCalledOnce()
  expect(tasks[0]?.lastDelivery?.targetSessionId).toBe(reserved)
})

it('reuses a pending new-Session identity for a later manual retry', async () => {
  const reserved = SessionId('pending-manual')
  const tasks = [task({ kind: 'new', create: {} }, 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY', {
    pendingDelivery: { targetSessionId: reserved },
  })]
  const test = await setup(tasks)
  vi.setSystemTime('2026-09-16T00:10:00Z')
  expect(await test.runtime.runNow(tasks[0]!.record.id)).toMatchObject({ admitted: true })
  expect(test.createSession).toHaveBeenCalledExactlyOnceWith({ sessionId: reserved })
  expect(tasks[0]?.lastDelivery?.targetSessionId).toBe(reserved)
})

it('retries a failed receipt write in the Session that the first attempt created', async () => {
  const reserved = SessionId('reserved')
  const tasks = [task({ kind: 'new_once', sessionId: reserved, create: { cwd: '/work' } })]
  const test = await setup(tasks)
  test.commit.mockRejectedValueOnce(new Error('task write failed'))
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(tasks[0]).toMatchObject({ status: 'active', target: { kind: 'new_once', sessionId: reserved } })
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  // The reminder that preceded the failed write arrives again in the same Session.
  expect(test.agents.get(reserved)?.followup).toHaveBeenCalledTimes(2)
  expect(test.createSession).toHaveBeenCalledOnce()
  expect(tasks[0]).toMatchObject({ status: 'ended', target: { kind: 'session', sessionId: reserved } })
})

it.each(['Web', 'persistence'] as const)('creates no Session when the reserved identity has a %s ownership error', async (source) => {
  const reserved = SessionId('pending')
  const tasks = [task({ kind: 'new', create: {} }, undefined, { pendingDelivery: { targetSessionId: reserved } })]
  const test = await setup(tasks)
  const warn = vi.spyOn(test.ctx.logger, 'warn')
  const failure = source === 'Web'
    ? new RemoteError('session/writer-held', 'another Host writes it', { sessionId: reserved })
    : new SessionAlreadyOwnedError(reserved)
  test.resolve.mockRejectedValue(failure)
  await expect(test.runtime.runNow(tasks[0]!.record.id)).rejects.toBe(failure)
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.createSession).not.toHaveBeenCalled()
  expect(test.commit).not.toHaveBeenCalled()
  expect(tasks[0]).toMatchObject({ status: 'active', pendingDelivery: { targetSessionId: reserved } })
  expect(warn).toHaveBeenCalledExactlyOnceWith(`schedule: reminders ["task"] were not acknowledged: ${String(failure)}`)
})

it('retries in the created Session whose Agent did not resolve after creation', async () => {
  const tasks = [task({ kind: 'new', create: {} })]
  const test = await setup(tasks)
  test.resolve.mockImplementationOnce(async id => ({
    error: new RemoteError('session/writer-held', 'another Host writes it', { sessionId: id }),
  }))
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  const reserved = tasks[0]?.pendingDelivery?.targetSessionId
  expect(test.agents.get(reserved!)?.followup).not.toHaveBeenCalled()
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.createSession).toHaveBeenCalledOnce()
  expect(test.agents.get(reserved!)?.followup).toHaveBeenCalledOnce()
  expect(tasks[0]).toMatchObject({ status: 'ended', lastDelivery: { targetSessionId: reserved } })
})

it('keeps the timer of a failed member that restoration moved back into the future', async () => {
  const target = SessionId('target')
  const tasks = [task({ kind: 'session', sessionId: target })]
  const test = await setup(tasks)
  test.resolve.mockImplementationOnce(async () => {
    vi.setSystemTime('2026-09-16T00:00:00Z')
    return { error: new Error('failed') } as never
  })
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.commit).not.toHaveBeenCalled()
  const agent = agentFor(test.ctx, target)
  test.agents.set(target, agent)
  await vi.advanceTimersByTimeAsync(1000)
  expect(agent.followup).toHaveBeenCalledOnce()
  expect(tasks[0]?.status).toBe('ended')
})

it('creates no Session for a new-target task that a clock rollback made future before its target resolution', async () => {
  const target = SessionId('target')
  const fresh = seededTask(createRRuleScheduleRecord(
    ScheduleId('fresh'), 'Fresh', 'Do work', 'DTSTART:20260916T000001Z\nRRULE:FREQ=DAILY;COUNT=1', Date.now(),
  ), { kind: 'new', create: {} })
  const tasks = [task({ kind: 'session', sessionId: target }), fresh]
  const test = await setup(tasks)
  const agent = agentFor(test.ctx, target)
  test.resolve.mockImplementationOnce(async () => {
    vi.setSystemTime('2026-09-16T00:00:00Z')
    return { agent }
  })
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.commit).not.toHaveBeenCalled()
  expect(test.createSession).not.toHaveBeenCalled()
  test.agents.set(target, agent)
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.createSession).toHaveBeenCalledOnce()
  expect(tasks.map(item => item.status)).toEqual(['ended', 'ended'])
})

it('delivers the latest occurrence after a target resolution that spans several periods and advances past it', async () => {
  const target = SessionId('target')
  const tasks = [task({ kind: 'session', sessionId: target }, 'DTSTART:20260916T000001Z\nRRULE:FREQ=MINUTELY')]
  const test = await setup(tasks)
  const agent = agentFor(test.ctx, target)
  test.resolve.mockImplementationOnce(async () => {
    vi.setSystemTime('2026-09-16T00:03:30Z')
    return { agent }
  })
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(agent.followup).toHaveBeenCalledOnce()
  expect(tasks[0]).toMatchObject({
    status: 'active', record: { scheduledAt: '2026-09-16T00:04:01.000Z' },
    lastDelivery: { scheduledAt: '2026-09-16T00:03:01.000Z' },
  })
})

it('joins a created Session to the Workspace at its directory and names it after the task', async () => {
  const reserved = SessionId('reserved')
  const tasks = [task({ kind: 'new_once', sessionId: reserved, create: { cwd: '/work' } })]
  const test = await setup(tasks)
  const placed = await placement(test)
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(placed.attachSession).toHaveBeenCalledExactlyOnceWith(reserved)
  expect(placed.title(reserved)).toBe('Task')
  expect(test.agents.get(reserved)?.followup).toHaveBeenCalledOnce()
})

it('names each per-occurrence Session with its launch minute in the task time zone', async () => {
  const tasks = [task({ kind: 'new', create: {} }, 'DTSTART;TZID=Asia/Shanghai:20260916T080001\nRRULE:FREQ=DAILY')]
  const test = await setup(tasks)
  const placed = await placement(test)
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(placed.title(tasks[0]!.lastDelivery!.targetSessionId)).toBe('Task · 2026-09-16 08:00')
  vi.setSystemTime('2026-09-16T05:42:10Z')
  expect(await test.runtime.runNow(tasks[0]!.record.id)).toMatchObject({ admitted: true })
  expect(placed.title(tasks[0]!.lastDelivery!.targetSessionId)).toBe('Task · 2026-09-16 13:42')
  // A Session without a requested directory uses the Host directory and joins no Workspace.
  expect(placed.resolveByPath).not.toHaveBeenCalled()
})

it('delivers to the Session that an earlier delivery attempt created and keeps its title', async () => {
  const reserved = SessionId('pending')
  const tasks = [task({ kind: 'new', create: { cwd: '/work' } }, undefined, { pendingDelivery: { targetSessionId: reserved } })]
  const test = await setup(tasks)
  const placed = await placement(test)
  const agent = agentFor(test.ctx, reserved)
  test.agents.set(reserved, agent)
  test.ctx.sessionTitle.rename(agent.session, 'Earlier name')
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.createSession).not.toHaveBeenCalled()
  expect(placed.title(reserved)).toBe('Earlier name')
  expect(placed.attachSession).toHaveBeenCalledExactlyOnceWith(reserved)
  expect(agent.followup).toHaveBeenCalledOnce()
})

it('leaves a created Session outside every Workspace when no Workspace owns its directory', async () => {
  const reserved = SessionId('reserved')
  const tasks = [task({ kind: 'new_once', sessionId: reserved, create: { cwd: '/elsewhere' } })]
  const test = await setup(tasks)
  const placed = await placement(test)
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(placed.resolveByPath).toHaveBeenCalledExactlyOnceWith('/elsewhere')
  expect(placed.attachSession).not.toHaveBeenCalled()
  expect(placed.title(reserved)).toBe('Task')
})

it('delivers when the Workspace join and the naming of a created Session fail', async () => {
  const reserved = SessionId('reserved')
  // Title cleaning removes the zero-width space that task validation keeps, so the title service rejects the name.
  const record = createRRuleScheduleRecord(
    ScheduleId('task'), '\u200B', 'Do work', 'DTSTART:20260916T000001Z\nRRULE:FREQ=DAILY;COUNT=1', Date.now(),
  )
  const tasks = [seededTask(record, { kind: 'new_once', sessionId: reserved, create: { cwd: '/missing' } })]
  const test = await setup(tasks)
  const placed = await placement(test)
  const warn = vi.spyOn(test.ctx.logger, 'warn')
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.agents.get(reserved)?.followup).toHaveBeenCalledOnce()
  expect(tasks[0]).toMatchObject({ status: 'ended', target: { kind: 'session', sessionId: reserved } })
  expect(placed.title(reserved)).toBeUndefined()
  expect(warn.mock.calls).toEqual([
    ['schedule: Session reserved did not join the Workspace at /missing: Error: ENOENT: /missing'],
    ['schedule: Session reserved was not named: SessionTitleInvalidError: session title must contain visible characters'],
  ])
})
