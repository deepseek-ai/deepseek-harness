/** Cron parsing and bounded calendar arithmetic without Schedule task records or policy. */
import { describe, expect, it, vi } from 'vitest'
import { Temporal } from '@js-temporal/polyfill'
import { Cron, CRON_SEARCH_HORIZON_YEARS } from '../src/index.ts'

function parsed(expression: string, timeZone = 'UTC'): Cron {
  const result = Cron.parse(expression, timeZone)
  if (result.kind === 'rejected') throw new Error(result.detail)
  return result.rule
}

function canonicalExpression(expression: string): string {
  return parsed(expression).expression
}

/** Pair a valid rule with the committed floor used by its resolve operation. */
function reference(now: string, expression: string, timeZone = 'UTC') {
  const rule = parsed(expression, timeZone)
  const scheduledAt = rule.next(Date.parse(now))
  if (scheduledAt === undefined) throw new Error('Cron fixture has no future occurrence')
  return { rule, scheduledAt }
}

function decision(record: ReturnType<typeof reference>, now: string) {
  return record.rule.resolve(record.scheduledAt, Date.parse(now))
}

describe('cron occurrence resolution across a DST fall-back', () => {
  it('keeps the repeated hour as the latest due occurrence', () => {
    // 2026-11-01 repeats 01:00-01:59 in America/New_York: 01:45 EDT is 05:45Z and the
    // decision at 06:30Z renders as 01:30 EST, the second pass. The rule's 01:45 is
    // later on the wall clock than that 01:30 yet resolves to the earlier overlap, so
    // a due occurrence survives a saved target that predates the previous interval.
    const record = reference('2026-10-25T05:45:00.000Z', '45 1 * * 0', 'America/New_York')
    expect(decision(record, '2026-11-01T06:30:00.000Z').occurrenceAt).toBe('2026-11-01T05:45:00.000Z')
  })
})

describe('cron occurrence resolution when the due local date is not the UTC decision date', () => {
  it('resolves a due local date one day after the UTC decision date', () => {
    // Pacific/Kiritimati runs UTC+14, so at 11:00Z its local date is already the next
    // day: the due 00:30 local minute belongs to the UTC decision date plus one, and a
    // walk bounded by the decision's own UTC date resolves the previous day instead.
    const zone = 'Pacific/Kiritimati'
    const decision = Date.parse('2026-01-01T11:00:00.000Z')
    const record = reference('2025-12-31T00:00:00.000Z', '30 0 * * *', zone)
    const resolved = Date.parse(record.rule.resolve(record.scheduledAt, decision).occurrenceAt)
    expect(resolved).toBe(Date.parse('2026-01-01T10:30:00.000Z'))
    // An exhaustive scan of every minute-aligned instant around the decision finds the
    // same occurrence, and it is not the decision itself: the walk searched.
    let scanned = Number.NEGATIVE_INFINITY
    for (let at = decision - 4 * 86_400_000; at <= decision; at += 60_000) {
      const local = Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone)
      if (local.hour === 0 && local.minute === 30 && local.second === 0) scanned = local.epochMilliseconds
    }
    expect(resolved).toBe(scanned)
    expect(resolved).not.toBe(decision)
    // The occurrence a walk bounded by the decision's UTC date would take is earlier, so
    // this fixture separates the shipped bound from that one.
    const utcDate = Temporal.Instant.fromEpochMilliseconds(decision).toZonedDateTimeISO('UTC').toPlainDate()
    const bounded = Temporal.PlainDateTime.from(`${utcDate.toString()}T00:30`).toZonedDateTime(zone).epochMilliseconds
    expect(bounded).toBeLessThan(resolved)
    expect(bounded).toBeLessThanOrEqual(decision)
  })
})

