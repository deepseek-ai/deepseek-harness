/** Shared admission cutoff and bounded settlement for the Team runtime. */

import { TeamError } from './error.ts'

/** Owns the single Team runtime cancellation fact and disposal timeout. */
export class TeamRuntimeLifecycle {
  private readonly operations = new Set<Promise<unknown>>()
  private readonly controller = new AbortController()

  /**
   * @param disposalTimeoutMs - maximum wait for one disposal settlement operation.
   */
  constructor(private readonly disposalTimeoutMs: number) {}

  /** Signal aborted exactly when Team runtime admission closes. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Whether Team runtime admission is closed. */
  get disposed(): boolean {
    return this.signal.aborted
  }

  /** The exact cancellation reason used to distinguish expected disposal rejection. */
  get reason(): unknown {
    const reason: unknown = this.signal.reason
    return reason
  }

  /** Whether a rejection is the runtime cancellation, directly or through an Error cause chain. */
  private isCancellation(reason: unknown): boolean {
    const seen = new Set<unknown>()
    let current = reason
    while (!seen.has(current)) {
      if (this.disposed && current === this.reason) return true
      if (this.disposed && current instanceof TeamError && current.code === 'TEAM_DISPOSED') return true
      if (!(current instanceof Error)) return false
      seen.add(current)
      current = current.cause
    }
    return false
  }

  /** Close Team runtime admission and cancel admitted interruptible work. */
  close(): void {
    this.controller.abort(new TeamError('Agent Teams service disposed', 'TEAM_DISPOSED'))
  }

  /**
   * Track an admitted send or complete creation transaction until it settles.
   * @param operation - asynchronous work owned by this runtime.
   * @returns the same operation.
   */
  track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(() => { this.operations.delete(operation) }, () => { this.operations.delete(operation) })
    return operation
  }

  /**
   * Capture outstanding operations after closing admission.
   * @returns admitted work still awaiting settlement.
   */
  pending(): readonly Promise<unknown>[] {
    return [...this.operations]
  }

  /**
   * Await admitted operations and retain failures other than runtime cancellation.
   * @param operations - admitted operations captured after the admission cutoff.
   * @param failures - aggregate destination for unexpected rejection or timeout.
   */
  async settle(operations: readonly Promise<unknown>[], failures: unknown[]): Promise<void> {
    if (operations.length === 0) return
    try {
      const outcomes = await this.withTimeout(Promise.allSettled(operations))
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected' && !this.isCancellation(outcome.reason)) failures.push(outcome.reason)
      }
    } catch (error: unknown) {
      failures.push(error)
    }
  }

  /**
   * Bound one runtime settlement operation.
   * @param operation - settlement that may otherwise block HMR or process shutdown.
   * @returns the operation result.
   */
  async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new TeamError(
          `Agent Teams runtime disposal exceeded ${this.disposalTimeoutMs}ms`,
          'TEAM_DISPOSAL_TIMEOUT',
        ))
      }, this.disposalTimeoutMs)
    })
    try {
      return await Promise.race([operation, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
