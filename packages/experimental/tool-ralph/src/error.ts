/** Machine-routable Ralph loop failures. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link RalphError} code:
 * - `RALPH_PROVIDER_UNAVAILABLE` — the configured subagent provider is not registered; load it or change `subagentProvider`.
 * - `RALPH_PROVIDER_UNSUPPORTED` — the configured provider lacks structured output or inherits parent context;
 *   configure a fresh structured-output provider.
 * - `RALPH_WORKFLOW_FAILED` — the fixed workflow ended with an error or was cancelled without caller cancellation; report the message.
 * - `RALPH_INVALID_RESULT` — the fixed workflow returned a malformed report or terminal value; do not trust the result.
 * - `RALPH_ROUND_FAILED` — a round's child failed before producing a structured report; the message carries the last handoff.
 */
export const RALPH_ERROR_CODES = [
  'RALPH_PROVIDER_UNAVAILABLE',
  'RALPH_PROVIDER_UNSUPPORTED',
  'RALPH_WORKFLOW_FAILED',
  'RALPH_INVALID_RESULT',
  'RALPH_ROUND_FAILED',
] as const

/** One code from {@link RALPH_ERROR_CODES}. */
export type RalphErrorCode = typeof RALPH_ERROR_CODES[number]

/** Ralph loop failure carrying a stable {@link RalphErrorCode}. */
export class RalphError extends HarnessError {
  override readonly code: RalphErrorCode

  /**
   * @param message - parent-facing failure text.
   * @param code - failure class.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: RalphErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'RalphError'
    this.code = code
  }
}
