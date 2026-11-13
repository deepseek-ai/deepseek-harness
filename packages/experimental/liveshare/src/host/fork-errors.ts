/** Structured refusals of tool use by a forked or shared Session's viewer-driven turns. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link LiveshareForkDeniedError} code:
 * - `FORK_LIMITS_UNINSTALLED` — no execution limit is installed for the calling fork; nothing it runs can be vouched for.
 * - `FORK_CHILD_UNKNOWN` — the call cannot be attributed to a fork child.
 * - `FORK_CHILD_MISMATCH` — the call reaches into a Session other than the fork it came from.
 * - `FORK_TOOL_NOT_PERMITTED` — the fork's limit or the share's current grant does not admit the tool or its write.
 * - `FORK_PATHS_UNKNOWN` — the tool's filesystem effect could not be established, so it could not be authorized.
 *
 * The model should not retry a refused call unchanged; only `FORK_PATHS_UNKNOWN` can succeed with other arguments.
 * A path outside the granted workspace is a filesystem refusal instead: the guard and the confined tools both
 * record it as `FsError` with `FS_SANDBOX_DENIED`.
 */
export const LIVESHARE_FORK_DENIED_CODES = [
  'FORK_LIMITS_UNINSTALLED',
  'FORK_CHILD_UNKNOWN',
  'FORK_CHILD_MISMATCH',
  'FORK_TOOL_NOT_PERMITTED',
  'FORK_PATHS_UNKNOWN',
] as const

/** One code from {@link LIVESHARE_FORK_DENIED_CODES}. */
export type LiveshareForkDeniedCode = typeof LIVESHARE_FORK_DENIED_CODES[number]

/** Error name recorded on every liveshare grant refusal, thrown or returned by a guard. */
export const LIVESHARE_FORK_DENIED_ERROR_NAME = 'LiveshareForkDeniedError'

/** A tool use the fork's execution limit or the share's grant refused inside a tool body. */
export class LiveshareForkDeniedError extends HarnessError {
  override readonly code: LiveshareForkDeniedCode

  /**
   * @param message - Model-facing refusal.
   * @param code - The refused condition.
   */
  constructor(message: string, code: LiveshareForkDeniedCode) {
    super(message, code)
    this.name = 'LiveshareForkDeniedError'
    this.code = code
  }
}

/** A guard refusal: the model-facing reason and the structured identity the tool runtime records. */
export interface ForkToolDenial {
  readonly reason: string
  readonly info:
    | { readonly name: typeof LIVESHARE_FORK_DENIED_ERROR_NAME; readonly code: LiveshareForkDeniedCode }
    | { readonly name: 'FsError'; readonly code: 'FS_SANDBOX_DENIED' }
}

/**
 * Build a guard refusal of the grant.
 * @param reason - Model-facing refusal.
 * @param code - The refused condition.
 * @returns The refusal in the structure `ToolGuard` denials take.
 */
export function forkToolDenial(reason: string, code: LiveshareForkDeniedCode): ForkToolDenial {
  return { reason, info: { name: LIVESHARE_FORK_DENIED_ERROR_NAME, code } }
}

/**
 * Build a guard refusal of a path outside the granted workspace, with the identity the confined tools throw.
 * @param reason - Model-facing refusal.
 * @returns The refusal in the structure `ToolGuard` denials take.
 */
export function outsideWorkspaceDenial(reason: string): ForkToolDenial {
  return { reason, info: { name: 'FsError', code: 'FS_SANDBOX_DENIED' } }
}
