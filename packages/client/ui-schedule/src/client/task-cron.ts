/** Localized Cron descriptions built from the shared time parser's immutable fields. */
import { Cron } from '@deepseek-ai/dsh-util-time'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** ISO weekday dictionary key naming one cron day-of-week value. */
type CronWeekdayKey = `frequency.weekday.${1 | 2 | 3 | 4 | 5 | 6 | 7}`

/** Dictionary keys the cron description renders. */
export type CronDescriptionKey =
  | CronWeekdayKey
  | 'cron.list.join'
  | 'cron.part.join'
  | 'cron.weekday.name'
  | 'cron.weekday.range'
  | 'cron.months'
  | 'cron.day.every'
  | 'cron.day.weekdays'
  | 'cron.day.monthDays'
  | 'cron.day.both'
  | 'cron.day.bothStarred'
  | 'cron.hours.range'
  | 'cron.hours.list'
  | 'cron.time.everyMinute'
  | 'cron.time.everyMinutes'
  | 'cron.time.joinedEveryMinute'
  | 'cron.time.joinedEveryMinutes'
  | 'cron.time.everyHour'
  | 'cron.time.joinedEveryHour'
  | 'cron.time.everyNHours'
  | 'cron.time.joinedEveryNHours'
  | 'cron.time.hourlyAt'
  | 'cron.time.joinedHourlyAt'
  | 'cron.time.hoursEveryMinute'
  | 'cron.time.hoursEveryMinutes'
  | 'cron.time.at'
  | 'cron.time.hoursAt'

/** Namespace-independent translator for the cron description. */
export type CronDescriptionTranslator = Translate<CronDescriptionKey>

/** One parsed cron field: its matched values, its Vixie star flag, and its coverage. */
export interface CronField {
  /** Unique ascending matched values; Sunday 7 is folded onto 0. */
  readonly values: readonly number[]
  /**
   * Whether the field text starts with `*`, which is Vixie's `DOM_STAR`/`DOW_STAR`
   * test the Host applies: a stepped star such as `*​/2` counts, while a full range
   * written out (`1-31`) does not.
   */
  readonly starred: boolean
  /** Whether the matched set is every value the field can take. */
  readonly full: boolean
  /** Whether the field is a star field that matches every value. */
  readonly unrestricted: boolean
}

/** One parsed five-field cron expression in evaluation order. */
export interface ParsedCron {
  /** Unique ascending matched minutes. */
  readonly minutes: CronField
  /** Unique ascending matched hours. */
  readonly hours: CronField
  /** Unique ascending matched days of the month. */
  readonly daysOfMonth: CronField
  /** Unique ascending matched months. */
  readonly months: CronField
  /** Unique ascending matched cron weekdays, Sunday 0 through Saturday 6. */
  readonly daysOfWeek: CronField
}

/** ISO weekday dictionary keys indexed by ISO weekday minus one. */
const CRON_WEEKDAY_KEYS = [
  'frequency.weekday.1', 'frequency.weekday.2', 'frequency.weekday.3', 'frequency.weekday.4',
  'frequency.weekday.5', 'frequency.weekday.6', 'frequency.weekday.7',
] as const satisfies readonly CronWeekdayKey[]

/** Most clock times the description spells out before it names minutes and hours instead. */
const CRON_TIME_LIST_LIMIT = 6

/**
 * Read one array element the caller's own length guard already bounds.
 * @param values - array whose length the caller checked.
 * @param index - index inside that length.
 * @returns the element at that index.
 */
function cronElementAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  /* v8 ignore next -- every caller reads an index inside an array length it already proved. */
  if (value === undefined) throw new Error('cron description read an index outside its array')
  return value
}

/**
 * Parse one five-field cron expression in the dialect the Host accepts.
 * @param expression - candidate `minute hour day-of-month month day-of-week` text.
 * @returns parsed fields, or undefined when the Host would reject the expression.
 */
export function parseCronExpression(expression: string): ParsedCron | undefined {
  const result = Cron.parse(expression, 'UTC')
  if (result.kind === 'rejected') return undefined
  const parsed = result.rule.fields
  const fields = parsed.expression.split(/\s+/)
  const field = (values: readonly number[], count: number, index: number): CronField => {
    const starred = cronElementAt(fields, index).startsWith('*')
    const full = values.length === count
    return { values, starred, full, unrestricted: starred && full }
  }
  return {
    minutes: field(parsed.minutes, 60, 0),
    hours: field(parsed.hours, 24, 1),
    daysOfMonth: field(parsed.daysOfMonth, 31, 2),
    months: field(parsed.months, 12, 3),
    daysOfWeek: field(parsed.daysOfWeek, 7, 4),
  }
}

