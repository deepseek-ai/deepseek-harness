/** Single-consumer queue that turns Host callbacks into a Remote stream. */

/** Items pushed before iteration are retained; pushes after the stream ends are ignored. */
export class AsyncChannel<T> {
  private readonly items: T[] = []
  private waiter: (() => void) | undefined
  private done = false
  private failure: { readonly error: unknown } | undefined

  /**
   * Queue one item unless the stream has ended.
   * @param item - Next stream item.
   */
  push(item: T): void {
    if (this.done) return
    this.items.push(item)
    this.waiter?.()
  }

  /** End the stream after already queued items. */
  end(): void {
    this.done = true
    this.waiter?.()
  }

  /**
   * End the stream with a rejection unless it has already ended.
   * @param error - Rejection delivered after already queued items.
   */
  fail(error: unknown): void {
    if (this.done) return
    this.failure = { error }
    this.end()
  }

  /**
   * Deliver queued items until the stream ends, fails, or its consumer cancels.
   * @param signal - Consumer lifetime; cancellation ends the stream.
   * @param closed - Runs once after the consumer stops reading.
   * @returns The single iteration of this channel.
   */
  async *iterate(signal: AbortSignal, closed: () => void = () => {}): AsyncGenerator<T, void, undefined> {
    const abort = (): void => { this.end() }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) this.end()
    try {
      while (true) {
        const next = this.items.shift()
        if (next !== undefined) { yield next; continue }
        if (this.failure !== undefined) throw this.failure.error
        if (this.done) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.end()
      closed()
    }
  }
}
