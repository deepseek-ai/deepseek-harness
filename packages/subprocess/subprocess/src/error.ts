/** Machine-routable subprocess failures shared by every `ctx.subprocess` provider and its consumers. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link SubprocessError} code:
 * - `SUBPROCESS_INVALID_ARGV` — the request names no program; the caller fixes its argv.
 * - `SUBPROCESS_EXECUTABLE_NOT_FOUND` — executable lookup found no executable file.
 * - `SUBPROCESS_SPAWN_NOT_FOUND` — the platform reported `ENOENT` for the program or the working directory.
 * - `SUBPROCESS_SPAWN_FAILED` — the platform refused the spawn for another reason; `cause` holds the original error.
 * - `SUBPROCESS_RUNNER_FAILED` — the provider's private runner exited or reported a result before proving the process range empty.
 * - `SUBPROCESS_RUNNER_IPC_FAILED` — the provider's private runner channel was missing or carried a malformed message.
 * - `SUBPROCESS_PTY_UNAVAILABLE` — the host cannot load its terminal implementation.
 */
export const SUBPROCESS_ERROR_CODES = [
  'SUBPROCESS_INVALID_ARGV',
  'SUBPROCESS_EXECUTABLE_NOT_FOUND',
  'SUBPROCESS_SPAWN_NOT_FOUND',
  'SUBPROCESS_SPAWN_FAILED',
  'SUBPROCESS_RUNNER_FAILED',
  'SUBPROCESS_RUNNER_IPC_FAILED',
  'SUBPROCESS_PTY_UNAVAILABLE',
] as const

/** One code from {@link SUBPROCESS_ERROR_CODES}. */
export type SubprocessErrorCode = typeof SUBPROCESS_ERROR_CODES[number]

/** Subprocess failure carrying a stable {@link SubprocessErrorCode}. */
export class SubprocessError extends HarnessError {
  override readonly code: SubprocessErrorCode

  /**
   * @param message - names the process operation and the safe next step.
   * @param code - the failure class consumers route on.
   * @param options - standard `cause` chaining; foreign errno and Win32 codes stay there and in `message`.
   */
  constructor(message: string, code: SubprocessErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubprocessError'
    this.code = code
  }
}

/** Executable lookup completed without finding an executable file; `code` is `SUBPROCESS_EXECUTABLE_NOT_FOUND`. */
export class SubprocessExecutableNotFoundError extends SubprocessError {
  /**
   * @param message - provider-specific lookup diagnostic.
   * @param options - original provider failure, when available.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'SUBPROCESS_EXECUTABLE_NOT_FOUND', options)
    this.name = 'SubprocessExecutableNotFoundError'
  }
}

/**
 * Classify a spawn rejection for a consumer that reports it as its own
 * failure. Providers reject with the platform's original error so that
 * consumers can inspect errno fields; the consumer that turns the rejection
 * into a tool or service failure converts it here and keeps the original as
 * `cause`.
 * @param error - the provider's rejection value.
 * @param program - the program the consumer asked to spawn, named in the message.
 * @returns a {@link SubprocessError} for a platform spawn error, recognized by
 *   its string errno `code`: `SUBPROCESS_SPAWN_NOT_FOUND` for `ENOENT` and
 *   `SUBPROCESS_SPAWN_FAILED` for any other errno. Every other value, including
 *   a `HarnessError`, is returned unchanged, because it is not a spawn failure
 *   this helper can classify.
 */
export function subprocessSpawnFailure(error: unknown, program: string): unknown {
  if (!(error instanceof Error) || error instanceof HarnessError) return error
  const errno = (error as { code?: unknown }).code
  if (typeof errno !== 'string') return error
  const detail = error.message
  if (errno === 'ENOENT') {
    return new SubprocessError(
      `cannot start ${JSON.stringify(program)}: the program or the working directory does not exist (${detail})`,
      'SUBPROCESS_SPAWN_NOT_FOUND',
      { cause: error },
    )
  }
  return new SubprocessError(`cannot start ${JSON.stringify(program)}: ${detail}`, 'SUBPROCESS_SPAWN_FAILED', { cause: error })
}
