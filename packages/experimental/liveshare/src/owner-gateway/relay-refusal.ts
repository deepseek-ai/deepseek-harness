/**
 * When a Relay handshake response ends one registration for good.
 *
 * The Relay answers a gateway handshake it will not establish with an HTTP status instead of
 * upgrading. A credential the Relay does not accept (401), one it forbids for this share (403), or a
 * share it no longer serves (410), or an unsupported protocol (426) ends this registration.
 * Reconnecting with the same token and protocol reaches the same answer, so the share stays offline and the status becomes its diagnostic
 * instead of a silent retry. Every other failure — a Relay that is down (5xx), a rate limit, a
 * timeout, a refused socket — is transient and keeps the ordinary reconnect schedule.
 */

/** The Relay handshake statuses that end a registration for good. */
const RELAY_REFUSAL_STATUSES: readonly number[] = [401, 403, 410, 426]

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

/** The one form every permanent refusal reaches a Host as; nothing else composes it. */
const RELAY_REFUSAL_MESSAGE = /^relay refused registration status=(\d+)$/u

/**
 * Read one reported registration failure as the Relay status that decided it.
 *
 * The gateway reports a permanent refusal exactly as `relayRefusal` composes it, and every other
 * failure it reports — a status it did not refuse with, a dropped socket, a timeout — is worth
 * another attempt. A Host reading the message can therefore tell the owner to act on this address
 * instead of promising a retry that reaches the same answer, and can say which status decided it.
 * @param message - Failure the gateway reported for one registration.
 * @returns The refusing status, or undefined when the failure is worth retrying.
 */
export function relayRefusalStatus(message: string): number | undefined {
  const match = RELAY_REFUSAL_MESSAGE.exec(message)
  if (match === null) return undefined
  const status = Number(match[1])
  return RELAY_REFUSAL_STATUSES.includes(status) ? status : undefined
}
