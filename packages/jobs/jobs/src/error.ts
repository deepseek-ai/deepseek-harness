/** Machine-routable background-job failures. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link JobError} code:
 * - `JOB_CONTROLLER_UNAVAILABLE` — the jobs service is composed but no attached job controller serves the
 *   job's owner. A call whose composition lacks the jobs service itself throws `ToolContextUnavailableError`.
 * - `JOB_NOT_FOUND` — the job id names no listed job.
 * - `JOB_FOREIGN_SESSION` — the job belongs to another Session.
 * - `JOB_OWNER_NOT_LIVE` — the owning Agent is no longer live.
 * - `JOB_OWNER_REGISTRY_UNAVAILABLE` — a job names an owner, but the composition has no Agent registry to resolve it.
 * - `JOB_LIMIT_REACHED` — the registry's configured job limit is reached.
 */
export const JOB_ERROR_CODES = [
  'JOB_CONTROLLER_UNAVAILABLE',
  'JOB_NOT_FOUND',
  'JOB_FOREIGN_SESSION',
  'JOB_OWNER_NOT_LIVE',
  'JOB_OWNER_REGISTRY_UNAVAILABLE',
  'JOB_LIMIT_REACHED',
] as const

/** One code from {@link JOB_ERROR_CODES}. */
export type JobErrorCode = typeof JOB_ERROR_CODES[number]

/** Background-job failure carrying a stable {@link JobErrorCode}. */
export class JobError extends HarnessError {
  override readonly code: JobErrorCode

  /**
   * @param message - names the job operation and the safe next step.
   * @param code - the failure class consumers route on.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: JobErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'JobError'
    this.code = code
  }
}
