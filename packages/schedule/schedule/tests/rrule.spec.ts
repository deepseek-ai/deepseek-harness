/** RFC 5545 recurrence validation, occurrence arithmetic, and strict decoding of Host task records. */
import { describe, expect, it } from 'vitest'
import { MAX_FOUR_DIGIT_YEAR_MS, MIN_FOUR_DIGIT_YEAR_MS } from '@deepseek-ai/dsh-util-time'
import { ScheduleId } from '../src/domain.ts'
import type { RecurringOccurrence } from '../src/domain.ts'
import {
  createRRuleScheduleRecord, decodeRRuleScheduleRecord, formatScheduleLocalTime,
  normalizeRRule, resolveRRuleOccurrence, updateRRuleScheduleRecord,
} from '../src/domain.ts'

/** Join a DTSTART line and an RRULE body. */
function rule(body: string, start = 'DTSTART:20260916T010000Z'): string {
  return `${start}\nRRULE:${body}`
}

const now = Date.parse('2026-09-16T00:00:00.000Z')
const daily = rule('FREQ=DAILY')
const LINES = 'rrule must contain one DTSTART line followed by one RRULE line.'
const NOT_FUTURE = 'rrule must contain an occurrence strictly in the future.'

/** Return the occurrence that creation commits at a time. */
function first(rrule: string, at = now): string {
  return createRRuleScheduleRecord(ScheduleId('task'), 'Task', 'Prompt', rrule, at).scheduledAt
}

/** Resolve a stored record with a committed target at an admission time. */
function resolve(rrule: string, scheduledAt: string, acceptedAt: string): RecurringOccurrence {
  return resolveRRuleOccurrence(
    { kind: 'rrule', id: ScheduleId('task'), title: 'Task', prompt: 'Prompt', rrule, scheduledAt },
    Date.parse(acceptedAt),
  )
}

describe('RRULE Schedule policy', () => {
  it('normalizes authored content without changing the explicit DTSTART zone', () => {
    expect(normalizeRRule(` ${daily}\n`)).toBe(daily)
    const eastern = rule('FREQ=DAILY', 'DTSTART;TZID=US/Eastern:20260916T010000')
    expect(normalizeRRule(eastern)).toBe(eastern)
    expect(first(eastern)).toBe('2026-09-16T05:00:00.000Z')
  })

  it.each([
    ['bad', 'invalid_rule'],
    [rule('FREQ=SECONDLY'), 'frequency_too_high'],
    [rule('FREQ=DAILY', 'DTSTART;TZID=Not/A_Zone:20260916T010000'), 'invalid_time_zone'],
  ])('maps the shared parser rejection of %j to %s', (value, code) => {
    expect(() => normalizeRRule(value)).toThrow(expect.objectContaining({ code }))
  })

  it('refuses a task whose finite rule has no future occurrence', () => {
    expect(() => first(rule('FREQ=DAILY;COUNT=1', 'DTSTART:20250916T010000Z')))
      .toThrow(expect.objectContaining({ code: 'not_future', message: NOT_FUTURE }))
  })

  it('states an instant as wall time with its offset in the DTSTART zone', () => {
    const record = createRRuleScheduleRecord(ScheduleId('task'), 'Task', 'Prompt', daily, now)
    expect(formatScheduleLocalTime(record, '2026-09-16T01:02:59.999Z')).toBe('2026-09-16T01:02:59+00:00')
    const zoned = rule('FREQ=DAILY', 'DTSTART;TZID=Asia/Shanghai:20260916T090000')
    expect(formatScheduleLocalTime({ ...record, rrule: zoned }, '2026-09-16T16:30:00.000Z')).toBe('2026-09-17T00:30:00+08:00')
    // The offset distinguishes the two instants of a repeated wall time.
    const fallback = rule('FREQ=DAILY', 'DTSTART;TZID=America/New_York:20261101T013000')
    expect(formatScheduleLocalTime({ ...record, rrule: fallback }, '2026-11-01T05:30:00.000Z')).toBe('2026-11-01T01:30:00-04:00')
    expect(formatScheduleLocalTime({ ...record, rrule: fallback }, '2026-11-01T06:30:00.000Z')).toBe('2026-11-01T01:30:00-05:00')
  })

  it.each([Number.NaN, MIN_FOUR_DIGIT_YEAR_MS - 1, MAX_FOUR_DIGIT_YEAR_MS + 1])(
    'rejects the reference time %d',
    (instant) => {
      expect(() => first(daily, instant)).toThrow(expect.objectContaining({
        code: 'time_out_of_range', message: 'The recurrence reference time is outside the supported range.',
      }))
    },
  )
})

