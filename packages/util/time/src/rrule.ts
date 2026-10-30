/** Bounded RFC 5545 recurrence over UTC or explicit local wall time. */
import { Temporal } from '@js-temporal/polyfill'
import rrulePackage from 'rrule'
import { MAX_FOUR_DIGIT_YEAR_MS, canonicalizeTimeZone, isFourDigitYearInstant, resolveLocalInstant } from './instant.ts'
import { RecurrenceInputError, parseRecurrence, recurrenceDecision } from './recurrence.ts'
import type { RecurrenceOccurrence, RecurrenceResult } from './recurrence.ts'

/** Require a canonical zone while retaining the parser's validation result. */
function validatedZone(value: string): string {
  const result = canonicalizeTimeZone(value)
  if (result.kind === 'rejected') throw new RecurrenceInputError('time_zone', 'TZID must be UTC or a valid IANA Area/Location name.', { cause: result })
  return result.timeZone
}

const { Weekday, rrulestr } = rrulePackage

/** Largest accepted COUNT; a longer finite recurrence uses UNTIL. */
const MAX_RRULE_COUNT = 1_000

/** Largest number of occurrences that one FREQ period may generate: every minute of one week. */
const MAX_PERIOD_CANDIDATES = 10_080

/** Largest number of BYSETPOS values. */
const MAX_SET_POSITIONS = 31

/** Earliest DTSTART and UNTIL year; the recurrence library reads years 0000 through 0099 as 1900 through 1999. */
const MIN_RRULE_YEAR = 100

const DAY_MS = 86_400_000

/** Latest wall time that the recurrence library can generate or read as a DTSTART. */
const LAST_RRULE_WALL_MS = Date.UTC(9999, 11, 31, 23, 59, 59)

type Frequency = 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

/** FREQ periods in one 400-year Gregorian cycle; after a cycle, weekdays and leap days repeat. */
const CYCLE_PERIODS: Readonly<Record<Frequency, number>> = {
  MINUTELY: 210_379_680,
  HOURLY: 3_506_328,
  DAILY: 146_097,
  WEEKLY: 20_871,
  MONTHLY: 4_800,
  YEARLY: 400,
}

/** Length of one 400-year Gregorian cycle in milliseconds. */
const CYCLE_MS = CYCLE_PERIODS.DAILY * DAY_MS

