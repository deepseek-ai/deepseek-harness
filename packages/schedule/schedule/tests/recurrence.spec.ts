import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  ScheduleId,
  createEveryScheduleRecord,
  resolveEveryOccurrence,
} from '../src/domain.ts'

const BASE = Date.parse('2000-01-01T00:00:00.000Z')

describe('fixed-rate recurrence properties', () => {
  it('keeps latest-only occurrence calculation on the creation anchor', () => {
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

      },
    ), { numRuns: 300 })
  })
})
