/**
 * Authentication and redirect-rejecting transport shared by the Search and
 * Fetch API providers in this package
 * ([rationale](../../../../.agents/notes/implemented/feature/2026-10-15-deepseek-search-fetch-api.md)).
 * @module @deepseek-ai/dsh-web-deepseek-api/transport
 */
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'

const USER_AGENT = 'deepseek-harness/0.0.1'

/**
 * API key of one {@link DeepSeekWebAuthSource}: a literal value, where an empty string means no key, or a credential
 * reference read once per use without retention.
 */
export type DeepSeekWebApiKey = string | {
  /** Credential reference the key is stored under. */
  ref: CredentialRef
  /** Report key presence without reading or validating its value; store failures reject. */
  configured: () => Promise<boolean>
  /** Read and validate the key; undefined or empty means no key, and store or format failures reject. */
  resolve: () => Promise<string | undefined>
}

/**
 * One credential an operation can send, bound to the API base it is sent to. The operation appends its path, such as
 * `/search`, to `baseURL`.
 */
export type DeepSeekWebAuthSource =
  /** The account token released for the dispatch endpoint, sent as `x-dsh-auth-token`. */
  | {
    kind: 'account'
    /** API base the token is sent to, including its path prefix. */
    baseURL: string
    /** Read the token released for a dispatch endpoint; undefined or empty means no token, and read failures reject. */
    resolveToken: (endpoint: string) => Promise<string | undefined>
    /** Invalidate the exact token rejected by HTTP 401; failures must not replace the request error. */
    rejectToken: (token: string) => Promise<void>
  }
  /** An API key, sent as `Authorization: Bearer`. */
  | {
    kind: 'api-key'
    /** API base the key is sent to, including its path prefix. */
    baseURL: string
    /** The key to send. */
    key: DeepSeekWebApiKey
  }
  /** A credential whose settings do not resolve; reaching it fails the operation with `WEB_PROVIDER_MISCONFIGURED`. */
  | {
    kind: 'misconfigured'
    /** Model-facing diagnostic naming the settings and their recoveries. */
    message: string
  }

/**
 * Credentials of one operation in the order the caller chose. The operation reads them in order and sends one request
 * with the first that is present; a later source is not read once an earlier one is present, fails to read, or is
 * misconfigured. Request failures never move to another source.
 */
export interface DeepSeekWebAuth {
  /** Candidate credentials, first preferred. */
  sources: readonly DeepSeekWebAuthSource[]
  /** Model-facing `WEB_PROVIDER_CREDENTIAL_MISSING` diagnostic; omitted uses a generic missing-credential message. */
  missingCredentialMessage?: string
}

/** User-owned endpoint settings named by dispatch failures. */
export interface DeepSeekWebGuidance {
  /** Capability whose endpoint failed. */
  subject: 'Search' | 'Fetch'
  /** Plugin configuration namespace. */
  plugin: string
  /** Whether the endpoint is the capability's own base URL rather than one derived from a model route. */
  custom: boolean
  /** Configuration field of the capability's own base URL. */
  baseURLField: string
  /** Configuration field of the capability's own credential reference. */
  apiKeyEnvField: string
}

/** One fully resolved web API request. */
interface DeepSeekWebRequest<T> {
  /** Operation path appended to the base of the source sent, such as `/search`. */
  path: string
  /** JSON request body. */
  body: object
  /** Protocol headers without credentials. */
  headers?: Readonly<Record<string, string>>
  /** Additional API-key headers; not applied to account tokens. */
  apiKeyHeaders?: (key: string) => Readonly<Record<string, string>>
  /** Validate and project the response. */
  decode: (payload: unknown) => T
  /** Endpoint recovery settings. */
  guidance: DeepSeekWebGuidance
  /** Record model input before dispatch; a throw prevents dispatch. */
  recordRequest?: (endpoint: string) => void
  /** Wait for permission to send after credentials resolve; a rejection prevents dispatch. */
  waitToSend?: (signal?: AbortSignal) => Promise<void>
}

/**
 * Check synchronously whether an operation has a source to try, without reading credentials.
 * @param auth - Sources for the operation.
 * @returns Whether any source is an account, a credential reference, a non-empty literal key, or a misconfigured source
 *   the operation reports.
 */
export function hasDeepSeekWebCredential(auth: DeepSeekWebAuth): boolean {
  return auth.sources.some(source => source.kind !== 'api-key' || typeof source.key !== 'string' || source.key.length > 0)
}

/**
 * Check whether an operation would find a credential, reading the sources in the order {@link dispatchDeepSeekWeb}
 * does. An account source reads its token for the operation's endpoint; a referenced key is only checked for presence,
 * so a malformed or wrong key counts as ready. A misconfigured source or a failed read answers false without reading
 * later sources, because the operation fails there too. Nothing is sent and nothing is retained.
 * @param auth - Sources for the operation.
 * @param path - Operation path appended to each source's base.
 * @returns Whether a source before any misconfigured or unreadable one is present.
 */
