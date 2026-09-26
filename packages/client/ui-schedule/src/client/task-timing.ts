/**
 * Exact rule snapshots, editable timing fields, the injected task update callback, and Host
 * failure mapping; zone interpretation belongs to the Host.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ScheduleRecord, ScheduleUpdateRequest, ScheduleUpdateResult,
} from '@deepseek-ai/dsh-schedule/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { TaskManagerKey } from './task-manager-locales.ts'

/** Task mutation callback injected by the task catalog owner. */
export interface TaskTimingInjected {
  /**
   * Compare and update the exact task, then refresh the authoritative catalog on success or a stale rule.
   * Catalog read failures remain in catalog state and do not change the persistence result.
   * @param request - Captured task and Session, complete expected record, and the optional
   * replacement name, instruction, and timing change; an omitted `change` keeps the committed target.
   * @returns Original Remote mutation result; transport or storage exceptions may reject.
   */
  readonly onUpdateTiming: (request: ScheduleUpdateRequest) => Promise<RemoteResult<ScheduleUpdateResult>>
}

/** Native input values retained for one edit session. */
export interface TimingDraft {
  date: string
  time: string
  timeZone: string
  seconds: string
  expression: string
}

/**
 * Project only persisted rule fields, excluding catalog metadata and delivery receipts.
 * @param record - Rule from the current catalog.
 * @returns Independent complete expected rule for compare-and-update.
 */
export function timingSnapshot(record: ScheduleRecord): ScheduleRecord {
  const common = {
    id: record.id,
    title: record.title,
    prompt: record.prompt,
    scheduledAt: record.scheduledAt,
  }
  switch (record.kind) {
    case 'at': return { ...common, kind: record.kind }
    case 'after': return { ...common, kind: record.kind, afterSeconds: record.afterSeconds }
    case 'every': return { ...common, kind: record.kind, everySeconds: record.everySeconds }
    case 'daily': return { ...common, kind: record.kind, time: record.time, timeZone: record.timeZone }
    case 'weekly': return {
      ...common, kind: record.kind, time: record.time, timeZone: record.timeZone, weekdays: [...record.weekdays],
    }
    case 'cron': return {
      ...common, kind: record.kind, expression: record.expression, timeZone: record.timeZone,
    }
  }
  /* v8 ignore next -- Exhaustiveness guard for the closed ScheduleRecord union. */
  return assertNever(record)
}

/**
 * Zone a rule without a stored zone falls back to when the runtime cannot name
 * the device zone. A runtime that reports no zone stores `undefined`, which is
 * not an IANA id, so the draft needs one explicit fallback.
 */
const FALLBACK_ZONE = 'UTC'

/** IANA id the runtime reports for this device, or the explicit fallback. */
function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_ZONE
}

/** Zone one rule carries when it stores one, otherwise undefined. */
function storedZone(record: ScheduleRecord): string | undefined {
  return 'timeZone' in record ? record.timeZone : undefined
}

/**
 * The zone a new or switched-to rule starts its clock rows in, and whether that
 * zone came from the stored rule rather than this device.
 *
 * A daily, weekly, or cron record stores the zone its wall clock means, so
 * editing it keeps that zone. A one-shot `at` target and an `after` interval
 * store only the committed instant and no creation zone, so they start in this
 * device's zone.
 * @param record - rule the draft is seeded from.
 * @returns the draft's IANA zone and whether it is the no-stored-zone fallback.
 */
export function draftZone(record: ScheduleRecord): { zone: string; stored: boolean } {
  const stored = storedZone(record)
  return stored === undefined ? { zone: deviceZone(), stored: false } : { zone: stored, stored: true }
}

/**
 * The date and clock one instant names in one zone, keeping millisecond precision.
 *
 * The locale is fixed, so the field order never follows the interface language,
 * and each field is read by name rather than from a formatted string.
 * @param instant - canonical ISO instant.
 * @param zone - IANA zone the returned wall clock is expressed in.
 * @returns `YYYY-MM-DDTHH:MM:SS.mmm` in that zone.
 */
