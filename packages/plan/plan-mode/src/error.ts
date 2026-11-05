/**
 * Typed `exit_plan_mode` failures.
 *
 * @module @deepseek-ai/dsh-plan-mode/error
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Every machine-routable plan-mode failure:
 * - `PLAN_NOT_ACTIVE`: the caller's committed state is not plan mode; work without the exit tool.
 * - `PLAN_REVIEW_INTERRUPTED`: the plan-mode service was reloaded during the review; present the plan again.
 * - `PLAN_REVISION_REQUESTED`: the user chose to keep planning; revise the plan from the feedback in `message`.
 */
export const PLAN_MODE_ERROR_CODES = [
  'PLAN_NOT_ACTIVE',
  'PLAN_REVIEW_INTERRUPTED',
  'PLAN_REVISION_REQUESTED',
] as const

/** One plan-mode failure code. */
export type PlanModeErrorCode = typeof PLAN_MODE_ERROR_CODES[number]

/** Typed plan-mode failure; `code` is one of {@link PLAN_MODE_ERROR_CODES}. */
export class PlanModeError extends HarnessError {
  override readonly code: PlanModeErrorCode

  /**
   * @param message - model-facing reason and next step.
   * @param code - failure class from {@link PLAN_MODE_ERROR_CODES}.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: PlanModeErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PlanModeError'
    this.code = code
  }
}