export async function isDeepSeekWebAuthReady(auth: DeepSeekWebAuth, path: '/search' | '/fetch'): Promise<boolean> {
  for (const source of auth.sources) {
    switch (source.kind) {
      case 'misconfigured': return false
      case 'account': {
        let token: string | undefined
        try { token = await source.resolveToken(joinPath(source.baseURL, path)) }
        catch (_unreadableGrant) { return false /* The operation fails on this read before it tries another source. */ }
        if (token !== undefined && token.length > 0) return true
        break
      }
      case 'api-key': {
        const { key } = source
        if (typeof key === 'string') {
          if (key.length > 0) return true
          break
        }
        try { if (await key.configured()) return true }
        catch (_unreadableStore) { return false /* The operation fails on this read before it tries another source. */ }
        break
      }
      /* v8 ignore next -- the switch is exhaustive. */
      default: return assertNever(source)
    }
  }
  return false
}

/** Narrow a remote JSON object.
 * @param value - Untrusted JSON.
 * @returns Whether readable object fields exist.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Report malformed upstream JSON without embedding response content.
 * @returns The stable provider error.
 */
export function invalidResponse(): WebError {
  return new WebError('DeepSeek returned an invalid response body', 'WEB_PROVIDER_ERROR')
}

/** Authentication headers and endpoint for one operation, tagged by the credential that produced them. */
interface SearchAuth {
  /** `account` for a DeepSeek account token, `api-key` for an API key. */
  readonly kind: 'account' | 'api-key'
  /** Absolute dispatch URL under the base of the source. */
  readonly endpoint: string
  /** Headers carrying the credential. */
  readonly headers: Readonly<Record<string, string>>
  /** Request-bound invalidation, present only when an account token was sent. */
  readonly reject?: () => Promise<void>
}

/** Dispatch one operation using a single settings and credential snapshot: one request, with the first present source.
 * @param options - Ordered authentication sources for this operation.
 * @param request - Operation path, JSON payload, and response decoder.
 * @param signal - Caller cancellation signal.
 * @returns The validated provider result.
 */
export async function dispatchDeepSeekWeb<T>(
  options: DeepSeekWebAuth, request: DeepSeekWebRequest<T>, signal?: AbortSignal,
): Promise<T> {
  const { body, decode, recordRequest, guidance } = request
  const auth = await authHeaders(options, request, signal)
  const { endpoint } = auth
  await request.waitToSend?.(signal)
  throwIfSearchAborted(signal)
  recordRequest?.(endpoint)
  throwIfSearchAborted(signal)
  let response: Response
  /* jscpd:ignore-start */
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...auth.headers,
        ...request.headers,
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
    throw searchEndpointError(
      guidance,
      endpoint,
      `DeepSeek web request failed: ${String(error)}`,
      error,
    )
  }

  if (!response.ok) {
    const status = response.status
    let message = `DeepSeek API error (HTTP ${status})`
    let aborted: WebError | undefined
    try {
      const parsed: unknown = await response.json()
      if (isRecord(parsed)) {
        const detail = typeof parsed.error === 'string' ? parsed.error
          : isRecord(parsed.error) ? parsed.error.message : parsed.message
        if (typeof detail === 'string' && detail.length > 0) message += `: ${detail}`
      }
    } catch (error: unknown) {
      // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
      // into a generic HTTP-error message — cancellation is not a provider
      // error (the seam's cancellation contract).
      if (signal?.aborted === true || isAbortError(error)) aborted = searchAborted(signal, error)
      // Otherwise: the HTTP status is already captured in `message` above; a
      // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
      // cost a richer provider message, never the real error.
    }
    // The account service released this token only for its inference
    // origin, so the endpoint is not what the user must change.
    if (status === 401 && auth.kind === 'account') {
      // Invalidation can cancel this Session; finish reading the HTTP failure before it does. A cancelled read still
      // invalidates the token the status rejected.
      try { await auth.reject?.() }
      catch (_credentialRemovalFailed) { /* Report the original failure even if credential removal fails. */ }
      throw aborted ?? accountRejectedError(message)
    }
    if (aborted !== undefined) throw aborted
    throw searchEndpointError(guidance, endpoint, message)
  }
  /* jscpd:ignore-end */

  try {
    const payload: unknown = await response.json()
    throwIfSearchAborted(signal)
    return decode(payload)
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
    const message = error instanceof WebError
      ? error.message
      : `DeepSeek returned an unprocessable response body: ${String(error)}`
    throw searchEndpointError(guidance, endpoint, message, error)
  }
}

/** Replace endpoint guidance with sign-in guidance when DeepSeek rejects the account token. */
function accountRejectedError(message: string): WebError {
  return new WebError(
    `${message}\n\nDeepSeek rejected the account sign-in used for this web request. `
    + 'Guide the user to sign in to DeepSeek again; the endpoint does not need changing.',
    'WEB_PROVIDER_ERROR',
  )
}

/**
 * Add endpoint recovery instructions to failures that occur after request dispatch begins.
 * @param options - the plugin and settings fields the guidance names.
 * @param endpoint - the dispatched endpoint.
 * @param message - the failure description.
 * @param cause - the underlying failure, when one exists.
 * @returns the provider failure with recovery instructions.
 */
