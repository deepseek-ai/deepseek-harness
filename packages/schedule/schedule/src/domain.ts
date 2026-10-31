/**
 * Host task decoding, timing validation, occurrence selection, and reminder framing.
 * @module @deepseek-ai/dsh-schedule
 */

import { Temporal } from '@js-temporal/polyfill'
import {
  Cron,
  RRule,
  MAX_FOUR_DIGIT_YEAR_MS,
  MIN_FOUR_DIGIT_YEAR_MS,
  canonicalizeTimeZone as canonicalizeSharedTimeZone,
  formatFourDigitYearInstant,
  fourDigitYearEpoch,
  isFourDigitYearInstant,
  parseLocalCalendar,
  parseOffsetInstant,
  resolveLocalInstant,
} from '@deepseek-ai/dsh-util-time'
import type {
  InstantRejection, LocalCalendarRejection, LocalCalendarTime, TimeZoneRejection, RecurrenceResult,
} from '@deepseek-ai/dsh-util-time'
import type {
  AfterScheduleRecord,
  AtInput,
  AtScheduleRecord,
  EveryScheduleRecord,
  CronInput,
  CronScheduleRecord,
  DailyInput,
  DailyScheduleRecord,
  WeeklyInput,
  WeeklyScheduleRecord,
  RecurringScheduleRecord,
  LocalAtInput,
  ScheduleId as ScheduleIdType,
  ScheduleInputErrorCode,
} from './types.ts'
import type { ScheduleRecord, RRuleScheduleRecord } from './types.ts'

/** Minimum supported fixed-rate interval. */
export const MIN_EVERY_INTERVAL_SECONDS = 60

/** Maximum stored task title length. */
export const MAX_TITLE_LENGTH = 120

const LOCAL_CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/

/** Error from malformed or transition-invalid durable Schedule data. */
export class ScheduleLogError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'corrupt_schedule_log' as const

  /**
   * Construct a durable-log failure.
   * @param message - Package-specific violated invariant.
   */
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleLogError'
  }
}

/** Error from a model-supplied Schedule rule or target Session that cannot become a record. */
export class ScheduleInputError extends Error {
  /** Stable public Schedule input code. */
  readonly code: ScheduleInputErrorCode

  /**
   * Construct a stable input failure.
   * @param code - Public Schedule error discriminator.
   * @param message - Stable public diagnostic.
   * @param options - Optional contained implementation cause.
   */
  constructor(
    code: ScheduleInputErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ScheduleInputError'
    this.code = code
  }
}

/** One latest-only recurring decision derived without enumerating a backlog. */
export interface RecurringOccurrence {
  /** Latest occurrence due at the decision time. */
  readonly occurrenceAt: string
  /** First eligible target after the decision, or exhaustion. */
  readonly nextScheduledAt?: string
}

/**
 * Brand a raw task id without changing its runtime value.
 * @param value - Raw task id.
 * @returns The same string with the Schedule brand.
 */
export function ScheduleId(value: string): ScheduleIdType {
  return value as ScheduleIdType
}

/**
 * Narrow an unknown value to a non-array object.
 * @param value - Value to inspect.
 * @returns Whether the value is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Require exactly the named durable object keys.
 * @param value - Object to inspect.
 * @param expected - Complete allowed key set.
 * @returns Whether every expected key is present and no other key is present.
 */
export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected)
  return expected.every(key => key in value) && Object.keys(value).every(key => allowed.has(key))
}

/** Stable diagnostic for a title that is missing or empty after trimming. */
export const REQUIRED_TITLE_MESSAGE = 'title is required and must be non-empty after trimming.'

/**
 * Validate the title supplied at creation.
 *
 * Creation requires an explicit title: a missing, blank-after-trim, or over-long
 * value throws instead of deriving a name from the instruction.
 * @param title - Task name supplied at creation.
 * @returns The trimmed title; an invalid title throws ScheduleInputError.
 */
export function scheduleTitle(title: string): string {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new ScheduleInputError('invalid_prompt', REQUIRED_TITLE_MESSAGE)
  }
  const normalized = title.trim()
  if (normalized.length > MAX_TITLE_LENGTH) {
    throw new ScheduleInputError('invalid_prompt', `title must be at most ${MAX_TITLE_LENGTH} characters.`)
  }
  return normalized
}

/**
 * Validate one required stored title at the durable boundary.
 *
 * Only records written after titles became required are read: a missing,
 * blank-after-trim, untrimmed, or over-long stored title is invalid, and no name
 * is derived from the instruction.
 * @param value - Untrusted durable title field.
 * @returns The stored title; an invalid title throws ScheduleLogError.
 */
export function decodeStoredTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ScheduleLogError(REQUIRED_TITLE_MESSAGE)
  }
  if (value.length > MAX_TITLE_LENGTH) {
    throw new ScheduleLogError(`title must be at most ${MAX_TITLE_LENGTH} characters`)
  }
  if (value.trim() !== value) {
    throw new ScheduleLogError('title must be a trimmed string')
  }
  return value
}

/**
 * Decode the required stored title of one durable Host record, then require its exact key set.
 *
 * The title decodes first so that a record without the key reports the title
 * diagnostic rather than the record's required-key list.
 * @param value - Untrusted durable record already known to be an object.
 * @param expected - Exact keys the record must carry, including `title`.
 * @param message - Diagnostic naming the record's required keys.
 * @returns The stored title; an invalid title or key set throws ScheduleLogError.
 */
function decodeRecordTitle(value: Record<string, unknown>, expected: readonly string[], message: string): string {
  const title = decodeStoredTitle(value['title'])
  if (!hasExactKeys(value, expected)) throw new ScheduleLogError(message)
  return title
}

/**
 * Validate one stable task id at the durable boundary.
 * @param value - Untrusted durable id field.
 * @returns The branded id; an invalid id throws ScheduleLogError.
 */
export function decodeId(value: unknown): ScheduleIdType {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ScheduleLogError('schedule id must be a non-empty string without surrounding whitespace')
  }
  return ScheduleId(value)
}

/** Stable Schedule diagnostic for a `scheduledAt` outside the canonical profile. */
const NON_CANONICAL_INSTANT_MESSAGE = 'scheduledAt must be a canonical four-digit-year RFC 3339 UTC instant'

