/** Structured failures owned by the SSH execution-environment provider. */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable failure categories for SSH prerequisites and daemon installation. */
export type SshEnvironmentErrorCode =
  | 'ENVIRONMENT_SSH_NODE_NOT_FOUND'
  | 'ENVIRONMENT_SSH_DEPENDENCY_MISSING'
  | 'ENVIRONMENT_SSH_NODE_UNSUPPORTED'
  | 'ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE'
  | 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED'

/** A destination or local prerequisite failure with a machine-readable category. */
export class SshEnvironmentError extends HarnessError {
  /**
   * @param code - stable failure category.
   * @param message - affected host or artifact and the required correction.
   * @param options - original failure, when available.
   */
  constructor(code: SshEnvironmentErrorCode, message: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}
