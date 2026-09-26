import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { createAfterScheduleRecord, ScheduleId } from '../src/domain.ts'
import { ScheduleRuntime } from '../src/runtime.ts'
import type { ScheduleTask } from '../src/storage.ts'

it('acknowledges the real synchronous inbox splice after flush without claiming model execution', async () => {
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
      const resolve = vi.fn(async () => ({ agent }))
      ctx.provide('sessionController', { resolveAgent: resolve } as never)
      const record = createAfterScheduleRecord(ScheduleId('receipt'), 'Inbox only', 1, Date.now() - 2000, 'Inbox only')
      const tasks: ScheduleTask[] = [{ sessionId: agent.session.id, record, status: 'active' }]
      const flushStarted = Promise.withResolvers<undefined>()
      const releaseFlush = Promise.withResolvers<undefined>()
      let eventsAtFlush: readonly SessionEvent[] = []
      ctx.on('session/flush', (session) => {
        eventsAtFlush = session.snapshotEvents()
        flushStarted.resolve(undefined)
        return releaseFlush.promise
      })
      const commit = vi.fn(async (task: ScheduleTask) => { tasks[0] = task })
      const runtime = new ScheduleRuntime(ctx, () => tasks, work => work(), commit, { days: 30, records: 200 })
      try {
        runtime.requestDrive()
        await flushStarted.promise
        expect(resolve).toHaveBeenCalledWith(agent.session.id)
        const inserted = eventsAtFlush.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
        expect(inserted).toHaveLength(1)
        expect(inserted[0]?.source).toEqual({ kind: 'schedule' })
        expect(agent.inbox.nextTurn).toEqual(inserted)
        expect(commit).not.toHaveBeenCalled()
        expect(tasks).toEqual([{ sessionId: agent.session.id, record, status: 'active' }])
        vi.setSystemTime(new Date('2026-09-16T00:00:03.000Z'))
        releaseFlush.resolve(undefined)
        await runtime.dispose()
        expect(commit).toHaveBeenCalledTimes(1)
        expect(tasks).toEqual([{
          sessionId: agent.session.id, record, status: 'inactive',
          deliveryHistory: { records: [{
            scheduledAt: record.scheduledAt, deliveredAt: '2026-09-16T00:00:03.000Z', messageId: inserted[0]!.id,
            prompt: 'Inbox only',
          }], earlierRecordsUnavailable: true, earlierRecordsPruned: false },
          lastDelivery: {
            scheduledAt: record.scheduledAt, deliveredAt: '2026-09-16T00:00:03.000Z', messageId: inserted[0]!.id,
          },
        }])
        expect(agent.inbox.nextTurn).toEqual(inserted)
        expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
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