describe('RRULE task records', () => {
  const created = createRRuleScheduleRecord(ScheduleId('task'), ' Title ', ' Prompt ', ` ${daily}\n`, now)

  it('creates a frozen record with trimmed text and its first future occurrence', () => {
    expect(created).toEqual({ id: 'task', kind: 'rrule', title: 'Title', prompt: 'Prompt', rrule: daily, scheduledAt: '2026-09-16T01:00:00.000Z' })
    expect(Object.isFrozen(created)).toBe(true)
    const longest = 'x'.repeat(120)
    expect(createRRuleScheduleRecord(ScheduleId('long'), ` ${longest} `, 'Prompt', daily, now).title).toBe(longest)
  })

  it.each<[string, string, string, string]>([
    ['an overlong title', 'x'.repeat(121), 'Prompt', 'title must be at most 120 characters.'],
    ['a blank title', ' ', 'Prompt', 'title is required and must be non-empty after trimming.'],
    ['a blank prompt', 'Title', ' ', 'prompt must be non-empty after trimming.'],
  ])('rejects %s at creation and update', (_case, title, prompt, message) => {
    const failure = expect.objectContaining({ code: 'invalid_prompt', message }) as Error
    expect(() => createRRuleScheduleRecord(ScheduleId('task'), title, prompt, daily, now)).toThrow(failure)
    expect(() => updateRRuleScheduleRecord(created, { title, prompt }, now, false)).toThrow(failure)
  })

  it('updates text without moving the committed occurrence unless recomputation is requested', () => {
    const renamed = updateRRuleScheduleRecord(created, { title: ' Next ', prompt: ' Next prompt ', rrule: ` ${daily}\n` }, now, false)
    expect(renamed).toEqual({ ...created, title: 'Next', prompt: 'Next prompt' })
    expect(Object.isFrozen(renamed)).toBe(true)
    expect(updateRRuleScheduleRecord(created, {}, Date.parse('2026-09-16T05:00:00.000Z'), true))
      .toEqual({ ...created, scheduledAt: '2026-09-17T01:00:00.000Z' })
    const later = rule('FREQ=DAILY;COUNT=1', 'DTSTART:20260916T020000Z')
    expect(updateRRuleScheduleRecord(created, { rrule: later }, now, true))
      .toEqual({ ...created, rrule: later, scheduledAt: '2026-09-16T02:00:00.000Z' })
    expect(() => updateRRuleScheduleRecord(created, { rrule: 'bad' }, now, false))
      .toThrow(expect.objectContaining({ code: 'invalid_rule', message: LINES }))
  })

  it.each<[string, string]>([
    ['FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'DAILY'],
    ['FREQ=WEEKLY;BYDAY=FR;BYSETPOS=2', 'WEEKLY'],
    ['FREQ=MONTHLY;BYDAY=-1FR;BYSETPOS=1', 'MONTHLY'],
  ])('rejects the supplied rule %s, whose BYSETPOS has no effect', (body, frequency) => {
    const failure = expect.objectContaining({
      code: 'invalid_rule',
      message: `BYSETPOS has no effect because one FREQ=${frequency} period of this RRULE contains at most 1 occurrence. `
        + 'BYSETPOS selects among the occurrences of one period; for example, '
        + 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1 selects the last weekday of each month.',
    }) as Error
    expect(() => createRRuleScheduleRecord(ScheduleId('task'), 'Title', 'Prompt', rule(body), now)).toThrow(failure)
    expect(() => updateRRuleScheduleRecord(created, { rrule: rule(body) }, now, true)).toThrow(failure)
  })

  it('accepts the BYSETPOS example of that failure', () => {
    expect(first(rule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'))).toBe('2026-09-30T01:00:00.000Z')
  })

  it('keeps loading, resuming, and delivering a stored rule whose BYSETPOS has no effect', () => {
    const weekdays = rule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')
    const stored = decodeRRuleScheduleRecord({
      id: 'task', kind: 'rrule', title: 'Title', prompt: 'Prompt', rrule: weekdays, scheduledAt: '2026-09-16T01:00:00.000Z',
    })
    expect(updateRRuleScheduleRecord(stored, { title: 'Next' }, Date.parse('2026-09-16T05:00:00.000Z'), true))
      .toEqual({ ...stored, title: 'Next', scheduledAt: '2026-09-17T01:00:00.000Z' })
    expect(resolveRRuleOccurrence(stored, Date.parse('2026-09-18T12:00:00.000Z')))
      .toEqual({ occurrenceAt: '2026-09-18T01:00:00.000Z', nextScheduledAt: '2026-09-21T01:00:00.000Z' })
  })

  it('resolves only the latest due occurrence and the first later one', () => {
    const occurrence = resolveRRuleOccurrence(created, Date.parse('2026-09-18T12:00:00.000Z'))
    expect(occurrence).toEqual({ occurrenceAt: '2026-09-18T01:00:00.000Z', nextScheduledAt: '2026-09-19T01:00:00.000Z' })
    expect(Object.isFrozen(occurrence)).toBe(true)
    expect(resolve(rule('FREQ=DAILY;COUNT=1'), '2026-09-16T01:00:00.000Z', '2026-09-17T00:00:00.000Z'))
      .toEqual({ occurrenceAt: '2026-09-16T01:00:00.000Z' })
  })


  it.each<[number, string]>([
    [Date.parse('2026-09-16T00:59:59.999Z'), 'rrule dispatch cannot precede the active scheduledAt'],
    [Number.NaN, 'rrule acceptedAt must be a representable four-digit-year instant'],
  ])('rejects the admission time %d', (acceptedAt, message) => {
    expect(() => resolveRRuleOccurrence(created, acceptedAt))
      .toThrow(expect.objectContaining({ code: 'corrupt_schedule_log', message }))
  })

  it('decodes a detached frozen copy of an exact normalized record', () => {
    const stored = { ...created }
    const decoded = decodeRRuleScheduleRecord(stored)
    expect(decoded).toEqual(created)
    expect(decoded).not.toBe(stored)
    expect(Object.isFrozen(decoded)).toBe(true)
  })

  const EXACT_KEYS = 'rrule schedule must contain exactly id, kind, title, prompt, rrule, and scheduledAt'
  const PROMPT = 'schedule prompt must be non-empty and already trimmed'

  it.each<[unknown, string]>([
    [null, EXACT_KEYS],
    [[created], EXACT_KEYS],
    [{ ...created, extra: true }, EXACT_KEYS],
    [{ kind: 'rrule', id: 'task', title: 'Title', prompt: 'Prompt', rrule: daily }, EXACT_KEYS],
    [{ ...created, title: 'x'.repeat(121) }, 'title must be at most 120 characters'],
    [{ ...created, title: ' Title' }, 'title must be a trimmed string'],
    [{ ...created, prompt: '' }, PROMPT],
    [{ ...created, prompt: 1 }, PROMPT],
    [{ ...created, prompt: ' Prompt' }, PROMPT],
    [{ ...created, rrule: 1 }, 'schedule rrule must be a string'],
    [{ ...created, rrule: 'bad' }, `invalid schedule rrule: ScheduleInputError: ${LINES}`],
    [{ ...created, rrule: ` ${daily}` }, 'schedule rrule must be normalized'],
    [{ ...created, id: ' task' }, 'schedule id must be a non-empty string without surrounding whitespace'],
    [{ ...created, scheduledAt: '2026-09-16T01:00:00Z' }, 'scheduledAt must be a canonical four-digit-year RFC 3339 UTC instant'],
  ])('rejects the stored record %j', (value, message) => {
    expect(() => decodeRRuleScheduleRecord(value)).toThrow(expect.objectContaining({ code: 'corrupt_schedule_log', message }))
  })
})
