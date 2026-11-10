/** Typed timing construction and edits shared by all Schedule management callers. */
import { isDeepStrictEqual } from 'node:util'
import {
  createAfterScheduleRecord, createAtScheduleRecord, createCronScheduleRecord,
  createDailyScheduleRecord, createEveryScheduleRecord, createWeeklyScheduleRecord, createRRuleScheduleRecord,
  parseAtInput, parseCronInput, parseDailyInput, parseWeeklyInput,
  normalizeRRule, updateRRuleScheduleRecord, ScheduleInputError, scheduleTitle, isRecord, hasExactKeys,
} from './domain.ts'
import type { ScheduleId, SchedulePatch, ScheduleRecord, ScheduleTiming } from './types.ts'

/** Read exactly one matching timing payload at the untrusted management boundary. */
function validateTiming(value: ScheduleTiming): ScheduleTiming {
  const selectors = { after: 'after_seconds', at: 'at', every: 'every_seconds', daily: 'daily', weekly: 'weekly', cron: 'cron', rrule: 'rrule' } as const
  if (!isRecord(value) || !(value.kind in selectors)
    || !hasExactKeys(value, ['kind', selectors[value.kind]])) {
    throw new ScheduleInputError('invalid_rule', 'timing must contain exactly kind and its matching selector.')
  }
  return value
}

/**
 * Construct a current record with one authoritative timing kind and a future committed target.
 * @param id - Host-generated task identity.
 * @param title - Required user-facing task title.
 * @param prompt - Non-empty instruction delivered at each occurrence.
 * @param value - Exactly one typed timing selector.
 * @param now - Explicit acceptance time in epoch milliseconds.
 * @returns A validated record with its first future occurrence.
 */
export function createScheduleRecord(id: ScheduleId, title: string, prompt: string, value: ScheduleTiming, now: number): ScheduleRecord {
  const timing = validateTiming(value)
  switch (timing.kind) {
    case 'after': return createAfterScheduleRecord(id, prompt, timing.after_seconds, now, title)
    case 'at': return createAtScheduleRecord(id, prompt, timing.at, now, title)
    case 'every': return createEveryScheduleRecord(id, prompt, timing.every_seconds, now, title)
    case 'daily': return createDailyScheduleRecord(id, prompt, timing.daily, now, title)
    case 'weekly': return createWeeklyScheduleRecord(id, prompt, timing.weekly, now, title)
    case 'cron': return createCronScheduleRecord(id, prompt, timing.cron, now, title)
    case 'rrule': return createRRuleScheduleRecord(id, title, prompt, timing.rrule, now)
  }
}

/** Express a record's rule as editable timing; a one-shot retains its committed absolute target. */
function timingOf(record: ScheduleRecord): ScheduleTiming {
  switch (record.kind) {
    case 'after':
    case 'at': return { kind: 'at', at: record.scheduledAt }
    case 'every': return { kind: 'every', every_seconds: record.everySeconds }
    case 'daily': return { kind: 'daily', daily: { time: record.time, time_zone: record.timeZone } }
    case 'weekly': return { kind: 'weekly', weekly: { time: record.time, time_zone: record.timeZone, weekdays: record.weekdays } }
    case 'cron': return { kind: 'cron', cron: { expression: record.expression, time_zone: record.timeZone } }
    case 'rrule': return { kind: 'rrule', rrule: record.rrule }
  }
}

/** Normalize timing for equivalence before calculating any new target. */
function normalizedTiming(value: ScheduleTiming): unknown {
  const timing = validateTiming(value)
  switch (timing.kind) {
    case 'after': return timing
    case 'at': return { kind: 'at', at: parseAtInput(timing.at) }
    case 'every': return timing
    case 'daily': return { kind: 'daily', ...parseDailyInput(timing.daily) }
    case 'weekly': return { kind: 'weekly', ...parseWeeklyInput(timing.weekly) }
    case 'cron': return { kind: 'cron', ...parseCronInput(timing.cron) }
    case 'rrule': return { kind: 'rrule', rrule: normalizeRRule(timing.rrule) }
  }
}

/**
 * Keep unchanged timing and committed targets, or re-arm through the same constructor as creation.
 * @param current - Stored record before the edit.
 * @param patch - Descriptive fields and optional typed timing replacement.
 * @param now - Explicit edit acceptance time in epoch milliseconds.
 * @param resume - Whether to find a future occurrence for unchanged timing.
 * @returns The retained or revised authoritative timing record.
 */
export function updateScheduleRecord(current: ScheduleRecord, patch: SchedulePatch, now: number, resume: boolean): ScheduleRecord {
  const title = scheduleTitle(patch.title === undefined ? current.title : patch.title)
  const prompt = patch.prompt === undefined ? current.prompt : patch.prompt
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  const timing = patch.timing === undefined ? timingOf(current) : patch.timing
  const changed = patch.timing !== undefined && !isDeepStrictEqual(normalizedTiming(timing), normalizedTiming(timingOf(current)))
  try {
    if (current.kind === 'rrule' && timing.kind === 'rrule') {
      return updateRRuleScheduleRecord(current, { title, prompt,
        ...(changed ? { rrule: timing.rrule } : {}),
      }, now, changed || resume)
    }
    if (changed || resume) return createScheduleRecord(current.id, title, prompt, timing, now)
  } catch (error: unknown) {
    if (resume && !changed && error instanceof ScheduleInputError && error.code === 'not_future') {
      throw new ScheduleInputError('not_future', 'This task has no future occurrence. Set a future schedule before resuming it.')
    }
    throw error
  }
  return title === current.title && prompt.trim() === current.prompt ? current : Object.freeze({ ...current, title, prompt: prompt.trim() })
}
