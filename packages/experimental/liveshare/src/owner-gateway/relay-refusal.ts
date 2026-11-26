/**
 * When a Relay handshake response ends one registration for good.
 *
 * The Relay answers a gateway handshake it will not establish with an HTTP status instead of
 * upgrading. A credential the Relay does not accept (401), one it forbids for this share (403), a
 * share it no longer serves (404 or 410), or an unsupported protocol (426) ends this registration.
 * Reconnecting with the same token and protocol reaches the same answer, so the share stays offline and the status becomes its diagnostic
 * instead of a silent retry. Every other failure — a Relay that is down (5xx), a rate limit, a
 * timeout, a refused socket — is transient and keeps the ordinary reconnect schedule, bounded by
 * {@link RELAY_TRANSIENT_ATTEMPT_LIMIT} attempts and {@link RELAY_TRANSIENT_WINDOW_MS} of elapsed
 * time so an unavailable Relay cannot be retried forever.
 */

/** The Relay handshake statuses that end a registration for good. */
const RELAY_REFUSAL_STATUSES: readonly number[] = [401, 403, 404, 410, 426]

/** Failed dials allowed without an intervening admission. */
export const RELAY_TRANSIENT_ATTEMPT_LIMIT = 20

/** Maximum time from the first unadmitted dial, including handshakes and backoff delays. */
export const RELAY_TRANSIENT_WINDOW_MS = 3_600_000

/**
 * Read one handshake status as a decision about the registration it carried.
 * @param status HTTP status the Relay answered the gateway handshake with, if it answered.
 * @returns The refusal to report, or undefined when the failure is worth retrying.
 */
export function relayRefusal(status: number | undefined): string | undefined {
  if (status !== undefined && RELAY_REFUSAL_STATUSES.includes(status)) {
    return `relay refused registration status=${String(status)}`
  }
  return undefined
}
