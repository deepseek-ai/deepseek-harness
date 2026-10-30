/** A failed creation of a reserved Session keeps its task due, and the next drive request creates that same Session. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ScheduleId } from '../src/domain.ts'
import { createRRuleScheduleRecord } from '../src/domain.ts'
import { ScheduleRuntime } from '../src/runtime.ts'
import { agentFor, harness, seededTask } from './harness.ts'

const active: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-09-16T00:00:00Z') })
afterEach(async () => {
  await Promise.all(active.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.useRealTimers()
})

it('retries a reserved new Session identity after creation fails', async () => {
  const test = await harness()
  active.push(test)
  const reserved = SessionId('reserved-retry')
  const task = seededTask(
    createRRuleScheduleRecord(ScheduleId('retry'), 'Retry', 'Deliver', 'DTSTART:20260916T000001Z\nRRULE:FREQ=DAILY;COUNT=1', Date.now()),
    { kind: 'new_once', sessionId: reserved, create: {} },
  )
  const agents = new Map<string, Agent>()
  test.resolve.mockImplementation(async (id) => {
    const agent = agents.get(id)
    return agent === undefined ? { error: new RemoteError('session/not-found', `missing ${id}`, { sessionId: id }) } : { agent }
  })
  test.createSession.mockRejectedValueOnce(new Error('temporary create failure'))
  const runtime = new ScheduleRuntime(
    test.ctx, () => [task], work => work(), async (next) => { Object.assign(task, next) }, () => {},
    { retention: { days: 30, records: 200 }, newSessionIntervalMs: 3_600_000 }, test.resolveAgent,
  )
  try {
    runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(1000)
    expect(test.createSession).toHaveBeenLastCalledWith({ sessionId: reserved })
    expect(task.status).toBe('active')
    test.createSession.mockImplementation(async () => {
      agents.set(reserved, agentFor(test.ctx, reserved))
      return { sessionId: reserved }
    })
    runtime.requestDrive()
    await vi.runAllTimersAsync()
    expect(test.createSession).toHaveBeenCalledTimes(2)
    expect(test.createSession).toHaveBeenLastCalledWith({ sessionId: reserved })
    expect(task).toMatchObject({ status: 'ended', target: { kind: 'session', sessionId: reserved } })
  } finally {
    await runtime.dispose()
  }
})
