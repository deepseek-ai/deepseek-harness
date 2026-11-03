/** Program execution failures reported by PTC. @module */
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Tool-call allowance for one `run_code` program, with the per-minute budget its limit derives from. */
export interface ToolCallAllowance {
  /** Maximum dispatched tool-call attempts for the program; `Number.POSITIVE_INFINITY` without a resolved deadline. */
  limit: number
  /** Configured attempts granted per minute of resolved runtime timeout. */
  maxSubCallsPerMinute: number
}

/**
 * Host-only abort reason for an exhausted tool-call allowance; the excess call is never dispatched.
 * The executor recognizes this class at settlement and reports CODE_RUN_FAILED to the model.
 */
export class ToolCallLimitExceededError extends Error {
  /**
   * Describe the rejected call and how to correct the program.
   * @param allowance - Exhausted allowance, including the per-minute budget behind its limit.
   * @param callNumber - One-based attempt rejected without invoking the tool.
   */
  constructor(allowance: ToolCallAllowance, callNumber: number) {
    super(`run_code exceeded its limit of ${allowance.limit} tool calls `
      + `(maxSubCallsPerMinute ${allowance.maxSubCallsPerMinute}); call ${callNumber} was not dispatched. `
      + 'The run_code program may contain an infinite loop. Check loop termination or split the work into smaller run_code calls.')
    this.name = 'ToolCallLimitExceededError'
  }
}

/**
 * Thrown by `run_code` when the program run itself failed — a program
 * exception, a budget expiry, a runtime-local abort, or substrate death. Caller
 * cancellation uses the shared `AbortError` / `ABORTED` tool outcome. Extends
 * {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
 * pipeline converts it into a structured `isError` result whose text carries
 * the failure kind plus the captured logs, so the model can self-correct.
 */
export class CodeRunFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RUN_FAILED')
    this.name = 'CodeRunFailedError'
  }
}
