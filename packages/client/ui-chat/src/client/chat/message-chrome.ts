// Shared time-label helpers for user/assistant IconActions rows.

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** The date-template share of the conversation dictionary the clock consumes. */
export type ClockTranslate = Translate<'clock.md' | 'clock.ymd'>

/** The elapsed-duration share of the conversation dictionary. */
export type RunDurationTranslate =
  Translate<'duration.secondUnit' | 'duration.minuteUnit' | 'duration.hourUnit'>

/** Refresh interval for whole-second live run clocks. */
export const LIVE_RUN_CLOCK_INTERVAL_MS = 1000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Local calendar-day epoch (ms at local midnight) for an instant.
 * @param ms - Unix epoch ms.
 * @returns Midnight of that local calendar day.
 */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Delay until the next local midnight after `ms` (at least 1ms).
 * @param ms - Unix epoch ms.
 * @returns Milliseconds until the following local midnight.
 */
export function msUntilNextLocalMidnight(ms: number): number {
  const next = new Date(ms)
  next.setHours(24, 0, 0, 0)
  return Math.max(next.getTime() - ms, 1)
}

/** One numeric value or localized unit in an elapsed-time label. */
export interface RunDurationPart {
  readonly text: string
  readonly numeric: boolean
}

/**
 * Build elapsed-time fragments for both live and completed Turn labels.
 * @param ms - elapsed milliseconds; negatives clamp to zero and fractions floor.
 * @param t - translate seat supplying units and their trailing spacing.
 * @returns numbers and localized units in display order, without leading zeros;
 * minutes start at 60 seconds and hours at 60 minutes.
 */
export function formatRunDuration(ms: number, t: RunDurationTranslate): RunDurationPart[] {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  const parts: RunDurationPart[] = []
  if (hours > 0) parts.push({ text: String(hours), numeric: true }, { text: t('duration.hourUnit'), numeric: false })
  if (total >= 60) parts.push({ text: String(minutes), numeric: true }, { text: t('duration.minuteUnit'), numeric: false })
  parts.push({ text: String(seconds), numeric: true }, { text: t('duration.secondUnit'), numeric: false })
  return parts
}

/**
 * Decode-throughput figure: whole tokens from ten up, one decimal below.
 * @param tps - Tokens per second.
 * @returns Display number without unit.
 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/**
 * Compact local timestamp for message IconActions. Same calendar day →
 * `HH:mm`; earlier this year → the `clock.md` date template + clock; other
 * years → the `clock.ymd` template + clock. Pure: the date templates arrive
 * through the caller's locale seat.
 * @param time - Unix epoch ms from the source session event.
 * @param t - translate seat supplying the `clock.md` / `clock.ymd` templates.
 * @param now - Reference instant for the day/year cut (defaults to wall clock).
 * @returns Date-aware clock string (24-hour, zero-padded time).
 */
export function formatMessageClock(time: number, t: ClockTranslate, now: number = Date.now()): string {
  const d = new Date(time)
  const n = new Date(now)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (
    d.getFullYear() === n.getFullYear()
    && d.getMonth() === n.getMonth()
    && d.getDate() === n.getDate()
  ) {
    return clock
  }
  const params = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }
  const md = d.getFullYear() === n.getFullYear() ? t('clock.md', params) : t('clock.ymd', params)
  return `${md} ${clock}`
}
