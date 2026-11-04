/** Lossless guided and Custom editor projections for typed Schedule timing. */
import type { ScheduleCatalogEntry, ScheduleTiming } from '@deepseek-ai/dsh-schedule/client'
import { Cron, RRule, parseLocalCalendar, resolveLocalInstant } from '@deepseek-ai/dsh-util-time'
import { hostFrequencyKind, ruleFields } from './task-record.ts'

/** Periods represented by guided controls, plus a lossless advanced editor. */
export type FrequencyPreset = 'once' | 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'advanced'

/** Editable values that determine one typed timing selector. */
export interface TimingDraft {
  readonly frequency: FrequencyPreset
  readonly interval: string
  readonly start: string
  readonly timeZone: string
  readonly rrule: string
  /** Stored typed timing, retained in Custom and used to anchor guided edits to the current period. */
  readonly retainedTiming?: ScheduleTiming
  readonly weekdays: readonly number[]
  /** Day of the month; a month without that day runs on its last day. */
  readonly monthDay: number
  /** Daily `HH:MM` clock time. */
  readonly dailyTime: string
}

const WEEKDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
const FREQUENCY = {
  minutely: 'MINUTELY', hourly: 'HOURLY', daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY',
} as const

/**
 * Render an instant as the selected zone's local date and clock time.
 * @param timeZone - Zone used by the stored DTSTART.
 * @param at - Instant in epoch milliseconds.
 * @returns Zone-local date and second-precision time.
 */
function startInZone(timeZone: string, at: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  /* v8 ignore next -- the formatter emits every date and time part that its options request. */
  const field = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? ''
  return `${field('year').padStart(4, '0')}-${field('month')}-${field('day')}T${field('hour')}:${field('minute')}:${field('second')}`
}

/**
 * Initial form values for a new schedule.
 * @returns Guided timing with a one-hour-ahead one-shot default.
 */
