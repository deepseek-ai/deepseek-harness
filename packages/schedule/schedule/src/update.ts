/** Optimistic name, instruction, and timing updates of retained Host tasks, without Session mutations. */
import { isDeepStrictEqual } from 'node:util'
import {
  canonicalizeCronExpression, canonicalizeTimeZone, createAtScheduleRecord, createCronScheduleRecord,
  createDailyScheduleRecord, createEveryScheduleRecord, createWeeklyScheduleRecord, decodeScheduleRecord,
  decodeStoredTitle, parseAtInput, parseCronInput, parseDailyInput, parseWeeklyInput,
  ScheduleInputError, ScheduleLogError, scheduleTitle,
} from './domain.ts'
import type { ScheduleRecord, ScheduleTimingChange, ScheduleUpdateContent, ScheduleUpdateResult } from './types.ts'

/** Name the exact selector property each timing kind must carry, or undefined for an unknown discriminant. */
function timingSelector(kind: string): string | undefined {
  switch (kind) {
    case 'at': return 'at'
    case 'every': return 'every_seconds'
    case 'daily': return 'daily'
    case 'weekly': return 'weekly'
    case 'cron': return 'cron'
    default: return undefined
  }
}

/**
 * Validate the exact timing selector keys received over RPC.
 * @param value - Untrusted timing change; the wire can carry a null, array, or foreign discriminant.
 * @returns The same value narrowed to the closed timing-change union.
 */
function validateChange(value: unknown): ScheduleTimingChange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScheduleInputError('invalid_rule', 'Timing change must be an object with exactly one supported timing selector.')
  }
  const change = value as ScheduleTimingChange
  const selector = timingSelector(change.kind)
  const keys = Object.keys(change)
  if (selector === undefined || keys.length !== 2 || !keys.includes('kind') || !keys.includes(selector)) {
    throw new ScheduleInputError('invalid_rule', 'Timing change must contain exactly kind and its matching timing selector.')
  }
  return change
}

/**
 * Validate a replacement instruction received over RPC.
 * @param prompt - Untrusted instruction value; the wire can carry a non-string.
 * @returns The trimmed instruction; an invalid instruction throws ScheduleInputError.
 */
function schedulePrompt(prompt: string): string {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  return prompt.trim()
}

/**
 * Title one update must either keep or replace.
 *
 * A decoded record always carries a stored title. A record value without a
 * valid one is refused with the durable decode error instead of deriving a name.
 * @param record - Current active Host record.
 * @returns The stored title; a missing, blank, untrimmed, or over-long title throws ScheduleLogError.
 */
export function retainedTitle(record: ScheduleRecord): string {
  return decodeStoredTitle(record.title)
}

/**
 * Apply a replacement name and instruction to a stored record without touching its rule.
 * @param current - Current active record holding the committed target.
 * @param title - Validated replacement or retained name.
 * @param prompt - Validated replacement or retained instruction.
 * @returns The same record when both are unchanged, otherwise a frozen copy with the new content.
 */
function withContent(current: ScheduleRecord, title: string, prompt: string): ScheduleRecord {
  return title === current.title && prompt === current.prompt
    ? current
    : Object.freeze({ ...current, title, prompt })
}

/**
 * Resolve the requested rule against the current record after the complete expected record has matched.
 *
 * The change kind may differ from the current record's kind; a change whose normalized
 * timing equals the current rule keeps the committed target and only applies the supplied
 * name and instruction, while any other change recomputes the target exactly as creation
 * computes it from the same now.
 */
function changedRecord(
  current: ScheduleRecord,
  title: string,
  prompt: string,
  value: ScheduleTimingChange | undefined,
  now: number,
): ScheduleRecord {
  if (value === undefined) return withContent(current, title, prompt)
  const change = validateChange(value)
  switch (change.kind) {
    case 'at':
      if ((current.kind === 'after' || current.kind === 'at')
        && parseAtInput(change.at) === Date.parse(current.scheduledAt)) return withContent(current, title, prompt)
      return createAtScheduleRecord(current.id, prompt, change.at, now, title)
    case 'every':
      if (current.kind === 'every' && change.every_seconds === current.everySeconds) {
        return withContent(current, title, prompt)
      }
      return createEveryScheduleRecord(current.id, prompt, change.every_seconds, now, title)
    case 'daily': {
      if (current.kind === 'daily') {
        const normalized = parseDailyInput(change.daily)
        if (normalized.time === current.time
          && normalized.timeZone === canonicalizeTimeZone(current.timeZone)) return withContent(current, title, prompt)
      }
      return createDailyScheduleRecord(current.id, prompt, change.daily, now, title)
    }
    case 'weekly': {
      if (current.kind === 'weekly') {
        const normalized = parseWeeklyInput(change.weekly)
        if (normalized.time === current.time
          && normalized.timeZone === canonicalizeTimeZone(current.timeZone)
          && isDeepStrictEqual(normalized.weekdays, current.weekdays)) return withContent(current, title, prompt)
      }
      return createWeeklyScheduleRecord(current.id, prompt, change.weekly, now, title)
    }
    case 'cron': {
      if (current.kind === 'cron') {
        const normalized = parseCronInput(change.cron)
        if (normalized.expression === canonicalizeCronExpression(current.expression)
          && normalized.timeZone === canonicalizeTimeZone(current.timeZone)) return withContent(current, title, prompt)
      }
      return createCronScheduleRecord(current.id, prompt, change.cron, now, title)
    }
    /* v8 ignore next 4 -- validateChange rejects unknown discriminants before this closed union switch. */
    default: {
      const unreachable: never = change
      throw new Error(`Unknown validated timing change: ${String(unreachable)}`)
    }
  }
}

/**
 * Compare the complete observed record and resolve one name, instruction, and timing update
 * using a single queue-time sample.
 *
 * An omitted change, name, or instruction keeps the stored value. A supplied name or
 * instruction never re-anchors the schedule on its own; an equivalent normalized timing
 * change keeps the committed target too.
 * @param current - Current active Host record.
 * @param expected - Untrusted complete record observed by the caller.
 * @param change - Strict timing selector, whose kind may differ from the current record's kind, or undefined to keep timing.
 * @param now - Single wall-clock sample from the accepted FIFO slot.
 * @param content - Untrusted replacement name and instruction; each omitted field keeps its stored value.
 * @returns Current/new record or a bounded input/conflict result; unrelated failures throw.
 */
export function resolveScheduleUpdate(
  current: ScheduleRecord,
  expected: ScheduleRecord,
  change: ScheduleTimingChange | undefined,
  now: number,
  content: ScheduleUpdateContent = {},
): ScheduleUpdateResult {
  let decoded: ScheduleRecord
  try {
    decoded = decodeScheduleRecord(expected)
  } catch (error) {
    if (!(error instanceof ScheduleLogError)) throw error
    return { code: 'invalid_rule', message: 'expected must be a complete valid Schedule record.' }
  }
  if (!isDeepStrictEqual(current, decoded)) {
    return { id: current.id, updated: false, code: 'schedule_conflict' }
  }
  try {
    const retained = retainedTitle(current)
    const title = content.title === undefined ? retained : scheduleTitle(content.title)
    const prompt = content.prompt === undefined ? current.prompt : schedulePrompt(content.prompt)
    const record = changedRecord(current, title, prompt, change, now)
    return { id: current.id, updated: record !== current, record }
  } catch (error) {
    if (!(error instanceof ScheduleInputError)) throw error
    return { code: error.code, message: error.message }
  }
}
