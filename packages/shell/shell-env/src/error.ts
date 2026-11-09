/** Machine-routable shell environment failures. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link ShellEnvError} code:
 * - `SHELL_ENV_CONTRIBUTION_INVALID` — a registered contributor returned an undeclared key or a non-string value; the
 *   shell command does not run, and the contributing plugin must be fixed.
 */
export const SHELL_ENV_ERROR_CODES = ['SHELL_ENV_CONTRIBUTION_INVALID'] as const

/** One code from {@link SHELL_ENV_ERROR_CODES}. */
export type ShellEnvErrorCode = typeof SHELL_ENV_ERROR_CODES[number]

/** Shell environment failure carrying a stable {@link ShellEnvErrorCode}. */
export class ShellEnvError extends HarnessError {
  override readonly code: ShellEnvErrorCode

  /**
   * @param message - names the contributor and the offending key.
   * @param code - the failure class consumers route on.
   */
  constructor(message: string, code: ShellEnvErrorCode) {
    super(message, code)
    this.name = 'ShellEnvError'
    this.code = code
  }
}
