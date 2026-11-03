/** Startup variables required by native executables before model evaluation. */
import { syncBuiltinESMExports } from 'node:module'

/** Native executable search, Windows system paths, and sandbox temporary paths retained in the OS environment. */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])

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
