/**
 * Wake bookkeeping shared by the two observation generators: a wake-flag
 * waiter that never loses a wake between waits, and an abortable sleep that
 * coalesces bursts into bounded frames.
 * @module @deepseek-ai/dsh-api-job-controller/wake
 */

/** Wake-flag waiter: a wake between waits is never lost. */
export class OutputWaiter {
  private dirty = false
  private resolve: (() => void) | undefined

  /** Record one wake; releases a pending wait or arms the next one. */
  wake(): void {
    this.dirty = true
    this.resolve?.()
  }

  /**
   * Resolve on the next wake, immediately when one already arrived, or on abort.
   * @param signal - generation cancellation.
   * @returns settles when woken or aborted.
   */
  wait(signal: AbortSignal): Promise<void> {
    if (this.dirty || signal.aborted) {
      this.dirty = false
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one wait owns the sole installed resolver. */
        if (this.resolve === finish) this.resolve = undefined
        this.dirty = false
        resolve()
      }
      this.resolve = finish
      signal.addEventListener('abort', finish, { once: true })
    })
  }
}

/**
 * Sleep for the coalescing window, or return at once when aborted.
 * @param ms - window in milliseconds.
 * @param signal - generation cancellation.
 * @returns settles after the window or on abort.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
