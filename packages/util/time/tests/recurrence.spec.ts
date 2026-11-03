/** Consumer-independent Cron and RRULE values share strict parsing and bounded occurrence behavior. */
import { expect, it } from 'vitest'
import { Cron, RRule, MIN_FOUR_DIGIT_YEAR_MS, MAX_FOUR_DIGIT_YEAR_MS } from '../src/index.ts'
import type { RecurrenceResult } from '../src/index.ts'
import { parseRecurrence } from '../src/recurrence.ts'

function accepted<T>(result: RecurrenceResult<T>): T {
  if (result.kind !== 'accepted') throw new Error(result.detail)
  return result.rule
}

it('preserves unexpected parser failures instead of reporting invalid user input', () => {
  const failure = new TypeError('parser failed')
  expect(() => parseRecurrence(() => { throw failure })).toThrow(failure)
})

it('keeps Cron expression and zone distinct from RRULE content', () => {
  const cron = accepted(Cron.parse('0 9 1 * 1', 'UTC'))
  const rrule = accepted(RRule.parse('DTSTART:20261001T090000Z\nRRULE:FREQ=MONTHLY'))
  expect(cron.expression).toBe('0 9 1 * 1')
  expect(cron.timeZone).toBe('UTC')
  expect(cron.fields.daysOfMonth).toEqual([1])
  expect(cron.fields.daysOfWeek).toEqual([1])
  expect(cron.fields.dayOfMonthStar).toBe(false)
  expect(Object.isFrozen(cron.fields.minutes)).toBe(true)
  expect(rrule.expression).toContain('RRULE:FREQ=MONTHLY')
  const after = Date.parse('2026-10-02T00:00:00Z')
  expect(cron.next(after)).toBe('2026-10-05T09:00:00.000Z')
  expect(rrule.next(after)).toBe('2026-11-01T09:00:00.000Z')
  expect(Object.isFrozen(cron)).toBe(true)
  expect(Object.isFrozen(rrule)).toBe(true)
})

it('keeps discontinuous minute groups through canonicalization and occurrence searches', () => {
  const rule = accepted(Cron.parse('8,0,1,4,7 9 * * *', 'UTC'))
  expect(rule.expression).toBe('0-1,4,7-8 9 * * *')
  expect(rule.fields.minutes).toEqual([0, 1, 4, 7, 8])
  expect(rule.next(Date.parse('2026-10-01T09:04:00.001Z'))).toBe('2026-10-01T09:07:00.000Z')
  expect(rule.resolve('2026-10-01T09:00:00.000Z', Date.parse('2026-10-01T09:08:00.001Z')))
    .toEqual({ occurrenceAt: '2026-10-01T09:08:00.000Z', nextScheduledAt: '2026-10-02T09:00:00.000Z' })
})

it.each([
  () => accepted(Cron.parse('30 2 * * *', 'America/New_York')),
  () => accepted(RRule.parse('DTSTART;TZID=America/New_York:20260307T023000\nRRULE:FREQ=DAILY')),
])('skips a missing local time without changing the explicit zone', (parse) => {
  expect(parse().next(Date.parse('2026-03-08T00:00:00Z'))).toBe('2026-03-09T06:30:00.000Z')
})

it.each([
  () => accepted(Cron.parse('0 1 * * *', 'America/New_York')),
  () => accepted(RRule.parse('DTSTART;TZID=America/New_York:20261031T010000\nRRULE:FREQ=DAILY')),
])('does not repeat an overlapping wall-clock occurrence', (parse) => {
  expect(parse().next(Date.parse('2026-11-01T05:30:00Z'))).toBe('2026-11-02T06:00:00.000Z')
})

it.each([
  () => accepted(Cron.parse('* * * * *', 'UTC')),
  () => accepted(RRule.parse('DTSTART:20260101T000000Z\nRRULE:FREQ=MINUTELY')),
])('coalesces missed occurrences from an explicit committed lower bound', (parse) => {
  const rule = parse()
  expect(rule.resolve('2026-01-01T00:00:00.000Z', Date.parse('2026-10-01T01:02:03Z')))
    .toEqual({ occurrenceAt: '2026-10-01T01:02:00.000Z', nextScheduledAt: '2026-10-01T01:03:00.000Z' })
  for (const after of [NaN, MIN_FOUR_DIGIT_YEAR_MS - 1, MAX_FOUR_DIGIT_YEAR_MS + 1]) {
    expect(() => rule.next(after)).toThrow(RangeError)
  }
  expect(() => rule.resolve('2026-01-01T00:00:00.000Z', 0)).toThrow(RangeError)
})

it.each([
  () => accepted(Cron.parse('* * * * *', 'UTC')),
  () => accepted(RRule.parse('DTSTART:20260101T000000Z\nRRULE:FREQ=MINUTELY')),
])('refuses a committed lower bound outside the canonical stored instant profile', (parse) => {
  const rule = parse()
  const decision = Date.parse('2026-03-03T00:00:00.000Z')
  for (const scheduledAt of [
    '2026-02-30T00:00:00.000Z',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00.0000Z',
    '2026-01-01T08:00:00.000+08:00',
    '2026-01-01',
    '0000-01-01T00:00:00.000Z',
    'not-an-instant',
  ]) {
    expect(() => rule.resolve(scheduledAt, decision), scheduledAt).toThrow(RangeError)
  }
})

it.each([
  [Cron.parse('* * * * * *', 'UTC'), 'syntax'],
  [Cron.parse('* * * * *', 'Not/A_Zone'), 'time_zone'],
  [RRule.parse('RRULE:FREQ=DAILY'), 'syntax'],
  [RRule.parse('DTSTART:20260916T000000Z\nRRULE:FREQ=SECONDLY'), 'density'],
  [RRule.parse('DTSTART:20260916T000000Z\nRRULE:FREQ=DAILY;BYSECOND=0,30'), 'density'],
] as const)('reports parser rejections without a consumer error code', (result, reason) => {
  expect(result).toMatchObject({ kind: 'rejected', reason })
  expect(result).not.toHaveProperty('code')
})

it('permits a stricter authoring profile without changing valid RFC arithmetic', () => {
  const text = 'DTSTART:20260916T090000Z\nRRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'
  expect(RRule.parse(text).kind).toBe('accepted')
  expect(RRule.parse(text, { rejectIneffectiveSetPositions: true })).toMatchObject({ kind: 'rejected', reason: 'syntax' })
})