export function zonedWallClock(instant: string, zone: string): string {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return ''
  try {
    const fields = new Map(new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
      hourCycle: 'h23',
    }).formatToParts(at).map(part => [part.type, part.value]))
    const date = `${fields.get('year')}-${fields.get('month')}-${fields.get('day')}`
    const clock = `${fields.get('hour')}:${fields.get('minute')}:${fields.get('second')}.${fields.get('fractionalSecond')}`
    return `${date}T${clock}`
  } catch {
    // An unusable zone cannot place the instant; the callers keep the stored text.
    return ''
  }
}

/**
 * Initialize one-shot inputs in the zone the rule states, or in this device's
 * zone for a rule that stores none.
 *
 * An `at` target stores an instant and no creation zone, so its rows show that
 * instant in the draft's zone: the shown pair names the instant the record
 * already commits rather than restating it in a zone the record does not have.
 * @param record - Expected rule captured when editing starts.
 * @returns Native input values without rounding seconds or milliseconds.
 */
export function timingDraft(record: ScheduleRecord): TimingDraft {
  const draft = { date: '', time: '', timeZone: '', seconds: '', expression: '' }
  switch (record.kind) {
    case 'at':
    case 'after': {
      const zone = draftZone(record).zone
      const wallClock = zonedWallClock(record.scheduledAt, zone)
      return {
        ...draft,
        date: wallClock.slice(0, 10),
        time: wallClock.slice(11, 23),
        timeZone: zone,
      }
    }
    case 'every': return { ...draft, seconds: String(record.everySeconds) }
    case 'daily':
    case 'weekly': return { ...draft, time: record.time, timeZone: record.timeZone }
    case 'cron': return { ...draft, expression: record.expression, timeZone: record.timeZone }
  }
  /* v8 ignore next -- Exhaustiveness guard for the closed ScheduleRecord union. */
  return assertNever(record)
}

/**
 * One date as the rows and pickers expose it.
 *
 * The draft, the calendar's own comparisons, and the text submitted to the Host
 * all stay `YYYY-MM-DD`; only the exposed text takes the slashed form the design
 * states, so no caller has to parse or re-format a date merely to show it.
 * @param date - stored or staged ISO date text.
 * @returns the same date with slashes between its fields.
 */
export function slashDate(date: string): string {
  return date.replaceAll('-', '/')
}

/**
 * One clock time at whole-second precision.
 *
 * The rows and the clock picker both show `HH:MM:SS`; an untouched stored value
 * keeps its milliseconds in the draft so a save can submit them back.
 * @param time - stored or staged clock text, with or without fractional seconds.
 * @returns the same clock time at whole-second precision, or the input when it is not a clock time.
 */
export function secondPrecision(time: string): string {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(time)
  if (match === null) return time
  return `${match[1]}:${match[2]}:${match[3] ?? '00'}`
}

/**
 * Localize controlled Host failures without exposing transport or storage diagnostics.
 * @param code - Error code returned by the timing update.
 * @returns Dictionary key describing the recovery action.
 */
export function timingError(code: Extract<ScheduleUpdateResult, { code: string }>['code']): TaskManagerKey {
  switch (code) {
    case 'schedule_conflict': return 'timing.conflict'
    case 'schedule_ended': return 'timing.inactive'
    case 'schedule_not_found': return 'timing.notFound'
    case 'invalid_time_zone': return 'timing.invalidZone'
    case 'not_future': return 'timing.notFuture'
    case 'frequency_too_high': return 'timing.invalidInterval'
    case 'invalid_prompt':
    case 'invalid_selector':
    case 'invalid_rule':
    case 'time_out_of_range': return 'timing.invalid'
    case 'internal_error': return 'timing.error'
  }
  /* v8 ignore next -- Exhaustiveness guard for the closed ScheduleUpdateResult error-code union. */
  return assertNever(code)
}
