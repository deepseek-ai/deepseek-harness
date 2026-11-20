/** Persistent Remote browser credentials, independent of Token authentication and runtime Peers. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import { decodeBase64Url as decode, encodeBase64Url as encode } from './base64.ts'

const RECORD_KEY = credentialKey('client-remote-connection', 'browser-session')
const VERSION = 1
const SECRET_BYTES = 32
const DAY_MILLISECONDS = 86_400_000
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000

type AuthenticationErrorCode =
  | 'REMOTE_AUTH_CREDENTIAL_CORRUPT'
  | 'REMOTE_AUTH_CREDENTIAL_UNAVAILABLE'
  | 'REMOTE_AUTH_CREDENTIAL_FAILED'
  | 'REMOTE_AUTH_INVALID_LIFETIME'

class RemoteAuthenticationError extends HarnessError {
  constructor(message: string, code: AuthenticationErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'RemoteAuthenticationError'
  }
}

interface CookiePayload {
  readonly version: typeof VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSecret(value: CredentialRecord | undefined): Buffer | undefined {
  if (value === undefined) return undefined
  if (value.kind !== 'grant' || !record(value.payload)
    || value.payload.version !== VERSION || Object.keys(value.payload).length !== 2
    || typeof value.payload.secret !== 'string') {
    throw new RemoteAuthenticationError(
      'Remote browser-session credentials have an unsupported format; restore the credential record before enabling Remote login.',
      'REMOTE_AUTH_CREDENTIAL_CORRUPT',
    )
  }
  const secret = decode(value.payload.secret)
  if (secret?.byteLength !== SECRET_BYTES) {
    throw new RemoteAuthenticationError(
      'Remote browser-session credentials contain an invalid signing key; restore the credential record before enabling Remote login.',
      'REMOTE_AUTH_CREDENTIAL_CORRUPT',
    )
  }
  return secret
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const payload = { version: VERSION, secret: encode(randomBytes(SECRET_BYTES)) }
  let stored: CredentialRecord | undefined
  try {
    stored = await credentials.modifyRecord(RECORD_KEY, (current) => {
      if (current !== undefined) {
        readSecret(current)
        return Promise.resolve(undefined)
      }
      return Promise.resolve({ kind: 'grant', payload })
    })
  } catch (error) {
    if (error instanceof HarnessError) throw error
    throw new RemoteAuthenticationError(
      'Remote browser-session credentials could not be loaded; check the credential provider before enabling Remote login.',
      'REMOTE_AUTH_CREDENTIAL_FAILED',
      { cause: error },
    )
  }
  const secret = readSecret(stored)
  if (secret === undefined) {
    throw new RemoteAuthenticationError(
      'Remote browser-session credentials were not saved; configure a writable credential provider before enabling Remote login.',
      'REMOTE_AUTH_CREDENTIAL_UNAVAILABLE',
    )
  }
  return secret
}

function header(headers: ConnectionTrustRequest['headers'], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function audience(request: ConnectionTrustRequest, secure: boolean): string | undefined {
  const host = header(request.headers, 'host')
  if (host === undefined || host.length === 0 || /[\s/\\?#@]/u.test(host)) return undefined
  try {
    return new URL(`${secure ? 'https:' : 'http:'}//${host}`).origin
  } catch (_invalidHost) {
    return undefined
  }
}

function cookieName(authority: string): string {
  return `dsh-remote-${encode(createHash('sha256').update(authority).digest())}`
}

function cookieValue(value: string, name: string): string | undefined {
  let found: string | undefined
  for (const part of value.split(';')) {
    const at = part.indexOf('=')
    if (at === -1 || part.slice(0, at).trim() !== name) continue
    if (found !== undefined) return undefined
    found = part.slice(at + 1).trim()
  }
  return found
}

function parsePayload(body: Buffer): CookiePayload | undefined {
  let value: unknown
  try { value = JSON.parse(body.toString('utf8')) } catch (_invalidJson) { return undefined }
  if (!record(value) || Object.keys(value).length !== 4 || value.version !== VERSION
    || typeof value.authority !== 'string'
    || typeof value.issuedAt !== 'number' || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0
    || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt > MAX_DATE_MILLISECONDS) return undefined
  return { version: VERSION, authority: value.authority, issuedAt: value.issuedAt, expiresAt: value.expiresAt }
}

/** A durable signing key and fixed cookie lifetime for the Remote authentication provider. */
export class RemoteBrowserAuth {
  private constructor(private readonly secret: Buffer, private readonly lifetimeMs: number) {}

