/** Startup variables required by native executables before model evaluation. */
import { syncBuiltinESMExports } from 'node:module'

/** Native executable search, Windows system paths, and sandbox temporary paths retained in the OS environment. */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])

/** Warnings that the runtime's own use of experimental Node features emits once per process. */
const RUNTIME_WARNINGS = new Set([
  'vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time',
  'stripTypeScriptTypes is an experimental feature and might change at any time',
])

function withoutRuntimeWarning(emitWarning: typeof process.emitWarning): typeof process.emitWarning {
  return function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : undefined
    if (message !== undefined && RUNTIME_WARNINGS.has(message)) return
    Reflect.apply(emitWarning, this, [warning, ...rest])
  }
}

/**
 * Drop warnings that the runtime itself triggers in the child, which would otherwise appear in program output; other warnings still print.
 * @param state - Child process whose `emitWarning` is wrapped; structural test doubles without it stay unchanged.
 */
export function filterRuntimeWarnings(state: { emitWarning?: typeof process.emitWarning }): void {
  if (state.emitWarning !== undefined) state.emitWarning = withoutRuntimeWarning(state.emitWarning)
}

/**
 * Run a synchronous host call without printing the runtime's own experimental-feature warnings.
 * @param call - Synchronous work, such as type stripping, that may emit such a warning on first use.
 * @returns The call's result; `process.emitWarning` is restored before returning or rethrowing.
 */
export function quietRuntimeCall<T>(call: () => T): T {
  // oxlint-disable-next-line typescript/unbound-method -- The original method is restored unchanged after the call.
  const emitWarning = process.emitWarning
  // The replacement exists only during this synchronous call, so no other code observes it.
  process.emitWarning = withoutRuntimeWarning(emitWarning)
  try {
    return call()
  } finally {
    process.emitWarning = emitWarning
  }
}

/**
 * Clear inherited credentials while preserving native child-process startup paths.
 * With the native child process, preloaded node:process exports observe the replacement.
 * Isolated state objects only replace their own environment; they do not replace the native process.
 * @param state - Native child process in production, or isolated state in in-process tests.
 */
export function clearProgramEnvironment(state: { env: NodeJS.ProcessEnv }): void {
  for (const key of Object.keys(state.env)) {
    if (!STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase())) Reflect.deleteProperty(state.env, key)
  }
  state.env = Object.create(null) as NodeJS.ProcessEnv
  syncBuiltinESMExports()
}
