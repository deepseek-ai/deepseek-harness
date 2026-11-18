/** Typed `load_workspace_dependencies` payload preparation failures. */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link WorkspaceDependencyError} code:
 * - `WORKSPACE_DEPENDENCY_INVALID_PAYLOAD`: `runtime.json` is missing, unreadable, malformed, or
 *   inconsistent, or a payload entry or interpreter alias is missing or of the wrong kind; reinstall or
 *   rebuild the payload.
 * - `WORKSPACE_DEPENDENCY_UNSUPPORTED_PLATFORM`: the payload targets another platform or architecture.
 * - `WORKSPACE_DEPENDENCY_PREPARATION_FAILED`: a filesystem operation failed while installing or
 *   validating the payload, including an installation path that is a filesystem link; `cause` is the
 *   original error.
 */
export const WORKSPACE_DEPENDENCY_ERROR_CODES = [
  'WORKSPACE_DEPENDENCY_INVALID_PAYLOAD',
  'WORKSPACE_DEPENDENCY_UNSUPPORTED_PLATFORM',
  'WORKSPACE_DEPENDENCY_PREPARATION_FAILED',
] as const

/** One {@link WorkspaceDependencyError} code. */
export type WorkspaceDependencyErrorCode = typeof WORKSPACE_DEPENDENCY_ERROR_CODES[number]

/** Typed payload preparation failure; `code` is one of {@link WORKSPACE_DEPENDENCY_ERROR_CODES}. */
export class WorkspaceDependencyError extends HarnessError {
  override readonly code: WorkspaceDependencyErrorCode

  constructor(message: string, code: WorkspaceDependencyErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'WorkspaceDependencyError'
    this.code = code
  }
}
