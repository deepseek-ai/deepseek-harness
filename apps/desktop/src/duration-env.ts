/** Millisecond settings read from the Desktop process environment. */

/**
 * Read a duration that `setTimeout` accepts without clamping.
 * @param env - Desktop process environment.
 * @param name - Variable to read; the validation error names it.
 * @param fallback - Value used when the variable is unset.
 * @returns Integer milliseconds from 1000 through 2147483647.
 */
export function resolveDurationMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 2_147_483_647) {
    throw new Error(`${name} must be an integer from 1000 through 2147483647`)
  }
  return value
}
