import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ScheduleId,
  createEveryScheduleRecord,
  foldScheduleEvents,
  resolveEveryOccurrence,
} from '../src/domain.ts'

const BASE = Date.parse('2000-01-01T00:00:00.000Z')

function event(data: unknown, seq: number): SessionEvent {
  return { type: 'schedule/change', seq, time: BASE, data } as SessionEvent
}

describe('fixed-rate recurrence properties', () => {
  it('keeps latest-only runtime calculation and durable folding on the creation anchor', () => {
    fc.assert(fc.property(
      fc.integer({ min: 300, max: 86_400 }),
      fc.integer({ min: 0, max: 10_000 }),
      fc.nat({ max: 86_399_999 }),
      (everySeconds, skipped, rawOffset) => {
        const record = createEveryScheduleRecord(
          ScheduleId('schedule-property'),
          'property reminder',
          everySeconds,
          BASE,
          'property reminder',
        )
        const interval = everySeconds * 1_000
        const target = Date.parse(record.scheduledAt)
        const accepted = target + skipped * interval + rawOffset % interval
        const calculated = resolveEveryOccurrence(record, accepted)
        const expectedOccurrence = new Date(target + skipped * interval).toISOString()
        const expectedNext = new Date(target + (skipped + 1) * interval).toISOString()
        expect(calculated).toEqual({
          occurrenceAt: expectedOccurrence,
          nextScheduledAt: expectedNext,
        })

        const folded = foldScheduleEvents([
          event({ version: 1, operation: 'create', schedule: record }, 0),
          event({
            version: 1,
            operation: 'dispatch',
            id: record.id,
            acceptedAt: new Date(accepted).toISOString(),
          }, 1),
        ])
        expect(folded.active).toEqual([{ ...record, scheduledAt: expectedNext }])
      },
    ), { numRuns: 300 })
  })
})
