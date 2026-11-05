/** Strict five-field Cron parsing and bounded, zone-aware occurrence arithmetic. */
import { Temporal } from '@js-temporal/polyfill'
import { MAX_FOUR_DIGIT_YEAR_MS, MIN_FOUR_DIGIT_YEAR_MS, canonicalizeTimeZone, isFourDigitYearInstant, resolveLocalInstant } from './instant.ts'
import { RecurrenceInputError, parseRecurrence, recurrenceDecision } from './recurrence.ts'
import type { RecurrenceOccurrence, RecurrenceResult } from './recurrence.ts'

/** Gregorian calendar repetition bounds both forward and backward searches. */
export const CRON_SEARCH_HORIZON_YEARS = 400

/** Project an explicit instant into a calendar date in the rule's zone. */
function localDate(epoch: number, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(epoch).toZonedDateTimeISO(timeZone).toPlainDate()
}

/** Recognize one of the rule's explicit ISO weekdays on a local calendar date. */
type WeekdayMatch = (date: Temporal.PlainDate) => boolean

/** Field bounds of the supported five-field cron dialect, in evaluation order. */
interface CronFieldSpec {
  /** Field name used in diagnostics. */
  readonly name: string
  /** Lowest value accepted in the input dialect. */
  readonly min: number
  /** Highest value accepted in the input dialect; Sunday accepts both 0 and 7. */
  readonly max: number
  /** Highest value retained after folding Sunday 7 onto 0. */
  readonly canonicalMax: number
}

const CRON_FIELDS: readonly [CronFieldSpec, CronFieldSpec, CronFieldSpec, CronFieldSpec, CronFieldSpec] = [
  { name: 'minute', min: 0, max: 59, canonicalMax: 59 },
  { name: 'hour', min: 0, max: 23, canonicalMax: 23 },
  { name: 'day-of-month', min: 1, max: 31, canonicalMax: 31 },
  { name: 'month', min: 1, max: 12, canonicalMax: 12 },
  { name: 'day-of-week', min: 0, max: 7, canonicalMax: 6 },
]

/** One parsed cron field: its matched values, canonical spelling, and Vixie star flag. */
interface ParsedCronField {
  /** Unique ascending matched values after Sunday folding. */
  readonly values: readonly number[]
  /** Canonical spelling of exactly those values. */
  readonly canonical: string
  /** Whether the field text starts with `*`, which is Vixie's DOM_STAR/DOW_STAR test. */
  readonly star: boolean
}

/** Build the stable diagnostic for one malformed cron field element. */
function invalidCronField(spec: CronFieldSpec, element: string): RecurrenceInputError {
  return new RecurrenceInputError(
    'syntax',
    `cron.expression ${spec.name} field element ${JSON.stringify(element)} must be *, a value, a-b, */n, a-b/n, `
    + 'or a comma-separated list of those.',
  )
}

/** Read one in-range cron field value. */
function cronFieldValue(text: string, spec: CronFieldSpec): number {
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw new RecurrenceInputError(
      'syntax',
      `cron.expression ${spec.name} field value ${text} is outside ${spec.min}-${spec.max}.`,
    )
  }
  return value
}

/** Read one positive cron field step. */
function cronFieldStep(text: string, spec: CronFieldSpec): number {
  const step = Number(text)
  if (!Number.isSafeInteger(step) || step < 1) {
    throw new RecurrenceInputError('syntax', `cron.expression ${spec.name} field step must be a positive integer.`)
  }
  return step
}