describe('cron expression parsing and canonicalization', () => {
  it.each<[string, string]>([
    ['0 0 * * *', '0 0 * * *'],
    ['*/15 9-17 * * 1-5', '*/15 9-17 * * 1-5'],
    ['30,10,20 * * * *', '10-30/10 * * * *'],
    ['1,2,5 0 * * *', '1-2,5 0 * * *'],
    ['20,30,10 * * * *', '10-30/10 * * * *'],
    ['0,0,30 * * * *', '0-30/30 * * * *'],
    ['*/1 * * * *', '* * * * *'],
    ['0 0 */2 * *', '0 0 */2 * *'],
    ['0-59/1 0 * * *', '0-59 0 * * *'],
    ['0-59 0-23 1-31 1-12 0-7', '0-59 0-23 1-31 1-12 0-6'],
    ['0 0 * * 0', '0 0 * * 0'],
    ['0 0 * * 7', '0 0 * * 0'],
    ['0 0 * * 1-2,3-4', '0 0 * * 1-4'],
    ['0 0 * * 5-7', '0 0 * * 0,5-6'],
    ['1,3,5 * * * *', '1-5/2 * * * *'],
    ['1-5/2 * * * *', '1-5/2 * * * *'],
    ['00 09 * * 5,4,3,2,1', '0 9 * * 1-5'],
    ['0 0 1-15/2 * *', '0 0 1-15/2 * *'],
    ['0 0 * * */7', '0 0 * * */7'],
    ['0 0 * * */3', '0 0 * * */3'],
    // A field's canonical spelling keeps its star flag: a `*`-led field stays `*`-led, and a
    // field that did not start with `*` never gains one, so day-field AND/OR selection survives
    // the stored canonical expression.
    ['0 9 1-31 * */7', '0 9 1-31 * */7'],
    ['0 9 * * */7', '0 9 * * */7'],
    ['0 9 * * */2', '0 9 * * */2'],
    ['0 9 */31 * 1', '0 9 */31 * 1'],
    ['0 9 */2 * 1', '0 9 */2 * 1'],
    ['0 9 */2,4 * *', '0 9 */2,4 * *'],
    ['0 9 1-31/2 * 1', '0 9 1-31/2 * 1'],
    ['0 9 * * 1', '0 9 * * 1'],
    ['* * * * *', '* * * * *'],
  ])('canonicalizes %j to %j', (input, canonical) => {
    expect(canonicalExpression(input)).toBe(canonical)
    expect(canonicalExpression(canonical)).toBe(canonical)
  })

  it('keeps the unrestricted star distinct from an explicit full range', () => {
    expect(canonicalExpression('* * * * *')).toBe('* * * * *')
    expect(canonicalExpression('0-59 0-23 1-31 1-12 0-7')).toBe('0-59 0-23 1-31 1-12 0-6')
    expect(canonicalExpression('*,5 0 * * *')).toBe('* 0 * * *')
    expect(canonicalExpression('5,* 0 * * *')).toBe('0-59 0 * * *')
  })

  it('preserves every field star flag and idempotence across canonicalization', () => {
    const expressions = [
      '0 9 1-31 * */7', '0 9 */31 * 1', '0 9 */2 * 1', '0 9 * * */7', '0 9 * * 1', '*/1 * * * *',
      '0 9 */2,4 * *', '0 9 1-31/2 * 1', '0 9 * * */2', '0 9 */30 * *', '0,0,30 * * * *',
    ]
    for (const expression of expressions) {
      const canonical = canonicalExpression(expression)
      expect(canonicalExpression(canonical)).toBe(canonical)
      const fields = expression.split(' ')
      const canonicalFields = canonical.split(' ')
      expect(canonicalFields).toHaveLength(fields.length)
      fields.forEach((field, index) => {
        expect(canonicalFields[index]!.startsWith('*')).toBe(field.startsWith('*'))
      })
    }
  })

  it('resolves an expression exactly like its stored canonical spelling', () => {
    const expressions = [
      '0 9 1-31 * */7', '0 9 */31 * 1', '0 9 */2 * 1', '0 9 * * */7', '0 9 * * 1',
      '0 9 */2,4 * *', '0 9 1-31/2 * 1', '0 9 * * */2', '0 0 1-31 * 5',
    ]
    const floors = ['2026-09-02T00:00:00Z', '2026-09-13T00:00:00Z', '2026-09-20T00:00:00Z']
    for (const expression of expressions) {
      const canonical = canonicalExpression(expression)
      for (const floor of floors) {
        const record = reference(floor, expression)
        const raw = { ...record, rule: parsed(expression) }
        const stored = { ...record, rule: parsed(canonical) }
        const later = new Date(Math.max(Date.parse(floor) + 86_400_000, Date.parse(record.scheduledAt) + 1)).toISOString()
        expect(decision(raw, later)).toEqual(decision(stored, later))
      }
    }
  })

  it('keeps a star-led day field from changing the day rule after storage', () => {
    const starLed = reference('2026-09-01T00:00:00Z', '0 9 1-31 * */7')
    const restricted = { ...starLed, rule: parsed('0 9 1-31 * 0') }
    expect(starLed.rule.expression).toBe('0 9 1-31 * */7')
    expect(decision(starLed, '2026-09-07T00:00:00Z').nextScheduledAt).toBe('2026-09-13T09:00:00.000Z')
    expect(decision(restricted, '2026-09-07T00:00:00Z').nextScheduledAt).toBe('2026-09-07T09:00:00.000Z')
  })

  it.each<[string, string, RegExp]>([
    ['six fields', '0 0 * * * *', /exactly five/],
    ['four fields', '0 0 * *', /exactly five/],
    ['a macro', '@daily', /exactly five/],
    ['last day', '0 0 L * *', /day-of-month/],
    ['nearest weekday', '0 0 15W * *', /day-of-month/],
    ['nth weekday', '0 0 * * 1#2', /day-of-week/],
    ['a month name', '0 0 * JAN *', /month/],
    ['a weekday name', '0 0 * * MON', /day-of-week/],
    ['minute above range', '60 0 * * *', /minute field value 60 is outside 0-59/],
    ['hour above range', '0 24 * * *', /hour field value 24 is outside 0-23/],
    ['day-of-month below range', '0 0 0 * *', /day-of-month field value 0 is outside 1-31/],
    ['day-of-month above range', '0 0 32 * *', /day-of-month field value 32 is outside 1-31/],
    ['month below range', '0 0 * 0 *', /month field value 0 is outside 1-12/],
    ['month above range', '0 0 * 13 *', /month field value 13 is outside 1-12/],
    ['weekday above range', '0 0 * * 8', /day-of-week field value 8 is outside 0-7/],
    ['inverted day-of-month range', '0 0 20-10 * *', /day-of-month field range 20-10 is inverted/],
    ['inverted month range', '0 0 * 12-1 *', /month field range 12-1 is inverted/],
    ['zero step', '*/0 * * * *', /minute field step must be a positive integer/],
    ['zero range step', '0-10/0 * * * *', /minute field step must be a positive integer/],
    ['empty first element', '0,,1 * * * *', /minute field must not contain an empty list element/],
    ['trailing comma', '0 0 * * 1,', /day-of-week field must not contain an empty list element/],
    ['a bare step', '5/2 * * * *', /minute field element "5\/2"/],
    ['a bare star suffix', '*5 * * * *', /minute field element "\*5"/],
    ['a negative value', '-5 * * * *', /minute field element "-5"/],
    ['leading whitespace', ' 0 0 * * *', /non-empty trimmed string/],
    ['trailing whitespace', '0 0 * * * ', /non-empty trimmed string/],
    ['empty text', '', /non-empty trimmed string/],
    ['blank text', ' ', /non-empty trimmed string/],
  ])('rejects %s', (_label, expression, message) => {
    const result = Cron.parse(expression, 'UTC')
    expect(result).toMatchObject({ kind: 'rejected', reason: 'syntax' })
    expect(result).toHaveProperty('detail', expect.stringMatching(message))
  })

})