  /**
   * Load or atomically create Remote's signing key without changing an existing key.
   * @param credentials - persistent provider storing Remote's browser-session grant.
   * @param cookieMaxAgeDays - positive whole days for each credential's absolute lifetime.
   * @returns issuer and verifier whose credentials remain valid across plugin and process restarts until expiry.
   * @throws when the stored record is invalid, the provider fails, or the lifetime exceeds supported timestamps.
   */
  static async create(credentials: CredentialProvider, cookieMaxAgeDays: number): Promise<RemoteBrowserAuth> {
    const lifetimeMs = cookieMaxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0
      || !Number.isInteger(cookieMaxAgeDays) || Date.now() + lifetimeMs > MAX_DATE_MILLISECONDS) {
      throw new RemoteAuthenticationError(
        'Remote cookieMaxAgeDays must be positive whole days within the supported timestamp range.',
        'REMOTE_AUTH_INVALID_LIFETIME',
      )
    }
    return new RemoteBrowserAuth(await initializeSecret(credentials), lifetimeMs)
  }

  /**
   * Sign a Remote browser credential after the caller validates its invitation or approval.
   * @param request - request whose Host selects the signed audience; source policy is checked by the caller's route.
   * @param secure - whether the receiving listener serves HTTPS; selects the audience and Secure attribute.
   * @returns Set-Cookie, or undefined when Host cannot identify an audience. This method does not authenticate the caller.
   */
  createSessionCookie(request: ConnectionTrustRequest, secure: boolean): string | undefined {
    const authority = audience(request, secure)
    if (authority === undefined) return undefined
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.lifetimeMs
    const payload: CookiePayload = { version: VERSION, authority, issuedAt, expiresAt }
    const body = encode(Buffer.from(JSON.stringify(payload)))
    const signed = `v${VERSION}.${body}`
    const signature = encode(createHmac('sha256', this.secret).update(signed).digest())
    const cookie = `${cookieName(authority)}=${signed}.${signature}; Max-Age=${String(this.lifetimeMs / 1000)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
    return secure ? `${cookie}; Secure` : cookie
  }

  /**
   * Verify one Remote credential without changing its fixed expiry or allocating a Peer.
   * @param request - request carrying Host and Cookie; unrelated cookies are ignored.
   * @param secure - whether the receiving listener serves HTTPS; HTTP and HTTPS credentials are isolated.
   * @returns true only for one unambiguous, authentic, unexpired credential for this listener authority.
   */
  isAuthenticated(request: ConnectionTrustRequest, secure: boolean): boolean {
    const authority = audience(request, secure)
    const cookies = header(request.headers, 'cookie')
    if (authority === undefined || cookies === undefined) return false
    const value = cookieValue(cookies, cookieName(authority))
    if (value === undefined) return false
    const parts = value.split('.')
    const [version, body, signature] = parts
    if (parts.length !== 3 || version !== `v${VERSION}` || body === undefined || signature === undefined) return false
    const supplied = decode(signature)
    const expected = createHmac('sha256', this.secret).update(`${version}.${body}`).digest()
    if (supplied?.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) return false
    const bytes = decode(body)
    if (bytes === undefined) return false
    const payload = parsePayload(bytes)
    if (payload === undefined || payload.authority !== authority) return false
    const now = Date.now()
    return payload.issuedAt <= now && payload.expiresAt > now && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= this.lifetimeMs
  }
}
