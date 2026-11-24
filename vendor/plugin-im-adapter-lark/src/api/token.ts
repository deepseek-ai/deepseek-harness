/**
 * Tenant access token of a Lark / Feishu application.
 *
 * `POST /open-apis/auth/v3/tenant_access_token/internal { app_id, app_secret }` answers
 * `{ code, msg, tenant_access_token, expire }`, where `expire` is the token's lifetime in **seconds** (7200 on a
 * production tenant). The token is refreshed `refreshBeforeMs` (default 30 minutes, the remaining-window rule the
 * ported client used) before it expires, and refreshes are **single-flight**: concurrent callers share one request,
 * so a burst of sends cannot rotate the token several times. A refresh that fails while the cached token is still
 * accepted keeps serving that token instead of failing the caller.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/api/token
 */

import { PlatformError } from '@deepseek-ai/cordis-plugin-im-core'
import { classify, LarkApiError } from '../errors.ts'

/** Body of a successful `tenant_access_token/internal` call; `expire` is the lifetime in seconds. */
export interface TenantAccessTokenResult {
  code?: number
  msg?: string
  tenant_access_token?: string
  expire?: number | string
}

/** Request body of the token endpoint. */
export interface TenantAccessTokenRequest {
  app_id: string
  app_secret: string
}

/**
 * HTTP transport of the token request. The adapter passes a `ctx.http`-backed poster; tests pass a stub, so no test
 * needs the network. It must resolve with the decoded JSON body and reject on a transport failure.
 */
export type TenantTokenPoster = (
  url: string,
  data: TenantAccessTokenRequest,
  signal?: AbortSignal,
) => Promise<TenantAccessTokenResult>

export interface AccessTokenOptions {
  /** Application id. */
  appId: string
  /** Application secret. */
  appSecret: string
  /** OpenAPI root with a trailing slash; the token route hangs below it. */
  baseUrl: string
  /** Refresh this long before `expire` elapses; default 30 minutes. */
  refreshBeforeMs?: number
  /** Clock injection for tests; default `Date.now`. */
  now?: () => number
  /** POST transport. */
  post: TenantTokenPoster
}

/** Route of the internal tenant token (relative to the OpenAPI root). */
export const TENANT_ACCESS_TOKEN_PATH = 'auth/v3/tenant_access_token/internal'

/**
 * Cached tenant access token with a refresh window and a single in-flight refresh.
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

  /** Epoch ms at which the platform issued token stops being accepted, `undefined` before the first fetch. */
  get expiresAt() {
    return this.expiry
  }

  private get now() {
    return (this.options.now ?? Date.now)()
  }

  private get refreshBeforeMs() {
    return this.options.refreshBeforeMs ?? 30 * 60_000
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
   * @param signal - caller cancellation; observed only by this caller, never by the shared refresh.
   * @returns the tenant access token.
   * @throws LarkApiError when the platform rejected the application credentials.
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
    const { appId, appSecret, baseUrl, post } = this.options
    let result: TenantAccessTokenResult
    try {
      result = await post(new URL(TENANT_ACCESS_TOKEN_PATH, baseUrl).href, { app_id: appId, app_secret: appSecret })
    } catch (error) {
      // A refresh that fails while the cached token is still accepted must not break the caller.
      if (this.live) return this.value!
      if (PlatformError.is(error)) return Promise.reject(asUnpublishedTokenError(error))
      if (LarkApiError.is(error)) {
        throw error.published === 'no'
          ? error
          : new LarkApiError(error.message, {
              code: error.code,
              status: error.status,
              body: error.body,
              retryAfterMs: error.retryAfterMs,
              cause: error,
              published: 'no',
            })
      }
      throw asUnpublishedTokenError(classify(error))
    }
    const token = result?.tenant_access_token
    if (typeof token !== 'string' || !token) {
      if (this.live) return this.value!
      // A credential failure comes back as a code in a 200 answer, so it is a platform answer, not a transport one.
      if (typeof result?.code === 'number' && result.code !== 0) {
        throw new LarkApiError(`tenant access token rejected: ${result.msg ?? 'unknown error'}`, {
          code: result.code, status: 200, published: 'no',
        })
      }
      throw new PlatformError('retryable', 'Lark tenant access-token response carried no tenant_access_token', {
        code: 'invalid-token-response',
        published: 'no',
      })
    }
    const expire = Number(result?.expire)
    this.value = token
    this.expiry = this.now + (Number.isFinite(expire) && expire > 0 ? expire * 1000 : 7200_000)
    return token
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

function asUnpublishedTokenError(error: PlatformError): PlatformError {
  if (error.published === 'no') return error
  return new PlatformError(error.kind, error.message, {
    published: 'no',
    cause: error,
    ...error.code === undefined ? {} : { code: error.code },
    ...error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs },
  })
}