describe('cron target selection', () => {

  it.each<[string, string]>([
    ['2026-09-16T09:29:59.999Z', '2026-09-16T09:30:00.000Z'],
    ['2026-09-16T09:30:00.000Z', '2026-09-17T09:30:00.000Z'],
    ['2026-09-16T09:30:00.001Z', '2026-09-17T09:30:00.000Z'],
  ])('selects the strictly future instant from %s', (now, scheduledAt) => {
    expect(reference(now, '30 9 * * *').scheduledAt).toBe(scheduledAt)
  })

  it.each<[string, string, string]>([
    ['2026-04-01T00:00:00Z', '0 0 31 * *', '2026-05-31T00:00:00.000Z'],
    ['2026-01-01T00:00:00Z', '0 0 29 2 *', '2028-02-29T00:00:00.000Z'],
    ['2026-09-16T00:00:00Z', '0 0 1 * *', '2026-10-01T00:00:00.000Z'],
    ['2026-09-16T00:00:00Z', '0 0 * 1 *', '2027-01-01T00:00:00.000Z'],
  ])('selects the next calendar occurrence from %s for %j', (now, expression, scheduledAt) => {
    expect(reference(now, expression).scheduledAt).toBe(scheduledAt)
  })

  it('skips a local time and whole date that fall in a DST gap', () => {
    const record = reference('2026-03-01T00:00:00Z', '30 2 * 3 0', 'America/New_York')
    expect(record.scheduledAt).toBe('2026-03-01T07:30:00.000Z')
    expect(decision(record, '2026-03-08T12:00:00Z')).toEqual({
      occurrenceAt: '2026-03-01T07:30:00.000Z', nextScheduledAt: '2026-03-15T06:30:00.000Z',
    })
    expect(reference('2026-03-02T00:00:00Z', '30 2 * 3 0', 'America/New_York').scheduledAt)
      .toBe('2026-03-15T06:30:00.000Z')
    expect(decision(record, '2026-03-15T06:30:00Z')).toEqual({
      occurrenceAt: '2026-03-15T06:30:00.000Z', nextScheduledAt: '2026-03-22T06:30:00.000Z',
    })
  })

  it('uses the earlier occurrence of a DST overlap once for that date', () => {
    const record = reference('2026-10-25T00:00:00Z', '30 1 * 11 0', 'America/New_York')
    expect(record.scheduledAt).toBe('2026-11-01T05:30:00.000Z')
    for (const now of ['2026-11-01T05:30:00Z', '2026-11-01T06:00:00Z', '2026-11-01T06:30:00Z']) {
      expect(decision(record, now)).toEqual({
        occurrenceAt: '2026-11-01T05:30:00.000Z', nextScheduledAt: '2026-11-08T06:30:00.000Z',
      })
    }
  })

  it.each<[string, string, string, string]>([
    ['friday the 13th matches an earlier Friday', '2026-09-01T00:00:00Z', '0 0 13 * 5', '2026-09-04T00:00:00.000Z'],
    ['friday the 13th matches the 13th alone', '2026-09-12T00:00:00Z', '0 0 13 * 5', '2026-09-13T00:00:00.000Z'],
    ['a restricted day-of-month constrains alone', '2026-09-01T00:00:00Z', '0 0 13 * *', '2026-09-13T00:00:00.000Z'],
    ['a restricted day-of-week constrains alone', '2026-09-01T00:00:00Z', '0 0 * * 5', '2026-09-04T00:00:00.000Z'],
    ['two stars match every date', '2026-09-01T00:00:00Z', '0 0 * * *', '2026-09-02T00:00:00.000Z'],
    ['an explicit full day-of-month stays restricted', '2026-09-01T00:00:00Z', '0 0 1-31 * 5', '2026-09-02T00:00:00.000Z'],
    ['an explicit full day-of-week stays restricted', '2026-09-01T00:00:00Z', '0 0 13 * 0-7', '2026-09-02T00:00:00.000Z'],
    ['a stepped day-of-month star accepts an odd matching Monday', '2026-09-01T00:00:00Z', '0 9 */2 * 1', '2026-09-07T09:00:00.000Z'],
    ['a stepped day-of-month star rejects an even matching Monday', '2026-09-13T00:00:00Z', '0 9 */2 * 1', '2026-09-21T09:00:00.000Z'],
    ['a stepped day-of-week star still requires its own match', '2026-09-02T00:00:00Z', '0 9 1-31 * */2', '2026-09-03T09:00:00.000Z'],
    ['two stepped stars require both fields', '2026-09-02T00:00:00Z', '0 9 */2 * */2', '2026-09-03T09:00:00.000Z'],
    ['a stepped day-of-month star with a bare day-of-week star', '2026-09-02T00:00:00Z', '0 9 */2 * *', '2026-09-03T09:00:00.000Z'],
    ['a bare day-of-month star with a stepped day-of-week star', '2026-09-02T00:00:00Z', '0 9 * * */2', '2026-09-03T09:00:00.000Z'],
    ['a bare day-of-month star keeps only the weekday restriction', '2026-09-13T00:00:00Z', '0 9 * * 1', '2026-09-14T09:00:00.000Z'],
  ])('%s', (_label, now, expression, scheduledAt) => {
    expect(reference(now, expression).scheduledAt).toBe(scheduledAt)
  })

  it('selects only the latest due occurrence after downtime, including a same-date later time', () => {
    const record = reference('2026-09-15T00:00:00Z', '0 9,17 * * *')
    expect(record.scheduledAt).toBe('2026-09-15T09:00:00.000Z')
    expect(decision(record, '2026-09-15T10:00:00Z')).toEqual({
      occurrenceAt: '2026-09-15T09:00:00.000Z', nextScheduledAt: '2026-09-15T17:00:00.000Z',
    })
    expect(decision(record, '2026-09-15T20:00:00Z')).toEqual({
      occurrenceAt: '2026-09-15T17:00:00.000Z', nextScheduledAt: '2026-09-16T09:00:00.000Z',
    })
  })

  it('honors a pinned committed target and never repeats a same-date occurrence', () => {
    const pinned = {
      ...reference('2026-09-15T00:00:00Z', '0 9,17 * * *'), scheduledAt: '2026-09-15T12:00:00.000Z',
    }
    expect(decision(pinned, '2026-09-15T12:30:00Z')).toEqual({
      occurrenceAt: pinned.scheduledAt, nextScheduledAt: '2026-09-15T17:00:00.000Z',
    })
    expect(decision(pinned, '2026-09-15T17:30:00Z')).toEqual({
      occurrenceAt: '2026-09-15T17:00:00.000Z', nextScheduledAt: '2026-09-16T09:00:00.000Z',
    })
  })

  it('selects only the latest due weekday after a long downtime', () => {
    const record = reference('2026-06-01T00:00:00Z', '0 9 * * 1-5')
    expect(record.scheduledAt).toBe('2026-06-01T09:00:00.000Z')
    expect(decision(record, '2026-09-16T08:59:59Z')).toEqual({
      occurrenceAt: '2026-09-15T09:00:00.000Z', nextScheduledAt: '2026-09-16T09:00:00.000Z',
    })
    expect(decision(record, '2026-09-16T09:00:00Z')).toEqual({
      occurrenceAt: '2026-09-16T09:00:00.000Z', nextScheduledAt: '2026-09-17T09:00:00.000Z',
    })
  })

  it('retains the committed target when no local occurrence is representable', () => {
    const impossible = { rule: parsed('0 0 30 2 *'), scheduledAt: '2026-09-15T00:00:00.000Z' }
    expect(decision(impossible, '2026-09-16T00:00:00Z')).toEqual({ occurrenceAt: impossible.scheduledAt })
  })

  it('stops an unsatisfiable rule at the documented horizon instead of the year ceiling', () => {
    const impossible = { rule: parsed('0 0 30 2 *'), scheduledAt: '2026-09-15T00:00:00.000Z' }
    // The search advances one LocalDate per candidate day and per skipped month, and the
    // polyfill exposes that arithmetic on its prototypes, so those calls count the walk.
    const forward = vi.spyOn(Temporal.PlainDate.prototype, 'add')
    const backward = vi.spyOn(Temporal.PlainDate.prototype, 'subtract')
    let walked = 0
    try {
      expect(decision(impossible, '2026-09-16T00:00:00Z')).toEqual({ occurrenceAt: impossible.scheduledAt })
      walked = forward.mock.calls.length + backward.mock.calls.length
    } finally {
      forward.mockRestore()
      backward.mockRestore()
    }
    // Each searched year costs at most 366 day steps and 12 month skips in each direction.
    expect(walked).toBeGreaterThan(0)
    expect(walked).toBeLessThanOrEqual(CRON_SEARCH_HORIZON_YEARS * (366 + 12) * 2)
  })

  it('converts a walked date once while it lies beyond the decision', () => {
    const record = reference('2026-09-16T00:00:00Z', '* * * * *', 'America/New_York')
    // Every candidate the walk evaluates is built from its date here, so counting
    // this counts the candidates, not the dates visited.
    const converted = vi.spyOn(Temporal.PlainDate.prototype, 'toPlainDateTime')
    let candidates = 0
    try {
      decision(record, '2026-09-16T12:00:00Z')
      candidates = converted.mock.calls.length
    } finally {
      converted.mockRestore()
    }
    // The date after the decision costs one candidate and the date that straddles it
    // scans down from 23:59 to the decision's minute: 962 across the two reverse
    // walks, plus the two the forward walk converts on the floor date. Without the
    // whole-date skip the reverse walk also built all 1440 times of the date beyond
    // it, 2402 in total, which this ceiling separates.
    expect(candidates).toBeGreaterThan(0)
    expect(candidates).toBeLessThanOrEqual(1_500)
  })


  it('resolves local dates on either side of the lowest supported UTC year', () => {
    expect(reference('0001-01-01T00:00:00Z', '30 0 * * *').scheduledAt).toBe('0001-01-01T00:30:00.000Z')
    expect(reference('0001-01-01T00:00:00Z', '0 0 * * *', 'Etc/GMT-1').scheduledAt)
      .toBe('0001-01-01T23:00:00.000Z')
    // A decision this early keeps the backward search on the four-digit floor, not the horizon.
    expect(decision(reference('0001-01-01T00:00:00Z', '0 0 * * *'), '0001-01-02T00:00:00Z')).toEqual({
      occurrenceAt: '0001-01-02T00:00:00.000Z', nextScheduledAt: '0001-01-03T00:00:00.000Z',
    })
  })

  it('resolves a negative-offset due minute inside the floor date of its own zone', () => {
    // The four-digit floor is an instant, so this rule's latest due minute before a
    // decision inside the floor's UTC day is local and dated one day earlier.
    const record = reference('0001-01-01T00:01:00Z', '* * * * *', 'Etc/GMT+1')
    expect(decision(record, '0001-01-01T00:30:00Z')).toEqual({
      occurrenceAt: '0001-01-01T00:30:00.000Z', nextScheduledAt: '0001-01-01T00:31:00.000Z',
    })
  })

  it('retains the final occurrence and reports exhaustion without a five-digit target', () => {
    const record = reference('9999-12-31T23:00:00Z', '* * * * *')
    expect(decision(record, '9999-12-31T23:59:59.999Z')).toEqual({ occurrenceAt: '9999-12-31T23:59:00.000Z' })
    expect(parsed('* * * * *').next(Date.parse('9999-12-31T23:59:00Z'))).toBeUndefined()
  })


})
