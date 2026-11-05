/**
 * Time vocabulary shared by the boundaries that accept a caller's zone or a
 * wall-clock selector, elapsed span, or bounded Cron/RRULE recurrence.
 *
 * The library validates, canonicalizes, parses, and renders one canonical instant
 * format; it produces no model-facing text and owns no failure vocabulary. A refusal that carries a
 * reason is a discriminated result, and each caller maps that reason onto its
 * own domain code and diagnostic. `canonicalClientTimeZone` is the wire-boundary
 * form and answers a name or `undefined`; `formatFourDigitYearInstant` and
 * `resolveLocalInstant` take already-validated values and answer a string or
 * epoch milliseconds directly; `Duration` holds a span in milliseconds with no
 * implicit numeric conversion. Cron and RRule parse distinct recurrence types
 * and compute occurrences from explicit times without task state or timers.
 * @module @deepseek-ai/dsh-util-time
 */

import { canonicalizeTimeZone } from './instant.ts'

export { Duration } from './duration.ts'
export {
  MAX_FOUR_DIGIT_YEAR_MS,
  MIN_FOUR_DIGIT_YEAR_MS,
  canonicalizeTimeZone,
  formatFourDigitYearInstant,
  fourDigitYearEpoch,
  isFourDigitYearInstant,
  parseLocalCalendar,
  parseOffsetInstant,
  resolveLocalInstant,
} from './instant.ts'
export type { InstantRejection, LocalCalendarRejection, LocalCalendarTime, TimeZoneRejection } from './instant.ts'

/**
 * Validate and canonicalize one caller-supplied IANA zone at a wire boundary.
 *
 * The canonical name is what a later reader needs: a zone identity is stored on
 * durable records and resolved again by another process, so an alias accepted
 * here would not compare equal to the zone a reader derives.
 * @param value - the caller's reported zone name.
 * @returns the canonical zone, or `undefined` when the name is unusable.
 */
export function canonicalClientTimeZone(value: string): string | undefined {
  const resolved = canonicalizeTimeZone(value)
  return resolved.kind === 'accepted' ? resolved.timeZone : undefined
}

export { Cron, CRON_SEARCH_HORIZON_YEARS } from './cron.ts'
export type { CronFields } from './cron.ts'
export { RRule } from './rrule.ts'
export type { RecurrenceOccurrence, RecurrenceRejection, RecurrenceResult } from './recurrence.ts'
