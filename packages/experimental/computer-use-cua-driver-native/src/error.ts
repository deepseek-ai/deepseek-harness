/** Machine-routable Cua Driver SDK failures. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link CuaDriverError} code:
 * - `CUA_DRIVER_FAILED` — the native SDK rejected the tool call; the message carries the SDK's text.
 *   Inspect fresh desktop state before retrying.
 * - `CUA_DRIVER_INVALID_RESULT` — the native SDK returned a result that is not JSON; report it rather than retrying unchanged.
 */
export const CUA_DRIVER_ERROR_CODES = [
  'CUA_DRIVER_FAILED',
  'CUA_DRIVER_INVALID_RESULT',
] as const

/** One code from {@link CUA_DRIVER_ERROR_CODES}. */
export type CuaDriverErrorCode = typeof CUA_DRIVER_ERROR_CODES[number]

/** Cua Driver native SDK failure carrying a stable {@link CuaDriverErrorCode}; the SDK's error is its `cause`. */
export class CuaDriverError extends HarnessError {
  override readonly code: CuaDriverErrorCode

  /**
   * @param message - names the failed Cua Driver tool or the SDK's own message.
   * @param code - the failure class consumers route on.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: CuaDriverErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'CuaDriverError'
    this.code = code
  }
}
