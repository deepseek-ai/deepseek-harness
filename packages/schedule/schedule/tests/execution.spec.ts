/** Real Agent inboxes keep one queued delivery per Host task across a runtime restart and a running Goal round. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import * as goalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { ScheduleId } from '../src/domain.ts'
import { createRRuleScheduleRecord } from '../src/domain.ts'
import { MIN_DELIVERY_INTERVAL_MS, ScheduleRuntime } from '../src/runtime.ts'
import type { ScheduleTask } from '../src/storage.ts'
import { seededTask } from './harness.ts'

const LIMITS = { retention: { days: 30, records: 200 }, newSessionIntervalMs: 3_600_000 }

class HangingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly complete = Promise.withResolvers<undefined>()

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    await Promise.race([this.complete.promise, new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })])
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('requeues a still-queued delivery after restart instead of enqueuing another copy', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-16T00:00:02.000Z'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const loop = await mountAgentLoopTestHarness(ctx)
    const agent = await loop.create(SessionId('delivery-owner'))
    // Maintenance holds model execution while the production followup still records inbox input.
    const releaseMaintenance = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(() => releaseMaintenance.promise)
    try {
      const whenIdle = vi.spyOn(agent, 'whenIdle')
      ctx.provide('sessionController', { resolveAgent: async () => ({ agent }) } as never)
      const record = createRRuleScheduleRecord(
        ScheduleId('receipt'), 'Inbox only', 'Inbox only',
        'DTSTART:20260916T000001Z\nRRULE:FREQ=DAILY;COUNT=1', Date.now() - 2000,
      )
      const tasks: ScheduleTask[] = [seededTask(record, { kind: 'session', sessionId: agent.session.id })]
      const flushStarted = Promise.withResolvers<undefined>()
      const releaseFlush = Promise.withResolvers<undefined>()
      let eventsAtFlush: readonly SessionEvent[] = []
      ctx.on('session/flush', (session) => {
        eventsAtFlush = session.snapshotEvents()
        flushStarted.resolve(undefined)
        return releaseFlush.promise
      })
      const commit = vi.fn(async (task: ScheduleTask) => { tasks[0] = task })
      const runtime = new ScheduleRuntime(ctx, () => tasks, work => work(), commit, () => {}, LIMITS, async () => agent)
      try {
        runtime.requestDrive()
        await flushStarted.promise
        // The Agent activity is captured before flush, and the task holds its admission slot from the enqueue.
        expect(whenIdle).toHaveBeenCalledOnce()
        expect(runtime.isExecutionActive(record.id)).toBe(true)
        const inserted = eventsAtFlush.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
        expect(inserted).toHaveLength(1)
        vi.setSystemTime(new Date('2026-09-16T00:00:03.000Z'))
        releaseFlush.resolve(undefined)
        await runtime.dispose()
        expect(tasks).toEqual([expect.objectContaining({
          record, target: { kind: 'session', sessionId: agent.session.id }, status: 'ended',
          lastDelivery: {
            scheduledAt: record.scheduledAt, deliveredAt: '2026-09-16T00:00:03.000Z',
            messageId: inserted[0]!.id, targetSessionId: agent.session.id,
          },
        })])

        // Past the admission floor, a restarted runtime finds the reminder still queued and requeues that message
        // instead of enqueuing a copy for either the due occurrence or a manual request.
        tasks[0] = { ...tasks[0]!, status: 'active' }
        vi.setSystemTime(Date.parse('2026-09-16T00:00:03.000Z') + MIN_DELIVERY_INTERVAL_MS)
        const recovered = new ScheduleRuntime(ctx, () => tasks, work => work(), commit, () => {}, LIMITS, async () => agent)
        try {
          recovered.requestDrive()
          await vi.advanceTimersByTimeAsync(0)
          expect(recovered.isExecutionActive(record.id)).toBe(true)
          expect(await recovered.runNow(record.id)).toMatchObject({ admitted: false })
          expect(agent.inbox.nextTurn).toEqual(inserted)
        } finally {
          await recovered.dispose()
        }

        // A failed recovery flush releases the slot, so the next request requeues the same message again.
        const failedRecovery = new ScheduleRuntime(ctx, () => tasks, work => work(), commit, () => {}, LIMITS, async () => agent)
        const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValueOnce(false)
        try {
          await expect(failedRecovery.runNow(record.id)).rejects.toThrow('did not acknowledge the recovered reminder')
          expect(failedRecovery.isExecutionActive(record.id)).toBe(false)
          expect(await failedRecovery.runNow(record.id)).toMatchObject({ admitted: false })
          expect(failedRecovery.isExecutionActive(record.id)).toBe(true)
          expect(agent.inbox.nextTurn).toEqual(inserted)
          expect(commit).toHaveBeenCalledTimes(1)
        } finally {
          flush.mockRestore()
          await failedRecovery.dispose()
        }
      } finally {
        releaseFlush.resolve(undefined)
        await runtime.dispose()
      }
    } finally {
      agent.cancel({ kind: 'user' })
      releaseMaintenance.resolve(undefined)
      await maintenance
    }
  } finally {
    await ctx.fiber.dispose()
    vi.useRealTimers()
  }
})

it('holds every recovered batch member before the real driver claims their shared message', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-16T00:01:02.000Z'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const loop = await mountAgentLoopTestHarness(ctx)
    const adapter = new HangingAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await loop.create(SessionId('batch-owner'), { provider: 'mock', model: 'mock' })
    const message = createUserMessage({ content: [{ type: 'text', text: 'Stored reminder batch' }], source: { kind: 'schedule' } })
    agent.inject(message)
    const receipt = { scheduledAt: '2026-09-15T00:00:01.000Z', deliveredAt: '2026-09-15T00:00:01.000Z',
      messageId: message.id, targetSessionId: agent.session.id }
    const tasks = ['first', 'second'].map((id) => {
      const record = createRRuleScheduleRecord(ScheduleId(id), id, id,
        'DTSTART:20260915T000001Z\nRRULE:FREQ=DAILY', Date.parse('2026-09-15T00:00:02.000Z'))
      return seededTask(record, { kind: 'session', sessionId: agent.session.id }, {
        lastDelivery: receipt,
        deliveryHistory: { records: [{ ...receipt, prompt: record.prompt }],
          earlierRecordsUnavailable: false, earlierRecordsPruned: false },
      })
    })
    const claimed = Promise.withResolvers<undefined>()
    ctx.on('agent/inbox/claimed', ({ agent: subject, message: input }) => {
      if (subject === agent && input.id === message.id) claimed.resolve(undefined)
    })
    // The restored driver takes the shared message before the recovery flush finishes.
    ctx.on('session/flush', () => claimed.promise)
    const commit = vi.fn(async (task: ScheduleTask) => {
      tasks[tasks.findIndex(current => current.record.id === task.record.id)] = task
    })
    const runtime = new ScheduleRuntime(ctx, () => tasks, work => work(), commit, () => {}, LIMITS, async () => agent)
    try {
      runtime.requestDrive()
      await vi.advanceTimersByTimeAsync(0)
      expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toHaveLength(0)
      expect(adapter.requests).toHaveLength(1)
      expect(tasks.map(task => runtime.isExecutionActive(task.record.id))).toEqual([true, true])
      expect(commit).not.toHaveBeenCalled()
      expect(await runtime.runNow(ScheduleId('second'))).toMatchObject({ admitted: false })

      adapter.complete.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(adapter.requests).toHaveLength(2)
      expect(commit).toHaveBeenCalledTimes(2)
      expect(tasks[0]?.lastDelivery?.messageId).not.toBe(message.id)
      expect(tasks[1]?.lastDelivery?.messageId).toBe(tasks[0]?.lastDelivery?.messageId)
      expect(tasks.map(task => task.record.scheduledAt)).toEqual(['2026-09-17T00:00:01.000Z', '2026-09-17T00:00:01.000Z'])
      expect(tasks.map(task => runtime.isExecutionActive(task.record.id))).toEqual([false, false])
    } finally {
      claimed.resolve(undefined)
      adapter.complete.resolve(undefined)
      await runtime.dispose()
    }
  } finally {
    await ctx.fiber.dispose()
    vi.useRealTimers()
  }
})

it('consolidates manual executions while a real Goal round is in flight', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(GoalService)
    await ctx.plugin(goalRoundDriver)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new HangingAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('goal-owner'), { provider: 'mock', model: 'mock' })
    ctx.goals.create(agent, { objective: 'Keep working while the schedule queues', maxGoalRounds: 2 })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    expect(agent.status).toBe('running')

    ctx.provide('sessionController', { resolveAgent: async () => ({ agent }) } as never)
    ctx.on('session/flush', () => {})
    const record = createRRuleScheduleRecord(
      ScheduleId('goal-queue'), 'Queue behind Goal', 'Scheduled follow-up',
      'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY', Date.now(),
    )
    const tasks: ScheduleTask[] = [seededTask(record, { kind: 'session', sessionId: agent.session.id })]
    const commit = async (task: ScheduleTask): Promise<void> => { tasks[0] = task }
    const runtime = new ScheduleRuntime(ctx, () => tasks, work => work(), commit, () => {}, LIMITS, async () => agent)
    try {
      const first = await runtime.runNow(record.id)
      const second = await runtime.runNow(record.id)
      // Past the admission floor, a restarted runtime finds the reminder still queued behind the running Goal round.
      vi.setSystemTime(Date.now() + MIN_DELIVERY_INTERVAL_MS)
      const recovered = new ScheduleRuntime(ctx, () => tasks, work => work(), commit, () => {}, LIMITS, async () => agent)
      const afterRestart = await recovered.runNow(record.id)
      expect(recovered.isExecutionActive(record.id)).toBe(true)
      await recovered.dispose()
      expect(first).toMatchObject({ admitted: true })
      expect(second).toMatchObject({ admitted: false })
      expect(afterRestart).toMatchObject({ admitted: false })
      expect(runtime.isExecutionActive(record.id)).toBe(true)
      expect(agent.inbox.nextTurn).toHaveLength(1)
      expect(agent.inbox.nextTurn[0]?.source).toEqual({ kind: 'schedule' })
    } finally {
      await runtime.dispose()
      vi.useRealTimers()
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
