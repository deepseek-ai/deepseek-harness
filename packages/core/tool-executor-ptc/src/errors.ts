/** Program execution failures reported by PTC. @module */
import type { PtcRunFailure } from '@deepseek-ai/dsh-ptc-runtime'
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
 * Failed program execution or output delivery. Output failures use
 * CODE_OUTPUT_INVALID or CODE_OUTPUT_LIMIT; all other kinds use CODE_RUN_FAILED.
 * Earlier effects are not rolled back. Caller cancellation uses AbortError / ABORTED.
 */
export class CodeRunFailedError extends HarnessError {
  /**
   * @param message - Runtime diagnostic, captured logs, and sandbox details.
   * @param kind - Runtime failure classification; omitted for host-owned execution failures.
   */
  constructor(message: string, kind?: PtcRunFailure['kind']) {
    const code = kind === 'invalid-output' ? 'CODE_OUTPUT_INVALID'
      : kind === 'output-limit' ? 'CODE_OUTPUT_LIMIT' : 'CODE_RUN_FAILED'
    const output = kind === 'invalid-output'
      ? 'Program reached completion, but its completion value could not be delivered as lossless JSON. Return a JSON value or no value.'
      : kind === 'output-limit' ? 'Output exceeded its limit. Program completion is not confirmed; execution may be partial.' : ''
    super(output === '' ? message : `${message}\n${output} Earlier actions are not rolled back. Inspect current state before any retry. Do not repeat actions just to repair output.`, code)
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
