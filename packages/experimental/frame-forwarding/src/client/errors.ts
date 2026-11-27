/** Expected frame cancellations and located frame failures of a receive channel. */
import type { FrameFailureSource } from '../types.ts'

/** Expected frame cancellation, distinct from a failed rendering transport. */
export class FrameDiscardedError extends Error {
  /**
   * @param reason - Lifecycle event making the frame unnecessary: cancellation, the receive channel
   *   closing, or Desktop losing the channel's frames.
   */
  constructor(readonly reason: 'cancelled' | 'closed' | 'lost') {
    super(reason === 'closed' ? 'Native channel closed.'
      : reason === 'lost' ? 'Native channel lost.' : 'Native frame wait cancelled.')
    this.name = 'FrameDiscardedError'
  }
}

/** A frame that failed in its producer or in Desktop's presentation. */
export class FrameFailureError extends Error {
  /**
   * @param source - Where the frame failed.
   * @param message - The Host's description of the failure.
   */
  constructor(readonly source: FrameFailureSource, message: string) {
    super(message)
    this.name = 'FrameFailureError'
  }
}
