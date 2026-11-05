/** Machine-routable worktree creation and restoration failures. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link WorktreeError} code:
 * - `WORKTREE_INVALID_ARGUMENT` — the branch name, start revision, or restoration request violates a documented
 *   constraint; correct it and retry.
 * - `WORKTREE_ALREADY_EXISTS` — the branch or checkout path already exists; choose another name or reuse the existing checkout.
 * - `WORKTREE_LOCKED` — Git keeps the missing checkout's registration locked; unlock it before restoring.
 * - `WORKTREE_COMMAND_FAILED` — a Git or directory-allocation command exited unsuccessfully; the message carries its status and stderr.
 * - `WORKTREE_OUTPUT_TOO_LARGE` — a command's output exceeded the configured `maxOutputBytes`; raise the limit or inspect the repository.
 * - `WORKTREE_TIMEOUT` — a command exceeded the configured `timeoutMs`; its effects are unknown, so inspect the repository before retrying.
 * - `WORKTREE_UNAVAILABLE` — the worktree service was disposed; retry after it is loaded again.
 */
export const WORKTREE_ERROR_CODES = [
  'WORKTREE_INVALID_ARGUMENT',
  'WORKTREE_ALREADY_EXISTS',
  'WORKTREE_LOCKED',
  'WORKTREE_COMMAND_FAILED',
  'WORKTREE_OUTPUT_TOO_LARGE',
  'WORKTREE_TIMEOUT',
  'WORKTREE_UNAVAILABLE',
] as const

/** One code from {@link WORKTREE_ERROR_CODES}. */
export type WorktreeErrorCode = typeof WORKTREE_ERROR_CODES[number]

/** Worktree failure carrying a stable {@link WorktreeErrorCode}. */
export class WorktreeError extends HarnessError {
  override readonly code: WorktreeErrorCode

  /**
   * @param message - names the operation and the safe next step.
   * @param code - failure class.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: WorktreeErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'WorktreeError'
    this.code = code
  }
}
