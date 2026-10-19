/**
 * Strict instant and local-calendar vocabulary for the boundaries that accept a
 * wall-clock selector.
 *
 * Every entry that reads untrusted text answers a discriminated result instead
 * of throwing: the library carries no failure vocabulary, and each caller maps
 * a reason onto its own domain code and diagnostic. `formatFourDigitYearInstant`
 * and `isFourDigitYearInstant` never throw, while `resolveLocalInstant` raises a
 * `RangeError` when a caller violates its precondition — an unknown zone, or
 * calendar fields naming a value the calendar does not have. Local wall-clock
 * resolution uses the maintained `Temporal` implementation, so no caller owns
 * offset sampling or DST rules.
 * @module @deepseek-ai/dsh-util-time
 */

import { Temporal } from '@js-temporal/polyfill'

/** Inclusive lower epoch-millisecond bound of a four-digit-year RFC 3339 UTC instant. */
export const MIN_FOUR_DIGIT_YEAR_MS = Date.parse('0001-01-01T00:00:00.000Z')

/** Inclusive upper epoch-millisecond bound of a four-digit-year RFC 3339 UTC instant. */
export const MAX_FOUR_DIGIT_YEAR_MS = Date.parse('9999-12-31T23:59:59.999Z')

/** Canonical four-digit-year RFC 3339 UTC instant with mandatory milliseconds. */
const UTC_INSTANT =
  /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/

/** RFC 3339 instant with mandatory date, time, and explicit zone; fraction is optional. */
const OFFSET_INSTANT = new RegExp(
  String.raw`^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})`
  + String.raw`T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})`
  + String.raw`(?:\.(?<fraction>\d{1,3}))?(?<zone>Z|(?<sign>[+-])`
  + String.raw`(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$`,
)

/** Four-digit ISO calendar date. */
const LOCAL_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/

/** Local wall-clock time with optional one-to-three digit fractional seconds. */
const LOCAL_TIME = /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?$/

/** Strict browser-zone profile: UTC or an IANA Area/Location-style identifier. */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/** Exact calendar fields of one local wall-clock value. */
export interface LocalCalendarTime {
  /**
   * Year of the calendar date. `parseLocalCalendar` rejects year 0 in untrusted
   * text; `resolveLocalInstant` accepts any year a real `Temporal` date carries,
   * so a caller that needs the four-digit bound filters the answered epoch.
   */
  readonly year: number
  /** Month from 1 through 12. */
  readonly month: number
  /** Day of month from 1 through the month's length. */
  readonly day: number
  /** Hour from 0 through 23. */
  readonly hour: number
  /** Minute from 0 through 59. */
  readonly minute: number
  /** Second from 0 through 59; leap seconds are rejected. */
  readonly second: number
  /** Millisecond from 0 through 999. */
  readonly millisecond: number
}

/** Why an RFC 3339 instant string is unusable. */
export type InstantRejection =
  | 'not_rfc3339'
  /** A field outside its calendar range: year 0, or an hour, minute, or second above its maximum. */
  | 'out_of_range'
  | 'not_a_calendar_date'
  | 'invalid_numeric_offset'

/** Why a local calendar selector is unusable. */
export type LocalCalendarRejection = 'malformed' | 'out_of_range' | 'not_a_calendar_date'

/** Why one IANA zone selector is unusable. */
export type TimeZoneRejection =
  | 'blank'
  | 'padded'
  | 'not_area_location'
  | 'unsupported'
  | 'not_canonical_shape'

/** Discriminated result of parsing one RFC 3339 instant string. */
export type InstantResult =
  | { readonly kind: 'accepted'; readonly epoch: number }
  | { readonly kind: 'rejected'; readonly reason: InstantRejection }

/** Discriminated result of parsing one local calendar selector. */
export type LocalCalendarResult =
  | { readonly kind: 'accepted'; readonly time: LocalCalendarTime }
  | { readonly kind: 'rejected'; readonly reason: LocalCalendarRejection }

/** Discriminated result of resolving one raw IANA zone selector. */
export type TimeZoneResult =
  | { readonly kind: 'accepted'; readonly timeZone: string }
  | {
    readonly kind: 'rejected'
    readonly reason: TimeZoneRejection
    /** Platform error caught while resolving the name; present when the platform refused a well-formed one. */
    readonly cause?: unknown
  }

/** Reject with one stable reason. */
function rejected<Reason extends string>(reason: Reason): { kind: 'rejected'; reason: Reason } {
  return Object.freeze({ kind: 'rejected', reason } as const)
}

