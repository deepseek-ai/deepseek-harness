/**
 * Lark platform errors and their mapping onto the core taxonomy.
 *
 * Every request the REST client makes either succeeds, or raises a {@link LarkApiError} carrying the platform's
 * numeric `code` (from a non-2xx answer, or from a `code` in an otherwise successful body). {@link classify} turns
 * that, a transport failure or an abort into the `PlatformError` the core retries by, together with `published`,
 * which tells dsh-im whether the platform definitively did not publish anything.
 *
 * Platform error rules:
 * - `230020` / `11232` / HTTP `429` are the frequency limits of the platform;
 * - `300305` / `230025` say the card (or its element count) is too large, which the renderer can fix by re-rendering
 *   shorter — a `limit` error, not a fatal one;
 * - `230034` / `230035` / `230018` (muted, or only designated members may speak) are permissions: the message stays
 *   unsent and the caller sees the platform's own refusal;
 * - `230054` / `230071` reject a threaded reply;
 * - `230075` (the message's edit window has passed) is the platform refusing `PUT /im/v1/messages/{id}` — including
 *   when tenant policy blocks post edits entirely. It is classified `limit`: the stream scheduler treats a `limit` as
 *   a budget violation and resolves it by recall-and-resend instead of failing the stream (see `stream.ts` of
 *   `plugin-im-core`);
 * - `230001` is the platform's generic "invalid parameter".
 *
 * Every refusal is a plain error: what a chat allows is the platform's answer at the moment of the call, never a
 * prediction the adapter caches about the chat.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/errors
 */

import { PlatformError, type PlatformErrorKind } from '@deepseek-ai/cordis-plugin-im-core'

const SECOND = 1000

/**
 * The platform code of the expired edit window — `PUT /im/v1/messages/{id}` on a message that cannot be edited.
 */
export const EXPIRED_EDIT_WINDOW = 230075

/** Initializer of a {@link LarkApiError}. */
export interface LarkApiErrorInit {
  /** Numeric platform code (the `code` field of the answer body). */
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

/** A Lark OpenAPI failure: a non-2xx answer, or a `code` in a successful answer body. */
export class LarkApiError extends Error {
  override name = 'LarkApiError'
  /** Numeric platform code of the answer body, when the platform gave one. */
  readonly code: number | undefined
  /** HTTP status of the answer, when a response was received. */
  readonly status: number | undefined
  /** Decoded answer body, kept for diagnostics. */
  readonly body: unknown
  /** `Retry-After` of the answer, in milliseconds. */
  readonly retryAfterMs: number | undefined
  /** Publication verdict of the failed request, when the caller knew it. */
  readonly published: 'no' | 'unknown' | undefined

  constructor(message: string, init: LarkApiErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.code = init.code
    this.status = init.status
    this.body = init.body
    this.retryAfterMs = init.retryAfterMs
    this.published = init.published
  }