function searchEndpointError(
  options: DeepSeekWebGuidance, endpoint: string, message: string, cause?: unknown,
): WebError {
  const { subject, plugin } = options
  const baseURLField = `${plugin}.${options.baseURLField}`, apiKeyEnvField = `${plugin}.${options.apiKeyEnvField}`
  const recovery = options.custom
    ? `${subject} sends the API key under ${apiKeyEnvField} to ${baseURLField}. If that endpoint is not intended, guide the`
      + ` user to correct ${baseURLField} and ${apiKeyEnvField}, or to remove both so ${subject} uses the DeepSeek`
      + ' credential of the conversation.'
    : `${subject} derives this endpoint from the base URL of the DeepSeek model provider whose credential it uses. If that`
      + ' endpoint is not intended, guide the user to check that provider\'s base URL on the Models page, or to set'
      + ` ${baseURLField} to a trusted DeepSeek endpoint and ${apiKeyEnvField} to the credential reference of its API key.`
  return new WebError(
    `${message}\n\nThe web request used endpoint ${JSON.stringify(endpoint)}. ${recovery} Only the user should choose or`
    + ' change the endpoint.',
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/**
 * Resolve one operation's authentication headers without retaining a credential on the provider.
 * @param auth - the caller's ordered sources, each binding its credential to the base it is sent to.
 * @param request - the resolved request; its path under the source's base is the endpoint.
 * @param signal - abort signal for the surrounding operation.
 * @returns the headers and endpoint of the first present source, tagged by credential kind.
 * @throws {@link WebError} `WEB_PROVIDER_MISCONFIGURED` at a misconfigured source, `WEB_PROVIDER_ERROR` when a read
 *   fails, `WEB_ABORTED` on cancellation, and `WEB_PROVIDER_CREDENTIAL_MISSING` when no source is present.
 */
async function authHeaders(
  auth: DeepSeekWebAuth, request: DeepSeekWebRequest<unknown>, signal?: AbortSignal,
): Promise<SearchAuth> {
  throwIfSearchAborted(signal)
  for (const source of auth.sources) {
    throwIfSearchAborted(signal)
    switch (source.kind) {
      case 'misconfigured': throw new WebError(source.message, 'WEB_PROVIDER_MISCONFIGURED')
      case 'account': {
        const endpoint = joinPath(source.baseURL, request.path)
        const token = await resolveCredential(() => source.resolveToken(endpoint), signal)
        if (token !== undefined && token.length > 0) return {
          kind: 'account', endpoint, headers: { 'x-dsh-auth-token': token },
          reject: async () => { await source.rejectToken(token) },
        }
        break
      }
      case 'api-key': {
        const { key } = source
        // A conditional await in a ternary can produce negative branch counts in V8-to-Istanbul mapping.
        let apiKey: string | undefined
        if (typeof key === 'string') apiKey = key
        else apiKey = await resolveCredential(key.resolve, signal)
        if (apiKey !== undefined && apiKey.length > 0) return { kind: 'api-key', endpoint: joinPath(source.baseURL, request.path), headers: {
          ...request.apiKeyHeaders?.(apiKey),
          'authorization': `Bearer ${apiKey}`,
        } }
        break
      }
      /* v8 ignore next -- the switch is exhaustive. */
      default: return assertNever(source)
    }
  }
  throw new WebError(
    auth.missingCredentialMessage ?? 'DeepSeek web access has no credential to send',
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/** Append an operation path to an API base, without doubling a trailing slash. */
function joinPath(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/u, '')}${path}`
}

/* v8 ignore start -- reached only by a value outside a closed union, which the compiler rejects. */
/** Reject an unhandled member of a closed union. */
function assertNever(value: never): never {
  throw new Error(`web-deepseek-api: unexpected credential source ${JSON.stringify(value)}`)
}
/* v8 ignore stop */

/* jscpd:ignore-start */
/**
 * Run one credential resolver under the search's cancellation signal. An
 * already-cancelled search never starts the resolver.
 * @param resolve - the resolver; a synchronous throw is mapped like a rejection.
 * @param signal - abort signal for the surrounding search.
 * @returns the resolved credential, or undefined when the resolver supplied none.
 * @throws {@link WebError} `WEB_ABORTED` on cancellation, `WEB_PROVIDER_ERROR` when the resolver fails.
 */
async function resolveCredential(
  resolve: () => Promise<string | undefined>, signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfSearchAborted(signal)
  try {
    return await abortable(resolve(), signal)
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
    throw new WebError(
      `DeepSeek web credential resolution failed: ${String(error)}`,
      'WEB_PROVIDER_ERROR',
      { cause: error },
    )
  }
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      },
    )
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/**
 * Build the provider's stable cancellation error while retaining the caller's reason.
 * @param signal - the aborted caller signal; its reason becomes the cause.
 * @param fallback - the cause when the signal has not aborted, such as a fetch `AbortError`.
 * @returns a `WEB_ABORTED` error.
 */
export function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('DeepSeek web request aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
/* jscpd:ignore-end */
