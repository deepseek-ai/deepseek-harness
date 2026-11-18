/**
 * Application access token of the QQ official bot.
 *
 * `POST https://bots.qq.com/app/getAppAccessToken { appId, clientSecret }` answers `{ access_token, expires_in }`.
 * The token is refreshed `refreshBeforeMs` (default 60 s) before it expires, and refreshes are **single-flight**:
 * concurrent callers share one request, so a burst of sends cannot rotate the token several times (a second client
 * never invalidates a token; it may only obtain a new one inside the last 60 s, during which both stay valid).
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/token
 */

import { PlatformError } from '@deepseek-ai/cordis-plugin-im-core'
import { classify } from './errors.ts'
import { DEFAULT_TOKEN_URL } from './config.ts'

/** Body of a successful `getAppAccessToken` call; `expires_in` is a string in some platform answers. */
export interface GetAppAccessTokenResult {
  access_token?: string
  expires_in?: number | string
}

/** Request body sent to the token endpoint. */
export interface GetAppAccessTokenRequest {
  appId: string
  clientSecret: string
}

/**
 * HTTP transport of the token request. The adapter passes a `ctx.http`-backed poster; tests pass a stub, so no
 * test needs the network. It must resolve with the decoded JSON body and reject on a transport failure.
 */
export type TokenPoster = (
  url: string,
  data: GetAppAccessTokenRequest,
  signal?: AbortSignal,
) => Promise<GetAppAccessTokenResult>

export interface AccessTokenOptions {
  appId: string
  secret: string
  /** Token endpoint; defaults to {@link DEFAULT_TOKEN_URL}. */
  tokenUrl?: string
  /** Refresh this long before `expires_in` elapses; default 60 s. */
  refreshBeforeMs?: number
  /** Clock injection for tests; default `Date.now`. */
  now?: () => number
  /** POST transport. */
  post: TokenPoster
}

/**
 * Cached application access token with a refresh window and a single-flight refresh.
 *
 * A shared refresh deliberately outlives any single caller's `AbortSignal`: cancelling one send must not cancel the
 * token request another send is waiting on.
 */
export class AccessToken {
  private value: string | undefined
  private expiry: number | undefined
  private pending: Promise<string> | undefined

  constructor(readonly options: AccessTokenOptions) {}

  /** Current token, `undefined` before the first successful fetch. */
  get token() {
    return this.value
  }

  /** Epoch ms at which the platform token stops being accepted, `undefined` before the first fetch. */
  get expiresAt() {
    return this.expiry
  }

  private get now() {
    return (this.options.now ?? Date.now)()
  }

  private get refreshBeforeMs() {
    return this.options.refreshBeforeMs ?? 60_000
  }

  /** Whether a cached token is still outside the refresh window. */
  private get usable() {
    return this.value !== undefined && this.expiry !== undefined && this.now < this.expiry - this.refreshBeforeMs
  }

  /** Whether a cached token is still accepted at all (used when a refresh fails). */
  private get live() {
    return this.value !== undefined && this.expiry !== undefined && this.now < this.expiry
  }

  /**
 * One token, fetching when nothing is cached or the cached token entered the refresh window. Concurrent calls
 * share one request.
 *
 * @param signal - caller cancellation; observed only by callers, never by the shared refresh.
 * @returns the access token.
 * @throws PlatformError `retryable` when no usable token is left after a failed refresh.
 */
  async get(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw cancelledTokenError(signal)
    if (this.usable) return this.value!
    const pending = (this.pending ??= this.refresh().finally(() => {
      this.pending = undefined
    }))
    if (!signal) return await pending
    return await new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(cancelledTokenError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      pending.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort)
      })
    })
  }

  /** Forget the cached token, e.g. after the platform rejected it. The next `get()` refetches. */
  invalidate() {
    this.value = undefined
    this.expiry = undefined
  }

  private async refresh(): Promise<string> {
    const { appId, secret, tokenUrl, post } = this.options
    const url = tokenUrl ?? DEFAULT_TOKEN_URL
    let result: GetAppAccessTokenResult
    try {
      result = await post(url, { appId, clientSecret: secret })
    } catch (error) {
 // A refresh that fails while the cached token is still accepted must not break the caller: the platform
 // keeps the old token valid for the remaining window.
      if (this.live) return this.value!
      const classified = classify(error)
      throw asUnpublishedTokenError(classified, error)
    }
    const accessToken = result?.access_token
    if (typeof accessToken !== 'string' || !accessToken) {
      if (this.live) return this.value!
      const init: { code?: string; published: 'no' } = { published: 'no' }
      if (!result || typeof result !== 'object') init.code = 'invalid-token-response'
      throw new PlatformError('retryable', 'QQ access-token response carried no access_token', init)
    }
    const expiresIn = Number(result?.expires_in)
    this.value = accessToken
    this.expiry = this.now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 7200_000)
    return accessToken
  }
}

/** Pre-request cancellation during token acquisition: no publication request has been sent yet (`published: 'no'`). */
function cancelledTokenError(signal: AbortSignal): PlatformError {
  const { reason } = signal
  if (PlatformError.is(reason)) return asUnpublishedTokenError(reason)
  const message = reason instanceof Error && reason.name !== 'AbortError' && reason.message
    ? reason.message
    : 'the request was cancelled'
  return new PlatformError('fatal', message, {
    published: 'no',
    ...reason === undefined ? {} : { cause: reason },
  })
}

function asUnpublishedTokenError(error: PlatformError, original?: unknown): PlatformError {
  if (error.published === 'no') return error
  const cause = error.cause ?? original ?? error
  const message = original !== undefined && cause === original && error.kind === 'retryable' && error.code === undefined && error.retryAfterMs === undefined
    ? 'failed to obtain a QQ access token'
    : error.message
  return new PlatformError(error.kind, message, {
    published: 'no',
    cause,
    ...error.code === undefined ? {} : { code: error.code },
    ...error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs },
  })
}
