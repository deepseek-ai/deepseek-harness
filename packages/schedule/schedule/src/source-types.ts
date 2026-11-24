/** Automation observations and handling-relevant delivery failures. */

/** Content produced by a source for delivery to an automation task. */
export interface AutomationCandidate {
  /** Observed text accompanying the stored instruction. Schedule rejects rather than truncates text whose
   * `JSON.stringify` result exceeds 10 MiB in UTF-8, including quotes and escapes. */
  readonly text: string
}

/** Handling-relevant failures from observation submission, task delivery, and cleanup. */
export type SourceErrorCode =
  | 'SOURCE_CLOSED'
  | 'SOURCE_DISPOSAL_FAILED'
  | 'SOURCE_INPUT_TOO_LARGE'
  | 'SOURCE_TASK_RECEIVER_UNAVAILABLE'
  | 'SOURCE_TASK_UNAVAILABLE'
  | 'SOURCE_TASK_BUSY'
  | 'SOURCE_TASK_INACTIVE'