/** Expand one comma-separated cron field into its matched value set. */
function cronFieldValues(raw: string, spec: CronFieldSpec): number[] {
  const matched = new Set<number>()
  for (const element of raw.split(',')) {
    if (element.length === 0) {
      throw new RecurrenceInputError(
        'syntax', `cron.expression ${spec.name} field must not contain an empty list element.`,
      )
    }
    if (element === '*') {
      for (let value = spec.min; value <= spec.max; value += 1) matched.add(value)
      continue
    }
    if (element.startsWith('*')) {
      const stepped = /^\*\/(?<step>\d+)$/.exec(element)
      const groups = stepped?.groups
      if (groups === undefined) throw invalidCronField(spec, element)
      const stepText = groups['step']
      /* v8 ignore next -- a successful fixed regex always provides the step group. */
      if (stepText === undefined) throw invalidCronField(spec, element)
      const step = cronFieldStep(stepText, spec)
      for (let value = spec.min; value <= spec.max; value += step) matched.add(value)
      continue
    }
    const parsed = /^(?<start>\d+)(?:-(?<end>\d+))?(?:\/(?<step>\d+))?$/.exec(element)
    const groups = parsed?.groups
    if (groups === undefined) throw invalidCronField(spec, element)
    const startText = groups['start']
    /* v8 ignore next -- a successful fixed regex always provides the start group. */
    if (startText === undefined) throw invalidCronField(spec, element)
    const start = cronFieldValue(startText, spec)
    const end = groups['end']
    const stepText = groups['step']
    if (end === undefined) {
      if (stepText !== undefined) throw invalidCronField(spec, element)
      matched.add(start)
      continue
    }
    const last = cronFieldValue(end, spec)
    if (start > last) {
      throw new RecurrenceInputError(
        'syntax', `cron.expression ${spec.name} field range ${start}-${last} is inverted.`,
      )
    }
    const step = stepText === undefined ? 1 : cronFieldStep(stepText, spec)
    for (let value = start; value <= last; value += step) matched.add(value)
  }
  const values = new Set<number>()
  for (const value of matched) {
    values.add(spec.canonicalMax !== spec.max && value === spec.max ? spec.min : value)
  }
  return [...values].sort((left, right) => left - right)
}

/**
 * Read one value the encoder already proved present.
 * @param values - matched value set the parser always fills.
 * @param index - index the caller derived from that set.
 * @returns the value at that index.
 */
function cronFieldValueAt(values: readonly number[], index: number): number {
  const value = values[index]
  /* v8 ignore next -- a parsed cron field always matches at least one value. */
  if (value === undefined) throw new Error('cron field encoding requires a non-empty value set')
  return value
}

/** Encode one matched value set as the shortest equivalent comma-separated cron field.
 * @param values - Matched values in ascending order.
 * @returns Field text that re-parses to exactly `values`, never spelled with a leading `*`.
 */
function encodeCronField(values: readonly number[]): string {
  const first = cronFieldValueAt(values, 0)
  if (values.length === 1) return String(first)
  const last = cronFieldValueAt(values, values.length - 1)
  const step = cronFieldValueAt(values, 1) - first
  let uniform = true
  for (let index = 2; index < values.length; index += 1) {
    if (cronFieldValueAt(values, index) - cronFieldValueAt(values, index - 1) !== step) {
      uniform = false
      break
    }
  }
  if (uniform) {
    if (step === 1) return `${first}-${last}`
    return `${first}-${last}/${step}`
  }
  const parts: string[] = []
  let runStart = first
  for (let index = 1; index < values.length; index += 1) {
    const current = cronFieldValueAt(values, index)
    const previous = cronFieldValueAt(values, index - 1)
    if (current === previous + 1) continue
    parts.push(runStart === previous ? String(runStart) : `${runStart}-${previous}`)
    runStart = current
  }
  const final = cronFieldValueAt(values, values.length - 1)
  parts.push(runStart === final ? String(runStart) : `${runStart}-${final}`)
  return parts.join(',')
}

/**
 * One uniform walk from a field's minimum, folded exactly as a parsed field folds.
 * @param spec - Field range and canonical maximum.
 * @param step - Positive step of the walk.
 * @returns Ascending values `step` produces from the minimum.
 */
function starWalk(spec: CronFieldSpec, step: number): number[] {
  const walked = new Set<number>()
  for (let value = spec.min; value <= spec.max; value += step) {
    walked.add(spec.canonicalMax !== spec.max && value === spec.max ? spec.min : value)
  }
  return [...walked].sort((left, right) => left - right)
}

/**
 * Canonical spelling of a field whose text started with `*`.
 *
 * Only a `*`-prefixed spelling keeps the star flag, and only the bare star or a star-step
 * (a `*` followed by `/n`) admits a leading `*`, so the encoding is the bare star for every
 * value, otherwise the widest star-step walk plus any remaining values as a list.
 * Re-parsing therefore reproduces both the star flag and the matched set, which is what
 * keeps day-of-month/day-of-week AND/OR selection stable across a stored canonical
 * expression.
 * @param values - Matched values in ascending order.
 * @param spec - Field range and canonical maximum.
 * @returns Canonical field text that starts with `*`.
 */
