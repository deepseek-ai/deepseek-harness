/** Reconnection lifecycle for the browser Client bridge. */

/** Owns one bounded-backoff timer and prevents reconnection after disposal. */
export class ClientBridgeLifecycle {
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(
    private readonly baseDelayMs: number,
    private readonly maxDelayMs: number,
  ) {}

  /** Reset backoff after the Worker accepts a source generation. */
  connected(): void {
    this.reconnectAttempt = 0
  }

  /**
   * Schedule the next reconnect attempt unless one is already pending.
   * @param connect - Operation that opens the next transport generation.
   */
  reconnect(connect: () => void): void {
    if (this.reconnectTimer !== undefined || this.closed) return
    const cap = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.reconnectAttempt)
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      connect()
    }, cap / 2 + Math.random() * cap / 2)
  }

  /** Stop pending and future reconnect attempts. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.cancelReconnect()
  }

  /** Cancel a scheduled attempt while the page is outside its active lifetime. */
  cancelReconnect(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }
}
