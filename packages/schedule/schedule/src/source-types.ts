/** Automation observations and handling-relevant delivery failures. */

/** Content produced by a source for delivery to an automation task. */
export interface AutomationCandidate {
  /** Additional input accompanying the stored instruction; the producer owns size limits, and delivery does not truncate it. */
  readonly text: string
}

/** Handling-relevant failures from observation submission, task delivery, and cleanup. */
export type SourceErrorCode =
  | 'SOURCE_CLOSED'
  | 'SOURCE_DISPOSAL_FAILED'
  | 'SOURCE_TASK_RECEIVER_UNAVAILABLE'
  | 'SOURCE_TASK_UNAVAILABLE'
  | 'SOURCE_TASK_BUSY'
  | 'SOURCE_TASK_INACTIVE'