function encodeStarCronField(values: readonly number[], spec: CronFieldSpec): string {
  if (values.length === spec.canonicalMax - spec.min + 1) return '*'
  const present = new Set(values)
  let bestStep: number | undefined
  let bestWalk: number[] = []
  for (let step = 1; step <= spec.max - spec.min + 1; step += 1) {
    const walk = starWalk(spec, step)
    if (walk.length > bestWalk.length && walk.every(value => present.has(value))) {
      bestStep = step
      bestWalk = walk
    }
  }
  /* v8 ignore next -- the widest step yields the single minimum, which every `*`-led field matches. */
  if (bestStep === undefined) throw new RecurrenceInputError('syntax', `${spec.name} cannot keep a leading \`*\`.`)
  const walked = new Set(bestWalk)
  const remaining = values.filter(value => !walked.has(value))
  const walkText = `*/${bestStep}`
  return remaining.length === 0
    ? walkText
    : `${walkText},${encodeCronField(remaining)}`
}

/**
 * Parse one cron field into its matched values, canonical spelling, and star flag.
 *
 * The star flag tests the field text's first character, which is how Vixie sets
 * `DOM_STAR`/`DOW_STAR`: a stepped star (`*` followed by `/2`) is a star although
 * it matches half the range, while an explicit full range such as `1-31` is
 * restricted. Canonicalization preserves the flag: a `*`-led field keeps a `*`-led
 * spelling, and a field that did not start with `*` is never spelled as a star-step.
 */
function parseCronField(raw: string, spec: CronFieldSpec): ParsedCronField {
  const values = cronFieldValues(raw, spec)
  const star = raw.startsWith('*')
  return Object.freeze({
    values: Object.freeze(values),
    canonical: star ? encodeStarCronField(values, spec) : encodeCronField(values),
    star,
  })
}

/** Parsed five-field cron rule: canonical text plus every field's matched values. */
export interface CronFields {
  /** Canonical expression stored in the durable record. */
  readonly expression: string
  /** Unique ascending matched minutes. */
  readonly minutes: readonly number[]
  /** Unique ascending matched hours. */
  readonly hours: readonly number[]
  /** Unique ascending matched days of the month. */
  readonly daysOfMonth: readonly number[]
  /** Unique ascending matched months. */
  readonly months: readonly number[]
  /** Unique ascending matched cron weekdays, Sunday 0 through Saturday 6. */
  readonly daysOfWeek: readonly number[]
  /** Whether the day-of-month field text starts with `*` (Vixie `DOM_STAR`). */
  readonly dayOfMonthStar: boolean
  /** Whether the day-of-week field text starts with `*` (Vixie `DOW_STAR`). */
  readonly dayOfWeekStar: boolean
}

