/** Foreground question lifetime and Client claims; durable question state stays in the projection. */

/** One live foreground wait, counted by the Host only while no answer UI holds it. */
export class TimedQuestionWait {
  private readonly controller = new AbortController()
  private readonly completion = Promise.withResolvers<void>()
  private readonly claims = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param deadline - Host-clock deadline used while no Client holds the wait.
   * @param parent - Calling Turn's cancellation signal.
   * @param timeout - Business error used to settle an unattended wait.
   */
  constructor(
    readonly deadline: number,
    private readonly parent: AbortSignal | undefined,
    private readonly timeout: Error,
  ) {
    parent?.addEventListener('abort', this.parentAborted, { once: true })
    if (parent?.aborted === true) this.parentAborted()
    else this.schedule()
  }

  /** Cancellation shared with the foreground waterfall, not with the calling Turn. */
  get signal(): AbortSignal { return this.controller.signal }

  /** Settles when the wait is cancelled, expires, or is disposed. */
  get done(): Promise<void> { return this.completion.promise }

  private readonly parentAborted = (): void => { this.close(this.parent?.reason) }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.signal.aborted || this.claims.size > 0) return
    this.timer = setTimeout(() => { this.close(this.timeout) }, Math.max(0, this.deadline - Date.now()))
  }

  /**
   * Hold the wait for one answer UI until its stream closes or the question settles.
   * @param signal - This business stream's cancellation lifetime.
   * @returns One remaining-duration frame; completion releases the claim.
   */
  async *attach(signal: AbortSignal): AsyncIterable<{ remainingMs: number }> {
    if (signal.aborted || this.signal.aborted) return
    if (this.claims.size === 0 && Date.now() >= this.deadline) {
      this.close(this.timeout)
      return
    }
    const ended = Promise.withResolvers<void>()
    const release = (): void => {
      if (!this.claims.delete(release)) return
      signal.removeEventListener('abort', release)
      this.signal.removeEventListener('abort', release)
      ended.resolve()
      this.schedule()
    }
    this.claims.add(release)
    signal.addEventListener('abort', release, { once: true })
    this.signal.addEventListener('abort', release, { once: true })
    this.schedule()
    try {
      yield { remainingMs: Math.max(0, this.deadline - Date.now()) }
      await ended.promise
    } finally {
      release()
    }
  }

  /**
   * Release timers, parent cancellation, and all Client claims.
   * @param reason - Cancellation delivered to the foreground waterfall.
   */
  close(reason: unknown): void {
    if (this.signal.aborted) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.parent?.removeEventListener('abort', this.parentAborted)
    this.controller.abort(reason)
    this.completion.resolve()
  }
}
