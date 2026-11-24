/** Internal wall-clock wakeups submitted to the owning Schedule runtime. */

/** Largest delay Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** One segmented timer and a coalesced sequence of acknowledged time signals. */
export class TimeSource {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private requested = false
  private closing: Promise<void> | undefined

  /**
   * @param onTime - Resolves when the due-task scan has settled.
   * @param reportFailure - Reports a failed callback without retrying it; this callback must not throw.
   */
  constructor(
    private readonly onTime: () => Promise<void>,
    private readonly reportFailure: (error: unknown) => void,
  ) {}

  /** Request a time signal without waiting for its callback; requests during a callback coalesce into one next signal. */
  request(): void {
    if (this.closing !== undefined) return
    this.requested = true
    this.arm(undefined)
    if (this.running === undefined) this.running = this.dispatch()
  }

  /**
   * Replace the timer without waiting for an in-flight callback. Each long-wait segment produces a time signal.
   * @param next - Finite epoch milliseconds for the next wakeup, or undefined to cancel the timer.
   */
  arm(next: number | undefined): void {
    if (this.closing !== undefined) return
    this.clearTimer()
    if (next === undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.request()
    }, Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS)))
    this.timer.unref()
  }

  /** Stop new wakeups immediately, then await the accepted callback; repeated calls join the same cleanup. */
  dispose(): Promise<void> {
    if (this.closing === undefined) {
      this.requested = false
      this.clearTimer()
      this.closing = Promise.allSettled([this.running]).then(() => {})
    }
    return this.closing
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async dispatch(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false
        this.clearTimer()
        await Promise.resolve().then(() => this.onTime())
      }
    } catch (error: unknown) {
      this.reportFailure(error)
    } finally {
      this.running = undefined
      if (this.requested) this.request()
    }
  }
}
