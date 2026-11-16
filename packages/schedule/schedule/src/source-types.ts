/** Typed source connections and automation-task delivery values. */

/**
 * A receiver owns its state and resolves only after accepting the value.
 * @param value - Typed input delivered through an upstream connection.
 * @returns Resolves after acceptance; rejection reports a failure without implying rollback.
 */
export type SourceReceiver<T> = (value: T) => Promise<void>

/** One directed connection; sharing the reference preserves every holder's send and close capabilities. */
export interface AutomationConnection<in T> {
  /**
   * Deliver only to this connection's receiver; concurrent calls may overlap.
   * @param value - Shared typed input, not copied or retained for replay.
   * @returns Resolves after acceptance; preserves a receiver rejection without rollback or automatic retry.
   * @throws SourceError with SOURCE_CONNECTION_CLOSED after this connection or either endpoint closes.
   */
  send(value: T): Promise<void>
  /**
   * Stop accepting values immediately and drain accepted calls. Repeated calls join the same cleanup.
   * A receiver must not await disposal of its own connection, input, emitting output, or owning Source from
   * inside an accepted call; cleanup waits for that call to return.
   */
  dispose(): Promise<void>
}

/** Content produced by a source for delivery to an automation task. */
export interface AutomationCandidate {
  /** Additional input accompanying the stored instruction; the producer owns size limits, and delivery does not truncate it. */
  readonly text: string
}

/** Handling-relevant failures from source connections, task delivery, and cleanup. */
export type SourceErrorCode =
  | 'SOURCE_CLOSED'
  | 'SOURCE_CONNECTION_CLOSED'
  | 'SOURCE_DELIVERY_FAILED'
  | 'SOURCE_DISPOSAL_FAILED'
  | 'SOURCE_TASK_RECEIVER_UNAVAILABLE'
  | 'SOURCE_TASK_UNAVAILABLE'
  | 'SOURCE_TASK_BUSY'
  | 'SOURCE_TASK_INACTIVE'
