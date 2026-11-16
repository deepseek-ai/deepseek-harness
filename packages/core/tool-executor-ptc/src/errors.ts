/** Program execution failures reported by PTC. @module */
import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Host-only abort reason for an exhausted tool-call allowance; the excess call is never dispatched.
 * The executor recognizes this class at settlement and reports CODE_RUN_FAILED to the model.
 */
export class ToolCallLimitExceededError extends Error {
  /**
   * Describe the rejected call and how to correct the program.
   * @param limit - Timeout-derived maximum tool-call attempts for one program.
   * @param callNumber - One-based attempt rejected without invoking the tool.
   * @param callsPerMinute - Attempts granted per minute of program timeout.
   * @param toolName - Program tool name.
   */
  constructor(limit: number, callNumber: number, callsPerMinute: number, toolName: string) {
    super(`${toolName} exceeded its limit of ${limit} tool calls (${callsPerMinute} per minute of its timeout); `
      + `call ${callNumber} was not dispatched. The ${toolName} program may contain an infinite loop. `
      + `Check loop termination or split the work into smaller ${toolName} calls.`)
    this.name = 'ToolCallLimitExceededError'
  }
}

/**
 * Every {@link CodeRunFailedError} code:
 * - `CODE_RUN_FAILED`: the program run failed, or the runtime rejected it without its own error code.
 * - `CODE_RUN_UNAVAILABLE`: the executor was disposed before the run started.
 */
export const CODE_RUN_ERROR_CODES = ['CODE_RUN_FAILED', 'CODE_RUN_UNAVAILABLE'] as const

/** One {@link CodeRunFailedError} code. */
export type CodeRunErrorCode = typeof CODE_RUN_ERROR_CODES[number]

/**
 * Thrown by `run_code` when the program run itself failed — a program
 * exception, a budget expiry, a runtime-local abort, or substrate death — or
 * could not start. Caller cancellation uses the shared `AbortError` /
 * `ABORTED` tool outcome. Extends {@link HarnessError} with a code from
 * {@link CODE_RUN_ERROR_CODES}; the registry's execution pipeline converts it
 * into a structured `isError` result with the failure kind. Captured text and
 * images accompany the original diagnostic; outer result replacements remain
 * authoritative.
 */
export class CodeRunFailedError extends HarnessError {
  override readonly code: CodeRunErrorCode

  constructor(message: string, code: CodeRunErrorCode = 'CODE_RUN_FAILED', options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'CodeRunFailedError'
    this.code = code
  }
}

/** A host reset is unsupported or failed; cleanup failures require an explicit retry. */
export class CodeResetFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RESET_FAILED')
    this.name = 'CodeResetFailedError'
  }
}
