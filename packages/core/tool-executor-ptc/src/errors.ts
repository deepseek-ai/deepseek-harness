/** Program execution failures reported by PTC. @module */
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** A nested call rejected before dispatch because its program exhausted the call limit. */
export class ToolCallLimitExceededError extends HarnessError {
  /**
   * Describe the rejected call and how to correct the program.
   * @param limit - Configured maximum tool-call attempts for one run_code invocation.
   * @param callNumber - One-based attempt rejected without invoking the tool.
   */
  constructor(readonly limit: number, readonly callNumber: number) {
    super(`run_code exceeded its limit of ${limit} tool calls; call ${callNumber} was not dispatched. `
      + 'The run_code program may contain an infinite loop. Check loop termination or split the work into smaller run_code calls.',
    'PTC_TOOL_CALL_LIMIT_EXCEEDED')
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
