/** Serializable Desktop failure diagnostics. */

/**
 * Preserve nested diagnostics when sending failures to a renderer.
 * @param error - Startup or runtime failure.
 * @returns Serializable error state.
 */
export function desktopErrorState(error: unknown): { phase: 'error'; message: string } {
  const message = error instanceof AggregateError
    ? [error.message, ...error.errors.map(item => desktopErrorState(item).message)].join('\n')
    : error instanceof Error ? error.message : String(error)
  return { phase: 'error', message }
}