/** Parse and canonicalize one strict five-field cron expression. */
function parseCronExpression(expression: string): CronFields {
  if (typeof expression !== 'string' || expression.length === 0 || expression.trim() !== expression) {
    throw new RecurrenceInputError('syntax', 'cron.expression must be a non-empty trimmed string.')
  }
  const fields = expression.split(/\s+/)
  if (fields.length !== 5) {
    throw new RecurrenceInputError(
      'syntax',
      'cron.expression must contain exactly five whitespace-separated fields: '
      + 'minute hour day-of-month month day-of-week.',
    )
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map(
    (field, index) => {
      const fieldSpec = CRON_FIELDS[index]
      /* v8 ignore next -- the five-field split bounds this index. */
      if (fieldSpec === undefined) throw new Error('cron field specification is missing')
      return parseCronField(field, fieldSpec)
    },
  ) as [ParsedCronField, ParsedCronField, ParsedCronField, ParsedCronField, ParsedCronField]
  return Object.freeze({
    expression: [minute, hour, dayOfMonth, month, dayOfWeek].map(field => field.canonical).join(' '),
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek: dayOfWeek.values,
    dayOfMonthStar: dayOfMonth.star,
    dayOfWeekStar: dayOfWeek.star,
  })
}

/**
 * Build the local-date predicate of one parsed cron rule under Vixie day-of-month/day-of-week semantics.
 *
 * The star flag selects the branch only; it never excuses a field's matched values.
 * When either field text starts with `*`, a local date must satisfy BOTH fields, so a
 * stepped star such as `*` followed by `/2` still restricts the dates it matches. A bare
 * `*` matches every value, which makes that field's match always true and degrades the
 * AND to the other field, exactly like Vixie's `DOM_STAR`/`DOW_STAR` test. Only when
 * neither field text starts with `*` does either field matching suffice.
 * @param parsed - Parsed cron rule with canonical field text and matched values.
 * @returns Whether one local date matches the rule.
 */
function cronDateMatch(parsed: CronFields): WeekdayMatch {
  const months = new Set(parsed.months)
  const daysOfMonth = new Set(parsed.daysOfMonth)
  const daysOfWeek = new Set(parsed.daysOfWeek)
  const dayOfMonthRestricted = !parsed.dayOfMonthStar
  const dayOfWeekRestricted = !parsed.dayOfWeekStar
  return (date) => {
    /* v8 ignore next -- both callers pre-filter by month before matching a date. */
    if (!months.has(date.month)) return false
    const dayOfMonth = daysOfMonth.has(date.day)
    const dayOfWeek = daysOfWeek.has(date.dayOfWeek % 7)
    if (dayOfMonthRestricted && dayOfWeekRestricted) return dayOfMonth || dayOfWeek
    return dayOfMonth && dayOfWeek
  }
}

/** Enumerate local minutes of day without constructing unvisited calendar values. */
function* cronTimes(parsed: CronFields, reverse = false): Generator<number> {
  const hours = reverse ? parsed.hours.toReversed() : parsed.hours
  const minutes = reverse ? parsed.minutes.toReversed() : parsed.minutes
  for (const hour of hours) {
    for (const minute of minutes) yield hour * 60 + minute
  }
}

/**
 * Find the first strictly future cron occurrence without leaving the four-digit UTC year range.
 *
 * The walk stops at {@link CRON_SEARCH_HORIZON_YEARS} past the floor date when that
 * horizon precedes the four-digit ceiling: a rule with no match inside the horizon
 * never matches, so its search resolves to exhaustion instead of scanning to the ceiling.
 * @param parsed - Parsed cron rule.
 * @param timeZone - Explicit zone interpreting its local date and time.
 * @param floor - Instant every returned target must exceed.
 * @returns The first matching target, or exhaustion as undefined.
 */
function nextCronTarget(parsed: CronFields, timeZone: string, floor: number): string | undefined {
  const matches = cronDateMatch(parsed)
  const months = new Set(parsed.months)
  const localFloor = Temporal.Instant.fromEpochMilliseconds(floor).toZonedDateTimeISO(timeZone)
  const firstDate = localFloor.toPlainDate()
  let date = firstDate
  // The floor's own local wall clock, so the first date converts only candidates
  // that can exceed it instead of its whole day of times.
  const floorMinute = localFloor.hour * 60 + localFloor.minute
  const ceiling = localDate(MAX_FOUR_DIGIT_YEAR_MS, 'UTC').add({ days: 1 })
  const horizon = date.add({ years: CRON_SEARCH_HORIZON_YEARS })
  const lastDate = Temporal.PlainDate.compare(horizon, ceiling) < 0 ? horizon : ceiling
  while (Temporal.PlainDate.compare(date, lastDate) <= 0) {
    if (!months.has(date.month)) {
      date = date.add({ months: 1 }).with({ day: 1 })
      continue
    }
    if (matches(date)) {
      for (const minute of cronTimes(parsed)) {
        if (date.equals(firstDate) && minute < floorMinute) continue
        const target = resolveLocalInstant(date.toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 }), timeZone)
        if (target === undefined) continue
        if (target > MAX_FOUR_DIGIT_YEAR_MS) return undefined
        if (target >= MIN_FOUR_DIGIT_YEAR_MS && target > floor) return new Date(target).toISOString()
      }
    }
    date = date.add({ days: 1 })
  }
  return undefined
}

/**
 * Find the latest matching cron occurrence at or before a decision without leaving the committed floor.
 *
 * The walk stops at {@link CRON_SEARCH_HORIZON_YEARS} before the decision date when that
 * horizon follows the four-digit floor, which is the local date holding that floor instant
 * in the rule's own zone: a rule with no match inside the horizon keeps the committed target
 * instead of scanning back to the floor, and a candidate before the floor instant is skipped.
 * @param parsed - Parsed cron rule.
 * @param timeZone - Explicit zone interpreting its local date and time.
 * @param decision - Wall-clock decision time in epoch milliseconds.
 * @param savedTarget - Committed target that stays due even when current zone data resolves past it.
 * @returns The latest due occurrence, or the committed target when no local occurrence is representable.
 */
