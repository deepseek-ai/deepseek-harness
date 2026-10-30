/** RRULE syntax and bounded calendar arithmetic, independent of Schedule task policy. */
import { describe, expect, it } from 'vitest'
import { RRule } from '../src/index.ts'

/** Join a DTSTART line and an RRULE body. */
function rule(body: string, start = 'DTSTART:20260916T010000Z'): string {
  return `${start}\nRRULE:${body}`
}

/** List the integers from `from` up to but excluding `to`, separated by commas. */
function numbers(from: number, to: number): string {
  return Array.from({ length: to - from }, (_, index) => from + index).join(',')
}

const now = Date.parse('2026-09-16T00:00:00.000Z')
const daily = rule('FREQ=DAILY')
const EVERY_MINUTE = `BYHOUR=${numbers(0, 24)};BYMINUTE=${numbers(0, 60)}`
const LINES = 'rrule must contain one DTSTART line followed by one RRULE line.'
const SPRING_GAP = 'DTSTART;TZID=America/New_York:20260308T023000'

/** Parse a valid test rule, preserving the shared utility's own failures. */
function parsed(value: string): RRule {
  const result = RRule.parse(value)
  if (result.kind === 'rejected') throw new Error(result.detail)
  return result.rule
}

function normalized(value: string): string {
  return parsed(value).expression
}

function first(value: string, at = now): string | undefined {
  return parsed(value).next(at)
}

function after(value: string, instant: string): string | undefined {
  return first(value, Date.parse(instant))
}

function resolve(value: string, scheduledAt: string | undefined, acceptedAt: string) {
  if (scheduledAt === undefined) throw new Error('RRULE fixture has no committed occurrence')
  return parsed(value).resolve(scheduledAt, Date.parse(acceptedAt))
}

/** Return up to `limit` consecutive occurrences after an instant. */
function occurrences(rrule: string, instant: string, limit: number): string[] {
  const result: string[] = []
  for (let next = after(rrule, instant); next !== undefined && result.length < limit; next = after(rrule, next)) {
    result.push(next)
  }
  return result
}