/**
 * Zero one field value to two digits.
 * @param value - number to spell.
 * @returns the value padded to at least two digits.
 */
function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Split ascending values into runs of consecutive numbers.
 * @param values - unique ascending values.
 * @returns the runs, each ascending, in value order.
 */
function consecutiveRuns(values: readonly number[]): number[][] {
  const runs: number[][] = []
  for (const value of values) {
    const run = runs[runs.length - 1]
    if (run !== undefined && cronElementAt(run, run.length - 1) + 1 === value) run.push(value)
    else runs.push([value])
  }
  return runs
}

/**
 * Join one list of numbers with the localized list separator.
 * @param values - numbers to spell.
 * @param t - cron translations supplying the separator.
 * @returns the localized list.
 */
function numberList(values: readonly number[], t: CronDescriptionTranslator): string {
  return values.map(String).join(t('cron.list.join'))
}

/**
 * Render cron weekdays as localized names, collapsing a run of three or more
 * consecutive days into one range.
 * @param values - cron weekdays, Sunday 0 through Saturday 6, ascending.
 * @param t - cron and weekday translations.
 * @returns localized weekday text, for example `Mon–Fri` or `Mon, Wed`.
 */
function cronWeekdayText(values: readonly number[], t: CronDescriptionTranslator): string {
  const join = t('cron.list.join')
  const name = (day: number): string =>
    t('cron.weekday.name', { weekday: t(cronElementAt(CRON_WEEKDAY_KEYS, day - 1)) })
  const iso = values.map(value => (value === 0 ? 7 : value)).sort((left, right) => left - right)
  return consecutiveRuns(iso).map(run => run.length >= 3
    ? t('cron.weekday.range', { from: name(cronElementAt(run, 0)), to: name(cronElementAt(run, run.length - 1)) })
    : run.map(name).join(join)).join(join)
}

/**
 * Name the months a rule restricts, or nothing when it matches every month.
 * @param values - matched months, January 1 through December 12.
 * @param locale - active UI locale naming the months.
 * @param t - cron translations.
 * @returns localized month suffix, or an empty string for all twelve months.
 */
function cronMonthSuffix(values: readonly number[], locale: string, t: CronDescriptionTranslator): string {
  if (values.length === 12) return ''
  const format = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' })
  const months = values.map(month => format.format(Date.UTC(2026, month - 1, 1))).join(t('cron.list.join'))
  return t('cron.months', { months })
}

/**
 * Describe the days one parsed rule matches.
 * @param parsed - parsed cron expression.
 * @param locale - active UI locale naming restricted months.
 * @param t - cron translations.
 * @returns whether the phrase states no day restriction at all, and the localized day phrase.
 */
function cronDayText(
  parsed: ParsedCron,
  locale: string,
  t: CronDescriptionTranslator,
): { everyDay: boolean; text: string } {
  const months = cronMonthSuffix(parsed.months.values, locale, t)
  const weekdays = cronWeekdayText(parsed.daysOfWeek.values, t)
  const days = numberList(parsed.daysOfMonth.values, t)
  const params = { days, weekdays, months }
  const dayOfMonth = parsed.daysOfMonth
  const dayOfWeek = parsed.daysOfWeek
  // The Host requires both day fields when either field text starts with `*`, and
  // otherwise accepts either field matching, so a star on either side narrows the
  // phrase to the intersection. A field covering every value adds nothing to that
  // intersection (and covers everything in a union).
  if (dayOfMonth.starred || dayOfWeek.starred) {
    if (dayOfMonth.full && dayOfWeek.full) return { everyDay: months === '', text: t('cron.day.every', { months }) }
    if (dayOfMonth.full) return { everyDay: false, text: t('cron.day.weekdays', params) }
    if (dayOfWeek.full) return { everyDay: false, text: t('cron.day.monthDays', params) }
    return { everyDay: false, text: t('cron.day.bothStarred', params) }
  }
  if (dayOfMonth.full || dayOfWeek.full) return { everyDay: months === '', text: t('cron.day.every', { months }) }
  return { everyDay: false, text: t('cron.day.both', params) }
}

/**
 * Name a restricted hour set as a contiguous range or an explicit list.
 * @param values - matched hours, ascending.
 * @param t - cron translations.
 * @returns localized hour scope, for example `09–17` or `09, 15`.
 */
function cronHourText(values: readonly number[], t: CronDescriptionTranslator): string {
  const hours = values.map(twoDigits)
  const contiguous = hours.length >= 2
    && cronElementAt(values, values.length - 1) - cronElementAt(values, 0) === values.length - 1
  return contiguous
    ? t('cron.hours.range', { from: cronElementAt(hours, 0), to: cronElementAt(hours, hours.length - 1) })
    : t('cron.hours.list', { hours: hours.join(t('cron.list.join')) })
}