export function defaultTiming(): TimingDraft {
  const date = new Date(Date.now() + 60 * 60_000)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  const start = `${local.toISOString().slice(0, 16)}:00`
  const day = Number(start.slice(8, 10))
  const weekday = (new Date(`${start.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7 + 1
  return {
    frequency: 'once', interval: '1', start,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, rrule: '',
    weekdays: [weekday], monthDay: day, dailyTime: start.slice(11, 16),
  }
}

/**
 * Format guided timing as DTSTART and RRULE content lines; return advanced text verbatim.
 * Draft fields and future occurrences require separate validation.
 * @param draft - Guided timing values or advanced text.
 * @param intervalFromNow - Use the current minute for intervals and the current period for edited typed recurrences;
 * false preserves the draft anchor.
 * @returns RFC 5545 content lines.
 */
export function rruleFromDraft(draft: TimingDraft, intervalFromNow = false): string {
  if (draft.frequency === 'advanced') return draft.rrule
  const now = Date.now()
  const anchor = intervalFromNow && (draft.frequency === 'minutely' || draft.frequency === 'hourly')
    ? startInZone(draft.timeZone, Math.floor(now / 60_000) * 60_000) : draft.start
  const time = draft.frequency === 'daily' ? `${draft.dailyTime}:00` : anchor.slice(11)
  let start = `${anchor.slice(0, 10)}T${time}`.replaceAll(/[-:]/g, '')
  let rule: string
  switch (draft.frequency) {
    case 'once': rule = 'FREQ=DAILY;COUNT=1'; break
    case 'minutely':
    case 'hourly': rule = `FREQ=${FREQUENCY[draft.frequency]};INTERVAL=${draft.interval}`; break
    case 'daily':
      rule = `FREQ=DAILY;INTERVAL=${draft.interval};BYHOUR=${Number(draft.dailyTime.slice(0, 2))}`
        + `;BYMINUTE=${Number(draft.dailyTime.slice(3, 5))}`
      break
    case 'weekly': rule = `FREQ=WEEKLY;INTERVAL=${draft.interval};BYDAY=${draft.weekdays.map(day => WEEKDAY[day - 1]).join(',')}`; break
    case 'monthly': rule = `FREQ=MONTHLY;INTERVAL=${draft.interval};BYMONTHDAY=${draft.monthDay},-1;BYSETPOS=1`; break
    /* v8 ignore next -- FrequencyPreset is closed and 'advanced' returned above; a new preset fails to compile here. */
    default: throw new Error(`Unsupported schedule timing: ${String(draft.frequency satisfies never)}`)
  }
  if (intervalFromNow && draft.retainedTiming !== undefined
    && draft.frequency !== 'once' && draft.frequency !== 'minutely' && draft.frequency !== 'hourly') {
    const clock = draft.frequency === 'daily' ? ''
      : `;BYHOUR=${Number(time.slice(0, 2))};BYMINUTE=${Number(time.slice(3, 5))}`
    // Anchor the interval grid to this period so an earlier edited clock can still occur within it.
    const probe = `DTSTART;TZID=${draft.timeZone}:${startInZone(draft.timeZone, now).replaceAll(/[-:]/g, '')}`
      + `\nRRULE:${rule}${clock};BYSECOND=${Number(time.slice(6, 8))}`
    const parsed = RRule.parse(probe)
    const next = parsed.kind === 'accepted' ? parsed.rule.next(now) : undefined
    // Callers reject invalid drafts; the Host rejects exhaustion. BYSECOND would make this probe Custom.
    if (next === undefined) return probe
    start = startInZone(draft.timeZone, Date.parse(next)).replaceAll(/[-:]/g, '')
  }
  return `DTSTART;TZID=${draft.timeZone}:${start}\nRRULE:${rule}`
}

/**
 * Recover only supported form rules; unknown rules remain verbatim in Advanced mode.
 * @param record - Stored schedule to edit.
 * @returns Guided values or the original advanced text.
 */
export function timingFromRecord(record: ScheduleCatalogEntry): TimingDraft {
  const initial = defaultTiming()
  if (record.kind === 'cron') {
    return { ...initial, frequency: 'advanced', rrule: record.expression, timeZone: record.timeZone }
  }
  if (record.kind !== 'rrule') {
    let retainedTiming: ScheduleTiming
    switch (record.kind) {
      case 'after':
      case 'at': retainedTiming = { kind: 'at', at: record.scheduledAt }; break
      case 'every': retainedTiming = { kind: 'every', every_seconds: record.everySeconds }; break
      case 'daily': retainedTiming = { kind: 'daily', daily: { time: record.time, time_zone: record.timeZone } }; break
      case 'weekly': retainedTiming = { kind: 'weekly', weekly: { time: record.time, time_zone: record.timeZone, weekdays: record.weekdays } }; break
    }
    const scheduledAt = Date.parse(record.scheduledAt)
    let timeZone = 'timeZone' in record ? record.timeZone : record.kind === 'every' ? 'UTC' : initial.timeZone
    let start = startInZone(timeZone, scheduledAt)
    if (record.kind === 'after' || record.kind === 'at') {
      const local = parseLocalCalendar(start.slice(0, 10), start.slice(11))
      if (local.kind === 'rejected' || resolveLocalInstant(local.time, timeZone) !== Math.floor(scheduledAt / 1_000) * 1_000) {
        // A local time that cannot round-trip to the stored instant needs an unambiguous UTC display.
        timeZone = 'UTC'
        start = startInZone(timeZone, scheduledAt)
      }
    }
    const guided = { ...initial, start, timeZone, retainedTiming, dailyTime: start.slice(11, 16),
      monthDay: Number(start.slice(8, 10)),
      weekdays: [(new Date(`${start.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7 + 1],
    }
    if (record.kind === 'after' || record.kind === 'at') {
      return { ...guided, frequency: 'once' }
    }
    if (record.kind === 'every' && Number.isSafeInteger(record.everySeconds / 60)) {
      const hourly = record.everySeconds % 3_600 === 0
      return { ...guided, frequency: hourly ? 'hourly' : 'minutely', interval: String(record.everySeconds / (hourly ? 3_600 : 60)) }
    }
    if (record.kind === 'daily' && /^\d{2}:\d{2}:00(?:\.0+)?$/.test(record.time)) {
      return { ...guided, frequency: 'daily', dailyTime: record.time.slice(0, 5) }
    }
    if (record.kind === 'weekly' && /^\d{2}:\d{2}:\d{2}(?:\.0+)?$/.test(record.time)) {
      return { ...guided, frequency: 'weekly', start: `${start.slice(0, 10)}T${record.time.slice(0, 8)}`, weekdays: record.weekdays }
    }
    return { ...initial, frequency: 'advanced', rrule: '',
      timeZone: 'timeZone' in record ? record.timeZone : initial.timeZone,
      retainedTiming,
    }
  }
  const startMatch = /^DTSTART(?:;TZID=([^:]+))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/m.exec(record.rrule)
  const fields = ruleFields(record.rrule)
  const kind = hostFrequencyKind(record)
  const start = startMatch === null ? initial.start
    : `${startMatch[2]}-${startMatch[3]}-${startMatch[4]}T${startMatch[5]}:${startMatch[6]}:${startMatch[7]}`
  const byDay = fields.get('BYDAY')?.split(',') ?? []
  // A guided daily rule names one hour and one minute, or neither and keeps the DTSTART clock.
  const hour = fields.get('BYHOUR') ?? start.slice(11, 13)
  const minute = fields.get('BYMINUTE') ?? start.slice(14, 16)
  // A guided monthly rule lists its day before -1, the fallback for a shorter month.
  const monthDay = kind === 'monthly' ? fields.get('BYMONTHDAY') : undefined
  const startWeekday = (new Date(`${start.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7 + 1
  return {
    frequency: kind === 'custom' ? 'advanced' : kind,
    interval: fields.get('INTERVAL') ?? '1', start,
    timeZone: startMatch?.[1] ?? 'UTC',
    rrule: record.rrule,
    weekdays: byDay.length === 0 ? [startWeekday] : byDay.map(day => WEEKDAY.indexOf(day as typeof WEEKDAY[number]) + 1),
    monthDay: Number.parseInt(monthDay ?? start.slice(8, 10), 10),
    dailyTime: kind === 'daily' ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` : start.slice(11, 16),
  }
}

/**
 * Resolve Custom Cron or RRULE text into its distinct management type.
 * @param draft - Current rule editor values, including any untouched stored timing.
 * @param intervalFromNow - Whether saves anchor intervals and edited typed recurrences to the current date and time.
 * @returns Typed timing for the shared Schedule management API.
 */
export function timingFromDraft(draft: TimingDraft, intervalFromNow = false): ScheduleTiming {
  if (draft.frequency === 'advanced') {
    if (draft.rrule.trim() === '' && draft.retainedTiming !== undefined) return draft.retainedTiming
    if (!draft.rrule.trimStart().startsWith('DTSTART')) {
      const expression = draft.rrule.trim()
      const parsed = Cron.parse(expression, draft.timeZone)
      return { kind: 'cron', cron: {
        expression: parsed.kind === 'accepted' ? parsed.rule.expression : expression, time_zone: draft.timeZone,
      } }
    }
  }
  const rrule = rruleFromDraft(draft, intervalFromNow)
  const parsed = draft.frequency === 'advanced' ? RRule.parse(rrule) : undefined
  return { kind: 'rrule', rrule: parsed?.kind === 'accepted' ? parsed.rule.expression : rrule }
}
