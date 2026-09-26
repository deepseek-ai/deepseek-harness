/** Two independent Escape presses addressed to one Conversation occurrence and live turn. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Freshly resolved cancellation target; occurrence and region preserve focus ownership. */
export interface StopTarget {
  readonly sessionId: SessionId
  readonly turn: number
  /** Materialized Session binding identity; replacement invalidates an earlier press. */
  readonly generation: object
  readonly region: Element
  readonly cancel: () => void
}

/** One short-lived first press, cleared before an accepted cancellation runs. */
export class StopSequence {
  private first: { target: StopTarget; deadline: number } | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param intervalMs - validated maximum time between independent presses.
   * @param release - releases observations retained by the pending first press.
   */
  constructor(private readonly intervalMs: number, private readonly release: () => void) {}

  /** Clear the first press and its expiry timer. */
  reset(): void {
    this.first = undefined
    clearTimeout(this.timer)
    this.timer = undefined
    this.release()
  }

  /**
   * Accept one eligible, non-repeated Escape against freshly resolved current state.
   * @param target - live turn and actual focused input region.
   * @returns whether this press requested cancellation.
   */
  press(target: StopTarget): boolean {
    const first = this.first
    this.reset()
    if (first !== undefined && performance.now() <= first.deadline
      && first.target.sessionId === target.sessionId
      && first.target.turn === target.turn && first.target.generation === target.generation
      && first.target.region === target.region) {
      target.cancel()
      return true
    }
    this.first = { target, deadline: performance.now() + this.intervalMs }
    this.timer = setTimeout(() => { this.reset() }, this.intervalMs + 1)
    return false
  }
}
