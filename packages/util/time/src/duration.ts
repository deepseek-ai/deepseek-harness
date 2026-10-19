/**
 * One span of time, held as a count of milliseconds and split into the whole
 * parts a reading is written in.
 *
 * A class rather than a branded number: arithmetic on two branded numbers
 * answers an unbranded `number`, so a brand cannot stop seconds and
 * milliseconds from being added, while an instance can. The published surface
 * is the set the migrated consumers call; a further member lands with the caller
 * that needs it.
 * @module @deepseek-ai/dsh-util-time
 */

const MS_PER_SECOND = 1_000
const SECONDS_PER_DAY = 86_400
const SECONDS_PER_HOUR = 3_600
const SECONDS_PER_MINUTE = 60

/** Whole parts of one non-negative span, in the units a reading is written in. */
export interface DurationParts {
  /** Whole days. */
  readonly days: number
  /** Whole hours left after the days, from 0 through 23. */
  readonly hours: number
  /** Whole minutes left after the hours, from 0 through 59. */
  readonly minutes: number
  /** Whole seconds left after the minutes, from 0 through 59. */
  readonly seconds: number
  /** Fractional milliseconds left after the seconds, from 0 up to (but excluding) 1000. */
  readonly milliseconds: number
}

/**
 * Largest millisecond count a span holds.
 *
 * Every integer up to this bound is exactly representable, which is what makes
 * the whole-part split exact; beyond it the parts a reader gets back would not
 * add up to the span.
 */
const MAX_SPAN_MS = Number.MAX_SAFE_INTEGER

/**
 * One span of time in milliseconds.
 *
 * Instances are frozen, so a span cannot drift after it is built. A span is
 * signed: a negative count builds, because the clock difference that produced it
 * is real, but `decompose()` refuses it because a negative interval has no single
 * whole-part split. A caller that reports parts therefore decides its own policy
 * first, and the elapsed reading clamps a backward clock reading to zero before
 * it builds the span. A span is bounded by the exactly representable millisecond
 * range, which is wider than any interval this harness schedules, and it carries
 * no calendar meaning: a month is not a fixed count of milliseconds.
 */
export class Duration {
  private readonly span: number

  private constructor(milliseconds: number) {
    this.span = milliseconds
    Object.freeze(this)
  }

  /**
   * Build one span from a millisecond count.
   * A negative count is accepted, so a caller can hold a backward clock difference;
   * such a span cannot be decomposed, and the caller states its own sign policy.
   * @param milliseconds - Signed count within the exactly representable range (about 285,000 years); fractions are kept.
   * @returns The span.
   * @throws TypeError when the count is not finite, or exceeds the exactly representable millisecond range.
   */
  static fromMilliseconds(milliseconds: number): Duration {
    if (!Number.isFinite(milliseconds)) {
      throw new TypeError(`duration milliseconds must be finite, got ${String(milliseconds)}`)
    }
    if (Math.abs(milliseconds) > MAX_SPAN_MS) {
      throw new TypeError(
        `duration milliseconds must not exceed ${MAX_SPAN_MS} so its parts stay exact, got ${String(milliseconds)}`,
      )
    }
    return new Duration(milliseconds)
  }

  /**
   * Split the span into whole days, hours, minutes, seconds, and the remaining
   * fraction of a second. Days, hours, minutes, and seconds are floored; the
   * millisecond part keeps the fraction below one second. Every span this class
   * accepts is inside the exactly representable millisecond range, so the parts
   * add back up to the span.
   * @returns The frozen whole parts.
   * @throws RangeError when the span is negative, because a negative interval
   * has no single whole-part decomposition: the caller owns that policy.
   */
  decompose(): DurationParts {
    if (this.span < 0) {
      throw new RangeError('a negative duration has no whole-part decomposition')
    }
    let seconds = Math.floor(this.span / MS_PER_SECOND)
    const days = Math.floor(seconds / SECONDS_PER_DAY)
    seconds %= SECONDS_PER_DAY
    const hours = Math.floor(seconds / SECONDS_PER_HOUR)
    seconds %= SECONDS_PER_HOUR
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
    seconds %= SECONDS_PER_MINUTE
    return Object.freeze({
      days,
      hours,
      minutes,
      seconds,
      milliseconds: this.span - Math.floor(this.span / MS_PER_SECOND) * MS_PER_SECOND,
    })
  }
}
