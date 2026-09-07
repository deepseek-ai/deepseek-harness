/** Shared conversion from reference-machine expectations to CI time budgets. */

/** Measured wall-time ratio between the x64 CI runner and the arm64 reference machine. */
export const CI_TIME_SCALE = 2
/** Allowed variance above the calibrated expectation. */
export const PERFORMANCE_BUDGET_HEADROOM = 1.25

/**
 * Convert a reference-machine duration into its CI wall-time budget.
 * @param expectedMs - Expected duration on the reference machine.
 * @returns Integer CI budget including machine scaling and variance headroom.
 */
export function ciTimeBudget(expectedMs: number): number {
  return Math.ceil(expectedMs * CI_TIME_SCALE * PERFORMANCE_BUDGET_HEADROOM)
}
