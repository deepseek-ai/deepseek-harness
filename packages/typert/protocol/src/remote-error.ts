/** The one Remote failure class shared by owners, the Gateway, and consumers. */

import { HarnessError } from '@deepseek-ai/dsh-error'
import type { RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure } from './types.ts'

/**
 * One Remote call failure: a `HarnessError` carrying its stable code and typed
 * details. Owners throw it at the failure point; the Host Gateway encodes it
 * onto the wire unchanged; the Client face rebuilds an instance for the
 * `RemoteResult` error branch, so `throw result.error` keeps throw semantics.
 * A tool body that throws it records `name: 'RemoteError'` and its Remote code
 * on `tool/result`. Discrimination is always by `code`, never by instanceof.
 */
export class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends HarnessError {
  /** Structural marker: cross-realm/bundle identification never uses instanceof. */
  readonly isDSHRemoteError: true = true

  /**
   * @param code - stable failure code declared in {@link RemoteErrorDetailsMap}.
   * @param message - human diagnostic carried across the wire.
   * @param details - structured payload typed by the code.
   * @param options - standard Error options (`cause` survives in-process only).
   */
  constructor(
    override readonly code: Code,
    message: string,
    readonly details: RemoteErrorDetailsMap[Code],
    options?: ErrorOptions,
  ) {
    super(message, code, options)
    this.name = 'RemoteError'
  }
}

/**
 * Structurally identify a RemoteError thrown across module or realm copies of
 * this class. Mechanism-internal: the Gateway and test assertions use it;
 * business code receives typed failures and never needs it.
 * @param value - a caught value.
 * @returns the failure when the marker matches, otherwise undefined.
 */
export function remoteErrorOf(value: unknown): RemoteFailure | undefined {
  // Structural, not instanceof: an Error thrown in another realm (iframe, VM)
  // fails instanceof Error here, so the marker plus the code field is the test.
  if (typeof value === 'object' && value !== null
    && (value as { isDSHRemoteError?: unknown }).isDSHRemoteError === true
    && typeof (value as { code?: unknown }).code === 'string') {
    return value as RemoteFailure
  }
  return undefined
}
