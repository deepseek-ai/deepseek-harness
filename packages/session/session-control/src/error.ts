/** Structured failures owned by Session control. */

import { HarnessError } from '@deepseek-ai/dsh-error'

/** Failures whose callers can distinguish without parsing a display message. */
export type SessionControlErrorCode =
  | 'SESSION_CONTROL_UNAVAILABLE'
  | 'SESSION_CONTROL_CALLER_UNAVAILABLE'
  | 'SESSION_CONTROL_INVALID_MESSAGE'
  | 'SESSION_CONTROL_NOT_FOUND'
  | 'SESSION_CONTROL_SUBAGENT_OWNED'
  | 'SESSION_CONTROL_ARCHIVED'
  | 'SESSION_CONTROL_WRITER_HELD'
  | 'SESSION_CONTROL_RESTORE_FAILED'
  | 'SESSION_CONTROL_RELEASE_FAILED'
  | 'SESSION_CONTROL_INPUT_CLOSED'

/** Failure to accept a message; callers must not retry an unknown outcome automatically. */
export class SessionControlError extends HarnessError {
  override readonly code: SessionControlErrorCode

  /**
   * @param message - actionable description of the failed operation.
   * @param code - stable failure classification.
   * @param options - original cause when converting a dependency failure.
   */
  constructor(message: string, code: SessionControlErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
