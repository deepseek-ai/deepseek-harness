/** Machine-routable browser ownership failures. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link BrowserSessionError} code:
 * - `BROWSER_FOREIGN_SESSION` — the browser tool or resource belongs to another Session's browser; this activation cannot use it.
 * - `BROWSER_LOCKED` — another live Session reserves the attached browser; wait for its release or use a new activation later.
 * - `BROWSER_OWNER_NOT_LIVE` — the calling Agent is no longer the live owner, or the provider is disposing; stop using the browser.
 * - `BROWSER_CLOSED` — the Session's browser closed while the operation was admitted; a later call acquires a new browser.
 * - `BROWSER_CLEANUP_FAILED` — closing one or more browsers failed; the cause lists each failure and ownership is retained.
 */
export const BROWSER_SESSION_ERROR_CODES = [
  'BROWSER_FOREIGN_SESSION',
  'BROWSER_LOCKED',
  'BROWSER_OWNER_NOT_LIVE',
  'BROWSER_CLOSED',
  'BROWSER_CLEANUP_FAILED',
] as const

/** One code from {@link BROWSER_SESSION_ERROR_CODES}. */
export type BrowserSessionErrorCode = typeof BROWSER_SESSION_ERROR_CODES[number]

/** Browser ownership failure carrying a stable {@link BrowserSessionErrorCode}. */
export class BrowserSessionError extends HarnessError {
  override readonly code: BrowserSessionErrorCode

  /**
   * @param message - names the provider, the ownership problem, and the safe next step.
   * @param code - the failure class consumers route on.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: BrowserSessionErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'BrowserSessionError'
    this.code = code
  }
}
