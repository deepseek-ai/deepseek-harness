/** Failures of execution environment runs. @module */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { EnvironmentRemoteFailure } from './types.ts'

/**
 * Failure classes of a run:
 * - `ENVIRONMENT_UNREACHABLE`: the daemon could not be reached, refused the handshake or did not connect in time; nothing ran remotely.
 * - `ENVIRONMENT_OUTCOME_UNKNOWN`: the connection closed after the run was sent; its remote effects are unknown.
 * - `ENVIRONMENT_REQUEST_REFUSED`: the run was not sent: too many outstanding runs, or its source, arguments and method
 *   names cannot be structured-cloned or exceed `maxMessageBytes`.
 * - `ENVIRONMENT_RUN_FAILED`: the remote function threw, its worker thread failed or exited, or the daemon could not
 *   send its result; `remote` describes which.
 * - `ENVIRONMENT_INVALID_RESULT`: the remote function's result failed the run's result validation.
 * - `ENVIRONMENT_DISPOSED`: the service was disposed.
 */
export type EnvironmentErrorCode =
  | 'ENVIRONMENT_UNREACHABLE'
  | 'ENVIRONMENT_OUTCOME_UNKNOWN'
  | 'ENVIRONMENT_REQUEST_REFUSED'
  | 'ENVIRONMENT_RUN_FAILED'
  | 'ENVIRONMENT_INVALID_RESULT'
  | 'ENVIRONMENT_DISPOSED'

/** A run failed for the reason its `code` names; transports' own `HarnessError` failures pass through unwrapped. */
export class EnvironmentError extends HarnessError {
  declare readonly code: EnvironmentErrorCode
  /**
   * For `ENVIRONMENT_RUN_FAILED`, the name, message and string code of the error the remote function threw, or of the
   * failure of its worker thread or of the daemon to send its result; otherwise undefined.
   */
  readonly remote: EnvironmentRemoteFailure | undefined

  /**
   * @param message - human-readable failure, including the transport's end reason when known.
   * @param code - the failure class.
   * @param options - the original failure as `cause`, and the remote error of a failed run.
   */
  constructor(message: string, code: EnvironmentErrorCode, options?: ErrorOptions & { readonly remote?: EnvironmentRemoteFailure }) {
    super(message, code, options)
    this.remote = options?.remote
  }
}