/** Read one required named regular-expression group as a number. */
function groupNumber(groups: Record<string, string | undefined>, name: string): number {
  const value = groups[name]
  /* v8 ignore next -- a successful fixed regex always provides every requested group. */
  if (value === undefined) throw new TypeError(`missing required regex group ${name}`)
  return Number(value)
}

/** Normalize an optional one-to-three digit fractional second to milliseconds. */
function fractionalMilliseconds(value: string | undefined): number {
  return value === undefined ? 0 : Number(value.padEnd(3, '0'))
}

/** Whether an integral epoch is inside the four-digit-year range. */
function inFourDigitYearRange(epoch: number): boolean {
  return Number.isSafeInteger(epoch) && epoch >= MIN_FOUR_DIGIT_YEAR_MS && epoch <= MAX_FOUR_DIGIT_YEAR_MS
}

/**
 * Build one plain date-time while refusing a date the calendar does not have.
 *
 * Every field is already range-checked by the caller, so the only refusal left
 * is a non-existent calendar date such as February 30.
 * @param time - Calendar fields with every numeric field in range.
 * @returns The plain date-time, or `undefined` when the date does not exist.
 */
function plainDateTime(time: LocalCalendarTime): Temporal.PlainDateTime | undefined {
  try {
    return Temporal.PlainDateTime.from(time, { overflow: 'reject' })
  } catch (error: unknown) {
    /* v8 ignore next -- a rejected overflow answers a RangeError, so the false path is unreachable. */
    if (error instanceof RangeError) return undefined
    /* v8 ignore next -- reached only when Temporal throws something other than a RangeError. */
    throw error
  }
}

/**
 * Read one local calendar selector strictly, without consulting a process zone.
 *
 * The date and time texts are matched separately, so a malformed spelling, a
 * non-existent calendar date such as February 30, and an out-of-range clock
 * field answer distinct reasons.
 * @param date - Candidate `YYYY-MM-DD` date text.
 * @param time - Candidate `HH:mm:ss` time text with optional 1-3 fractional digits.
 * @returns The parsed calendar fields, or the reason they are unusable.
 */
export function parseLocalCalendar(date: string, time: string): LocalCalendarResult {
  const dateMatch = LOCAL_DATE.exec(date)
  const timeMatch = LOCAL_TIME.exec(time)
  const dateGroups = dateMatch?.groups
  const timeGroups = timeMatch?.groups
  if (dateGroups === undefined || timeGroups === undefined) return rejected('malformed')
  const parts: LocalCalendarTime = {
    year: groupNumber(dateGroups, 'year'),
    month: groupNumber(dateGroups, 'month'),
    day: groupNumber(dateGroups, 'day'),
    hour: groupNumber(timeGroups, 'hour'),
    minute: groupNumber(timeGroups, 'minute'),
    second: groupNumber(timeGroups, 'second'),
    millisecond: fractionalMilliseconds(timeGroups['fraction']),
  }
  if (parts.year === 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    return rejected('out_of_range')
  }
  if (plainDateTime(parts) === undefined) return rejected('not_a_calendar_date')
  return Object.freeze({ kind: 'accepted', time: parts })
}

/**
 * Parse one RFC 3339 instant whose numeric offset is part of the input.
 *
 * A bare `Z` and an explicit numeric offset are both accepted, and the offset is
 * subtracted from the local wall-clock value. A negative zero offset, an offset
 * whose hour or minute is out of range, and a non-existent calendar date are refused.
 * @param value - Candidate instant text.
 * @returns The resolved epoch milliseconds, or the reason the text is unusable.
 */
export function parseOffsetInstant(value: string): InstantResult {
  const groups = OFFSET_INSTANT.exec(value)?.groups
  if (groups === undefined) return rejected('not_rfc3339')
  const parts: LocalCalendarTime = {
    year: groupNumber(groups, 'year'),
    month: groupNumber(groups, 'month'),
    day: groupNumber(groups, 'day'),
    hour: groupNumber(groups, 'hour'),
    minute: groupNumber(groups, 'minute'),
    second: groupNumber(groups, 'second'),
    millisecond: fractionalMilliseconds(groups['fraction']),
  }
  if (parts.year === 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    return rejected('out_of_range')
  }
  const local = plainDateTime(parts)
  if (local === undefined) return rejected('not_a_calendar_date')
  const localEpoch = local.toZonedDateTime('UTC').epochMilliseconds
  if (groups['zone'] === 'Z') return Object.freeze({ kind: 'accepted', epoch: localEpoch })
  const offsetHour = groupNumber(groups, 'offsetHour')
  const offsetMinute = groupNumber(groups, 'offsetMinute')
  if (offsetHour > 23 || offsetMinute > 59
    || (groups['sign'] === '-' && offsetHour === 0 && offsetMinute === 0)) {
    return rejected('invalid_numeric_offset')
  }
  const direction = groups['sign'] === '+' ? 1 : -1
  return Object.freeze({
    kind: 'accepted',
    epoch: localEpoch - direction * (offsetHour * 60 + offsetMinute) * 60_000,
  })
}

