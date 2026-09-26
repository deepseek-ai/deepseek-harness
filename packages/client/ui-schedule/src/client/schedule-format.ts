/** Browser-safe formatting shared by Session and Host reminder catalogs. */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { CronDescriptionKey } from './task-cron.ts'
import { cronPreview, parseCronExpression } from './task-cron.ts'

type TimeUnit = 'day' | 'hour' | 'minute' | 'second'
type UnitKey = `unit.${TimeUnit}.${'one' | 'other'}`
type WeekdayKey = `frequency.weekday.${1 | 2 | 3 | 4 | 5 | 6 | 7}`

/** Dictionary keys required to display exact reminder frequencies. */
export type FrequencyKey =
  | 'time.locale'
  | 'time.utcPrefix'
  | 'frequency.once'
  | 'frequency.every'
  | 'frequency.daily'
  | 'frequency.dailyLocal'
  | 'frequency.weekly'
  | 'frequency.weeklyLocal'
  | 'frequency.cron'
  | 'frequency.cronLocal'
  | 'frequency.cronRule'
  | 'frequency.weekday.join'
  | WeekdayKey
  | UnitKey
  | CronDescriptionKey

/** Namespace-independent translator for reminder frequencies and time units. */
export type FrequencyTranslator = Translate<FrequencyKey>

/** Dictionary keys required to localize a zone and mark the host's zone. */
export type ZoneLabelKey = 'time.locale' | 'time.utcPrefix' | 'rule.zone.system'
type ZoneLocaleKey = Extract<ZoneLabelKey, 'time.locale' | 'time.utcPrefix'>

/** Universal fallback when a runtime cannot enumerate its ICU time-zone data. */
export const FALLBACK_ZONES = ['UTC'] as const

/** Host-zone context a frequency line uses to omit or name a rule's stored zone. */
export interface FrequencyZone {
  /** Host's current IANA zone; a rule storing this zone shows no zone. */
  readonly system: string
  /** ICU-localized name and offset of one zone. */
  readonly label: (zone: string) => string
}

/** Dictionary keys required to display relative reminder targets. */
export type RelativeTimeKey = UnitKey | 'relative.now' | 'relative.future' | 'relative.overdue'

const SECOND_MS = 1_000
const SECOND_UNIT = { unit: 'second', seconds: 1 } as const
const UNIT_SECONDS: readonly { unit: TimeUnit; seconds: number }[] = [
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3_600 },
  { unit: 'minute', seconds: 60 },
  SECOND_UNIT,
]
const WEEKDAY_KEYS = [
  'frequency.weekday.1', 'frequency.weekday.2', 'frequency.weekday.3', 'frequency.weekday.4',
  'frequency.weekday.5', 'frequency.weekday.6', 'frequency.weekday.7',
] as const satisfies readonly WeekdayKey[]

/** Localized unit word for one integral magnitude. */
function unitLabel(unit: TimeUnit, value: number, t: Translate<UnitKey>): string {
  return t(`unit.${unit}.${value === 1 ? 'one' : 'other'}`, { count: value })
}

/**
 * Name one task from its stored title.
 *
 * Every decoded Host record and catalog entry carries a title that is non-empty
 * after trimming, so no name is derived from the instruction here. The
 * `schedule_create` card derives one only for a result read from a Session log
 * written before the stored field existed.
 * @param record - task being named.
 * @returns the stored title.
 */
export function taskName(record: ScheduleRecord): string {
  return record.title
}

/** Localized clock text that omits fractional seconds and zero seconds. */
function clockLabel(time: string): string {
  return time.replace(/\.\d+$/, '').replace(/:00$/, '')
}

/**
 * Render the stored ISO weekday set with localized names joined in locale order.
 * @param weekdays - Stored unique ascending ISO weekdays.
 * @param t - frequency, join, and unit translations.
 * @returns Localized weekday list, for example `Mon, Wed`.
 */
