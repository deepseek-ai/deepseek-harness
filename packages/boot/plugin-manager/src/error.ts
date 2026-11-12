/** Typed failures thrown by plugin management calls rather than reported in a change result. */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link PluginManagerError} code:
 * - `PLUGIN_MANAGER_PROFILE_READ_FAILED`: the profile manifest, patches, version exemptions, or
 *   installation manifest could not be read or parsed; `cause` is the original error. Repair the
 *   profile files before retrying.
 * - `PLUGIN_MANAGER_UNAVAILABLE`: the manager was disposed before the change started.
 */
export const PLUGIN_MANAGER_ERROR_CODES = [
  'PLUGIN_MANAGER_PROFILE_READ_FAILED',
  'PLUGIN_MANAGER_UNAVAILABLE',
] as const

/** One {@link PluginManagerError} code. */
export type PluginManagerErrorCode = typeof PLUGIN_MANAGER_ERROR_CODES[number]

/** Typed plugin management failure; `code` is one of {@link PLUGIN_MANAGER_ERROR_CODES}. */
export class PluginManagerError extends HarnessError {
  override readonly code: PluginManagerErrorCode

  constructor(message: string, code: PluginManagerErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PluginManagerError'
    this.code = code
  }
}

/**
 * Run one synchronous profile read, converting its failure.
 * @param read - reads and parses profile files.
 * @returns the read value.
 * @throws {PluginManagerError} `PLUGIN_MANAGER_PROFILE_READ_FAILED` with the original error as `cause`.
 */
export function readProfileState<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    // Profile readers fail with filesystem, JSON, YAML, or validation Error instances.
    throw new PluginManagerError(
      `plugin-manager: failed to read the profile: ${(error as Error).message}`,
      'PLUGIN_MANAGER_PROFILE_READ_FAILED', { cause: error },
    )
  }
}
