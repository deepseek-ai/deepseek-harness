/** Reference clock for the relative "time remaining" text. */
import { useEffect, useState } from 'react'

/**
 * Refresh period for relative-time text.
 *
 * The text names whole seconds, minutes, hours, or days, so a half-minute
 * period keeps it correct to its own granularity without re-rendering a mounted
 * page on every frame.
 */
export const RELATIVE_CLOCK_PERIOD_MS = 30_000

/** Longest delay a timer holds, about 24.8 days; a longer delay fires at once. */
const TIMER_LIMIT_MS = 2 ** 31 - 1

/**
 * Current epoch milliseconds, re-sampled on a fixed period.
 *
 * A relative duration is read against the moment it renders, not against the
 * moment its component mounted: a page left open across a delivery would keep
 * showing the time until the previous target.
 *
 * This is the shared clock of the mounted task page and its detail, the two
 * surfaces that sit side by side and must not disagree about how long remains.
 * Two other surfaces keep their own beat: the Session-header catalog reads
 * `Date.now()` and then a one-second interval while its popover is open, and the
 * Sidebar Session-row hover card samples `Date.now()` once per mount, because
 * that preview must not drift while the pointer rests on it.
 *
 * A state that ends between two periods, such as the delivery floor that holds
 * Run now, passes its end as `wakeAt` so the clock samples it then instead of
 * up to one period late.
 * @param periodMs - refresh period; defaults to {@link RELATIVE_CLOCK_PERIOD_MS}.
 * @param wakeAt - epoch milliseconds of one extra sample; an instant already past samples at once.
 *   An instant beyond the timer limit, about 24.8 days ahead, is left to the period.
 * @returns epoch milliseconds, updated once per period and at `wakeAt`.
 */
export function useRelativeClock(periodMs: number = RELATIVE_CLOCK_PERIOD_MS, wakeAt?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, periodMs)
    return () => { clearInterval(timer) }
  }, [periodMs])
  useEffect(() => {
    if (wakeAt === undefined || wakeAt - Date.now() > TIMER_LIMIT_MS) return
    // Date.now() can read slightly behind the timer's own clock, so the sample is never earlier than `wakeAt`.
    const timer = setTimeout(() => { setNow(Math.max(Date.now(), wakeAt)) }, Math.max(0, wakeAt - Date.now()))
    return () => { clearTimeout(timer) }
  }, [wakeAt])
  return now
}
