/** One-shot Team change waiters independent of durable state projection. */

import type { TeamId, TeamWaitResult } from './types.ts'
import { inspect } from 'node:util'
import { TeamError } from './error.ts'

/** Render a non-Error abort reason in one bounded line. */
function abortDescription(reason: unknown): string {
  return typeof reason === 'string' ? reason : inspect(reason, { breakLength: Infinity, compact: true, depth: 4 })
}

interface Waiter {
  readonly resolve: () => void
}

/** Owns current Team change waiters and releases each at most once. */
export class TeamActivity {
  private readonly waiters = new Map<TeamId, Set<Waiter>>()

  /**
   * Wait for one later Team-domain or member-status change.
   * @param id - Team whose next edge wakes the caller.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for this wait only.
   * @returns whether the wait ended by timeout.
   */
  async wait(id: TeamId, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
      throw new TeamError('timeoutMs must be an integer from 10000 through 3600000', 'TEAM_INVALID_TIMEOUT')
    }
    signal.throwIfAborted()
    const changed = await new Promise<boolean>((resolve, reject) => {
      let waiters = this.waiters.get(id)
      if (waiters === undefined) {
        waiters = new Set()
        this.waiters.set(id, waiters)
      }
      let settled = false
      const finish = (settle: () => void): void => {
        /* v8 ignore next -- timeout, abort, and notification may race after one winner removes the others. */
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) this.waiters.delete(id)
        settle()
      }
      const onAbort = (): void => {
        finish(() => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error
            ? reason
            : new TeamError(`wait_agent aborted: ${abortDescription(reason)}`, 'TEAM_WAIT_ABORTED'))
        })
      }
      const waiter: Waiter = {
        resolve: () => {
          finish(() => { resolve(true) })
        },
      }
      waiters.add(waiter)
      const timer = setTimeout(() => { finish(() => { resolve(false) }) }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      // AbortSignal does not replay an abort that wins between the pre-check and listener registration.
      /* v8 ignore next -- requires an abort in the synchronous gap between the pre-check and listener registration. */
      if (signal.aborted) onAbort()
    })
    return { timedOut: !changed }
  }

  /**
   * Wake and remove every current waiter for one Team.
   * @param id - Team whose current waiters observe the change.
   */
  notify(id: TeamId): void {
    const waiters = this.waiters.get(id)
    if (waiters === undefined) return
    this.waiters.delete(id)
    for (const waiter of waiters) waiter.resolve()
  }

  /** Wake every current waiter during runtime disposal; the disposed service admits no later wait. */
  close(): void {
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.resolve()
    }
    this.waiters.clear()
  }
}
