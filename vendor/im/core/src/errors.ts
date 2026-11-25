/**
 * Platform error taxonomy and the pipeline's own error types (partial send and stream limits).
 *
 * Adapters construct `PlatformError` in `classify()`.
 */

import type { MessageHandle } from './bot.ts'
import type { RenderReport } from './fallback.ts'
import type { LimitKey } from './mode.ts'

export type PlatformErrorKind = 'retryable' | 'rate-limit' | 'limit' | 'permission' | 'not-found' | 'invalid' | 'fatal'

export interface PlatformErrorInit {
  code?: string | number
  retryAfterMs?: number
  /** Default `'unknown'`. Adapters set `'no'` when the platform answered with an error code. */
  published?: 'no' | 'unknown'
  cause?: unknown
}

export class PlatformError extends Error {
  override name = 'PlatformError'
  kind: PlatformErrorKind
  /** Platform code (Lark 230020, QQ 40054005 …). */
  code?: string | number
  retryAfterMs?: number
  /** Whether the platform definitely did not publish anything (dsh-im receipt status). */
  published: 'no' | 'unknown'

  constructor(kind: PlatformErrorKind, message: string, init: PlatformErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.kind = kind
    this.code = init.code
    this.retryAfterMs = init.retryAfterMs
    this.published = init.published ?? 'unknown'
  }

  static is(error: unknown): error is PlatformError {
    return error instanceof PlatformError
  }
}

/** A hard limit violation of one draft or of a stream. */
export interface LimitViolation {
  /** `size`: bytes / elements / chars; `budget`: edits left, streaming window; `shape`: append-only got a non-prefix change. */
  kind: 'size' | 'budget' | 'shape'
  key?: LimitKey
  limit?: number
  actual?: number
  /** Index of the draft (platform message) concerned, when applicable. */
  part?: number
  message: string
}

/** `bot.send` failed after some parts were published. `handle.parts` holds the sent parts. */
export class PartialSendError extends Error {
  override name = 'PartialSendError'
  constructor(readonly handle: MessageHandle, override readonly cause: unknown, readonly report?: RenderReport) {
    super(`partial send: ${handle.parts.length} part(s) published before failure`, { cause })
  }
}

/** A stream could not stay within one platform message. */
export class StreamLimitError extends Error {
  override name = 'StreamLimitError'
  constructor(readonly violation: LimitViolation, readonly handle?: MessageHandle) {
    super(`stream limit: ${violation.message}`)
  }
}

/** Mode-level degradation rejected because `SendOptions.strict` was set. */
export class StrictRenderError extends Error {
  override name = 'StrictRenderError'
  constructor(readonly report: RenderReport) {
    super('strict send rejected: content would be degraded')
  }
}

/**
 * A fetched resource outgrew the byte limit of the fetch that asked for it. Raised while the body is read, so the
 * bytes past the limit are never buffered: the caller learns the outcome instead of the process holding the whole body.
 */
export class ResourceTooLargeError extends Error {
  override name = 'ResourceTooLargeError'
  constructor(readonly limit: number, readonly declared: number | undefined, message: string) {
    super(message)
  }
}

/**
 * A fetched resource did not finish within the deadline of the fetch that asked for it, its body included. The request
 * is aborted when the deadline passes, so a server that drips its answer holds the caller no longer than that.
 */
export class ResourceTimeoutError extends Error {
  override name = 'ResourceTimeoutError'
  constructor(readonly timeout: number, message: string) {
    super(message)
  }
}
