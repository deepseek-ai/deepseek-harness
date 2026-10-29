/** Controllable `ws` replacement for the in-process gateway worker lifecycle spec. */

import { EventEmitter } from 'node:events'

/**
 * One gateway socket whose lifecycle the spec drives synchronously.
 *
 * The worker owns the real handshake and heartbeat schedule; a socket double keeps their timing
 * deterministic while still delivering the same `open`/`message`/`close`/`error` events.
 */
export class FakeWebSocket extends EventEmitter {
  /** `WebSocket.OPEN`, read by the worker and `sendFrame`. */
  static readonly OPEN = 1

  /** `WebSocket.CLOSING`, accepted by callers that inspect the socket state. */
  static readonly CLOSING = 2

  /** `WebSocket.CLOSED`. */
  static readonly CLOSED = 3

  /** Every socket the worker constructed, in creation order. */
  static readonly instances: FakeWebSocket[] = []

  /**
   * Deliver a terminated socket's close on the next microtask.
   *
   * Real transports report `close` after the error that terminated them, so a spec that emits that
   * error from inside the handshake failure needs one turn before the close handler runs.
   */
  static deferClose = false

  /** State the worker reads before sending or pinging. */
  readyState = 0

  /** Raw frames the worker wrote to this socket. */
  readonly sent: string[] = []

  /** Pings the worker issued on this socket. */
  pingCount = 0

  /** Whether the worker terminated this socket rather than closing it cleanly. */
  terminated = false

  /**
   * Record one construction by the worker.
   * @param url Registration URL the worker built.
   * @param options Socket options carrying the handshake headers.
   */
  constructor(readonly url: URL, readonly options: { readonly headers?: Readonly<Record<string, string>> }) {
    super()
    FakeWebSocket.instances.push(this)
  }

  /** Complete the handshake. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open')
  }

  /** Count one heartbeat ping. */
  ping(): void {
    this.pingCount += 1
  }

  /**
   * Record one outgoing frame.
   * @param data Serialized frame.
   */
  send(data: string): void {
    this.sent.push(data)
  }

  /**
   * Close the socket and report it once.
   * @param code Close code.
   * @param reason Close reason.
   */
  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', code, Buffer.from(reason))
  }

  /**
   * Report a close without the socket going through its own transition again.
   *
   * A transport may surface a late close for a connection the worker already replaced; the
   * replacement guard must observe that event, not just the first close of each socket.
   * @param code Close code.
   * @param reason Close reason.
   */
  reportClose(code = 1006, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', code, Buffer.from(reason))
  }

  /** Abort the socket the way a failed transport does. */
  terminate(): void {
    this.terminated = true
    if (FakeWebSocket.deferClose) {
      this.readyState = FakeWebSocket.CLOSING
      void Promise.resolve().then(() => { this.close(1006) })
      return
    }
    this.close(1006)
  }

  /**
   * Deliver one decoded frame.
   * @param value Frame object serialized as the Relay would send it.
   */
  frame(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)))
  }

  /**
   * Deliver one raw socket message.
   * @param text Message text.
   */
  raw(text: string): void {
    this.emit('message', Buffer.from(text))
  }

  /**
   * Report a transport failure.
   * @param error Failure value.
   */
  fail(error: Error | string): void {
    this.emit('error', error)
  }

  /**
   * Report a refused handshake.
   * @param statusCode HTTP status the Relay answered with.
   */
  refuseHandshake(statusCode: number): void {
    this.emit('unexpected-response', {}, { statusCode })
  }
}
