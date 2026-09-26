/** Validated platform HTTP messages and restricted browser destinations. */
import { z } from 'zod'
import type { AccountBonusOrderId } from '@deepseek-ai/dsh-deepseek-account/types'

/** Protocol errors expose a stable code, never a response body or authorization URL. */
export class PlatformAuthError extends Error {
  /** @param code - safe error classification. */
  constructor(readonly code: 'network' | 'protocol' | 'expired' | 'storage') { super(`account: ${code}`) }
}

/** An authenticated Platform request was rejected with HTTP 401 or code 40003. */
export class AccountUnauthorizedError extends PlatformAuthError {
  constructor() { super('expired') }
}

/**
 * Accept HTTPS platform endpoints, or explicitly configured loopback development HTTP.
 * @param value - configured origin.
 * @param allowLoopbackHttp - development-only opt-in.
 * @returns normalized origin.
 */
export function platformOrigin(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || (allowLoopbackHttp && loopback && url.protocol === 'http:'))) {
    throw new Error('account: platformOrigin must be an HTTPS origin or explicitly enabled loopback HTTP origin')
  }
  return url.origin
}

/**
 * Validate platform-owned browser destinations without forwarding arbitrary URLs.
 * @param value - returned browser URL.
 * @param origin - configured platform origin.
 * @param path - fixed authorize or completion path.
 * @param rewriteOrigin - map validated browser pages to the configured development origin.
 * @returns normalized URL on the configured origin.
 */
export function browserUrl(value: string, origin: string, path: string, rewriteOrigin = false): string {
  let url: URL
  try { url = new URL(value) } catch {
    console.info('[deepseek-account] browser URL rejected', { path, reason: 'invalid-url' })
    throw new PlatformAuthError('protocol')
  }
  const allowedOrigin = url.origin === origin || (rewriteOrigin && url.protocol === 'https:')
  if (!allowedOrigin || url.pathname !== path || url.username || url.password || url.hash) {
    console.info('[deepseek-account] browser URL rejected', {
      path, originMismatch: !allowedOrigin, pathMismatch: url.pathname !== path,
      hasCredentials: Boolean(url.username || url.password), hasFragment: Boolean(url.hash),
    })
    throw new PlatformAuthError('protocol')
  }
  return rewriteOrigin ? `${origin}${url.pathname}${url.search}` : url.href
}

/**
 * Validate Host-only deployment headers without exposing their values in diagnostics.
 * @param values - configured headers for the Platform origin.
 * @returns normalized headers; authorization, routing and framing remain provider-owned.
 */
export function platformHeaders(values: Record<string, string>): Record<string, string> {
  const headers = new Headers()
  const names = new Set<string>()
  for (const [name, value] of Object.entries(values)) {
    const key = name.toLowerCase()
    if (['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(key)
      || names.has(key)) throw new Error('account: requestHeaders contains a reserved or duplicate header')
    names.add(key)
    try { headers.set(name, value) }
    catch { throw new Error('account: requestHeaders contains an invalid header') }
  }
  return Object.fromEntries(headers)
}

const envelope = z.object({ code: z.literal(0), data: z.object({ biz_code: z.number().int(), biz_data: z.unknown() }) })
/** Successful initialization response. */
export const initialization = z.object({
  authorize_url: z.url(), authorize_id: z.string().min(1), expires_in: z.number().positive(),
})
/** Successful code exchange response. */
export const exchange = z.object({ token: z.string().regex(/^[\x21-\x7e]+$/), authorized_url: z.url(), user: z.unknown().optional() })

/**
 * Read one bounded platform response with stable, non-secret diagnostics.
 * @param origin - validated platform origin.
 * @param method - platform endpoint suffix.
 * @param body - protocol request, never logged.
 * @param signal - attempt cancellation and timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns successful business payload, validated by its caller.
 */
export async function requestPlatform(origin: string, method: string, body: unknown,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/auth-api/v0/dsh/${method}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, signal)
}

/**
 * Fetch a fixed Platform account endpoint with the grant kept in Host request headers.
 * @param origin - configured and grant-matched origin.
 * @param path - account endpoint.
 * @param token - account grant.
 * @param signal - credential lifetime and request timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns successful business payload.
 */