/**
 * Validate one canonical four-digit-year UTC instant at the durable boundary.
 * @param value - Untrusted durable instant field.
 * @returns The canonical instant; an invalid instant throws ScheduleLogError.
 */
export function decodeInstant(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ScheduleLogError(NON_CANONICAL_INSTANT_MESSAGE)
  }
  const parsed = fourDigitYearEpoch(value)
  if (parsed.kind === 'rejected') throw new ScheduleLogError(instantDiagnostic(parsed.reason))
  return value
}

/**
 * Map one shared instant rejection onto the stable stored-data diagnostic.
 * @param reason - Reason the shared vocabulary refused the instant.
 * @returns The Schedule log diagnostic for that refusal.
 */
function instantDiagnostic(reason: InstantRejection): string {
  switch (reason) {
    case 'not_a_calendar_date':
      return 'scheduledAt is not a real UTC calendar instant'
    case 'not_rfc3339':
    case 'out_of_range':
    case 'invalid_numeric_offset':
      return NON_CANONICAL_INSTANT_MESSAGE
    /* v8 ignore next 3 -- the shared parser returns a closed rejection union. */
    default: {
      const unreachable: never = reason
      throw new ScheduleLogError(`unknown instant rejection ${String(unreachable)}`)
    }
  }
}

/**
 * Map one shared zone rejection onto the stable Schedule input code.
 * @param reason - Reason the shared vocabulary refused the name.
 * @param cause - Platform refusal the shared vocabulary caught, when it carried one.
 * @returns The public Schedule diagnostic for that refusal.
 */
function timeZoneError(reason: TimeZoneRejection, cause?: unknown): ScheduleInputError {
  const options = cause === undefined ? undefined : { cause }
  switch (reason) {
    case 'blank':
    case 'padded':
    case 'not_area_location':
    case 'unsupported':
      return new ScheduleInputError('invalid_time_zone', 'time_zone must be UTC or a valid IANA Area/Location name.', options)
    /* v8 ignore next 2 -- the shared parser does not answer not_canonical_shape for a canonical zone. */
    case 'not_canonical_shape':
      return new ScheduleInputError('invalid_time_zone', 'time_zone must resolve to UTC or an IANA Area/Location name.', options)
    /* v8 ignore next 3 -- TimeZoneRejection is closed; this arm only makes adding a reason a compile error. */
    default: {
      const unreachable: never = reason
      return unreachable
    }
  }
}

/**
 * Validate and canonicalize one raw IANA time-zone selector.
 * @param value - Candidate `UTC` or IANA Area/Location name.
 * @returns The runtime's canonical IANA name.
 */
export function canonicalizeTimeZone(value: string): string {
  const resolved = canonicalizeSharedTimeZone(value)
  if (resolved.kind === 'rejected') throw timeZoneError(resolved.reason, resolved.cause)
  return resolved.timeZone
}

/** Parse strict local calendar fields without consulting a process time zone. */
function parseLocalAt(value: LocalAtInput): LocalCalendarTime {
  const parsed = parseLocalCalendar(value.date, value.time)
  if (parsed.kind === 'rejected') {
    throw new ScheduleInputError('invalid_rule', localCalendarDiagnostic(parsed.reason))
  }
  return parsed.time
}

/** Map one shared local-calendar rejection onto the stable Schedule diagnostic. */
function localCalendarDiagnostic(reason: LocalCalendarRejection): string {
  switch (reason) {
    case 'malformed':
      return 'Local at requires date YYYY-MM-DD and time HH:mm:ss with optional one-to-three digit milliseconds.'
    case 'not_a_calendar_date':
      return 'The at value must be a real ISO calendar date and time.'
    case 'out_of_range':
      return 'The local at value must be a real ISO calendar date and time.'
    /* v8 ignore next 3 -- the shared parser returns a closed rejection union. */
    default: {
      const unreachable: never = reason
      throw new Error(`unknown local calendar rejection ${String(unreachable)}`)
    }
  }
}

/** Resolve a local one-shot, rejecting nonexistent wall-clock times. */
function resolveLocalAt(parts: LocalCalendarTime, timeZone: string): number {
  const target = resolveLocalInstant(parts, timeZone)
  if (target === undefined) {
    throw new ScheduleInputError('invalid_rule', 'The local at time does not exist in the selected time zone.')
  }
  return target
}

/**
 * Require a safe, representable, strictly future UTC target.
 * @param epoch - Candidate target in epoch milliseconds.
 * @param now - Exclusive lower bound in epoch milliseconds.
 * @returns The canonical UTC instant; an out-of-range or past target throws ScheduleInputError.
 */
export function futureInstant(epoch: number, now: number): string {
  const instant = formatFourDigitYearInstant(epoch)
  if (!Number.isSafeInteger(now) || instant === undefined) {
    throw new ScheduleInputError(
      'time_out_of_range',
      'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.',
    )
  }
  if (epoch <= now) {
    throw new ScheduleInputError('not_future', 'The scheduled time must be strictly in the future.')
  }
  return instant
}

/** Parse a strict RFC 3339 instant whose numeric offset is part of the input. */
function parseAtOffsetInstant(value: string): number {
  const parsed = parseOffsetInstant(value)
  if (parsed.kind === 'accepted') return parsed.epoch
  switch (parsed.reason) {
    case 'not_rfc3339':
      throw new ScheduleInputError(
        'invalid_rule',
        'at must use YYYY-MM-DDTHH:mm:ss with optional 1-3 digit fractional seconds and an explicit Z or numeric offset.',
      )
    case 'invalid_numeric_offset':
      throw new ScheduleInputError('invalid_rule', 'The at numeric offset is invalid.')
    case 'not_a_calendar_date':
    case 'out_of_range':
      throw new ScheduleInputError('invalid_rule', 'The at value must be a real ISO calendar date and time.')
    /* v8 ignore next 3 -- the shared parser returns a closed rejection union. */
    default: {
      const unreachable: never = parsed.reason
      throw new Error(`unknown instant rejection ${String(unreachable)}`)
    }
  }
}

