/** Poll cadence for watched change requests. */

import type { ChangeRequestBrief } from './types.ts'

/** Resolved intervals that pace polling. */
export interface PollIntervals {
  /** Delay while checks run, and once after a status first reports an unknown mergeability. */
  readonly activeIntervalMs: number
  /** Delay for a closed request or an open request whose checks have settled. */
  readonly idleIntervalMs: number
  /** Largest delay after consecutive failures. */
  readonly maxBackoffMs: number
}

/**
 * Choose the delay before the poll after a status. Merged change requests stop
 * polling, while closed ones use the idle cadence to detect reopening. An
 * unknown mergeability, which a code host reports while it computes one, earns
 * the active interval for one poll; a change request that reports it again
 * waits the idle interval, because some never report another value.
 * @param status - state of the latest snapshot or brief.
 * @param intervals - configured cadence.
 * @param unknownBefore - whether the status before `status` also reported an unknown mergeability.
 * @returns the delay in milliseconds, or undefined after a terminal state.
 */
export function nextPollDelay(
  status: Pick<ChangeRequestBrief, 'state' | 'mergeability' | 'checksRollup'>,
  intervals: PollIntervals,
  unknownBefore: boolean,
): number | undefined {
  if (status.state === 'merged') return undefined
  if (status.state === 'closed') return intervals.idleIntervalMs
  const computing = status.mergeability === 'unknown' && !unknownBefore
  return status.checksRollup === 'pending' || computing ? intervals.activeIntervalMs : intervals.idleIntervalMs
}

/**
 * Choose the delay before the poll after a failed one: the active interval doubled for each consecutive failure, up
 * to `maxBackoffMs`.
 * @param failures - consecutive failures, counting the latest.
 * @param intervals - configured cadence.
 * @returns the delay in milliseconds.
 */
export function backoffDelay(failures: number, intervals: PollIntervals): number {
  return Math.min(intervals.maxBackoffMs, intervals.activeIntervalMs * 2 ** failures)
}