  static is(error: unknown): error is LarkApiError {
    return error instanceof LarkApiError
  }
}

/** How one platform code is classified. */
export interface LarkErrorRule {
  kind: PlatformErrorKind
  message: string
  retryAfterMs?: number
}

/**
 * Platform error code table. Codes outside this table are classified by their HTTP status, and `invalid` when there is
 * no status either.
 */
export const LARK_ERRORS: Readonly<Record<number, LarkErrorRule>> = {
  /** Generic "invalid parameter" of the platform. */
  230001: { kind: 'invalid', message: 'the platform rejected a parameter of the request' },
  /** The app credentials are wrong (token endpoint). */
  10003: { kind: 'invalid', message: 'the app id or app secret is not accepted' },
  10014: { kind: 'permission', message: 'the app id or app secret is not accepted' },
  /** The user is outside the app's availability scope. */
  230013: { kind: 'permission', message: 'the user or chat is outside the application availability scope' },
  /** A `file_key` this app did not upload. */
  230017: { kind: 'invalid', message: 'the file key was uploaded by another application' },
  /** Only designated members may speak in the group. */
  230018: { kind: 'permission', message: 'this group only accepts messages from designated members' },
  /** Frequency limit. */
  230020: { kind: 'rate-limit', message: 'the platform is rate limiting this bot' },
  /** Too many card elements. */
  230025: { kind: 'limit', message: 'the card has too many elements' },
  /** Urgent notifications are disabled in this chat. */
  230027: { kind: 'invalid', message: 'urgent notification is not supported in this chat' },
  /** DLP/保密模式 blocks the read or write. */
  230028: { kind: 'permission', message: 'the message is blocked by the tenant data-protection policy' },
  /** The bot was muted in the group. */
  230035: { kind: 'permission', message: 'the bot is muted in this chat' },
  /** Cross-tenant p2p is forbidden. */
  230038: { kind: 'permission', message: 'cross-tenant direct messages are not allowed' },
  /** The user blocked the bot. */
  230053: { kind: 'permission', message: 'the user does not accept messages from this bot' },
  /** This chat rejects threaded replies. */
  230054: { kind: 'invalid', message: 'this message does not accept a reply' },
  /** Forward of this message kind is not allowed. */
  230066: { kind: 'invalid', message: 'this message cannot be forwarded' },
  /** `reply_in_thread` rejected for this chat. */
  230071: { kind: 'invalid', message: 'this chat rejects threaded replies' },
  /** Editing is disabled in 密聊 / 密盾聊. */
  230073: { kind: 'permission', message: 'messages of this chat cannot be edited' },
  230074: { kind: 'permission', message: 'messages of this chat cannot be edited' },
  /**
   * The message's edit window has passed, or tenant policy refuses `PUT /im/v1/messages/{id}` outright.
   *
   * `limit` is deliberate: the stream scheduler resolves a limit by recalling the streamed message and sending the
   * final state again (a `failure` kind would fail the stream instead).
   */
  [EXPIRED_EDIT_WINDOW]: {
    kind: 'limit',
    message: 'the message can no longer be edited (its edit window has passed)',
  },
  /** Frequency limit (older code of the same family). */
  11232: { kind: 'rate-limit', message: 'the platform is rate limiting this application' },
  /** Card too large. */
  300305: { kind: 'limit', message: 'the card exceeds the platform size limit' },
  /** Missing application scope. */
  99991672: { kind: 'permission', message: 'the application lacks a scope required by this request' },
}

/**
 * The rule of one platform code.
 *
 * @param code - numeric platform code.
 * @returns the matching rule, if the taxonomy knows the code.
 */
export function ruleFor(code: number): LarkErrorRule | undefined {
  return LARK_ERRORS[code]
}

/** How an HTTP status is classified when the answer body carried no platform code. */
function ruleForStatus(status: number): LarkErrorRule {
  if (status === 401 || status === 403) return { kind: 'permission', message: 'the platform refused the credentials or permission' }
  if (status === 404) return { kind: 'not-found', message: 'the platform reports the target as absent' }
  if (status === 429) return { kind: 'rate-limit', message: 'the platform is rate limiting this bot' }
  if (status >= 500) return { kind: 'retryable', message: 'the platform failed to answer' }
  return { kind: 'invalid', message: 'the platform rejected the request' }
}

/** `Retry-After` of a response in milliseconds (the header is in seconds). */
function retryAfterOf(response: ResponseLike | undefined): number | undefined {
  if (!response) return undefined
  const value = Number(response.headers.get('retry-after'))
  return Number.isFinite(value) && value > 0 ? value * SECOND : undefined
}

/** Minimal `Response` shape (including `undici.Response`) read by {@link responseOf} and {@link retryAfterOf}. */
interface ResponseLike {
  readonly status: number
  readonly headers: { get(name: string): string | null }
}

/** The HTTP answer a transport failure carried, if any. */
function responseOf(error: unknown): ResponseLike | undefined {
  const response = (error as { response?: unknown } | undefined)?.response
  if (typeof response !== 'object' || response === null) return undefined
  const candidate = response as { status?: unknown; headers?: { get?: unknown } }
  if (typeof candidate.status !== 'number' || typeof candidate.headers?.get !== 'function') return undefined
  return response as ResponseLike
}

/** Whether the failure is a cancellation (a timeout is not). */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Map anything the REST client or the transport can throw onto the core taxonomy.
 *
 * Rules: a platform code wins over the HTTP status; `published` is `'no'` when the platform answered with a code or
 * a 4xx (it definitively rejected the request) and `'unknown'` for a 5xx or a transport failure, whose request may
 * have reached the platform; a network failure and a 5xx are `retryable`; a cancellation is `fatal` and its
 * `published` is `'unknown'`, because the request may already have been written and answered — only a `published`
 * the thrown error itself carries overrides that.
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

  if (LarkApiError.is(error)) {
    // No code and no status: the request never got an answer, so it is a transport failure.
    if (error.code === undefined && error.status === undefined) {
      return new PlatformError('retryable', error.message, { published: error.published ?? 'unknown', cause: error })
    }
    const rule = error.code === undefined ? undefined : ruleFor(error.code)
    const fallback = rule ?? (error.status === undefined ? undefined : ruleForStatus(error.status))
    const kind = fallback?.kind ?? 'invalid'
    const init: {
      code?: number | string
      retryAfterMs?: number
      published?: 'no' | 'unknown'
      cause?: unknown
    } = { cause: error }
    if (error.code !== undefined) init.code = error.code
    const retryAfterMs = error.retryAfterMs ?? fallback?.retryAfterMs
    if (retryAfterMs !== undefined) init.retryAfterMs = retryAfterMs
    // A code always means "the platform answered and did not publish"; a 4xx without a code means the same, while
    // a 5xx leaves publication unknown unless the caller decided otherwise.
    init.published = error.published
      ?? (error.code !== undefined || (error.status !== undefined && error.status < 500) ? 'no' : 'unknown')
    // A code the taxonomy does not know keeps the platform's own text: it is the only description of what was wrong
    // (e.g. 230099 "Failed to create card content … element exceeds the limit").
    const message = rule !== undefined
      ? rule.message
      : `${fallback?.message ?? 'the platform rejected the request'}${error.code === undefined ? '' : ` (${error.code})`}: ${error.message}`
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

  const message = error instanceof Error && error.message ? error.message : 'Lark request failed'
  return new PlatformError('retryable', message, { cause: error })
}
