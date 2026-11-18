/** Fixed source samples delivered through Schedule in the shipped headless profile. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-storage-domain'
import ScheduleService, { ScheduleId, scheduleDomain } from '@deepseek-ai/dsh-schedule'
import type { AutomationCandidate } from '@deepseek-ai/dsh-schedule'

class SampleSource {
  private readonly submit: (candidate: AutomationCandidate) => Promise<void>

  constructor(submit: (candidate: AutomationCandidate) => Promise<void>) {
    this.submit = submit
  }

  sample(left: string, right: string): Promise<void> {
    return this.submit({ text: `Left: ${left}\nRight: ${right}` })
  }
}

/** Snapshot-only source producer name. */
export const name = 'source-task-input'
/** The profile owns persistence, while this fixture owns its one task and sample producer. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'storageDomain']

/**
 * Seed an authoritative task with a fixed identity, then deliver samples during the initiating user turn.
 * @param ctx - Shipped profile context with real storage and Agent services.
 */
export function apply(ctx: Context): void {
  const id = ScheduleId('schedule-source-snapshot')
  ctx.on('agent/created', async ({ agent }) => {
    const domain = await ctx.storageDomain.open(scheduleDomain)
    try {
      await domain.table('tasks').put(id, {
        record: {
          id, kind: 'at', title: 'Compare observations',
          prompt: 'Compare both observations and report their differences.',
          scheduledAt: '2099-01-01T00:00:00.000Z',
        },
        target: { kind: 'session', sessionId: agent.id },
        involvedSessionIds: [agent.id],
        status: 'active',
        deliveryHistory: { records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
      })
    } finally {
      await domain.close()
    }
    await ctx.plugin(ScheduleService, {})
    await ctx.plugin({
      name: 'source-task-input-consumer',
      inject: ['schedule'],
      apply(scope: Context) {
        const schedule = scope.schedule
        const source = new SampleSource(candidate => schedule.submit(id, candidate))
        let delivery: Promise<void> | undefined
        scope.effect(function* () {
          yield scope.on('schedule/resolve-agent', (sessionId, next) => sessionId === agent.id ? Promise.resolve(agent) : next())
          yield async () => { await delivery }
        }, 'source-snapshot.producer()')
        let delivered = false
        scope.on('agent/pre-step', async ({ agent: subject }, next) => {
          if (subject !== agent || delivered) return next()
          delivered = true
          // Only this isolated process owns Date.now; no model request runs until the sample is restored.
          const now = Date.now
          Date.now = () => Date.UTC(2026, 10, 11, 0, 0, 0)
          try {
            delivery = source.sample('build passed', 'tests failed\n"review" \\ observed')
            await delivery
          } finally {
            Date.now = now
          }
          const task = await scope.schedule.view({ id })
          assert.ok(!('code' in task))
          assert.equal(task.scheduledAt, '2099-01-01T00:00:00.000Z')
          assert.ok(task.lastDelivery)
          assert.equal(task.lastDelivery.scheduledAt, '2026-11-11T00:00:00.000Z')
          return next()
        })
      },
    })
  })
}