export function formatWeekdays(weekdays: readonly number[], t: FrequencyTranslator): string {
  return weekdays
    .map(weekday => t(WEEKDAY_KEYS[weekday - 1] ?? 'frequency.weekday.1'))
    .join(t('frequency.weekday.join'))
}

/** UTC offset, in minutes, of one IANA zone at the current instant. */
function zoneOffset(zone: string, at: number): number | undefined {
  try {
    const value = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, timeZoneName: 'longOffset',
    }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value
    if (value === 'GMT') return 0
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(value ?? '')
    if (match === null) return undefined
    const minutes = Number(match[2]) * 60 + Number(match[3])
    return match[1] === '-' ? -minutes : minutes
  } catch {
    return undefined
  }
}

/** Stable UTC-offset label for one valid IANA zone. */
function zoneOffsetLabel(zone: string, at: number, prefix: string): string | undefined {
  const minutes = zoneOffset(zone, at)
  if (minutes === undefined) return undefined
  const absolute = Math.abs(minutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const remainder = String(absolute % 60).padStart(2, '0')
  return `${prefix}${minutes < 0 ? '-' : '+'}${hours}:${remainder}`
}

/**
 * Localize one IANA zone through the runtime's ICU/CLDR data, prefixed by its
 * current UTC offset. The raw IANA id remains internal unless ICU cannot name
 * a valid stored alias.
 * @param zone - IANA zone to label.
 * @param t - translate providing the active ICU locale.
 * @param at - instant used to resolve the current UTC offset and zone name.
 * @returns the UTC offset and localized zone name.
 */
export function zoneLabel(zone: string, t: Translate<ZoneLocaleKey>, at = Date.now()): string {
  const offset = zoneOffsetLabel(zone, at, t('time.utcPrefix'))
  try {
    const name = new Intl.DateTimeFormat(t('time.locale'), {
      timeZone: zone, timeZoneName: 'longGeneric',
    }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value
    if (offset === undefined) return name ?? zone
    return name === undefined || /^GMT(?:[+-]|$)/.test(name) ? offset : `${offset} · ${name}`
  } catch {
    return offset === undefined ? zone : `${offset} · ${zone}`
  }
}

/**
 * Name one zone and mark it when it is the host's own zone.
 * @param zone - IANA zone to name.
 * @param system - the host's current IANA zone.
 * @param t - translate providing the active ICU locale and system suffix.
 * @param at - instant used to resolve the current UTC offset and zone name.
 * @returns UTC offset and localized zone name, with the system suffix when applicable.
 */
export function zoneName(
  zone: string,
  system: string,
  t: Translate<ZoneLabelKey>,
  at = Date.now(),
): string {
  const name = zoneLabel(zone, t, at)
  return zone === system ? `${name}${t('rule.zone.system')}` : name
}

/**
 * IANA zones this runtime enumerates, or `undefined` when it cannot enumerate.
 *
 * `Intl.supportedValuesOf('timeZone')` (ES2022) returns the engine's own
 * inventory. An engine without the method, and one whose `Intl` refuses the
 * call, both throw here; `undefined` then keeps `zoneChoices` on its minimal
 * fallback rather than an empty menu.
 * @returns the enumerated IANA zones, or `undefined` when enumeration fails.
 */
function timeZoneInventory(): readonly string[] | undefined {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    // Enumeration is optional engine support; the minimal fallback covers its absence.
    return undefined
  }
}

/**
 * Zones the time-zone menu offers, in menu order: the host's current zone,
 * followed by the runtime's IANA inventory ordered by current UTC offset and
 * canonical id, including a stored alias the inventory omits.
 *
 * `Intl.supportedValuesOf('timeZone')` supplies the inventory, so an engine
 * that can enumerate zones offers all of them. When enumeration is unavailable,
 * the menu falls back to the host zone, UTC, and any stored zone, so it is never
 * empty. A stored zone outside the inventory is appended,
 * so an accepted alias never disappears from the menu.
 * @param stored - zone the shown rule stores.
 * @param system - the host's current IANA zone.
 * @param at - instant used to order zones by their current UTC offset.
 * @returns IANA zones in menu order, de-duplicated.
 */
export function zoneChoices(stored: string, system: string, at = Date.now()): readonly string[] {
  const inventory = timeZoneInventory()
  const zones = inventory === undefined ? FALLBACK_ZONES : [...FALLBACK_ZONES, ...inventory]
  const choices = [...new Set([...zones, stored])].filter(zone => zone !== system)
  // One offset per zone, read once alongside the zone it belongs to: each
  // `zoneOffset` builds a formatter, so resolving offsets inside the comparator
  // would build O(n log n) of them for the several hundred zones the inventory lists.
  const ordered = choices
    .map(zone => ({ zone, offset: zoneOffset(zone, at) ?? Number.POSITIVE_INFINITY }))
    .sort((left, right) => {
      if (left.offset !== right.offset) return left.offset - right.offset
      return left.zone < right.zone ? -1 : 1
    })
    .map(entry => entry.zone)
  return [system, ...ordered]
}

/**
 * IANA zone a record's stored wall-clock rule interprets its time in.
 *
 * Daily, weekly, and cron records store an explicit zone. One-shot `at` and
 * `after` records, and fixed-interval `every` records, store only the UTC
 * instant, so they have no rule zone and their displayed time uses the browser zone.
 * @param record - reminder whose kind determines whether a zone is stored.
 * @returns the stored IANA zone, or undefined when the record stores none.
 */
export function recordTimeZone(record: ScheduleRecord): string | undefined {
  switch (record.kind) {
    case 'after':
    case 'at':
    case 'every': return undefined
    case 'daily':
    case 'weekly':
    case 'cron': return record.timeZone
  }
}

/**
 * Format exact intervals or wall-clock rules without changing their precision or zone.
 *
 * A cron rule reads as the sentence `cronPreview` derives from its expression,
 * for example `Every day at 09:00, 15:00`. An expression this parser cannot
 * read keeps the raw `Cron {expression}` form, so the stored rule stays visible
 * when the Host's dialect and this parser diverge.
 * @param record - reminder whose kind and stored rule determine its frequency.
 * @param t - frequency, weekday, and unit translations, independent of the catalog namespace.
 * @param zone - host-zone context; when present, a stored zone equal to `zone.system` is omitted
 * and another zone is named by `zone.label`. Without it ICU localizes the stored zone.
 * @returns localized one-shot, fixed-interval, daily, weekly, or cron time-and-zone text.
 */
export function formatScheduleFrequency(
  record: ScheduleRecord,
  t: FrequencyTranslator,
  zone?: FrequencyZone,
): string {
  switch (record.kind) {
    case 'after':
    case 'at': return t('frequency.once')
    case 'cron': {
      const parsed = parseCronExpression(record.expression)
      if (parsed !== undefined) {
        const rule = cronPreview(parsed, t, t('time.locale'))
        if (zone === undefined) return t('frequency.cronRule', { rule, timeZone: zoneLabel(record.timeZone, t) })
        return zone.system === record.timeZone
          ? rule
          : t('frequency.cronRule', { rule, timeZone: zone.label(record.timeZone) })
      }
      if (zone === undefined) return t('frequency.cron', { expression: record.expression, timeZone: zoneLabel(record.timeZone, t) })
      return zone.system === record.timeZone
        ? t('frequency.cronLocal', { expression: record.expression })
        : t('frequency.cron', { expression: record.expression, timeZone: zone.label(record.timeZone) })
    }
    case 'daily': {
      const time = clockLabel(record.time)
      if (zone === undefined) return t('frequency.daily', { time, timeZone: zoneLabel(record.timeZone, t) })
      return zone.system === record.timeZone
        ? t('frequency.dailyLocal', { time })
        : t('frequency.daily', { time, timeZone: zone.label(record.timeZone) })
    }
    case 'weekly': {
      const params = { weekdays: formatWeekdays(record.weekdays, t), time: clockLabel(record.time) }
      if (zone === undefined) return t('frequency.weekly', { ...params, timeZone: zoneLabel(record.timeZone, t) })
      return zone.system === record.timeZone
        ? t('frequency.weeklyLocal', params)
        : t('frequency.weekly', { ...params, timeZone: zone.label(record.timeZone) })
    }
    case 'every': {
      let selected: { unit: TimeUnit; seconds: number } = SECOND_UNIT
      for (const candidate of UNIT_SECONDS) {
        if (record.everySeconds % candidate.seconds !== 0) continue
        selected = candidate
        break
      }
      const value = record.everySeconds / selected.seconds
      return t('frequency.every', { value, unit: unitLabel(selected.unit, value, t) })
    }
  }
  /* v8 ignore next -- The Remote decoder validates this closed union. */
  return assertNever(record)
}

/**
 * Format one target instant as a localized month-and-day date with its time, the
 * form the mock's task list shows and the same `Intl` field pair the universal
 * cards use.
 *
 * The month is a locale-owned name, not a zero-padded number: `en` renders
 * `Dec 31, 9:00 AM` and `zh-CN` renders `12月31日 09:00`, so neither locale can
 * produce a `12-31` string. The year appears only when the instant falls outside
 * the current year in the displayed zone, so a same-year target or delivery
 * stays compact while an older record still dates itself.
 *
 * `timeZone` carries the rule's own zone for a daily, weekly, or cron record, so
 * its occurrence reads in the task's zone. A one-shot `at` or `after` record
 * stores only the UTC instant, so callers pass no zone and it formats in the
 * browser zone.
 * @param scheduledAt - durable UTC target.
 * @param locale - BCP-47 locale owning the month name, day order, and clock.
 * @param timeZone - IANA zone of the task's own rule, or undefined for the browser zone.
 * @returns the localized month, day, and time, with the year when it is not the
 * current one, or the raw instant when the value cannot be parsed.
 */
export function formatScheduleNextRun(scheduledAt: string, locale: string, timeZone?: string): string {
  const at = Date.parse(scheduledAt)
  if (Number.isNaN(at)) return scheduledAt
  const zone = timeZone === undefined ? {} : { timeZone }
  const yearOf = new Intl.DateTimeFormat('en-US', { year: 'numeric', ...zone })
  return new Intl.DateTimeFormat(locale, {
    ...(yearOf.format(at) === yearOf.format(Date.now()) ? {} : { year: 'numeric' as const }),
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...zone,
  }).format(at)
}

/**
 * Languages whose absolute date reads the year. The design pins English and
 * Chinese (`en` states it, `zh` reads month and day only), and every other
 * language joins English: silently dropping the year would hide the year of a
 * target that can sit months or a year away.
 */
const YEAR_LANGUAGES: readonly string[] = ['en']
const NO_YEAR_LANGUAGES: readonly string[] = ['zh']

/**
 * Whether one locale's absolute date states the year.
 * @param locale - BCP-47 locale tag.
 * @returns whether the year is stated; an unlisted language states it.
 */
function statesYear(locale: string): boolean {
  const language = locale.toLowerCase().replace(/-.*$/, '')
  if (YEAR_LANGUAGES.includes(language)) return true
  if (NO_YEAR_LANGUAGES.includes(language)) return false
  // Unlisted languages take the stated default, so no language silently loses
  // the year for a target that can sit months or a year away.
  return true
}

/**
 * Format one target as an absolute time in this device's zone.
 *
 * A task whose stored rule names its own zone still shows its next run in the
 * reader's zone: the instant is the same one, and the reader compares it with
 * their own clock. The locale owns the month name, the field order, and the
 * separators, so the stamp reads `Sep 19, 2026, 15:51` in English and
 * `9月19日 15:51` in Chinese.
 *
 * Whether a bare date reads the year is a per-language typographic choice, and
 * the languages the design pins are stated in {@link YEAR_LANGUAGES} and
 * {@link NO_YEAR_LANGUAGES}. Every language not listed there states the year:
 * dropping it silently would hide the year of a target that can sit months or a
 * year away, which is worse than one field more than the reader needs.
 * @param scheduledAt - durable UTC target.
 * @param locale - BCP-47 locale owning the month name, field order, and clock.
 * @returns the localized absolute next run in the device zone, or the raw instant when it cannot be parsed.
 */
export function formatScheduleAbsolute(scheduledAt: string, locale: string): string {
  const at = Date.parse(scheduledAt)
  if (Number.isNaN(at)) return scheduledAt
  return new Intl.DateTimeFormat(locale, {
    ...(statesYear(locale) ? { year: 'numeric' as const } : {}),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    // h23 matches the clock rows' own formatter (task-timing.ts): `hour12: false`
    // leaves midnight's hour open in older engines, which may render `24:00`.
    hourCycle: 'h23',
  }).format(at)
}

/**
 * One next-run line as its two texts: the device-zone stamp and the distance.
 *
 * The list rows, the detail, the Session-header catalog, and the Sidebar hover
 * card all state this pair, so they take it from here instead of each composing
 * it: the stamp follows the language through `formatScheduleAbsolute`, and the
 * distance stays the reader's countdown.
 * @param scheduledAt - durable UTC target.
 * @param locale - BCP-47 locale owning the month name, field order, and clock.
 * @param now - current epoch milliseconds.
 * @param t - relative-time and unit translations.
 * @returns the absolute stamp, and the same distance wrapped in parentheses.
 */
export function nextRunParts(
  scheduledAt: string,
  locale: string,
  now: number,
  t: Translate<RelativeTimeKey>,
): { readonly absolute: string; readonly relative: string } {
  return {
    absolute: formatScheduleAbsolute(scheduledAt, locale),
    relative: `(${formatScheduleRelative(scheduledAt, now, t)})`,
  }
}

/**
 * Format a relative target using the largest natural clock unit.
 * @param scheduledAt - durable UTC target.
 * @param now - current epoch milliseconds.
 * @param t - relative-time and unit translations.
 * @returns localized future, overdue, or due-now label.
 */
export function formatScheduleRelative(
  scheduledAt: string,
  now: number,
  t: Translate<RelativeTimeKey>,
): string {
  const difference = Date.parse(scheduledAt) - now
  if (difference === 0) return t('relative.now')
  const absoluteSeconds = Math.abs(difference) / SECOND_MS
  const selected = UNIT_SECONDS.find(candidate => absoluteSeconds >= candidate.seconds)
    ?? SECOND_UNIT
  const value = Math.max(1, difference > 0
    ? Math.ceil(absoluteSeconds / selected.seconds)
    : Math.floor(absoluteSeconds / selected.seconds))
  const unit = unitLabel(selected.unit, value, t)
  return t(difference > 0 ? 'relative.future' : 'relative.overdue', { value, unit })
}

/**
 * Order overdue records first and future records by ascending target time.
 * @param records - reminders to order without mutating the input.
 * @param now - current epoch milliseconds used to identify overdue targets.
 * @returns sorted copy preserving input order for equal targets.
 */
export function orderScheduleRecords(records: readonly ScheduleRecord[], now: number): ScheduleRecord[] {
  return records.map((record, index) => ({ record, index })).sort((left, right) => {
    const leftTime = Date.parse(left.record.scheduledAt)
    const rightTime = Date.parse(right.record.scheduledAt)
    const leftOverdue = leftTime <= now
    const rightOverdue = rightTime <= now
    if (leftOverdue !== rightOverdue) return Number(rightOverdue) - Number(leftOverdue)
    return leftTime - rightTime || left.index - right.index
  }).map(({ record }) => record)
}
