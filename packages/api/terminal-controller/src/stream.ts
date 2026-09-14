/** A bounded output queue for one Remote stream generation. */
import { Deque } from '@deepseek-ai/dsh-deque'
import type { TerminalFrame } from './types.ts'

/** Slow followers fail explicitly; a later attachment recovers from the screen. */
export class TerminalFollower {
  private readonly queue = new Deque<{ frame: TerminalFrame; bytes: number }>()
  private bytes = 0
  private wake: (() => void) | undefined
  private closed = false
  private finished = false
  private failure: Error | undefined

  /** @param maxBytes - maximum queued UTF-8 bytes for this follower. */
  constructor(private readonly maxBytes: number) {}

  /**
   * Queue a frame or fail this follower when its byte limit is exceeded.
   * @param frame - next ordered frame.
   */
  push(frame: TerminalFrame): void {
    if (this.closed || this.finished) return
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    if (this.bytes + bytes > this.maxBytes) {
      this.failure = new Error('Terminal output consumer exceeded its buffer; reconnect to recover the current screen')
      this.close()
      return
    }
    this.queue.pushBack({ frame, bytes })
    this.bytes += bytes
    this.wake?.()
  }

  /** Finish after delivering every queued frame, including the final exit state. */
  finish(): void {
    this.finished = true
    this.wake?.()
  }

  /** Stop this follower without stopping its terminal. */
  close(): void {
    this.closed = true
    this.queue.clear()
    this.bytes = 0
    this.wake?.()
  }

  /**
   * Drain until detached or failed.
   * @param signal - Remote generation cancellation.
   * @returns ordered terminal frames.
   */
  async *read(signal: AbortSignal): AsyncIterable<TerminalFrame> {
    const abort = (): void => { this.close() }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      while (!this.closed) {
        const next = this.queue.popFront()
        if (next !== undefined) {
          this.bytes -= next.bytes
          yield next.frame
        } else {
          if (this.finished) break
          await new Promise<void>((resolve) => { this.wake = resolve })
          this.wake = undefined
        }
      }
      if (this.failure !== undefined) throw this.failure
    } finally {
      signal.removeEventListener('abort', abort)
      this.close()
    }
  }
}