/**
 * Read the uniform step of a field that covers its whole range.
 * @param values - unique ascending matched values.
 * @param min - lowest value of the field.
 * @param max - highest value of the field.
 * @returns the step when the values cover the whole field in equal increments, otherwise undefined.
 */
function cronFullRangeStep(values: readonly number[], min: number, max: number): number | undefined {
  if (values.length < 2) return undefined
  const first = cronElementAt(values, 0)
  if (first !== min) return undefined
  const step = cronElementAt(values, 1) - first
  for (let index = 1; index < values.length; index += 1) {
    if (cronElementAt(values, index) - cronElementAt(values, index - 1) !== step) return undefined
  }
  return cronElementAt(values, values.length - 1) + step > max ? step : undefined
}

/**
 * Describe the times of day one parsed rule matches.
 *
 * `interval` marks the phrases that state the repetition themselves; they read
 * as a whole sentence on their own and need the lower-case `joined` wording
 * when a day phrase precedes them.
 * @param parsed - parsed cron expression.
 * @param t - cron translations.
 * @returns whether the phrase states the repeating interval itself, its standalone
 * text, and its text after a day phrase.
 */
function cronTimeText(
  parsed: ParsedCron,
  t: CronDescriptionTranslator,
): { interval: boolean; text: string; joined: string } {
  const step = parsed.minutes.unrestricted ? undefined : cronFullRangeStep(parsed.minutes.values, 0, 59)
  if (parsed.hours.unrestricted) {
    if (parsed.minutes.unrestricted) {
      return { interval: true, text: t('cron.time.everyMinute'), joined: t('cron.time.joinedEveryMinute') }
    }
    if (step !== undefined && step >= 2) {
      return {
        interval: true,
        text: t('cron.time.everyMinutes', { step }),
        joined: t('cron.time.joinedEveryMinutes', { step }),
      }
    }
    // One minute past every hour is the hour itself when that minute is zero:
    // `0 * * * *` reads as `Every hour` rather than naming its zero minute.
    if (parsed.minutes.values.length === 1 && cronElementAt(parsed.minutes.values, 0) === 0) {
      return {
        interval: true,
        text: t('cron.time.everyHour'),
        joined: t('cron.time.joinedEveryHour'),
      }
    }
    const text = t('cron.time.hourlyAt', { minutes: numberList(parsed.minutes.values, t) })
    return {
      interval: false,
      text,
      joined: t('cron.time.joinedHourlyAt', { minutes: numberList(parsed.minutes.values, t) }),
    }
  }
  const hours = cronHourText(parsed.hours.values, t)
  if (parsed.minutes.unrestricted) {
    const text = t('cron.time.hoursEveryMinute', { hours })
    return { interval: false, text, joined: text }
  }
  if (step !== undefined && step >= 2) {
    const text = t('cron.time.hoursEveryMinutes', { hours, step })
    return { interval: false, text, joined: text }
  }
  // A zero minute over an evenly stepped hour set repeats whole hours: `0 */2 * * *`
  // reads as `Every 2 hours` rather than naming its zero minute.
  const hourStep = cronFullRangeStep(parsed.hours.values, 0, 23)
  if (parsed.minutes.values.length === 1 && cronElementAt(parsed.minutes.values, 0) === 0
    && hourStep !== undefined && hourStep >= 2) {
    return {
      interval: true,
      text: t('cron.time.everyNHours', { count: hourStep }),
      joined: t('cron.time.joinedEveryNHours', { count: hourStep }),
    }
  }
  const times = parsed.hours.values.flatMap(hour =>
    parsed.minutes.values.map(minute => `${twoDigits(hour)}:${twoDigits(minute)}`))
  const text = times.length <= CRON_TIME_LIST_LIMIT
    ? t('cron.time.at', { times: times.join(t('cron.list.join')) })
    : t('cron.time.hoursAt', { hours, minutes: numberList(parsed.minutes.values, t) })
  return { interval: false, text, joined: text }
}

/**
 * Describe one parsed cron expression as one localized sentence.
 * @param parsed - parsed cron expression.
 * @param t - cron translations.
 * @param locale - active UI locale naming restricted months.
 * @returns localized sentence, for example `Mon–Fri at 09:00` or `Every 15 minutes`.
 */
export function cronPreview(parsed: ParsedCron, t: CronDescriptionTranslator, locale: string): string {
  const day = cronDayText(parsed, locale, t)
  const time = cronTimeText(parsed, t)
  return day.everyDay && time.interval ? time.text : [day.text, time.joined].join(t('cron.part.join'))
}
