/** Typed source subscriptions and automation-task delivery values. */

/**
 * A receiver owns its state and resolves only after accepting the value.
 * @param value - Typed output from the subscribed source instance.
 * @returns Resolves after acceptance; rejection reports a failure without implying rollback.
 */
export type SourceReceiver<T> = (value: T) => Promise<void>

/** One subscription, independent of every other subscriber to the same source. */
export interface SourceConnection {
  /**
   * Stop accepting values immediately and await already accepted calls. Repeated calls await the same work.
   * A receiver must not await disposal of its own connection from inside an accepted call.
   */
  dispose(): Promise<void>
}

/** Content produced by a source for delivery to an automation task. */
export interface AutomationCandidate {
  /** Additional input accompanying the stored instruction; the producer owns size limits, and delivery does not truncate it. */
  readonly text: string
}

/** Handling-relevant failures from source subscriptions and task delivery. */
export type SourceErrorCode =
  | 'SOURCE_CLOSED'
  | 'SOURCE_DELIVERY_FAILED'
  | 'SOURCE_TASK_RECEIVER_UNAVAILABLE'
  | 'SOURCE_TASK_UNAVAILABLE'
  | 'SOURCE_TASK_BUSY'
  | 'SOURCE_TASK_INACTIVE'