/** Decode a delayed one-shot Host record. */
function decodeAfterRecord(value: Record<string, unknown>): AfterScheduleRecord {
  const title = decodeRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'afterSeconds', 'scheduledAt'],
    'after schedule must contain exactly id, kind, title, prompt, afterSeconds, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('after prompt must be non-empty and already trimmed')
  }
  const afterSeconds = value['afterSeconds']
  if (!Number.isSafeInteger(afterSeconds) || (afterSeconds as number) <= 0) {
    throw new ScheduleLogError('afterSeconds must be a positive safe integer')
  }
  return Object.freeze({
    id: decodeId(value['id']),
    kind: 'after',
    title,
    prompt,
    afterSeconds: afterSeconds as number,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/** Decode an absolute one-shot Host record. */
function decodeAtRecord(value: Record<string, unknown>): AtScheduleRecord {
  const title = decodeRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'scheduledAt'],
    'at schedule must contain exactly id, kind, title, prompt, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('at prompt must be non-empty and already trimmed')
  }
  return Object.freeze({
    id: decodeId(value['id']),
    kind: 'at',
    title,
    prompt,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/** Decode a fixed-rate Host record. */
function decodeEveryRecord(value: Record<string, unknown>): EveryScheduleRecord {
  const title = decodeRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'everySeconds', 'scheduledAt'],
    'every schedule must contain exactly id, kind, title, prompt, everySeconds, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('every prompt must be non-empty and already trimmed')
  }
  const everySeconds = value['everySeconds']
  const interval = typeof everySeconds === 'number' ? everySeconds * 1_000 : Number.NaN
  if (!Number.isSafeInteger(everySeconds)
    || (everySeconds as number) < MIN_EVERY_INTERVAL_SECONDS
    || !Number.isSafeInteger(interval)) {
    throw new ScheduleLogError(`everySeconds must be a safe integer of at least ${MIN_EVERY_INTERVAL_SECONDS}`)
  }
  return Object.freeze({
    id: decodeId(value['id']),
    kind: 'every',
    title,
    prompt,
    everySeconds: everySeconds as number,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/**
 * Parse one strict local clock time shared by the wall-clock selectors.
 * @param value - Candidate `HH:mm:ss` time with optional one-to-three fractional digits.
 * @param selector - Public selector name used in the diagnostic.
 * @returns The parsed plain time; malformed input throws ScheduleInputError.
 */
function localClockTime(value: string, selector: string): Temporal.PlainTime {
  if (!LOCAL_CLOCK_TIME.test(value)) {
    throw new ScheduleInputError(
      'invalid_rule',
      `${selector}.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00.`,
    )
  }
  return Temporal.PlainTime.from(value)
}

/** Parse strictly before Temporal can constrain or coerce the supplied time. */
function dailyTime(value: string): Temporal.PlainTime {
  return localClockTime(value, 'daily')
}

/**
 * Parse one strict local clock time accepted by the weekly selector.
 * @param value - Candidate `HH:mm:ss` time with optional one-to-three fractional digits.
 * @returns The parsed plain time; malformed input throws ScheduleInputError.
 */
export function weeklyTime(value: string): Temporal.PlainTime {
  return localClockTime(value, 'weekly')
}

/** Fail already-typed durable values without wrapping the stored-data diagnostic. */
function rethrowLogError(error: unknown): never {
  throw new ScheduleLogError(String(error))
}

/** Decode a Host daily rule without re-resolving its committed UTC target. */
function decodeDailyRecord(value: Record<string, unknown>): DailyScheduleRecord {
  const title = decodeRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'scheduledAt'],
    'daily schedule must contain exactly id, kind, title, prompt, time, timeZone, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('daily prompt must be non-empty and already trimmed')
  }
  const time = value['time']
  const timeZone = value['timeZone']
  if (typeof time !== 'string' || typeof timeZone !== 'string') {
    throw new ScheduleLogError('daily time and timeZone must be strings')
  }
  let normalized: string
  try {
    normalized = dailyTime(time).toString({ fractionalSecondDigits: 3 })
    canonicalizeTimeZone(timeZone)
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  if (time !== normalized) throw new ScheduleLogError('daily time must be normalized to HH:mm:ss.SSS')
  return Object.freeze({
    id: decodeId(value['id']), kind: 'daily', title, prompt, time, timeZone,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/**
 * Normalize the explicit ISO weekday set of one weekly rule.
 * @param weekdays - Untrusted candidate weekday values.
 * @returns Frozen unique ascending weekdays from 1 (Monday) through 7 (Sunday).
 */
export function normalizeWeekdays(weekdays: unknown): number[] {
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    throw new ScheduleInputError('invalid_rule', 'weekly.weekdays must be a non-empty array of ISO weekday numbers.')
  }
  const unique = new Set<number>()
  for (const weekday of weekdays as unknown[]) {
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new ScheduleInputError(
        'invalid_rule', 'Each weekly.weekdays entry must be an integer from 1 (Monday) through 7 (Sunday).',
      )
    }
    if (unique.has(weekday)) {
      throw new ScheduleInputError('invalid_rule', `weekly.weekdays must not repeat weekday ${weekday}.`)
    }
    unique.add(weekday)
  }
  const ordered = [...unique].sort((left, right) => left - right)
  Object.freeze(ordered)
  return ordered
}
/**
 * Decode a Host weekly rule without re-resolving its committed UTC target.
 * @param value - Untrusted durable record already identified as weekly.
 * @returns Detached frozen weekly record; malformed fields throw ScheduleLogError.
 */
function decodeWeeklyRecord(value: Record<string, unknown>): WeeklyScheduleRecord {
  const title = decodeRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'weekdays', 'scheduledAt'],
    'weekly schedule must contain exactly id, kind, title, prompt, time, timeZone, weekdays, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('weekly prompt must be non-empty and already trimmed')
  }
  const time = value['time']
  const timeZone = value['timeZone']
  if (typeof time !== 'string' || typeof timeZone !== 'string') {
    throw new ScheduleLogError('weekly time and timeZone must be strings')
  }
  try {
    canonicalizeTimeZone(timeZone)
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  let normalized: string
  try {
    normalized = weeklyTime(time).toString({ fractionalSecondDigits: 3 })
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  if (time !== normalized) throw new ScheduleLogError('weekly time must be normalized to HH:mm:ss.SSS')
  // normalizeWeekdays proves the field is a number array before this check compares it to the decoded copy.
  const stored = value['weekdays'] as number[]
  let weekdays: number[]
  try {
    weekdays = normalizeWeekdays(stored)
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  if (weekdays.some((weekday, index) => weekday !== stored[index])) {
    throw new ScheduleLogError('weekly weekdays must be normalized to unique ascending ISO weekday numbers')
  }
  return Object.freeze({
    id: decodeId(value['id']), kind: 'weekly', title, prompt, time, timeZone,
    weekdays, scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/**
 * Decode a Host cron rule without re-resolving its committed UTC target.
 * @param value - Untrusted durable record already identified as cron.
 * @returns Detached frozen cron record; malformed fields throw ScheduleLogError.
 */
function decodeCronRecord(value: Record<string, unknown>): CronScheduleRecord {
  const title = decodeRecordTitle(
    value,
    ['id', 'kind', 'title', 'prompt', 'expression', 'timeZone', 'scheduledAt'],
    'cron schedule must contain exactly id, kind, title, prompt, expression, timeZone, and scheduledAt',
  )
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('cron prompt must be non-empty and already trimmed')
  }
  const expression = value['expression']
  const timeZone = value['timeZone']
  if (typeof expression !== 'string' || typeof timeZone !== 'string') {
    throw new ScheduleLogError('cron expression and timeZone must be strings')
  }
  try {
    canonicalizeTimeZone(timeZone)
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  let canonical: string
  try {
    canonical = canonicalizeCronExpression(expression)
  } catch (error: unknown) {
    rethrowLogError(error)
  }
  if (expression !== canonical) throw new ScheduleLogError('cron expression must be canonical')
  return Object.freeze({
    id: decodeId(value['id']), kind: 'cron', title, prompt, expression, timeZone,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/**
 * Decode one of the seven current Host timing records without recomputing its committed occurrence.
 * @param value - Untrusted durable JSON record.
 * @returns Detached frozen record with its required title and authoritative timing fields.
 */
export function decodeScheduleRecord(value: unknown): ScheduleRecord {
  if (!isRecord(value)) throw new ScheduleLogError('schedule record must be an object')
  switch (value['kind']) {
    case 'after': return decodeAfterRecord(value)
    case 'at': return decodeAtRecord(value)
    case 'every': return decodeEveryRecord(value)
    case 'daily': return decodeDailyRecord(value)
    case 'weekly': return decodeWeeklyRecord(value)
    case 'cron': return decodeCronRecord(value)
    case 'rrule': return decodeRRuleScheduleRecord(value)
    default: throw new ScheduleLogError('schedule kind must be "after", "at", "every", "daily", "weekly", "cron", or "rrule"')
  }
}

/** Timing fields one fixed-rate decision needs from its record. */
type EveryOccurrenceInput = Pick<EveryScheduleRecord, 'everySeconds' | 'scheduledAt'>

/**
 * Resolve one fixed-rate decision without enumerating missed occurrences.
 * @param record - Active record whose target is the earliest unaccepted occurrence.
 * @param acceptedAt - Wall-clock decision time in epoch milliseconds.
 * @returns The latest due occurrence and first strictly future target, if representable.
 */
export function resolveEveryOccurrence(
  record: EveryOccurrenceInput,
  acceptedAt: number,
): RecurringOccurrence {
  const target = Date.parse(record.scheduledAt)
  const interval = record.everySeconds * 1_000
  if (!isFourDigitYearInstant(acceptedAt)) {
    throw new ScheduleLogError('every acceptedAt must be a representable four-digit-year instant')
  }
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new ScheduleLogError('every interval milliseconds must be a positive safe integer')
  }
  if (acceptedAt < target) {
    throw new ScheduleLogError('every dispatch cannot precede the active scheduledAt')
  }
  const steps = Math.floor((acceptedAt - target) / interval)
  const occurrence = target + steps * interval
  /* v8 ignore next -- bounded operands and a quotient-derived product stay safe. */
  if (!Number.isSafeInteger(occurrence) || occurrence < target || occurrence > acceptedAt) {
    throw new ScheduleLogError('every occurrence arithmetic must stay within the accepted interval')
  }
  const occurrenceAt = new Date(occurrence).toISOString()
  const next = occurrence + interval
  if (!isFourDigitYearInstant(next)) {
    return Object.freeze({ occurrenceAt })
  }
  return Object.freeze({
    occurrenceAt,
    nextScheduledAt: new Date(next).toISOString(),
  })
}

/** Project an explicit instant into a calendar date in the rule's zone. */
function localDate(epoch: number, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(epoch).toZonedDateTimeISO(timeZone).toPlainDate()
}

/** Recognize one of the rule's explicit ISO weekdays on a local calendar date. */
type WeekdayMatch = (date: Temporal.PlainDate) => boolean

/** Skip every local date; used by a rule that selects by time alone. */
const EVERY_DATE: WeekdayMatch = () => true

/** Select the explicit ISO weekdays of one normalized weekly rule. */
function weekdaySet(weekdays: readonly number[]): WeekdayMatch {
  const selected = new Set(weekdays)
  return date => selected.has(date.dayOfWeek)
}

/** Find the first actual occurrence after now and, when supplied, after a delivered date. */
function nextMatchingTarget(
  time: Temporal.PlainTime,
  timeZone: string,
  now: number,
  matches: WeekdayMatch,
  afterDate?: Temporal.PlainDate,
): string | undefined {
  let date = localDate(now, timeZone)
  const lastDate = localDate(MAX_FOUR_DIGIT_YEAR_MS, 'UTC').add({ days: 1 })
  if (afterDate !== undefined && Temporal.PlainDate.compare(date, afterDate) <= 0) {
    date = afterDate.add({ days: 1 })
  }
  for (; Temporal.PlainDate.compare(date, lastDate) <= 0; date = date.add({ days: 1 })) {
    if (!matches(date)) continue
    const target = resolveLocalInstant(date.toPlainDateTime(time), timeZone)
    if (target === undefined) continue
    if (target > MAX_FOUR_DIGIT_YEAR_MS) return undefined
    if (target >= MIN_FOUR_DIGIT_YEAR_MS && target > now) return new Date(target).toISOString()
  }
  return undefined
}

/** Find the latest actual occurrence at or before a decision without leaving the committed floor. */
function latestDueOccurrence(
  timeZone: string,
  matches: WeekdayMatch,
  time: Temporal.PlainTime,
  acceptedAt: number,
  savedTarget: number,
): number {
  // Offsets are less than 24 hours; a date-line rollback can make the current local date earlier than a due date.
  let date = localDate(acceptedAt, 'UTC').add({ days: 1 })
  for (;; date = date.subtract({ days: 1 })) {
    if (!matches(date)) continue
    const candidate = resolveLocalInstant(date.toPlainDateTime(time), timeZone)
    if (candidate === undefined || candidate > acceptedAt) continue
    // A committed target remains due even if current tzdata places the rule before it.
    return Math.max(candidate, savedTarget)
  }
}

/**
 * Resolve a wall-clock rule only when its decision is at a representable four-digit-year instant.
 * @param selector - Rule kind named in the failure message.
 * @param acceptedAt - Explicit wall-clock decision time in epoch milliseconds.
 * @returns The validated decision time.
 */
export function acceptedDecision(selector: string, acceptedAt: number): number {
  if (!isFourDigitYearInstant(acceptedAt)) {
    throw new ScheduleLogError(`${selector} acceptedAt must be a representable four-digit-year instant`)
  }
  return acceptedAt
}

/** Find the first actual daily occurrence after now and, when supplied, after a delivered date. */
function nextDailyTarget(
  time: Temporal.PlainTime,
  timeZone: string,
  now: number,
  afterDate?: Temporal.PlainDate,
): string | undefined {
  return nextMatchingTarget(time, timeZone, now, EVERY_DATE, afterDate)
}

/**
 * Resolve a daily decision near the decision's local date, not across its missed history.
 * @param record - Daily rule with a committed earliest unaccepted UTC target.
 * @param acceptedAt - Explicit wall-clock decision time, at or after the committed target.
 * @returns Latest actual due occurrence and the next future occurrence on a later local date.
 */
export function resolveDailyOccurrence(record: DailyScheduleRecord, acceptedAt: number): RecurringOccurrence {
  const decision = acceptedDecision('daily', acceptedAt)
  const savedTarget = Date.parse(record.scheduledAt)
  if (decision < savedTarget) throw new ScheduleLogError('daily dispatch cannot precede the active scheduledAt')
  const time = dailyTime(record.time)
  const occurrence = latestDueOccurrence(record.timeZone, EVERY_DATE, time, decision, savedTarget)
  const occurrenceAt = new Date(occurrence).toISOString()
  const nextScheduledAt = nextDailyTarget(time, record.timeZone, decision, localDate(occurrence, record.timeZone))
  return Object.freeze(nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt })
}

/**
 * Find the first actual weekly occurrence after now and, when supplied, after a delivered date.
 * @param time - Normalized local clock time of the rule.
 * @param timeZone - Explicit zone interpreting that clock time.
 * @param weekdays - Normalized explicit ISO weekdays of the rule.
 * @param now - Explicit decision time in epoch milliseconds.
 * @param afterDate - Local date of the delivered occurrence, excluded from the search.
 * @returns The first strictly future target, or exhaustion as undefined.
 */
function nextWeeklyTarget(
  time: Temporal.PlainTime,
  timeZone: string,
  weekdays: readonly number[],
  now: number,
  afterDate?: Temporal.PlainDate,
): string | undefined {
  return nextMatchingTarget(time, timeZone, now, weekdaySet(weekdays), afterDate)
}

/**
 * Resolve a weekly decision near the decision's local date, not across its missed history.
 * @param record - Weekly rule with a committed earliest unaccepted UTC target.
 * @param acceptedAt - Explicit wall-clock decision time, at or after the committed target.
 * @returns Latest actual due occurrence and the next future occurrence on a selected weekday.
 */
export function resolveWeeklyOccurrence(record: WeeklyScheduleRecord, acceptedAt: number): RecurringOccurrence {
  const decision = acceptedDecision('weekly', acceptedAt)
  const savedTarget = Date.parse(record.scheduledAt)
  if (decision < savedTarget) throw new ScheduleLogError('weekly dispatch cannot precede the active scheduledAt')
  const time = weeklyTime(record.time)
  const weekdays = normalizeWeekdays(record.weekdays)
  const occurrence = latestDueOccurrence(record.timeZone, weekdaySet(weekdays), time, decision, savedTarget)
  const occurrenceAt = new Date(occurrence).toISOString()
  const nextScheduledAt = nextWeeklyTarget(time, record.timeZone, weekdays, decision, localDate(occurrence, record.timeZone))
  return Object.freeze(nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt })
}

/**
 * Resolve a Cron rule through the shared bounded recurrence engine.
 * @param record - Authoritative Cron expression, zone, and committed occurrence.
 * @param acceptedAt - Decision time at or after the committed occurrence.
 * @returns The latest due occurrence and optional future successor.
 */
export function resolveCronOccurrence(record: CronScheduleRecord, acceptedAt: number): RecurringOccurrence {
  acceptedDecision('cron', acceptedAt)
  if (acceptedAt < Date.parse(record.scheduledAt)) throw new ScheduleLogError('cron dispatch cannot precede the active scheduledAt')
  return readRecurrence(Cron.parse(record.expression, record.timeZone)).resolve(record.scheduledAt, acceptedAt)
}

/**
 * Identify recurring Host records explicitly, excluding both one-shot variants.
 * @param record - Current Host schedule record.
 * @returns Whether the record uses a recurring rule.
 */
export function isRecurringScheduleRecord(record: ScheduleRecord): record is RecurringScheduleRecord {
  return record.kind === 'every' || record.kind === 'daily' || record.kind === 'weekly' || record.kind === 'cron' || record.kind === 'rrule'
}

/**
 * Resolve one due recurring Host record with its rule-specific calendar or interval arithmetic.
 * @param record - Due recurring rule.
 * @param acceptedAt - Explicit decision time in epoch milliseconds.
 * @returns Latest due occurrence and optional future target.
 */
export function resolveRecurringOccurrence(record: RecurringScheduleRecord, acceptedAt: number): RecurringOccurrence {
  switch (record.kind) {
    case 'every': return resolveEveryOccurrence(record, acceptedAt)
    case 'daily': return resolveDailyOccurrence(record, acceptedAt)
    case 'weekly': return resolveWeeklyOccurrence(record, acceptedAt)
    case 'cron': return resolveCronOccurrence(record, acceptedAt)
    case 'rrule': return resolveRRuleOccurrence(record, acceptedAt)
  }
}

/**
 * Validate a model after rule and compute its durable target.
 * @param id - Already allocated task id.
 * @param prompt - Reminder content supplied at creation.
 * @param afterSeconds - Requested positive delay.
 * @param now - Single rule-acceptance wall-clock sample in epoch milliseconds.
 * @param title - Required task name supplied at creation.
 * @returns Frozen durable after record.
 */
export function createAfterScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  afterSeconds: number,
  now: number,
  title: string,
): AfterScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  if (!Number.isSafeInteger(afterSeconds) || afterSeconds <= 0) {
    throw new ScheduleInputError('invalid_rule', 'after_seconds must be a positive safe integer.')
  }
  const delay = afterSeconds * 1_000
  const target = now + delay
  return Object.freeze({
    id,
    kind: 'after',
    title: scheduleTitle(title),
    prompt: normalizedPrompt,
    afterSeconds,
    scheduledAt: futureInstant(target, now),
  })
}

/**
 * Validate an absolute selector and compute its sole durable UTC target.
 * @param id - Already allocated task id.
 * @param prompt - Reminder content supplied at creation.
 * @param at - Explicit-offset instant or structured local calendar value.
 * @param now - Single rule-acceptance wall-clock sample in epoch milliseconds.
 * @param title - Required task name supplied at creation.
 * @returns Frozen durable absolute one-shot record.
 */
export function createAtScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  at: AtInput,
  now: number,
  title: string,
): AtScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }

  return Object.freeze({
    id,
    kind: 'at',
    title: scheduleTitle(title),
    prompt: normalizedPrompt,
    scheduledAt: futureInstant(parseAtInput(at), now),
  })
}

/**
 * Parse an absolute selector without requiring it to be future.
 * @param at - Explicit-offset instant or strict local calendar input.
 * @returns Resolved epoch milliseconds; malformed input throws ScheduleInputError.
 */
export function parseAtInput(at: AtInput): number {
  let target: number
  if (typeof at === 'string') {
    target = parseAtOffsetInstant(at)
  } else if (isRecord(at)) {
    if (!hasExactKeys(at, ['date', 'time', 'time_zone'])) {
      throw new ScheduleInputError('invalid_rule', 'Local at must contain exactly date, time, and time_zone.')
    }
    if (typeof at['date'] !== 'string' || typeof at['time'] !== 'string') {
      throw new ScheduleInputError('invalid_rule', 'Local at date and time must be strings.')
    }
    const rawTimeZone = at['time_zone']
    if (typeof rawTimeZone !== 'string') {
      throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
    }
    const local: LocalAtInput = {
      date: at['date'],
      time: at['time'],
      time_zone: rawTimeZone,
    }
    target = resolveLocalAt(parseLocalAt(local), canonicalizeTimeZone(rawTimeZone))
  } else {
    throw new ScheduleInputError('invalid_rule', 'at must be an explicit-offset string or local calendar object.')
  }

  return target
}

/**
 * Validate a fixed-rate selector and compute the first target of a new interval anchor.
 * @param id - Already allocated task id.
 * @param prompt - Reminder content supplied at creation.
 * @param everySeconds - Requested fixed safe-integer interval.
 * @param now - Single rule-acceptance wall-clock sample in epoch milliseconds.
 * @param title - Required task name supplied at creation.
 * @returns Frozen durable fixed-rate record.
 */
export function createEveryScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  everySeconds: number,
  now: number,
  title: string,
): EveryScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  if (!Number.isSafeInteger(everySeconds)) {
    throw new ScheduleInputError('invalid_rule', 'every_seconds must be a safe integer.')
  }
  if (everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
    throw new ScheduleInputError(
      'frequency_too_high',
      `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
    )
  }
  const interval = everySeconds * 1_000
  const target = now + interval
  return Object.freeze({
    id,
    kind: 'every',
    title: scheduleTitle(title),
    prompt: normalizedPrompt,
    everySeconds,
    scheduledAt: futureInstant(target, now),
  })
}

/**
 * Create a daily wall-clock rule with a strictly future committed UTC target.
 * @param id - Already allocated task identity.
 * @param prompt - Reminder content supplied at creation.
 * @param daily - Strict local time and explicit IANA zone.
 * @param now - Single rule-acceptance wall-clock sample in epoch milliseconds.
 * @param title - Required task name supplied at creation.
 * @returns Frozen daily record; absent future dates throw time_out_of_range.
 */
export function createDailyScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  daily: DailyInput,
  now: number,
  title: string,
): DailyScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  const { time, timeZone } = parseDailyInput(daily)
  if (!isFourDigitYearInstant(now)) {
    throw new ScheduleInputError('time_out_of_range', 'Daily creation time must be a representable four-digit-year UTC instant.')
  }
  const scheduledAt = nextDailyTarget(dailyTime(time), timeZone, now)
  if (scheduledAt === undefined) {
    throw new ScheduleInputError('time_out_of_range', 'No future daily occurrence is representable as a four-digit-year UTC instant.')
  }
  return Object.freeze({
    id, kind: 'daily', title: scheduleTitle(title), prompt: normalizedPrompt, time, timeZone, scheduledAt,
  })
}

/**
 * Normalize a daily selector without calculating a new committed target.
 * @param daily - Strict local time and explicit IANA zone.
 * @returns Normalized time and canonical zone; malformed input throws ScheduleInputError.
 */
export function parseDailyInput(daily: DailyInput): { readonly time: string; readonly timeZone: string } {
  if (!isRecord(daily) || !hasExactKeys(daily, ['time', 'time_zone']) || typeof daily['time'] !== 'string') {
    throw new ScheduleInputError(
      'invalid_rule', 'daily must contain exactly time and time_zone, with time HH:mm:ss and optional 1-3 fractional digits.',
    )
  }
  if (typeof daily['time_zone'] !== 'string') {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
  }
  return {
    time: dailyTime(daily['time']).toString({ fractionalSecondDigits: 3 }),
    timeZone: canonicalizeTimeZone(daily['time_zone']),
  }
}

/**
 * Create a weekly wall-clock rule with a strictly future committed UTC target.
 * @param id - Already allocated task identity.
 * @param prompt - Reminder content supplied at creation.
 * @param weekly - Strict local time, explicit IANA zone, and explicit ISO weekday set.
 * @param now - Single rule-acceptance wall-clock sample in epoch milliseconds.
 * @param title - Required task name supplied at creation.
 * @returns Frozen weekly record; absent future weekdays throw time_out_of_range.
 */
export function createWeeklyScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  weekly: WeeklyInput,
  now: number,
  title: string,
): WeeklyScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  const { time, timeZone, weekdays } = parseWeeklyInput(weekly)
  if (!isFourDigitYearInstant(now)) {
    throw new ScheduleInputError('time_out_of_range', 'Weekly creation time must be a representable four-digit-year UTC instant.')
  }
  const scheduledAt = nextWeeklyTarget(weeklyTime(time), timeZone, weekdays, now)
  if (scheduledAt === undefined) {
    throw new ScheduleInputError('time_out_of_range', 'No future weekly occurrence is representable as a four-digit-year UTC instant.')
  }
  return Object.freeze({
    id, kind: 'weekly', title: scheduleTitle(title), prompt: normalizedPrompt, time, timeZone,
    weekdays, scheduledAt,
  })
}

/**
 * Create a cron wall-clock rule with a strictly future committed UTC target.
 * @param id - Already allocated task identity.
 * @param prompt - Reminder content supplied at creation.
 * @param cron - Strict five-field expression and explicit IANA zone.
 * @param now - Single rule-acceptance wall-clock sample in epoch milliseconds.
 * @param title - Required task name supplied at creation.
 * @returns Frozen cron record; absent future occurrences throw time_out_of_range.
 */
export function createCronScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  cron: CronInput,
  now: number,
  title: string,
): CronScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  const { expression, timeZone } = parseCronInput(cron)
  if (!isFourDigitYearInstant(now)) {
    throw new ScheduleInputError('time_out_of_range', 'Cron creation time must be a representable four-digit-year UTC instant.')
  }
  const scheduledAt = readRecurrence(Cron.parse(expression, timeZone)).next(now)
  if (scheduledAt === undefined) {
    throw new ScheduleInputError('time_out_of_range', 'No future cron occurrence is representable as a four-digit-year UTC instant.')
  }
  return Object.freeze({
    id, kind: 'cron', title: scheduleTitle(title), prompt: normalizedPrompt, expression, timeZone, scheduledAt,
  })
}

/**
 * Normalize a weekly selector without calculating a new committed target.
 * @param weekly - Strict local time, explicit IANA zone, and explicit ISO weekday set.
 * @returns Normalized time, canonical zone, and unique ascending weekdays; malformed input throws ScheduleInputError.
 */
export function parseWeeklyInput(
  weekly: WeeklyInput,
): { readonly time: string; readonly timeZone: string; readonly weekdays: number[] } {
  if (!isRecord(weekly)
    || !hasExactKeys(weekly, ['time', 'time_zone', 'weekdays'])
    || typeof weekly['time'] !== 'string') {
    throw new ScheduleInputError(
      'invalid_rule',
      'weekly must contain exactly time, time_zone, and weekdays, with time HH:mm:ss and optional 1-3 fractional digits.',
    )
  }
  if (typeof weekly['time_zone'] !== 'string') {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
  }
  return {
    time: weeklyTime(weekly['time']).toString({ fractionalSecondDigits: 3 }),
    timeZone: canonicalizeTimeZone(weekly['time_zone']),
    weekdays: normalizeWeekdays(weekly['weekdays']),
  }
}

/** Map a shared time-parser reason into Schedule's public error vocabulary. */
function readRecurrence<T>(result: RecurrenceResult<T>): T {
  if (result.kind === 'accepted') return result.rule
  const codes = { syntax: 'invalid_rule', time_zone: 'invalid_time_zone', density: 'frequency_too_high' } as const
  throw new ScheduleInputError(codes[result.reason], result.detail, { cause: result.cause })
}

/**
 * Canonicalize one supported five-field Cron expression.
 * @param expression - Strict five-field input text.
 * @returns Canonical text preserving the Vixie day-matching semantics.
 */
export function canonicalizeCronExpression(expression: string): string {
  return readRecurrence(Cron.parse(expression, 'UTC')).expression
}

/**
 * Normalize a cron selector without calculating a new committed target.
 * @param cron - Strict five-field expression and explicit IANA zone.
 * @returns The canonical expression and canonical zone; malformed input throws ScheduleInputError.
 */
export function parseCronInput(cron: CronInput): { readonly expression: string; readonly timeZone: string } {
  if (!isRecord(cron) || !hasExactKeys(cron, ['expression', 'time_zone']) || typeof cron['expression'] !== 'string') {
    throw new ScheduleInputError(
      'invalid_rule', 'cron must contain exactly expression and time_zone, with a five-field cron expression.',
    )
  }
  if (typeof cron['time_zone'] !== 'string') {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
  }
  return {
    expression: canonicalizeCronExpression(cron['expression']),
    timeZone: canonicalizeTimeZone(cron['time_zone']),
  }
}

/** Fixed model-facing origin line shared by one-shot and recurring reminder delivery. */
const SCHEDULED_MESSAGE_FRAMING = 'This is a scheduled message from the user'

/**
 * Render the fixed model framing for one due reminder.
 * @param record - Due task identity, instruction, and delivered occurrence.
 * @returns Stable model-visible text with JSON-escaped dynamic fields.
 */
export function renderReminderFraming(
  record: { readonly id: ScheduleIdType; readonly prompt: string; readonly scheduledAt: string },
): string {
  return [
    '[SCHEDULE REMINDER]',
    SCHEDULED_MESSAGE_FRAMING,
    `schedule_id_json: ${JSON.stringify(record.id)}`,
    `occurrence_at: ${record.scheduledAt}`,
    `reminder_prompt_json: ${JSON.stringify(record.prompt)}`,
  ].join('\n')
}

/**
 * Render one recurring reminder batch in the supplied order.
 * @param reminders - Complete admitted batch with one latest occurrence per record.
 * @returns Stable model-visible text whose dynamic payload is canonical JSON.
 */
export function renderRecurringReminderBatchFraming(
  reminders: readonly {
    readonly record: { readonly id: ScheduleIdType; readonly prompt: string }
    readonly occurrenceAt: string
  }[],
): string {
  const payload = reminders.map(({ record, occurrenceAt }) => ({
    schedule_id: record.id,
    occurrence_at: occurrenceAt,
    reminder_prompt: record.prompt,
  }))
  return [
    '[SCHEDULE REMINDER BATCH]',
    SCHEDULED_MESSAGE_FRAMING,
    `reminders_json: ${JSON.stringify(payload)}`,
  ].join('\n')
}

/** Freeze a record whose scheduledAt is the first occurrence of a prepared rule strictly after a time. */
function firstRecord(id: ScheduleIdType, title: string, prompt: string, prepared: RRule, now: number): RRuleScheduleRecord {
  if (!isFourDigitYearInstant(now)) throw new ScheduleInputError('time_out_of_range', 'The recurrence reference time is outside the supported range.')
  const scheduledAt = prepared.next(now)
  if (scheduledAt === undefined) {
    throw new ScheduleInputError('not_future', 'rrule must contain an occurrence strictly in the future.')
  }
  return Object.freeze({ id, kind: 'rrule', title, prompt, rrule: prepared.expression, scheduledAt })
}

/**
 * Validate and normalize the supported RFC 5545 recurrence content.
 * @param value - Two-line DTSTART and RRULE input.
 * @returns The trimmed newline-separated recurrence; an unsupported rule throws ScheduleInputError.
 */
export function normalizeRRule(value: string): string {
  return readRecurrence(RRule.parse(value)).expression
}

/**
 * Create one Host task record with its first committed occurrence.
 * @param id - Host-allocated canonical schedule id.
 * @param title - User-facing schedule title.
 * @param prompt - Instruction delivered when the schedule fires.
 * @param rrule - DTSTART and RRULE content.
 * @param now - Exclusive creation-time lower bound in epoch milliseconds.
 * @returns Frozen schedule record.
 */
export function createRRuleScheduleRecord(
  id: ScheduleIdType,
  title: string,
  prompt: string,
  rrule: string,
  now: number,
): RRuleScheduleRecord {
  const normalizedTitle = scheduleTitle(title)
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  const prepared = readRecurrence(RRule.parse(rrule, { rejectIneffectiveSetPositions: true }))
  return firstRecord(id, normalizedTitle, normalizedPrompt, prepared, now)
}

/**
 * Update descriptive fields and optionally recompute the next occurrence.
 * @param current - Existing schedule record.
 * @param change - Supplied editable record fields.
 * @param now - Exclusive edit-time lower bound in epoch milliseconds.
 * @param recompute - Whether to derive a fresh next occurrence.
 * @returns Frozen updated schedule record.
 */
export function updateRRuleScheduleRecord(
  current: RRuleScheduleRecord,
  change: { readonly title?: string; readonly prompt?: string; readonly rrule?: string },
  now: number,
  recompute: boolean,
): RRuleScheduleRecord {
  const title = scheduleTitle(change.title ?? current.title)
  const prompt = (change.prompt ?? current.prompt).trim()
  if (prompt.length === 0) throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  const prepared = change.rrule === undefined
    ? readRecurrence(RRule.parse(current.rrule))
    : readRecurrence(RRule.parse(change.rrule, { rejectIneffectiveSetPositions: true }))
  if (recompute) return firstRecord(current.id, title, prompt, prepared, now)
  return Object.freeze({ ...current, title, prompt, rrule: prepared.expression })
}

/**
 * Resolve the latest due occurrence and the first later occurrence without replaying a backlog.
 * @param record - Due schedule record.
 * @param acceptedAt - Dispatch admission time in epoch milliseconds.
 * @returns Latest due occurrence and optional next occurrence.
 */
export function resolveRRuleOccurrence(record: RRuleScheduleRecord, acceptedAt: number): RecurringOccurrence {
  const decision = acceptedDecision('rrule', acceptedAt)
  const savedTarget = Date.parse(record.scheduledAt)
  if (decision < savedTarget) throw new ScheduleLogError('rrule dispatch cannot precede the active scheduledAt')
  return readRecurrence(RRule.parse(record.rrule)).resolve(record.scheduledAt, decision)
}

/**
 * Decode a current Host task record.
 * @param value - Untrusted durable JSON record.
 * @returns Detached frozen record; malformed fields throw ScheduleLogError.
 */
export function decodeRRuleScheduleRecord(value: unknown): RRuleScheduleRecord {
  if (!isRecord(value) || value['kind'] !== 'rrule' || !hasExactKeys(value, ['id', 'kind', 'title', 'prompt', 'rrule', 'scheduledAt'])) {
    throw new ScheduleLogError('rrule schedule must contain exactly id, kind, title, prompt, rrule, and scheduledAt')
  }
  const title = decodeStoredTitle(value['title'])
  const prompt = value['prompt']
  const rrule = value['rrule']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('schedule prompt must be non-empty and already trimmed')
  }
  if (typeof rrule !== 'string') throw new ScheduleLogError('schedule rrule must be a string')
  let normalized: string
  try {
    normalized = normalizeRRule(rrule)
  } catch (error: unknown) {
    throw new ScheduleLogError(`invalid schedule rrule: ${String(error)}`)
  }
  if (normalized !== rrule) throw new ScheduleLogError('schedule rrule must be normalized')
  return Object.freeze({
    id: decodeId(value['id']),
    kind: 'rrule',
    title,
    prompt,
    rrule,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/**
 * Render an instant in the authoritative zone of any timing kind; elapsed and absolute rules use UTC.
 * @param record - Timing record that owns the display zone.
 * @param instant - UTC instant to render with second precision.
 * @returns Local ISO date-time with its numeric offset.
 */
export function formatScheduleLocalTime(record: ScheduleRecord, instant: string): string {
  const timeZone = record.kind === 'rrule' ? readRecurrence(RRule.parse(record.rrule)).timeZone
    : 'timeZone' in record ? record.timeZone : 'UTC'
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone)
    .toString({ timeZoneName: 'never', smallestUnit: 'second' })
}
