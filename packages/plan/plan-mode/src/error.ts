/** Typed plan-mode failures. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every machine-routable plan-mode failure:
 * - `PLAN_NOT_ACTIVE`: the caller's committed state is not plan mode; work without the exit tool.
 * - `PLAN_REVIEW_INTERRUPTED`: the plan-mode service was reloaded during the review; present the plan again.
 * - `PLAN_REVISION_REQUESTED`: the user chose to keep planning; revise the plan from the feedback in `message`.
 * - `PLAN_STATE_UNAVAILABLE`: the plan projection reader is not registered yet; await plugin activation before running an agent.
 */
export type PlanModeErrorCode =
  | 'PLAN_NOT_ACTIVE'
  | 'PLAN_REVIEW_INTERRUPTED'
  | 'PLAN_REVISION_REQUESTED'
  | 'PLAN_STATE_UNAVAILABLE'

/** Typed plan-mode failure; `code` is one {@link PlanModeErrorCode}. */
export class PlanModeError extends HarnessError {
  override readonly code: PlanModeErrorCode

  /**
   * @param message - reason and next step for the caller.
   * @param code - failure class.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: PlanModeErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PlanModeError'
    this.code = code
  }
}
