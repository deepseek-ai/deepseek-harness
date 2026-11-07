/** Program execution failures reported by PTC. @module */
import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Host-only abort reason for an exhausted tool-call allowance; the excess call is never dispatched.
 * The executor recognizes this class at settlement and reports CODE_RUN_FAILED to the model.
 */
export class ToolCallLimitExceededError extends Error {
  /**
   * Describe the rejected call and how to correct the program.
   * @param limit - Timeout-derived maximum tool-call attempts for one run_code invocation.
   * @param callNumber - One-based attempt rejected without invoking the tool.
   * @param callsPerMinute - Attempts granted per minute of run_code timeout.
   */
  constructor(limit: number, callNumber: number, callsPerMinute: number) {
    super(`run_code exceeded its limit of ${limit} tool calls (${callsPerMinute} per minute of its timeout); `
      + `call ${callNumber} was not dispatched. The run_code program may contain an infinite loop. `
      + 'Check loop termination or split the work into smaller run_code calls.')
    this.name = 'ToolCallLimitExceededError'
  }
}

/**
 * Structured error codes carried by {@link CodeRunFailedError}: output delivery
 * failures use CODE_OUTPUT_INVALID or CODE_OUTPUT_LIMIT; every other execution
 * failure uses CODE_RUN_FAILED.
 */
export type CodeRunFailureCode = 'CODE_RUN_FAILED' | 'CODE_OUTPUT_INVALID' | 'CODE_OUTPUT_LIMIT'

/**
 * Failed program execution or output delivery. Earlier effects are not rolled
 * back. Caller cancellation uses AbortError / ABORTED instead.
 */
export class CodeRunFailedError extends HarnessError {
  /**
   * @param message - Model-facing diagnostic, including captured logs and recovery guidance.
   * @param code - Failure classification; defaults to CODE_RUN_FAILED.
   */
  constructor(message: string, code: CodeRunFailureCode = 'CODE_RUN_FAILED') {
    super(message, code)
    this.name = 'CodeRunFailedError'
  }
}

/** A host reset is unsupported or failed; cleanup failures require an explicit retry. */
export class CodeResetFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RESET_FAILED')
    this.name = 'CodeResetFailedError'
  }
}
