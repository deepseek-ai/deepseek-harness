/** Exact, directional exceptions to the shipped SDK/Desktop capability comparison. */
export type ToolMode = 'standard' | 'ptc'

interface Exception {
  tool: string
  side: 'sdk' | 'desktop'
  reason: string
}

/** Intentional product differences; obsolete entries fail alongside undeclared differences. */
export const toolParityExceptions: Record<ToolMode, readonly Exception[]> = {
  standard: [{ tool: 'list_subagent_models', side: 'desktop',
    reason: 'Desktop enables subagent model discovery; SDK delegation inherits the caller model by default.' }],
  ptc: [
    { tool: 'list_subagent_models', side: 'desktop',
      reason: 'Desktop enables subagent model discovery; SDK delegation inherits the caller model by default.' },
    { tool: 'plugin_manager', side: 'sdk',
      reason: 'SDK PTC changes are persisted for restart without replacing active bindings because HMR is disabled; Desktop PTC excludes management in its HMR-enabled preset.' },
    { tool: 'workflow', side: 'sdk',
      reason: 'The SDK PTC overlay changes only the executor so existing base workflow callers keep working; Desktop PTC uses run_code orchestration and omits the separate workflow surface.' },
  ],
}

/**
 * Compare actual step-admitted sets, rejecting both drift and unused exceptions.
 * @param mode - matching SDK executor and Desktop preset.
 * @param sdk - SDK capability names.
 * @param desktop - Desktop capability names.
 * @param exceptions - exact one-sided product differences with their rationale.
 */
export function assertToolParity(
  mode: ToolMode, sdk: readonly string[], desktop: readonly string[],
  exceptions = toolParityExceptions[mode],
): void {
  if (sdk.length === 0 || desktop.length === 0) throw new Error(`Empty tool inventory: ${mode}`)
  const only = {
    sdk: new Set(sdk.filter(name => !desktop.includes(name))),
    desktop: new Set(desktop.filter(name => !sdk.includes(name))),
  }
  const stale: string[] = []
  for (const exception of exceptions) {
    if (!exception.reason.trim()) throw new Error(`Tool exception requires a reason: ${exception.tool}`)
    if (!only[exception.side].delete(exception.tool)) stale.push(`${exception.side}:${exception.tool}`)
  }
  if (only.sdk.size || only.desktop.size || stale.length) {
    throw new Error([
      `SDK/Desktop tool mismatch: ${mode}`,
      `Missing from SDK: ${[...only.desktop].sort().join(', ') || '(none)'}`,
      `Only in SDK: ${[...only.sdk].sort().join(', ') || '(none)'}`,
      `Stale exceptions: ${stale.sort().join(', ') || '(none)'}`,
    ].join('\n'))
  }
}
