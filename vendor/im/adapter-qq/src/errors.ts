/**
 * QQ platform errors and their mapping onto the core taxonomy.
 *
 * Every request the REST client makes either succeeds, or raises a {@link QqApiError} carrying the platform's
 * numeric `code` (a non-2xx answer, or a `code` in an otherwise successful body). {@link classify} turns that,
 * a transport failure, or an abort into the `PlatformError` the core retries by, together with `published`, which
 * tells dsh-im whether the platform definitively did not publish anything.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/errors
 */

import { PlatformError, type PlatformErrorKind } from '@deepseek-ai/cordis-plugin-im-core'

const SECOND = 1000

/** Initializer of a {@link QqApiError}. */
export interface QqApiErrorInit {
  /** Numeric platform code of the answer body (`40054010` …). */
  code?: number | undefined
  /** HTTP status the platform (or a proxy) answered with. */
  status?: number | undefined
  /** Decoded answer body, kept for diagnostics. */
  body?: unknown
  /** `Retry-After` of the answer, in milliseconds. */
  retryAfterMs?: number | undefined
  /** Publication verdict when the caller knows better than the code/status rule of {@link classify}. */
  published?: 'no' | 'unknown' | undefined
  cause?: unknown
}

/** A QQ OpenAPI failure: a non-2xx answer, or a `code` in a successful answer body. */
export class QqApiError extends Error {
  override name = 'QqApiError'
  /** Numeric platform code of the answer body, when the platform gave one. */
  readonly code: number | undefined
  /** HTTP status of the answer, when a response was received. */
  readonly status: number | undefined
  /** Decoded answer body, kept for diagnostics. */
  readonly body: unknown
  /** `Retry-After` of the answer, in milliseconds. */
  readonly retryAfterMs: number | undefined
  /** Publication verdict of the failed request, when known. */
  readonly published: 'no' | 'unknown' | undefined

  constructor(message: string, init: QqApiErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.code = init.code
    this.status = init.status
    this.body = init.body
    this.retryAfterMs = init.retryAfterMs
    this.published = init.published
  }

  static is(error: unknown): error is QqApiError {
    return error instanceof QqApiError
  }
}

/** How one platform code is classified. */
export interface QqErrorRule {
  kind: PlatformErrorKind
  message: string
  retryAfterMs?: number
}

/**
 * Platform error code table. Codes outside this table and the quota range below are classified `invalid` and keep the
 * platform's own sentence (see {@link classify}): the platform rejected the request, and its text says why.
 */
export const QQ_ERRORS: Readonly<Record<number, QqErrorRule>> = {
  /** Same `(msg_id, msg_seq)` sent twice. `send.ts` bumps `msg_seq` and retries once. */
  40054005: { kind: 'invalid', message: 'message deduplicated: msg_id + msg_seq already used' },
  /** The content carries a URL that is not registered in the console. */
  40054010: { kind: 'invalid', message: 'URL is not allowed: register the link in the bot console first' },
  /** Keyboard grid (5 rows × 5) or a label longer than 10 characters. */
  40034029: { kind: 'invalid', message: 'keyboard rows, columns or label length exceed the platform limit' },
  /** The bot was muted in the group; treated like a temporary permission loss. */
  40054002: { kind: 'permission', message: 'the bot is muted in this chat' },
  /** C2C requires a friend relationship. */
  40054004: { kind: 'permission', message: 'no friend relationship with the user' },
  /** The user refused bot messages. */
  40054013: { kind: 'permission', message: 'the user rejected messages from this bot' },
  /** Generic "no permission" of the platform. */
  11253: { kind: 'permission', message: 'no permission to perform this request' },
  /** Content over the (unpublished) length cap — the send is safe to re-render shorter. */
  40054007: { kind: 'limit', message: 'message content exceeds the platform length limit' },
  40054018: { kind: 'limit', message: 'message content exceeds the platform length limit' },
  /** Passive window gone: the `msg_id` is no longer usable; a retry cannot succeed. */
  304103: { kind: 'invalid', message: 'the passive message id expired' },
  40034005: { kind: 'invalid', message: 'the passive message id expired' },
  /** Message still in the platform's audit queue (频道 only, but the code is shared). */
  304023: { kind: 'invalid', message: 'the message is pending platform audit' },
  /** ark template not applied for. */
  304004: { kind: 'invalid', message: 'the ark template is not available to this bot' },
  /** 主动消息 quota. */
  22009: { kind: 'rate-limit', message: 'message quota exceeded' },
  /** 主动消息 frequency limit. */
  40034100: { kind: 'rate-limit', message: 'active-message frequency limit exceeded' },
  /**
   * The chat grants no 主动消息 permission, and the reply could not answer an inbound event: nothing was being
   * answered, or the passive window of the event it answers is spent.
   */
  40034105: { kind: 'permission', message: 'this chat does not allow active messages' },
  /** The passive window or the reply budget of the event being answered is spent. */
  40034128: { kind: 'invalid', message: 'the passive window or reply budget of the answered event is spent' },
  /** The interaction id this reply answers is not the form the message body takes. */
  40034025: { kind: 'invalid', message: 'the platform rejected the event id of the answer' },
}

/** Lowest / highest code of the quota family the platform answers with `304…`. */
const QUOTA_RANGE: readonly [number, number] = [304000, 304999]

