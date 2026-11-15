/** Cancellation-owned queue for a reading-state follow generation. */
import { Deque } from '@deepseek-ai/dsh-deque'
import type { SessionReadFrame } from './types.ts'

type ChangedFrame = Extract<SessionReadFrame, { type: 'changed' }>

/** One follower's ordered committed updates. */
export class SessionReadFollower {
  private readonly frames = new Deque<ChangedFrame>()
  private wake: (() => void) | undefined
  private readonly lifetime = new AbortController()
  private failure: Error | undefined

  /** Aborts when this follower closes, including while its consumer is paused. */
  get signal(): AbortSignal { return this.lifetime.signal }

  /**
   * Enqueue one update for an active follower.
   * @param frame - committed whole-record replacement.
   */
  push(frame: ChangedFrame): void {
    if (this.signal.aborted) return
    this.frames.pushBack(frame)
    this.wake?.()
  }

  /**
   * Wake the reader and end this generation, preserving the first close reason.
   * Queued frames are discarded; the next generation supplies a complete baseline.
   * @param failure - terminal stream failure, when present.
   */
  close(failure?: Error): void {
    if (this.signal.aborted) return
    this.failure = failure
    this.lifetime.abort()
    this.wake?.()
  }

  /**
   * Consume queued changes until cancellation, teardown, or stream failure.
   * @param signal - Remote generation lifetime.
   * @returns ordered updates; rejects with the first terminal stream failure.
   */
  async *read(signal: AbortSignal): AsyncIterable<ChangedFrame> {
    const abort = (): void => { this.close() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted && !this.signal.aborted) {
        const frame = this.frames.popFront()
        if (frame !== undefined) yield frame
        else await new Promise<void>((resolve) => { this.wake = resolve })
      }
      if (this.failure !== undefined) throw this.failure
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}