describe('RRULE validation', () => {
  it('keeps the trimmed DTSTART and RRULE lines and the TZID as written', () => {
    expect(normalized(' DTSTART:20260916T010000Z\r\n\n RRULE:FREQ=DAILY \n')).toBe(daily)
    const eastern = rule('FREQ=DAILY', 'DTSTART;TZID=US/Eastern:20260916T010000')
    expect(normalized(eastern)).toBe(eastern)
    expect(first(eastern)).toBe('2026-09-16T05:00:00.000Z')
  })

  it('accepts the bounds of each numeric part', () => {
    for (const rrule of [
      rule('FREQ=DAILY;COUNT=1000'),
      rule('FREQ=DAILY;UNTIL=99991231T235959Z'),
      rule('FREQ=DAILY', 'DTSTART:01000101T000000Z'),
      rule(`FREQ=DAILY;INTERVAL=${Number.MAX_SAFE_INTEGER}`),
      rule('FREQ=YEARLY;BYMONTH=1,12;BYMONTHDAY=-31,31;BYHOUR=0,23;BYMINUTE=0,59;BYSECOND=59'),
      rule('FREQ=YEARLY;BYYEARDAY=-366,366;BYWEEKNO=-53,53;BYDAY=MO'),
      rule('FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYSETPOS=-366,366'),
    ]) expect(normalized(rrule)).toBe(rrule)
    expect(first(rule('FREQ=YEARLY;BYDAY=53MO'))).toBe('2029-12-31T01:00:00.000Z')
    expect(first(rule('FREQ=MONTHLY;BYMONTHDAY=+5'))).toBe('2026-10-05T01:00:00.000Z')
    expect(first(rule('FREQ=MONTHLY;BYMONTHDAY=05'))).toBe('2026-10-05T01:00:00.000Z')
  })

  const DTSTART_DATE = 'DTSTART must be a real calendar date and time in years 0100 through 9999.'
  const DTSTART_FORM = 'DTSTART must use UTC with Z or a local date-time with an explicit TZID.'
  const FIELDS = 'RRULE fields must be non-empty and unique.'
  const SUPPORTED_PARTS = 'RRULE supports only FREQ, INTERVAL, COUNT, UNTIL, WKST, BYSECOND, BYMINUTE, BYHOUR, BYDAY, '
    + 'BYMONTHDAY, BYYEARDAY, BYWEEKNO, BYMONTH, BYSETPOS.'
  const FREQ = 'FREQ must be MINUTELY, HOURLY, DAILY, WEEKLY, MONTHLY, or YEARLY.'
  const INTERVAL = 'INTERVAL must be a positive safe integer.'
  const COUNT = 'COUNT must be an integer from 1 to 1000; use UNTIL for a longer finite recurrence.'
  const UNTIL_DATE = 'UNTIL must be a real calendar date and time in years 0100 through 9999.'
  const BYDAY = 'BYDAY contains an invalid weekday selector.'

  it.each<[string, string]>([
    ['', LINES],
    ['RRULE:FREQ=DAILY', LINES],
    ['RRULE:FREQ=DAILY\nDTSTART:20260916T010000Z', LINES],
    ['DTSTART:20260916T010000Z\nEXDATE:20260917T010000Z', LINES],
    [`${daily}\n${daily}`, LINES],
    [rule('FREQ=DAILY', 'DTSTART:20260916T010000'), DTSTART_FORM],
    ['DTSTART;VALUE=DATE:20260916\nRRULE:FREQ=DAILY', DTSTART_FORM],
    [rule('FREQ=DAILY', 'DTSTART:00991231T000000Z'), DTSTART_DATE],
    [rule('FREQ=DAILY', 'DTSTART:20260230T010000Z'), DTSTART_DATE],
    [rule('FREQ=DAILY', 'DTSTART;TZID=UTC:20260916T240000'), DTSTART_DATE],
    [rule('FREQ=DAILY', SPRING_GAP), 'DTSTART must be a real local date and time in its time zone.'],
    [rule('FREQ=DAILY;COUNT=1', SPRING_GAP), 'DTSTART must be a real local date and time in its time zone.'],
    [rule('NOT_A_RULE'), FIELDS],
    [rule('=DAILY'), FIELDS],
    [rule('FREQ='), FIELDS],
    [rule('FREQ=DAILY;'), FIELDS],
    [rule('FREQ=DAILY;FREQ=WEEKLY'), FIELDS],
    [rule('freq=daily'), SUPPORTED_PARTS],
    [rule('FREQ=DAILY;BYEASTER=0'), SUPPORTED_PARTS],
    [rule('INTERVAL=2'), 'RRULE must contain FREQ.'],
    [rule('FREQ=NOTREAL'), FREQ],
    [rule('FREQ=constructor'), FREQ],
    [rule('FREQ=DAILY;INTERVAL=0'), INTERVAL],
    [rule('FREQ=DAILY;INTERVAL=-1'), INTERVAL],
    [rule('FREQ=DAILY;INTERVAL=9007199254740992'), INTERVAL],
    [rule('FREQ=DAILY;COUNT=0'), COUNT],
    [rule('FREQ=DAILY;COUNT=1001'), COUNT],
    [rule('FREQ=DAILY;UNTIL=20260917T010000'), 'UNTIL must be an absolute UTC date-time ending in Z.'],
    [rule('FREQ=DAILY;UNTIL=20260230T010000Z'), UNTIL_DATE],
    [rule('FREQ=DAILY;UNTIL=00991231T000000Z'), UNTIL_DATE],
    [rule('FREQ=WEEKLY;WKST=XX'), 'WKST must be MO, TU, WE, TH, FR, SA, or SU.'],
    [rule('FREQ=DAILY;BYSECOND=-1'), 'BYSECOND values must be integers from 0 to 59.'],
    [rule('FREQ=DAILY;BYMINUTE=60'), 'BYMINUTE values must be integers from 0 to 59.'],
    [rule('FREQ=DAILY;BYHOUR=9,'), 'BYHOUR values must be integers from 0 to 23.'],
    [rule('FREQ=MONTHLY;BYMONTHDAY=0'), 'BYMONTHDAY values must be integers from -31 to 31, excluding 0.'],
    [rule('FREQ=YEARLY;BYYEARDAY=367'), 'BYYEARDAY values must be integers from -366 to 366, excluding 0.'],
    [rule('FREQ=YEARLY;BYWEEKNO=+54'), 'BYWEEKNO values must be integers from -53 to 53, excluding 0.'],
    [rule('FREQ=YEARLY;BYMONTH=13'), 'BYMONTH values must be integers from 1 to 12.'],
    [rule('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=0'), 'BYSETPOS values must be integers from -366 to 366, excluding 0.'],
    [rule('FREQ=DAILY;BYHOUR=12,12'), 'BYHOUR values must be unique.'],
    [rule('FREQ=MONTHLY;BYMONTHDAY=1,+1'), 'BYMONTHDAY values must be unique.'],
    [rule('FREQ=DAILY;BYDAY=XX'), BYDAY],
    [rule('FREQ=MONTHLY;BYDAY=0MO'), BYDAY],
    [rule('FREQ=YEARLY;BYDAY=54MO'), BYDAY],
    [rule('FREQ=MONTHLY;BYDAY=2TU,+2TU'), 'BYDAY values must be unique.'],
    [rule('FREQ=DAILY;COUNT=2;UNTIL=20261001T000000Z'), 'RRULE must not contain both COUNT and UNTIL.'],
    [
      rule('FREQ=MINUTELY;BYSECOND=0'),
      'FREQ=MINUTELY does not support BY rule parts; use FREQ=DAILY or FREQ=WEEKLY with BYHOUR and BYMINUTE.',
    ],
    [
      rule('FREQ=HOURLY;BYDAY=MO'),
      'FREQ=HOURLY does not support BY rule parts; use FREQ=DAILY or FREQ=WEEKLY with BYHOUR and BYMINUTE.',
    ],
    [rule('FREQ=MONTHLY;BYWEEKNO=1'), 'BYWEEKNO requires FREQ=YEARLY.'],
    [rule('FREQ=DAILY;BYYEARDAY=1'), 'BYYEARDAY requires FREQ=YEARLY.'],
    [rule('FREQ=WEEKLY;BYMONTHDAY=1'), 'BYMONTHDAY requires FREQ=MONTHLY or FREQ=YEARLY.'],
    [rule('FREQ=WEEKLY;BYDAY=1MO'), 'BYDAY ordinals require FREQ=MONTHLY or FREQ=YEARLY.'],
    [rule('FREQ=YEARLY;BYWEEKNO=1;BYDAY=1MO'), 'BYDAY ordinals cannot be combined with BYWEEKNO.'],
    [rule('FREQ=MONTHLY;BYSETPOS=1'), 'BYSETPOS requires another BY rule part.'],
    [rule(`FREQ=YEARLY;BYDAY=MO;BYSETPOS=${numbers(1, 33)}`), 'BYSETPOS must contain at most 31 values.'],
  ])('rejects %j as an invalid rule', (rrule, message) => {
    expect(RRule.parse(rrule)).toMatchObject({ kind: 'rejected', reason: 'syntax', detail: message })
  })

  it.each<[string, string]>([
    [rule('FREQ=SECONDLY;INTERVAL=300'), 'FREQ=SECONDLY is not supported; occurrences must be at least 60 seconds apart.'],
    [rule('FREQ=SECONDLY;BYSECOND=0'), 'FREQ=SECONDLY is not supported; occurrences must be at least 60 seconds apart.'],
    [rule('FREQ=DAILY;BYSECOND=0,30'), 'BYSECOND must contain one value; occurrences must be at least 60 seconds apart.'],
    [
      rule(`FREQ=MONTHLY;BYMONTHDAY=${numbers(1, 9)};${EVERY_MINUTE}`),
      'One FREQ period of this RRULE can contain up to 11520 occurrences; the limit is 10080.',
    ],
    [
      rule(`FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;${EVERY_MINUTE}`),
      'One FREQ period of this RRULE can contain up to 44640 occurrences; the limit is 10080.',
    ],
  ])('rejects %j as too frequent', (rrule, message) => {
    expect(RRule.parse(rrule)).toMatchObject({ kind: 'rejected', reason: 'density', detail: message })
  })

  it.each([
    'DTSTART;TZID=Not/A_Zone:20260916T010000',
    'DTSTART;TZID=EST:20260916T010000',
  ])('rejects the zone in %j', (start) => {
    expect(RRule.parse(rule('FREQ=DAILY', start))).toMatchObject({
      kind: 'rejected', reason: 'time_zone', detail: 'TZID must be UTC or a valid IANA Area/Location name.',
    })
  })

  it.each<[string, number]>([
    ['FREQ=DAILY;BYHOUR=9,17', 2],
    ['FREQ=WEEKLY;BYDAY=MO,WE', 2],
    ['FREQ=MONTHLY;BYDAY=MO', 5],
    ['FREQ=MONTHLY;BYMONTHDAY=1,15;BYDAY=MO', 2],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29,30', 2],
    ['FREQ=YEARLY;BYWEEKNO=1', 9],
    ['FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO', 9],
    ['FREQ=YEARLY;BYYEARDAY=1,2', 2],
    ['FREQ=YEARLY;BYMONTHDAY=1', 12],
    ['FREQ=YEARLY;BYDAY=MO', 53],
    ['FREQ=YEARLY;BYMONTH=1,2;BYDAY=MO', 10],
    ['FREQ=YEARLY;BYMONTH=1;BYYEARDAY=1', 1],
    ['FREQ=YEARLY;BYMONTH=1;BYWEEKNO=1', 9],
    ['FREQ=YEARLY;BYMONTH=1', 1],
    ['FREQ=YEARLY;BYHOUR=1', 1],
  ])('limits BYSETPOS for %s to %i positions in one FREQ period', (body, bound) => {
    expect(() => normalized(rule(`${body};BYSETPOS=${bound}`))).not.toThrow()
    expect(() => normalized(rule(`${body};BYSETPOS=-${bound}`))).not.toThrow()
    expect(RRule.parse(rule(`${body};BYSETPOS=${bound + 1}`))).toMatchObject({
      kind: 'rejected', reason: 'syntax',
      detail: `BYSETPOS values must be from 1 to ${bound} or from -${bound} to -1; `
        + `one FREQ period of this RRULE contains at most ${bound} occurrences.`,
    })
  })

  it('accepts a FREQ period with at most one week of minutes', () => {
    const everyMinute = rule(`FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;${EVERY_MINUTE}`)
    expect(after(everyMinute, '2026-09-20T12:34:56.000Z')).toBe('2026-09-20T12:35:00.000Z')
    expect(first(rule(`FREQ=MONTHLY;BYMONTHDAY=${numbers(1, 8)};${EVERY_MINUTE}`))).toBe('2026-10-01T00:00:00.000Z')
    expect(after(rule(`FREQ=DAILY;${EVERY_MINUTE}`), '2026-09-16T05:06:07.000Z')).toBe('2026-09-16T05:07:00.000Z')
  })
})

