import { z } from 'zod'
import type { Activity, IntervalReport, TimeRange } from './records.ts'
import { HISTORY_MS, MINUTE_MS } from './policy.ts'

const periodPolicy = z.array(z.number().positive().max(86400000)).min(1).max(5)

/**
 * Union recorded intervals without inventing activity across gaps.
 * @param ranges - ranges to merge.
 * @returns ordered, nonoverlapping ranges.
 */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const result: TimeRange[] = []
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (end <= start) continue
    const last = result.at(-1)
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else result.push([start, end])
  }
  return result
}

/**
 * Public turn brackets are the timing authority; an open turn is clipped at the requested boundary.
 * @param activity - recorded session activity.
 * @param start - lower time bound in milliseconds.
 * @param end - upper time bound in milliseconds.
 * @returns activity within the requested bounds.
 */
export function activeRanges(
  activity: Activity,
  start: number,
  end: number,
): TimeRange[] {
  return mergeRanges(
    [...activity.ranges, ...(activity.open === null ? [] : [[activity.open, end] as TimeRange])]
      .map(([a, b]): TimeRange => [Math.max(a, start), Math.min(b, end)])
      .filter(([a, b]) => b > a),
  )
}

/**
 * Captured report timing is immutable; old reports can use retained Session evidence.
 * @param report - the saved report to inspect.
 * @param activity - recorded session activity.
 * @returns the report's recorded ranges or reconstructed activity.
 */
export function reportRanges(report: IntervalReport, activity: Activity | undefined): TimeRange[] | undefined {
  return report.ranges ??
    (activity !== undefined && report.start >= activity.start ? activeRanges(activity, report.start, report.end) : undefined)
}

/**
 * A saved report keeps its original nominal period when live settings change.
 * @param report - the saved report to inspect.
 * @returns the report's configured period, when known.
 */
export function savedPeriod(report: IntervalReport): number | undefined {
  try {
    const values = periodPolicy.parse(JSON.parse(report.policy))
    if (report.level >= values.length) return undefined
    return values.slice(0, report.level + 1).reduce((period, factor) => Math.round(period * factor))
  } catch {
    return undefined
  }
}

/**
 * Minimum elapsed-time thresholds; actual work remains separate from report coverage.
 * @param policy - configured interval and rollup periods.
 * @returns each report level's period in milliseconds.
 */
export function reportPeriods(
  policy: { intervalMs: number; rollupFactors: readonly number[] },
): number[] {
  const periods = [policy.intervalMs]
  let period = policy.intervalMs
  for (const factor of policy.rollupFactors) {
    period = Math.round(period * factor)
    periods.push(period)
  }
  return periods
}

/**
 * Check that each report level is reachable before its child reports expire.
 * @param periods - ordered report periods in milliseconds, starting with the base.
 * @returns whether the cadence can be saved and scheduled.
 */
export function validReportPeriods(periods: readonly number[]): boolean {
  const base = periods[0]
  return base !== undefined && base <= 86400000 && periods.length <= 5 &&
    periods.every((period, index) =>
      Number.isSafeInteger(period) && period >= MINUTE_MS && period <= HISTORY_MS &&
      period > (periods[index - 1] ?? 0))
}

/**
 * Format a configured report period for display.
 * @param ms - duration in milliseconds.
 * @returns a compact interval label.
 */
export function formatPeriod(ms: number): string {
  const [unit, size] =
    ms >= 86400000
      ? ['d', 86400000] as const
      : ms >= 3600000
        ? ['h', 3600000] as const
        : ms >= 60000
          ? ['m', 60000] as const
          : ['s', 1000] as const
  return `${Number((ms / size).toFixed(2))}${unit}`
}

/**
 * Stable human-readable elapsed time without rapidly changing decimal minutes.
 * @param ms - duration in milliseconds.
 * @returns a compact elapsed time label.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}