/**
 * Validate one canonical four-digit-year RFC 3339 UTC instant.
 *
 * The accepted profile carries exactly three fractional digits and a `Z`, and
 * every year from 0001 through 9999 whose calendar date exists is representable.
 * @param value - Untrusted candidate instant.
 * @returns The epoch milliseconds, or the reason the text is not the canonical profile.
 */
export function fourDigitYearEpoch(value: string): InstantResult {
  if (!UTC_INSTANT.test(value)) return rejected('not_rfc3339')
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || !inFourDigitYearRange(epoch) || new Date(epoch).toISOString() !== value) {
    return rejected('not_a_calendar_date')
  }
  return Object.freeze({ kind: 'accepted', epoch })
}

/**
 * Whether an epoch is representable as a canonical four-digit-year RFC 3339 UTC instant.
 *
 * Callers that only need the bound use this instead of re-deriving it from the
 * two constants, so the range has one owner.
 * @param epoch - Candidate epoch milliseconds.
 * @returns Whether the epoch is a safe integer inside the four-digit-year range.
 */
export function isFourDigitYearInstant(epoch: number): boolean {
  return inFourDigitYearRange(epoch)
}

/**
 * Format one epoch as the canonical four-digit-year RFC 3339 UTC instant.
 *
 * The bound check runs first, so a caller that also compares the result with a
 * decision time never formats an unrepresentable instant.
 * @param epoch - Candidate epoch milliseconds; a non-integral value is unrepresentable.
 * @returns The canonical instant text, or `undefined` when the epoch is unrepresentable.
 */
export function formatFourDigitYearInstant(epoch: number): string | undefined {
  if (!inFourDigitYearRange(epoch)) return undefined
  const instant = new Date(epoch).toISOString()
  /* v8 ignore next -- an in-range integral Date always formats as the canonical UTC profile. */
  if (!UTC_INSTANT.test(instant)) return undefined
  return instant
}

/**
 * Validate and canonicalize one raw IANA zone selector.
 *
 * A zone identity is stored on durable records and resolved again by another
 * process, so an alias is answered by its platform-canonical name. Abbreviations,
 * numeric offsets, single-segment names, and unknown names are refused.
 * @param value - Candidate `UTC` or IANA Area/Location name.
 * @returns The canonical zone, or the reason the name is unusable.
 */
export function canonicalizeTimeZone(value: string): TimeZoneResult {
  if (value.length === 0) return rejected('blank')
  if (value.trim() !== value) return rejected('padded')
  if (value !== 'UTC' && !IANA_TIME_ZONE.test(value)) return rejected('not_area_location')
  let canonical: string
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch (error: unknown) {
    // Intl rejects a well-formed name the platform's IANA data does not know;
    // the caught error is the caller's only evidence for its own diagnostic.
    return Object.freeze({ kind: 'rejected', reason: 'unsupported', cause: error } as const)
  }
  /* v8 ignore next -- Intl answers UTC or a canonical IANA Area/Location for every accepted name. */
  if (canonical !== 'UTC' && !IANA_TIME_ZONE.test(canonical)) return rejected('not_canonical_shape')
  return Object.freeze({ kind: 'accepted', timeZone: canonical })
}

/**
 * Resolve one local wall-clock value in an explicit zone.
 *
 * A value inside a forward transition's gap does not exist, so it answers
 * `undefined`; a value inside an overlap resolves to the earlier instant, which
 * is the same choice the maintained `Temporal` implementation makes.
 * @param time - Exact calendar fields of a real date, or an already-built plain date-time.
 * @param timeZone - Already-canonical `UTC` or IANA zone.
 * @returns The resolved epoch milliseconds, or `undefined` for a nonexistent wall-clock time.
 * @throws RangeError when `timeZone` is not a known zone or the calendar value does not exist.
 */
export function resolveLocalInstant(
  time: LocalCalendarTime | Temporal.PlainDateTime,
  timeZone: string,
): number | undefined {
  // A caller walking candidate dates already holds an instance, and `from` copies it.
  const local = time instanceof Temporal.PlainDateTime
    ? time
    : Temporal.PlainDateTime.from(time, { overflow: 'reject' })
  const zoned = local.toZonedDateTime(timeZone, { disambiguation: 'earlier' })
  return zoned.toPlainDateTime().equals(local) ? zoned.epochMilliseconds : undefined
}