describe('RRULE occurrences', () => {
  it('fills the time and date parts that a DAILY or longer rule omits from DTSTART', () => {
    expect(after(rule('FREQ=WEEKLY', 'DTSTART:20260916T013000Z'), '2027-03-01T00:00:00.000Z'))
      .toBe('2027-03-03T01:30:00.000Z')
    const weekdays = rule('FREQ=WEEKLY;BYDAY=MO,FR')
    expect(after(weekdays, '2026-09-16T01:00:00.000Z')).toBe('2026-09-18T01:00:00.000Z')
    expect(after(weekdays, '2026-09-18T01:00:00.000Z')).toBe('2026-09-21T01:00:00.000Z')
    // A month or year without the DTSTART day has no occurrence.
    const monthEnd = rule('FREQ=MONTHLY', 'DTSTART:20260131T010000Z')
    expect(first(monthEnd)).toBe('2026-10-31T01:00:00.000Z')
    expect(after(monthEnd, '2026-01-31T01:00:00.000Z')).toBe('2026-03-31T01:00:00.000Z')
    expect(first(rule('FREQ=YEARLY', 'DTSTART:20240229T010000Z'))).toBe('2028-02-29T01:00:00.000Z')
    expect(first(rule('FREQ=YEARLY;BYMONTH=1,7'))).toBe('2027-01-16T01:00:00.000Z')
  })

  it('enumerates the times of one day in ascending order whatever the list order', () => {
    const start = 'DTSTART:20260101T000000Z'
    expect(after(rule('FREQ=DAILY;BYHOUR=18,9;BYMINUTE=0;BYSECOND=0', start), '2026-01-01T08:00:00.000Z'))
      .toBe('2026-01-01T09:00:00.000Z')
    expect(after(rule('FREQ=DAILY;BYHOUR=9;BYMINUTE=30,10;BYSECOND=0', start), '2026-01-01T09:05:00.000Z'))
      .toBe('2026-01-01T09:10:00.000Z')
  })

  it('aligns INTERVAL periods to DTSTART and WKST as in the RFC 5545 example', () => {
    const start = 'DTSTART;TZID=America/New_York:19970805T090000'
    const fromMonday = ['1997-08-05T13:00:00.000Z', '1997-08-10T13:00:00.000Z', '1997-08-19T13:00:00.000Z', '1997-08-24T13:00:00.000Z']
    const fromSunday = ['1997-08-05T13:00:00.000Z', '1997-08-17T13:00:00.000Z', '1997-08-19T13:00:00.000Z', '1997-08-31T13:00:00.000Z']
    for (const [weekStart, expected] of [['MO', fromMonday], ['SU', fromSunday]] as const) {
      const body = `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=${weekStart}`
      expect(occurrences(rule(`${body};COUNT=4`, start), '1997-08-05T12:00:00.000Z', 5)).toEqual(expected)
      expect(occurrences(rule(body, start), '1997-08-05T12:00:00.000Z', 4)).toEqual(expected)
    }
    expect(after(rule('FREQ=HOURLY;INTERVAL=5', 'DTSTART;TZID=Asia/Singapore:20260916T090000'), '2026-09-17T00:00:00.000Z'))
      .toBe('2026-09-17T02:00:00.000Z')
    expect(after(rule('FREQ=DAILY;INTERVAL=3'), '2026-10-01T00:00:00.000Z')).toBe('2026-10-01T01:00:00.000Z')
    const longCycle = rule('FREQ=YEARLY;INTERVAL=401')
    expect(first(longCycle)).toBe('2026-09-16T01:00:00.000Z')
    expect(after(longCycle, '2026-09-16T01:00:00.000Z')).toBe('2427-09-16T01:00:00.000Z')
  })

  it.each(['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])(
    'ends FREQ=%s after DTSTART when INTERVAL is the largest safe integer',
    (frequency) => {
      const once = rule(`FREQ=${frequency};INTERVAL=${Number.MAX_SAFE_INTEGER}`)
      expect(first(once)).toBe('2026-09-16T01:00:00.000Z')
      expect(after(once, '2026-09-16T01:00:00.000Z')).toBeUndefined()
    },
  )

  it('enumerates a rule without COUNT from the FREQ period that contains the reference time', () => {
    const minutely = rule('FREQ=MINUTELY', 'DTSTART:01000101T000000Z')
    expect(first(minutely, Date.parse('2026-10-09T00:00:30.000Z'))).toBe('2026-10-09T00:01:00.000Z')
    expect(resolve(minutely, '2026-10-09T00:01:00.000Z', '2026-10-10T00:00:30.000Z')).toEqual({
      occurrenceAt: '2026-10-10T00:00:00.000Z', nextScheduledAt: '2026-10-10T00:01:00.000Z',
    })
    expect(first(rule('FREQ=WEEKLY', 'DTSTART:01000101T010000Z'))).toBe('2026-09-18T01:00:00.000Z')
  })

  it('counts a sparse COUNT rule from DTSTART', () => {
    const leapMondays = rule('FREQ=YEARLY;COUNT=1000;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO', 'DTSTART:01000101T000000Z')
    expect(first(leapMondays)).toBe('2044-02-29T00:00:00.000Z')
    expect(resolve(leapMondays, '2044-02-29T00:00:00.000Z', '2044-03-01T00:00:00.000Z')).toEqual({
      occurrenceAt: '2044-02-29T00:00:00.000Z', nextScheduledAt: '2072-02-29T00:00:00.000Z',
    })
  })

  it.each(['2,-3', '-3,2'])('counts an overlapping BYSETPOS=%s occurrence only once', (positions) => {
    const counted = rule(`FREQ=WEEKLY;BYHOUR=2,3;BYDAY=WE,SA;BYSETPOS=${positions};COUNT=4`, 'DTSTART:20260107T020000Z')
    const expected = [
      '2026-01-07T03:00:00.000Z',
      '2026-01-14T03:00:00.000Z',
      '2026-01-21T03:00:00.000Z',
      '2026-01-28T03:00:00.000Z',
    ]
    expect(occurrences(counted, '2026-01-07T00:00:00.000Z', 5)).toEqual(expected)
    expect(resolve(counted, expected[0], '2026-01-21T12:00:00.000Z')).toEqual({
      occurrenceAt: expected[2], nextScheduledAt: expected[3],
    })
  })

  it('ends at an inclusive absolute UNTIL instant', () => {
    const start = 'DTSTART;TZID=Asia/Singapore:20260916T090000'
    const until = rule('FREQ=DAILY;UNTIL=20260917T010000Z', start)
    expect(after(until, '2026-09-16T01:00:00.000Z')).toBe('2026-09-17T01:00:00.000Z')
    expect(after(until, '2026-09-17T01:00:00.000Z')).toBeUndefined()
    expect(resolve(until, first(until), '2026-09-18T01:00:00.000Z')).toEqual({ occurrenceAt: '2026-09-17T01:00:00.000Z' })
    expect(after(rule('FREQ=DAILY;UNTIL=20260917T005959Z', start), '2026-09-16T01:00:00.000Z')).toBeUndefined()
  })

  // The second Sunday of March at 02:30 always falls inside the New York forward transition.
  it.each([
    rule('FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30'),
    rule('FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30', 'DTSTART:01000101T000000Z'),
    rule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30'),
    rule('FREQ=YEARLY;BYMONTH=3;BYDAY=2SU;BYHOUR=2;BYMINUTE=30', 'DTSTART;TZID=America/New_York:20260307T023000'),
    rule('FREQ=YEARLY;COUNT=5;BYMONTH=3;BYDAY=2SU;BYHOUR=2;BYMINUTE=30', 'DTSTART;TZID=America/New_York:20260307T023000'),
    rule('FREQ=DAILY;COUNT=1', 'DTSTART:20250916T000100Z'),
  ])('reports no future occurrence for %j', (rrule) => {
    expect(first(rrule)).toBeUndefined()
  })

  it('resolves a repeated wall time to its earlier instant', () => {
    const fallback = rule('FREQ=DAILY', 'DTSTART;TZID=America/New_York:20261101T013000')
    expect(first(fallback, Date.parse('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01T05:30:00.000Z')
    expect(resolve(fallback, '2026-11-01T05:30:00.000Z', '2026-11-01T06:15:00.000Z')).toEqual({
      occurrenceAt: '2026-11-01T05:30:00.000Z', nextScheduledAt: '2026-11-02T06:30:00.000Z',
    })
    // Wall times from 01:00 through 01:45 occur once, before the clocks move back.
    const quarterHours = rule('FREQ=MINUTELY;INTERVAL=15', 'DTSTART;TZID=America/New_York:20261101T000000')
    expect(first(quarterHours, Date.parse('2026-11-01T06:15:00.000Z'))).toBe('2026-11-01T07:00:00.000Z')
    for (const saved of ['2026-11-01T05:00:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-01T05:45:00.000Z']) {
      expect(resolve(quarterHours, saved, '2026-11-01T06:15:00.000Z')).toEqual({
        occurrenceAt: '2026-11-01T05:45:00.000Z', nextScheduledAt: '2026-11-01T07:00:00.000Z',
      })
    }
  })

  it('skips a wall time inside a forward transition and does not count it', () => {
    const counted = rule('FREQ=DAILY;COUNT=3', 'DTSTART;TZID=America/New_York:20260307T023000')
    const created = first(counted, Date.parse('2026-03-07T00:00:00.000Z'))
    expect(created).toBe('2026-03-07T07:30:00.000Z')
    expect(resolve(counted, created, '2026-03-08T12:00:00.000Z')).toEqual({
      occurrenceAt: '2026-03-07T07:30:00.000Z', nextScheduledAt: '2026-03-09T06:30:00.000Z',
    })
    expect(resolve(counted, created, '2026-03-10T12:00:00.000Z')).toEqual({ occurrenceAt: '2026-03-10T06:30:00.000Z' })
    expect(after(counted, '2026-03-10T06:30:00.000Z')).toBeUndefined()
    const endless = rule('FREQ=DAILY', 'DTSTART;TZID=America/New_York:20260307T023000')
    for (const acceptedAt of ['2026-03-08T05:00:00.000Z', '2026-03-08T12:00:00.000Z']) {
      expect(resolve(endless, created, acceptedAt)).toEqual({
        occurrenceAt: '2026-03-07T07:30:00.000Z', nextScheduledAt: '2026-03-09T06:30:00.000Z',
      })
    }
  })

  it('recurs only through the last four-digit-year instant', () => {
    for (const body of ['FREQ=DAILY', 'FREQ=DAILY;COUNT=3']) {
      const lastDay = rule(body, 'DTSTART;TZID=America/Los_Angeles:99991230T200000')
      expect(first(lastDay)).toBe('9999-12-31T04:00:00.000Z')
      expect(resolve(lastDay, '9999-12-31T04:00:00.000Z', '9999-12-31T05:00:00.000Z'))
        .toEqual({ occurrenceAt: '9999-12-31T04:00:00.000Z' })
      const beyond = rule(body, 'DTSTART;TZID=America/Los_Angeles:99991231T200000')
      expect(first(beyond)).toBeUndefined()
    }
    // At this instant, the Kiritimati wall time is already in year 10000.
    const ahead = rule('FREQ=DAILY', 'DTSTART;TZID=Pacific/Kiritimati:20260916T090000')
    expect(after(ahead, '9999-12-31T12:00:00.000Z')).toBeUndefined()
  })


})


describe('RRULE committed occurrence and zone', () => {
  it('finds the latest occurrence of a sparse rule across empty search windows', () => {
    expect(resolve(rule('FREQ=YEARLY'), '2026-09-16T01:00:00.000Z', '2026-12-01T00:00:00.000Z')).toEqual({
      occurrenceAt: '2026-09-16T01:00:00.000Z', nextScheduledAt: '2027-09-16T01:00:00.000Z',
    })
  })

  it('exposes the authoritative DTSTART time zone', () => {
    expect(parsed(daily).timeZone).toBe('UTC')
    expect(parsed(rule('FREQ=DAILY', 'DTSTART;TZID=US/Eastern:20260916T010000')).timeZone).toBe('America/New_York')
  })

  it('keeps a committed target due when the rule does not generate it', () => {
    expect(resolve(rule('FREQ=DAILY', 'DTSTART:20260916T090000Z'), '2026-09-16T08:00:00.000Z', '2026-09-16T08:30:00.000Z'))
      .toEqual({ occurrenceAt: '2026-09-16T08:00:00.000Z', nextScheduledAt: '2026-09-16T09:00:00.000Z' })
    const quarterHours = rule('FREQ=MINUTELY;INTERVAL=15', 'DTSTART;TZID=America/New_York:20261101T000000')
    expect(resolve(quarterHours, '2026-11-01T06:15:00.000Z', '2026-11-01T06:20:00.000Z'))
      .toEqual({ occurrenceAt: '2026-11-01T06:15:00.000Z', nextScheduledAt: '2026-11-01T07:00:00.000Z' })
    const later = rule('FREQ=DAILY', 'DTSTART;TZID=Asia/Singapore:20300916T090000')
    expect(resolve(later, '2026-09-16T01:00:00.000Z', '2026-09-16T01:00:00.000Z'))
      .toEqual({ occurrenceAt: '2026-09-16T01:00:00.000Z', nextScheduledAt: '2030-09-16T01:00:00.000Z' })
  })
})