/** RFC 5545 weekday codes; index 0 is Monday, as in the recurrence library. */
const WEEKDAYS: readonly string[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

const SUPPORTED_PARTS: readonly string[] = [
  'FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY',
  'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS',
]

/** Inclusive range of one numeric BY list; a range with a negative minimum excludes 0. */
interface ListRange {
  readonly min: number
  readonly max: number
}

const LIST_RANGES: ReadonlyMap<string, ListRange> = new Map([
  ['BYSECOND', { min: 0, max: 59 }],
  ['BYMINUTE', { min: 0, max: 59 }],
  ['BYHOUR', { min: 0, max: 23 }],
  ['BYMONTHDAY', { min: -31, max: 31 }],
  ['BYYEARDAY', { min: -366, max: 366 }],
  ['BYWEEKNO', { min: -53, max: 53 }],
  ['BYMONTH', { min: 1, max: 12 }],
  ['BYSETPOS', { min: -366, max: 366 }],
])

/** BY lists whose values the recurrence library combines into the times of one day. */
const TIME_PARTS: readonly string[] = ['BYHOUR', 'BYMINUTE', 'BYSECOND']

const DTSTART_UTC = /^DTSTART:\d{8}T\d{6}Z$/
const DTSTART_ZONED = /^DTSTART;TZID=[^:;]+:\d{8}T\d{6}$/
const BASIC_UTC = /^\d{8}T\d{6}Z$/
const UNSIGNED_INTEGER = /^\d+$/
const SIGNED_INTEGER = /^[+-]?\d+$/
const WEEKDAY_SELECTOR = /^(?:[+-]?(?:[1-9]|[1-4]\d|5[0-3]))?(?:MO|TU|WE|TH|FR|SA|SU)$/

/** BYDAY entry counts; an ordinal entry such as `2TU` selects at most one day of its month or year. */
interface ByDayCounts {
  readonly entries: number
  readonly ordinals: number
}

/** Decoded RRULE values used by the combination and cost checks. */
interface RuleValues {
  readonly frequency: Frequency
  readonly interval: number
  readonly count: number | undefined
  /** UNTIL instant in epoch milliseconds. */
  readonly until: number | undefined
  /** WKST index; 0 is Monday. */
  readonly weekStart: number
  readonly lists: ReadonlyMap<string, readonly number[]>
  readonly byDay: ByDayCounts | undefined
}

/** One validated rule and the recurrence-library input for its UTC-shaped local wall time. */
interface PreparedRRule {
  /** Trimmed two-line input; stored records keep this text. */
  readonly normalized: string
  /** Canonical zone; `UTC` when DTSTART ends in Z. */
  readonly timeZone: string
  /** DTSTART wall time as UTC-shaped epoch milliseconds. */
  readonly start: number
  readonly frequency: Frequency
  readonly interval: number
  /** WKST index; 0 is Monday. */
  readonly weekStart: number
  readonly count: number | undefined
  /** UNTIL instant, or the latest four-digit-year instant. */
  readonly limit: number
  /**
   * RRULE line with explicit DTSTART-derived defaults, ascending time lists, and without COUNT and UNTIL, which this
   * module applies to actual instants; any period start can replace DTSTART.
   */
  readonly recurrence: string
  /** Wall-time length of one complete calendar and INTERVAL cycle; a longer run of gap wall times never ends. */
  readonly invalidRunLimit: number
}

/** Latest occurrence at or before a decision time and the first occurrence after it. */
interface OccurrenceWindow {
  latest: number | undefined
  next: number | undefined
}

/** Read a matched basic date-time `YYYYMMDDTHHMMSS` as UTC-shaped epoch milliseconds, rejecting normalization. */
function basicTime(field: string, text: string): number {
  const year = Number(text.slice(0, 4))
  const month = Number(text.slice(4, 6))
  const day = Number(text.slice(6, 8))
  const hour = Number(text.slice(9, 11))
  const minute = Number(text.slice(11, 13))
  const second = Number(text.slice(13, 15))
  const message = `${field} must be a real calendar date and time in years 0100 through 9999.`
  if (year < MIN_RRULE_YEAR) throw new RecurrenceInputError('syntax', message)
  try {
    Temporal.PlainDateTime.from({ year, month, day, hour, minute, second }, { overflow: 'reject' })
  } catch (error: unknown) {
    throw new RecurrenceInputError('syntax', message, { cause: error })
  }
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

/** Split the input into its trimmed DTSTART and RRULE lines. */
function recurrenceLines(value: string): readonly [string, string] {
  const [startLine, ruleLine, ...rest] = value.replaceAll('\r\n', '\n').trim().split('\n')
    .map(line => line.trim()).filter(Boolean)
  if (startLine === undefined || ruleLine === undefined || rest.length > 0
    || !startLine.startsWith('DTSTART') || !ruleLine.startsWith('RRULE:')) {
    throw new RecurrenceInputError('syntax', 'rrule must contain one DTSTART line followed by one RRULE line.')
  }
  return [startLine, ruleLine]
}

/** Read DTSTART as its canonical zone and UTC-shaped wall time. */
function parseStart(line: string): { readonly timeZone: string; readonly start: number } {
  if (DTSTART_UTC.test(line)) return { timeZone: 'UTC', start: basicTime('DTSTART', line.slice(-16, -1)) }
  if (!DTSTART_ZONED.test(line)) {
    throw new RecurrenceInputError('syntax', 'DTSTART must use UTC with Z or a local date-time with an explicit TZID.')
  }
  return { timeZone: validatedZone(line.slice('DTSTART;TZID='.length, -16)), start: basicTime('DTSTART', line.slice(-15)) }
}

/** Split the RRULE line into its parts in input order. */
function ruleParts(line: string): ReadonlyMap<string, string> {
  const parts = new Map<string, string>()
  for (const component of line.slice('RRULE:'.length).split(';')) {
    const separator = component.indexOf('=')
    const key = component.slice(0, separator)
    const text = component.slice(separator + 1)
    if (separator <= 0 || text.length === 0 || parts.has(key)) {
      throw new RecurrenceInputError('syntax', 'RRULE fields must be non-empty and unique.')
    }
    if (!SUPPORTED_PARTS.includes(key)) {
      throw new RecurrenceInputError('syntax', `RRULE supports only ${SUPPORTED_PARTS.join(', ')}.`)
    }
    parts.set(key, text)
  }
  return parts
}

/** Recognize a FREQ value that this module enumerates. */
function isFrequency(value: string): value is Frequency {
  return Object.hasOwn(CYCLE_PERIODS, value)
}

/** Read FREQ; SECONDLY is valid RFC 5545 but violates the 60-second occurrence spacing. */
function frequencyOf(text: string | undefined): Frequency {
  if (text === undefined) throw new RecurrenceInputError('syntax', 'RRULE must contain FREQ.')
  if (text === 'SECONDLY') {
    throw new RecurrenceInputError(
      'density',
      'FREQ=SECONDLY is not supported; occurrences must be at least 60 seconds apart.',
    )
  }
  if (!isFrequency(text)) {
    throw new RecurrenceInputError('syntax', 'FREQ must be MINUTELY, HOURLY, DAILY, WEEKLY, MONTHLY, or YEARLY.')
  }
  return text
}

/** Read an optional unsigned part from 1 through max. */
function positiveValue(text: string | undefined, max: number, message: string): number | undefined {
  if (text === undefined) return undefined
  const value = Number(text)
  if (!UNSIGNED_INTEGER.test(text) || value < 1 || value > max) throw new RecurrenceInputError('syntax', message)
  return value
}

/** Read an optional UNTIL as an actual UTC instant. */
function untilOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  if (!BASIC_UTC.test(text)) {
    throw new RecurrenceInputError('syntax', 'UNTIL must be an absolute UTC date-time ending in Z.')
  }
  return basicTime('UNTIL', text.slice(0, -1))
}

/** Read WKST as a weekday index; RFC 5545 defaults it to Monday. */
function weekStartOf(text: string | undefined): number {
  const index = WEEKDAYS.indexOf(text ?? 'MO')
  if (index < 0) throw new RecurrenceInputError('syntax', 'WKST must be MO, TU, WE, TH, FR, SA, or SU.')
  return index
}

/** Read one numeric BY list whose values are unique and in range. */
function listValues(key: string, text: string, range: ListRange): readonly number[] {
  const signed = range.min < 0
  const values = text.split(',').map((item) => {
    const value = Number(item)
    if (!(signed ? SIGNED_INTEGER : UNSIGNED_INTEGER).test(item) || value < range.min || value > range.max
      || (signed && value === 0)) {
      throw new RecurrenceInputError(
        'syntax',
        `${key} values must be integers from ${range.min} to ${range.max}${signed ? ', excluding 0' : ''}.`,
      )
    }
    return value
  })
  if (new Set(values).size !== values.length) throw new RecurrenceInputError('syntax', `${key} values must be unique.`)
  return values
}

/** Read an optional BYDAY list; `+2TU` and `2TU` select the same day. */
function byDayOf(text: string | undefined): ByDayCounts | undefined {
  if (text === undefined) return undefined
  const selectors = text.split(',')
  const seen = new Set<string>()
  let ordinals = 0
  for (const selector of selectors) {
    if (!WEEKDAY_SELECTOR.test(selector)) {
      throw new RecurrenceInputError('syntax', 'BYDAY contains an invalid weekday selector.')
    }
    const ordinal = selector.slice(0, -2)
    seen.add(`${Number(ordinal)}${selector.slice(-2)}`)
    if (ordinal.length > 0) ordinals += 1
  }
  if (seen.size !== selectors.length) throw new RecurrenceInputError('syntax', 'BYDAY values must be unique.')
  return { entries: selectors.length, ordinals }
}

/** Decode every RRULE part value. */
function ruleValues(parts: ReadonlyMap<string, string>): RuleValues {
  const frequency = frequencyOf(parts.get('FREQ'))
  const interval = positiveValue(parts.get('INTERVAL'), Number.MAX_SAFE_INTEGER, 'INTERVAL must be a positive safe integer.')
  const count = positiveValue(
    parts.get('COUNT'),
    MAX_RRULE_COUNT,
    `COUNT must be an integer from 1 to ${MAX_RRULE_COUNT}; use UNTIL for a longer finite recurrence.`,
  )
  const until = untilOf(parts.get('UNTIL'))
  const weekStart = weekStartOf(parts.get('WKST'))
  const lists = new Map<string, readonly number[]>()
  for (const [key, range] of LIST_RANGES) {
    const text = parts.get(key)
    if (text !== undefined) lists.set(key, listValues(key, text, range))
  }
  return { frequency, interval: interval ?? 1, count, until, weekStart, lists, byDay: byDayOf(parts.get('BYDAY')) }
}

/** Reject a part combination that RFC 5545 forbids or that breaks the 60-second occurrence spacing. */
function checkCombination(values: RuleValues): void {
  const { frequency, lists, byDay } = values
  const ordinals = byDay?.ordinals ?? 0
  if (values.count !== undefined && values.until !== undefined) {
    throw new RecurrenceInputError('syntax', 'RRULE must not contain both COUNT and UNTIL.')
  }
  if ((lists.get('BYSECOND')?.length ?? 1) > 1) {
    throw new RecurrenceInputError(
      'density',
      'BYSECOND must contain one value; occurrences must be at least 60 seconds apart.',
    )
  }
  if ((frequency === 'MINUTELY' || frequency === 'HOURLY') && (lists.size > 0 || byDay !== undefined)) {
    throw new RecurrenceInputError(
      'syntax',
      `FREQ=${frequency} does not support BY rule parts; use FREQ=DAILY or FREQ=WEEKLY with BYHOUR and BYMINUTE.`,
    )
  }
  for (const key of ['BYWEEKNO', 'BYYEARDAY']) {
    if (lists.has(key) && frequency !== 'YEARLY') throw new RecurrenceInputError('syntax', `${key} requires FREQ=YEARLY.`)
  }
  if (lists.has('BYMONTHDAY') && frequency !== 'MONTHLY' && frequency !== 'YEARLY') {
    throw new RecurrenceInputError('syntax', 'BYMONTHDAY requires FREQ=MONTHLY or FREQ=YEARLY.')
  }
  if (ordinals > 0 && frequency !== 'MONTHLY' && frequency !== 'YEARLY') {
    throw new RecurrenceInputError('syntax', 'BYDAY ordinals require FREQ=MONTHLY or FREQ=YEARLY.')
  }
  if (ordinals > 0 && lists.has('BYWEEKNO')) {
    throw new RecurrenceInputError('syntax', 'BYDAY ordinals cannot be combined with BYWEEKNO.')
  }
  if (lists.has('BYSETPOS') && lists.size === 1 && byDay === undefined) {
    throw new RecurrenceInputError('syntax', 'BYSETPOS requires another BY rule part.')
  }
}

/** Return an upper bound on BYDAY days in one month or year, or Infinity without BYDAY. */
function byDayDays(byDay: ByDayCounts | undefined, perWeekday: number): number {
  return byDay === undefined ? Infinity : byDay.ordinals + perWeekday * (byDay.entries - byDay.ordinals)
}

/**
 * Return an upper bound on the days that one FREQ period selects; the rule carries its DTSTART defaults explicitly.
 *
 * One BYWEEKNO value selects at most 9 days of a year, because the year can also contain days of the adjacent year's
 * week with that number.
 */
function periodDays(values: RuleValues): number {
  const { lists, byDay } = values
  const size = (key: string): number => lists.get(key)?.length ?? Infinity
  const months = lists.get('BYMONTH')?.length
  switch (values.frequency) {
    case 'MINUTELY':
    case 'HOURLY':
    case 'DAILY':
      return 1
    case 'WEEKLY':
      return Math.min(7, byDayDays(byDay, 1))
    case 'MONTHLY':
      return Math.min(31, size('BYMONTHDAY'), byDayDays(byDay, 5))
    case 'YEARLY':
      if (months === undefined) {
        return Math.min(366, size('BYYEARDAY'), 12 * size('BYMONTHDAY'), 9 * size('BYWEEKNO'), byDayDays(byDay, 53))
      }
      return Math.min(
        31 * months,
        size('BYYEARDAY'),
        months * size('BYMONTHDAY'),
        9 * size('BYWEEKNO'),
        months * byDayDays(byDay, 5),
      )
  }
}

/**
 * Reject a rule whose FREQ period can generate more occurrences than one enumeration may visit.
 * @param values - Rule values with the DTSTART defaults explicit.
 */
function checkCost(values: RuleValues, rejectIneffectiveSetPositions: boolean): void {
  const times = ['BYHOUR', 'BYMINUTE', 'BYSECOND']
    .reduce((product, key) => product * (values.lists.get(key)?.length ?? 1), 1)
  const candidates = periodDays(values) * times
  if (candidates > MAX_PERIOD_CANDIDATES) {
    throw new RecurrenceInputError(
      'density',
      `One FREQ period of this RRULE can contain up to ${candidates} occurrences; the limit is ${MAX_PERIOD_CANDIDATES}.`,
    )
  }
  const positions = values.lists.get('BYSETPOS') ?? []
  if (rejectIneffectiveSetPositions && candidates === 1 && positions.length > 0) {
    throw new RecurrenceInputError(
      'syntax',
      `BYSETPOS has no effect because one FREQ=${values.frequency} period of this RRULE contains at most 1 occurrence. `
      + 'BYSETPOS selects among the occurrences of one period; for example, '
      + 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1 selects the last weekday of each month.',
    )
  }
  if (positions.length > MAX_SET_POSITIONS) {
    throw new RecurrenceInputError('syntax', `BYSETPOS must contain at most ${MAX_SET_POSITIONS} values.`)
  }
  if (positions.some(position => Math.abs(position) > candidates)) {
    throw new RecurrenceInputError(
      'syntax',
      `BYSETPOS values must be from 1 to ${candidates} or from -${candidates} to -1; `
      + `one FREQ period of this RRULE contains at most ${candidates} occurrences.`,
    )
  }
}

/** Return the parts that the recurrence library derives from DTSTART when a DAILY or longer rule omits them. */
function startDefaults(values: RuleValues, start: number): ReadonlyMap<string, string> {
  const defaults = new Map<string, string>()
  const { frequency, lists, byDay } = values
  if (frequency === 'MINUTELY' || frequency === 'HOURLY') return defaults
  const date = new Date(start)
  if (!lists.has('BYHOUR')) defaults.set('BYHOUR', String(date.getUTCHours()))
  if (!lists.has('BYMINUTE')) defaults.set('BYMINUTE', String(date.getUTCMinutes()))
  if (!lists.has('BYSECOND')) defaults.set('BYSECOND', String(date.getUTCSeconds()))
  if (byDay !== undefined || lists.has('BYMONTHDAY') || lists.has('BYYEARDAY') || lists.has('BYWEEKNO')) return defaults
  if (frequency === 'WEEKLY') defaults.set('BYDAY', new Weekday((date.getUTCDay() + 6) % 7).toString())
  if (frequency === 'MONTHLY' || frequency === 'YEARLY') defaults.set('BYMONTHDAY', String(date.getUTCDate()))
  if (frequency === 'YEARLY' && !lists.has('BYMONTH')) defaults.set('BYMONTH', String(date.getUTCMonth() + 1))
  return defaults
}

/** Return the greatest common divisor of two positive safe integers. */
function gcd(left: number, right: number): number {
  return right === 0 ? left : gcd(right, left % right)
}

/**
 * Validate a rule completely, then derive its enumeration inputs.
 * @param value - DTSTART and RRULE content.
 */
function prepareRRule(value: string, rejectIneffectiveSetPositions: boolean): PreparedRRule {
  const [startLine, ruleLine] = recurrenceLines(value)
  const { timeZone, start } = parseStart(startLine)
  if (instantOf(new Date(start), timeZone) === undefined) {
    throw new RecurrenceInputError('syntax', 'DTSTART must be a real local date and time in its time zone.')
  }
  const parts = ruleParts(ruleLine)
  const values = ruleValues(parts)
  checkCombination(values)
  const recurrenceParts = new Map([...parts, ...startDefaults(values, start)])
  const recurrenceValues = ruleValues(recurrenceParts)
  checkCost(recurrenceValues, rejectIneffectiveSetPositions)
  recurrenceParts.delete('COUNT')
  recurrenceParts.delete('UNTIL')
  // The recurrence library combines the time lists in their given order, so ascending lists enumerate each day in time order.
  for (const key of TIME_PARTS) {
    const list = recurrenceValues.lists.get(key)
    if (list !== undefined) recurrenceParts.set(key, list.toSorted((left, right) => left - right).join(','))
  }
  const recurrence = [...recurrenceParts].map(([key, text]) => `${key}=${text}`).join(';')
  return {
    normalized: `${startLine}\n${ruleLine}`,
    timeZone,
    start,
    frequency: values.frequency,
    interval: values.interval,
    weekStart: values.weekStart,
    count: values.count,
    limit: values.until ?? MAX_FOUR_DIGIT_YEAR_MS,
    recurrence: `RRULE:${recurrence}`,
    invalidRunLimit: CYCLE_MS * values.interval / gcd(values.interval, CYCLE_PERIODS[values.frequency]),
  }
}

/** Express an actual instant as UTC-shaped wall time in a zone. */
function wallOf(epoch: number, timeZone: string): number {
  return epoch + Temporal.Instant.fromEpochMilliseconds(epoch).toZonedDateTimeISO(timeZone).offsetNanoseconds / 1_000_000
}

/** Resolve a UTC-shaped wall time to its earlier actual instant, or undefined inside a forward transition. */
function instantOf(date: Date, timeZone: string): number | undefined {
  return resolveLocalInstant(new Temporal.PlainDateTime(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ), timeZone)
}

/** Format UTC-shaped epoch milliseconds as a basic date-time without its Z. */
function basic(epoch: number): string {
  return new Date(epoch).toISOString().replaceAll('-', '').replaceAll(':', '').slice(0, 15)
}

/** Return the epoch day of UTC-shaped epoch milliseconds. */
function dayOf(epoch: number): number {
  return Math.floor(epoch / DAY_MS)
}

/** Return the epoch day of the week start at or before an epoch day; epoch day 0 is a Thursday. */
function weekStartDay(day: number, weekStart: number): number {
  return day - ((((day + 3 - weekStart) % 7) + 7) % 7)
}

/** Return the absolute month number of UTC-shaped epoch milliseconds. */
function monthOf(epoch: number): number {
  const date = new Date(epoch)
  return date.getUTCFullYear() * 12 + date.getUTCMonth()
}

/** Return the year of UTC-shaped epoch milliseconds. */
function yearOf(epoch: number): number {
  return new Date(epoch).getUTCFullYear()
}

/** Return the latest point `origin + k * step` at or before value. */
function floorStep(origin: number, value: number, step: number): number {
  return origin + Math.floor((value - origin) / step) * step
}

/** Return the start of the INTERVAL-aligned FREQ period that contains a wall time at or after DTSTART. */
function periodStart(prepared: PreparedRRule, wall: number): number {
  const { start, interval, weekStart } = prepared
  switch (prepared.frequency) {
    case 'MINUTELY':
      return floorStep(start, wall, interval * 60_000)
    case 'HOURLY':
      return floorStep(start, wall, interval * 3_600_000)
    case 'DAILY':
      return floorStep(dayOf(start), dayOf(wall), interval) * DAY_MS
    case 'WEEKLY':
      return floorStep(weekStartDay(dayOf(start), weekStart), weekStartDay(dayOf(wall), weekStart), 7 * interval) * DAY_MS
    case 'MONTHLY': {
      const month = floorStep(monthOf(start), monthOf(wall), interval)
      return Date.UTC(Math.floor(month / 12), month % 12, 1)
    }
    case 'YEARLY':
      return Date.UTC(floorStep(yearOf(start), yearOf(wall), interval), 0, 1)
  }
}

/**
 * Return the enumeration start for the period that contains a wall time.
 *
 * The first period keeps the original DTSTART, because the library truncates a first WEEKLY period at DTSTART.
 */
function periodAnchor(prepared: PreparedRRule, wall: number): number {
  return wall > prepared.start ? Math.max(periodStart(prepared, wall), prepared.start) : prepared.start
}

/** Build the library rule that enumerates UTC-shaped wall times from a period start. */
function libraryRule(prepared: PreparedRRule, anchor: number): ReturnType<typeof rrulestr> {
  return rrulestr(`DTSTART:${basic(anchor)}Z\n${prepared.recurrence}`)
}

/**
 * Report whether the rule can generate a wall time.
 *
 * Whole 400-year cycles preserve the Gregorian calendar, so the scan starts at the latest equivalent period that leaves one
 * complete calendar and INTERVAL cycle before year 9999. A rule without a wall time therefore costs at most two cycles.
 */
function hasCandidate(prepared: PreparedRRule): boolean {
  if (prepared.frequency === 'MINUTELY' || prepared.frequency === 'HOURLY') return true
  const first = periodStart(prepared, prepared.start)
  const firstYear = yearOf(first)
  const years = CYCLE_PERIODS.YEARLY
  const cycleYears = years * prepared.interval / gcd(prepared.interval, CYCLE_PERIODS[prepared.frequency])
  const cycles = Math.max(firstYear < MIN_RRULE_YEAR ? 1 : 0, Math.floor((9999 - firstYear - cycleYears - 1) / years))
  const anchor = first + cycles * CYCLE_MS
  return libraryRule(prepared, anchor).after(new Date(anchor), true) !== null
}

/**
 * Find the latest occurrence at or before a decision among wall times from one start, and the first later occurrence.
 *
 * Wall times at or before the decision wall time convert to instants only from the latest one backwards.
 */
function scanWindow(prepared: PreparedRRule, fromWall: number, decision: number): OccurrenceWindow {
  const window: OccurrenceWindow = { latest: undefined, next: undefined }
  if (fromWall > LAST_RRULE_WALL_MS) return window
  const bound = Math.min(decision, prepared.limit)
  const boundWall = wallOf(bound, prepared.timeZone)
  const below: Date[] = []
  const run = { lastValidWall: boundWall }
  libraryRule(prepared, periodAnchor(prepared, fromWall)).all((date) => {
    const wall = date.getTime()
    if (wall < fromWall) return true
    if (wall <= boundWall) {
      below.push(date)
      return true
    }
    // UTC offsets are shorter than one day.
    if (wall >= prepared.limit + DAY_MS) return false
    const instant = instantOf(date, prepared.timeZone)
    if (instant === undefined) return wall - run.lastValidWall <= prepared.invalidRunLimit
    run.lastValidWall = wall
    if (instant <= bound) {
      window.latest = instant
      return true
    }
    if (instant <= prepared.limit) window.next = instant
    return false
  })
  while (window.latest === undefined) {
    const date = below.pop()
    if (date === undefined) break
    const instant = instantOf(date, prepared.timeZone)
    if (instant !== undefined && instant <= bound) window.latest = instant
  }
  return window
}

/** Find the latest due occurrence; the window starts two days before the decision and doubles while it has none. */
function dispatchWindow(prepared: PreparedRRule, saved: number, decision: number): OccurrenceWindow {
  const savedWall = wallOf(saved, prepared.timeZone)
  const boundWall = wallOf(Math.min(decision, prepared.limit), prepared.timeZone)
  for (let span = 2 * DAY_MS; ; span *= 2) {
    const fromWall = Math.max(boundWall - span, savedWall)
    const window = scanWindow(prepared, fromWall, decision)
    if (window.latest !== undefined || fromWall === savedWall) return window
  }
}

/** Enumerate distinct COUNT instances from DTSTART through the first occurrence after a decision. */
function countWindow(prepared: PreparedRRule, decision: number, count: number): OccurrenceWindow {
  const window: OccurrenceWindow = { latest: undefined, next: undefined }
  const run = { remaining: count, lastValidWall: prepared.start }
  libraryRule(prepared, prepared.start).all((date) => {
    const wall = date.getTime()
    const instant = instantOf(date, prepared.timeZone)
    if (instant === undefined) return wall - run.lastValidWall <= prepared.invalidRunLimit
    if (instant === window.latest) return true
    run.lastValidWall = wall
    if (instant > decision) {
      if (instant <= MAX_FOUR_DIGIT_YEAR_MS) window.next = instant
      return false
    }
    window.latest = instant
    run.remaining -= 1
    return run.remaining > 0
  })
  return window
}

/** Format the first occurrence strictly after a representable reference time. */
function nextOccurrence(prepared: PreparedRRule, after: number): string | undefined {
  if (!hasCandidate(prepared)) return undefined
  const next = prepared.count === undefined
    ? scanWindow(prepared, wallOf(after, prepared.timeZone), after).next
    : countWindow(prepared, after, prepared.count).next
  return next === undefined ? undefined : new Date(next).toISOString()
}


/** Parsed two-line DTSTART/RRULE value with bounded occurrence arithmetic. */
export class RRule {
  private constructor(private readonly prepared: PreparedRRule) {}

  /** Trimmed two-line expression; DTSTART owns the zone and recurrence anchor. */
  get expression(): string { return this.prepared.normalized }

  /** Canonical zone from DTSTART, or UTC for a Z start. */
  get timeZone(): string { return this.prepared.timeZone }

  /**
   * Validate syntax and enumeration cost before any occurrence search.
   * @param expression - Exactly one DTSTART line followed by one RRULE line.
   * @param options - Optional stricter BYSETPOS authoring checks.
   * @returns A bounded parsed value, or a syntax, zone, or density refusal.
   */
  static parse(expression: string, options: { readonly rejectIneffectiveSetPositions?: boolean } = {}): RecurrenceResult<RRule> {
    return parseRecurrence(() => {
      const rule = new RRule(prepareRRule(expression, options.rejectIneffectiveSetPositions ?? false))
      Object.freeze(rule)
      return rule
    })
  }

  /**
   * First occurrence strictly after the explicit lower bound, or exhaustion.
   * @param after - Representable epoch milliseconds that the occurrence must exceed.
   * @returns The UTC occurrence, or exhaustion of the accepted rule.
   */
  next(after: number): string | undefined {
    if (!isFourDigitYearInstant(after)) throw new RangeError('RRULE lower bound must be a four-digit-year instant')
    return nextOccurrence(this.prepared, after)
  }

  /**
   * Latest due occurrence and first future occurrence, retaining the committed floor.
   * @param scheduledAt - Canonical four-digit-year UTC occurrence with milliseconds, retained across zone-data changes.
   * @param acceptedAt - Representable decision time at or after that occurrence.
   * @returns The latest due occurrence and optional future successor.
   * @throws RangeError when either instant is invalid or the decision precedes the committed occurrence.
   */
  resolve(scheduledAt: string, acceptedAt: number): RecurrenceOccurrence {
    const savedTarget = recurrenceDecision(scheduledAt, acceptedAt)
    const prepared = this.prepared
    const window = prepared.count === undefined
      ? dispatchWindow(prepared, savedTarget, acceptedAt)
      : countWindow(prepared, acceptedAt, prepared.count)
    const occurrenceAt = new Date(Math.max(window.latest ?? savedTarget, savedTarget)).toISOString()
    const nextScheduledAt = window.next === undefined ? undefined : new Date(window.next).toISOString()
    return Object.freeze(nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt })
  }
}
