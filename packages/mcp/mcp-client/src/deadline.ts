/** Shared settlement deadline for the startup and probe budgets. */

import { McpLocalError } from './diagnostic.ts'

/**
 * Settle with `promise`, or reject with an `MCP_TIMEOUT` {@link McpLocalError}
 * carrying `timeoutMessage` once `remainingMs` elapses first. The timer never holds the process open, and a non-Error
 * rejection is wrapped so callers always observe an Error.
 * @param promise - operation the deadline bounds.
 * @param remainingMs - remaining budget in milliseconds (clamped to at least 1).
 * @param timeoutMessage - diagnostic carried by the deadline rejection.
 * @returns the operation's value; rejects with the deadline or the operation's failure.
 */
export function withDeadline<T>(promise: Promise<T>, remainingMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpLocalError(timeoutMessage, 'MCP_TIMEOUT'))
    }, Math.max(1, remainingMs))
    timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
