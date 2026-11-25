/**
 * Delay schedule for one connection that keeps failing.
 *
 * The owner host's worker supervisor and the gateway's per-share Relay socket both reconnect rather
 * than give up, and both treat a connection that stayed up long enough as healthy, so the failure
 * after one starts the delays over instead of continuing the previous run's growth. Extracted from
 * the socket lifecycle so the schedule is deterministic and testable apart from spawning processes.
 */

/** Progress of one reconnect sequence. */
export interface RetryBackoff {
  /** Delay to wait before the next attempt. */
  readonly delayMs: number
  /** Attempts since the last stable connection. */
  readonly attempt: number
}

/** Delay before the first reconnect in a sequence; also the schedule of one not yet proven stable. */
const INITIAL_RETRY_DELAY_MS = 500

/** Schedule of a connection that has not (yet) proven itself stable. */
export const INITIAL_RETRY_BACKOFF: RetryBackoff = { delayMs: INITIAL_RETRY_DELAY_MS, attempt: 0 }

/**
 * Ceiling for the doubling delay of one share's Relay connection: a failing peer is retried, never
 * hammered.
 *
 * That connection stops after a bounded number of attempts or a bounded time, so this ceiling is the
 * interval between those attempts near their end rather than a pace that runs for as long as the
 * process lives. Three minutes keeps a peer that recovers during an outage within that bound rather
 * than only after the next worker restart, while the hour those attempts span stays a handful of
 * probes instead of a request every few seconds.
 */
export const RETRY_BACKOFF_MAX_MS = 180_000

/**
 * Ceiling for the supervisor's delay before it replaces a crashed worker.
 *
 * Nothing bounds that replacement except this ceiling, and every share is offline while it waits:
 * the delay settles at ten seconds so a worker that keeps exiting is still retried while the owner
 * is using the share, instead of leaving every share offline for trips as long as the Relay
 * connection's own ceiling.
 */
export const RESTART_BACKOFF_MAX_MS = 10_000

/**
 * A connection that stays up this long is healthy, so the next failure starts the delays over.
 * A peer that replaces the connection right after the handshake keeps the previous backoff instead
 * of retrying every 500 ms.
 */
export const RETRY_STABLE_MS = 30_000

/**
 * Advance the schedule after one failed attempt.
 * @param state Backoff of the attempt that just failed.
 * @param maxDelayMs Ceiling this sequence grows to, so each reconnect keeps the ceiling its own recovery needs.
 * @returns Schedule the retry starts from: the delay to wait and the state after that attempt.
 */
export function retryBackoffNext(state: RetryBackoff, maxDelayMs: number): RetryBackoff {
  return { delayMs: Math.min(state.delayMs * 2, maxDelayMs), attempt: state.attempt + 1 }
}

/**
 * Schedule for a connection that has proven itself stable.
 * @returns The schedule's first entry, so the next failure is retried promptly.
 */
export function retryBackoffSettled(): RetryBackoff {
  return INITIAL_RETRY_BACKOFF
}