export function requestAccount(origin: string, path: '/auth-api/v0/users/current' | '/api/v0/users/get_user_summary',
  token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}${path}`, { method: 'GET', headers: accountHeaders(headers, token) }, signal)
}

/**
 * Read the granted bonuses Platform has not yet recorded as displayed.
 * @param origin - configured origin matching the grant issuer.
 * @param token - stored account grant.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers for this origin.
 * @returns successful business payload holding the unnotified bonus list.
 */
export function requestUnnotifiedBonuses(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/api/v0/users/get_unnotified_bonuses`,
    { method: 'GET', headers: accountHeaders(headers, token) }, signal)
}

/**
 * Acknowledge an actually displayed bonus to Platform.
 * @param origin - configured origin matching the grant issuer.
 * @param token - stored account grant.
 * @param orderId - granted bonus order the user saw.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers for this origin.
 * @returns successful business payload, which carries no data.
 */
export function requestBonusNotified(origin: string, token: string, orderId: AccountBonusOrderId,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/api/v0/users/ack_bonus_notified`, {
    method: 'POST', headers: { ...accountHeaders(headers, token), 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: orderId }),
  }, signal)
}

// The grant is provider-owned; deployment requestHeaders cannot override it or the client identity.
function accountHeaders(headers: Record<string, string>, token: string): Record<string, string> {
  return { ...headers, 'x-dsh-auth-token': token }
}

/**
 * End the Platform session using its existing logout endpoint.
 * @param origin - configured origin matching the grant issuer.
 * @param token - stored account token.
 * @param signal - logout request deadline.
 * @param headers - validated deployment headers for this origin.
 * @returns after Platform confirms logout.
 */
export async function logoutAccount(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<void> {
  await platformRequest(`${origin}/auth-api/v0/users/logout`, {
    method: 'POST', headers: { ...headers, 'x-dsh-auth-token': token },
  }, signal)
}

async function platformRequest(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const path = new URL(url).pathname
  console.info('[deepseek-account] request', { path, method: init.method })
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal })
  } catch {
    console.info('[deepseek-account] request failed', { path, errorCode: 'network', aborted: signal.aborted })
    throw new PlatformAuthError('network')
  }
  console.info('[deepseek-account] response', { path, status: response.status })
  if (response.status === 401 && new Headers(init.headers).has('x-dsh-auth-token')) {
    await response.body?.cancel()
    throw new AccountUnauthorizedError()
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new PlatformAuthError('network')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let stage = 'read-body'
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 65_536) {
        stage = 'body-limit'
        throw new PlatformAuthError('protocol')
      }
      chunks.push(next.value)
    }
    stage = 'parse-json'
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const authorization = z.object({ code: z.literal(40003) }).safeParse(payload)
    if (authorization.success && new Headers(init.headers).has('x-dsh-auth-token')) {
      throw new AccountUnauthorizedError()
    }
    const codes = z.object({ code: z.number().int(), data: z.object({ biz_code: z.number().int() }).optional() }).safeParse(payload)
    if (codes.success) console.info('[deepseek-account] response codes', {
      path, code: codes.data.code, bizCode: codes.data.data?.biz_code,
    })
    stage = 'envelope'
    const parsed = envelope.safeParse(payload)
    if (!parsed.success) {
      console.info('[deepseek-account] envelope rejected', {
        path, issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })),
      })
      throw new PlatformAuthError('protocol')
    }
    stage = 'business-code'
    if (parsed.data.data.biz_code !== 0) {
      // TODO(product-error-ui): Apply product-defined copy and UI behavior for the supplied biz_code values.
      // Business failures use the existing generic failure UI until then; backend messages stay Host-only.
      throw new PlatformAuthError('protocol')
    }
    return parsed.data.data.biz_data
  } catch (error) {
    console.info('[deepseek-account] response rejected', { path, stage,
      errorCode: error instanceof PlatformAuthError ? error.code : 'protocol' })
    if (error instanceof PlatformAuthError) throw error
    throw new PlatformAuthError('protocol')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * Accept a browser-accessible loopback HTTP origin for local or SSH-forwarded login.
 * @param value - loopback HTTP origin with an explicit port supplied by the authenticated initiating client.
 * @returns normalized origin; remote domains and path-based proxies are unsupported.
 */
export function loginOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new PlatformAuthError('protocol') }
  const explicitPort = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]+)\/?$/i.exec(value)?.[1]
  if (explicitPort === undefined || Number(explicitPort) === 0
    || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new PlatformAuthError('protocol')
  }
  return `${url.protocol}//${url.hostname}:${Number(explicitPort)}`
}