function latestCronOccurrence(
  parsed: CronFields,
  timeZone: string,
  decision: number,
  savedTarget: number,
): number {
  const matches = cronDateMatch(parsed)
  const months = new Set(parsed.months)
  // Offsets are less than 24 hours; a date-line rollback can make a due local date
  // later than the UTC decision date, which is why the walk starts one day after it.
  let date = localDate(decision, 'UTC').add({ days: 1 })
  // The floor is an instant: the earliest local date the walk may reach is the one
  // holding it in the rule's own zone, and candidates below it are skipped, so a
  // negative offset can still resolve a due local minute dated before the UTC floor.
  const floorDate = localDate(MIN_FOUR_DIGIT_YEAR_MS, timeZone)
  const horizon = date.subtract({ years: CRON_SEARCH_HORIZON_YEARS })
  const firstDate = Temporal.PlainDate.compare(horizon, floorDate) > 0 ? horizon : floorDate
  while (Temporal.PlainDate.compare(date, firstDate) >= 0) {
    if (!months.has(date.month)) {
      date = date.with({ day: 1 }).subtract({ days: 1 })
      continue
    }
    if (matches(date)) {
      // One conversion of the date's earliest wall clock decides whether the whole
      // date lies beyond the decision: every later time on it is later too, so the
      // walk steps back instead of converting the rest of a day that cannot match.
      // An earliest time that a DST gap removes leaves the bound to the first time
      // that does exist, and a date with no existing time keeps the full walk.
      let earliest: number | undefined
      for (const minute of cronTimes(parsed)) {
        earliest = resolveLocalInstant(date.toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 }), timeZone)
        if (earliest !== undefined) break
      }
      if (earliest !== undefined && earliest > decision) {
        date = date.subtract({ days: 1 })
        continue
      }
      for (const minute of cronTimes(parsed, true)) {
        const candidate = resolveLocalInstant(date.toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 }), timeZone)
        if (candidate === undefined || candidate > decision || candidate < MIN_FOUR_DIGIT_YEAR_MS) continue
        // A committed target remains due even if current tzdata places the rule before it.
        return Math.max(candidate, savedTarget)
      }
    }
    date = date.subtract({ days: 1 })
  }
  return savedTarget
}


/** Parsed Cron value; expression and zone stay authoritative independently of any task. */
export class Cron {
  private constructor(private readonly parsed: CronFields, readonly timeZone: string) {}

  /** Immutable matched fields and canonical text for consumers such as rule descriptions. */
  get fields(): CronFields { return this.parsed }

  /** Canonical five-field expression, preserving Vixie star semantics. */
  get expression(): string { return this.parsed.expression }

  /**
   * Parse one five-field expression and its explicit IANA zone.
   * @param expression - Five numeric Cron fields with Vixie day matching.
   * @param timeZone - UTC or an IANA Area/Location zone.
   * @returns A parsed value, or a syntax/zone refusal without task policy.
   */
  static parse(expression: string, timeZone: string): RecurrenceResult<Cron> {
    return parseRecurrence(() => {
      const parsed = parseCronExpression(expression)
      const zone = canonicalizeTimeZone(timeZone)
      if (zone.kind === 'rejected') throw new RecurrenceInputError('time_zone', 'Cron requires a valid UTC or IANA Area/Location zone.', { cause: zone })
      const rule = new Cron(parsed, zone.timeZone)
      Object.freeze(rule)
      return rule
    })
  }

  /**
   * First strictly future occurrence, skipping gaps and choosing the earlier overlap.
   * @param after - Representable epoch milliseconds that the occurrence must exceed.
   * @returns The UTC occurrence, or exhaustion of the bounded search.
   */
  next(after: number): string | undefined {
    if (!isFourDigitYearInstant(after)) throw new RangeError('Cron lower bound must be a four-digit-year instant')
    return nextCronTarget(this.parsed, this.timeZone, after)
  }

  /**
   * Latest due occurrence and first future occurrence, without replaying a backlog.
   * @param scheduledAt - Canonical four-digit-year UTC occurrence with milliseconds, retained across zone-data changes.
   * @param acceptedAt - Representable decision time at or after that occurrence.
   * @returns The latest due occurrence and optional future successor.
   * @throws RangeError when either instant is invalid or the decision precedes the committed occurrence.
   */
  resolve(scheduledAt: string, acceptedAt: number): RecurrenceOccurrence {
    const savedTarget = recurrenceDecision(scheduledAt, acceptedAt)
    const occurrenceAt = new Date(latestCronOccurrence(this.parsed, this.timeZone, acceptedAt, savedTarget)).toISOString()
    const nextScheduledAt = this.next(acceptedAt)
    return Object.freeze(nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt })
  }
}