/**
 * The rule of one platform code: the explicit table first, then the `304…` quota family, then `undefined`.
 *
 * @param code - numeric platform code.
 * @returns the matching rule, if the taxonomy knows the code.
 */
export function ruleFor(code: number): QqErrorRule | undefined {
  const rule = QQ_ERRORS[code]
  if (rule) return rule
  if (code >= QUOTA_RANGE[0] && code <= QUOTA_RANGE[1]) {
    return { kind: 'rate-limit', message: `quota or frequency limit reached (${code})` }
  }
  return undefined
}

/** `Retry-After` of a response, in milliseconds (the header is in seconds). */
function retryAfterOf(response: ResponseLike | undefined): number | undefined {
  if (!response) return undefined
  const value = Number(response.headers.get('retry-after'))
  return Number.isFinite(value) && value > 0 ? value * SECOND : undefined
}

/** How an HTTP status is classified when the answer body carried no platform code. */
function ruleForStatus(status: number): QqErrorRule {
  if (status === 401 || status === 403) return { kind: 'permission', message: 'the platform refused the credentials or permission' }
  if (status === 404) return { kind: 'not-found', message: 'the platform reports the target as absent' }
  if (status === 429) return { kind: 'rate-limit', message: 'the platform is rate limiting this bot' }
  if (status >= 500) return { kind: 'retryable', message: 'the platform failed to answer' }
  return { kind: 'invalid', message: 'the platform rejected the request' }
}

/** Minimal `Response` shape (including `undici.Response`) read by {@link responseOf} and {@link retryAfterOf}. */
interface ResponseLike {
  readonly status: number
  readonly headers: { get(name: string): string | null }
}

/** Whether a failure carried an HTTP answer at all. */
function responseOf(error: unknown): ResponseLike | undefined {
  const response = (error as { response?: unknown } | undefined)?.response
  if (typeof response !== 'object' || response === null) return undefined
  const candidate = response as { status?: unknown; headers?: { get?: unknown } }
  if (typeof candidate.status !== 'number' || typeof candidate.headers?.get !== 'function') return undefined
  return response as ResponseLike
}

/** Whether the failure is a cancellation. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * Map anything a REST call or the gateway can throw onto the core taxonomy.
 *
 * Rules: a platform code wins over the HTTP status; `published` is `'no'` when the platform answered with a code
 * or a 4xx (it definitively rejected the request) and `'unknown'` for a 5xx or a transport failure, whose request
 * may have reached the platform; a network failure and a 5xx are `retryable`; a cancellation is `fatal` and its
 * `published` is `'unknown'`, because the request may already have been written and answered — only a `published`
 * the thrown error itself carries overrides that. A code the table does not list keeps the platform's own sentence,
 * which the client put into the error, so an unclassified refusal still says what the platform refused.
 *
 * @param error - the thrown value.
 * @returns the classified error; an already classified `PlatformError` passes through.
 */
export function classify(error: unknown): PlatformError {
  if (PlatformError.is(error)) return error

 // A cancellation must never become a retry, however it was wrapped on its way here. It does not prove the request
 // never left, so its publication stays unknown unless the thrown error records a verdict of its own.
  if (isAbort(error) || isAbort((error as { cause?: unknown } | undefined)?.cause)) {
    const published = (error as { published?: 'no' | 'unknown' } | undefined)?.published
    return new PlatformError('fatal', 'the request was cancelled', { published: published ?? 'unknown', cause: error })
  }

  if (QqApiError.is(error)) {
 // No code and no status: the request never got an answer, so it is a transport failure.
    if (error.code === undefined && error.status === undefined) {
      return new PlatformError('retryable', error.message, { published: error.published ?? 'unknown', cause: error })
    }
    const rule = error.code === undefined ? undefined : ruleFor(error.code)
    const fallback = rule ?? (error.status === undefined ? undefined : ruleForStatus(error.status))
    const kind = fallback?.kind ?? 'invalid'
    const init: { code?: number | string; retryAfterMs?: number; published?: 'no' | 'unknown'; cause?: unknown } = {
      cause: error,
    }
    if (error.code !== undefined) init.code = error.code
    const retryAfterMs = error.retryAfterMs ?? fallback?.retryAfterMs
    if (retryAfterMs !== undefined) init.retryAfterMs = retryAfterMs
 // A code always means "the platform answered and did not publish"; a 4xx without a code means the same, while
 // a 5xx leaves publication unknown unless the caller decided otherwise.
    init.published = error.published
      ?? (error.code !== undefined || (error.status !== undefined && error.status < 500) ? 'no' : 'unknown')
 // A code the table does not list keeps the platform's own sentence, which the client put into the error
 // (`… answered 400 (code 40034105: 主动消息失败, 无权限)`); a bare HTTP status takes the status rule's sentence.
    const message = rule === undefined && error.code !== undefined ? error.message : fallback?.message ?? error.message
    return new PlatformError(kind, message, init)
  }

  const response = responseOf(error)
  if (response) {
    const rule = ruleForStatus(response.status)
    const init: { retryAfterMs?: number; published?: 'no' | 'unknown'; cause?: unknown } = { cause: error }
    const retryAfterMs = retryAfterOf(response)
    if (retryAfterMs !== undefined) init.retryAfterMs = retryAfterMs
    if (response.status < 500) init.published = 'no'
    return new PlatformError(rule.kind, rule.message, init)
  }

  const message = error instanceof Error && error.message ? error.message : 'QQ request failed'
  return new PlatformError('retryable', message, { cause: error })
}
