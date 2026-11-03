/**
 * Authentication and redirect-rejecting transport shared by the Search and
 * Fetch API providers in this package
 * ([rationale](../../../../.agents/notes/implemented/feature/2026-10-15-deepseek-search-fetch-api.md)).
 * @module @deepseek-ai/dsh-web-deepseek-api/transport
 */
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'

const USER_AGENT = 'deepseek-harness/0.0.1'

/** Account token tried before the API key of an operation. */
interface DeepSeekWebAccountAuth {
  /** API base the token is sent to, including its path prefix. */
  baseURL: string
  /** Resolve the token the account releases for a dispatch endpoint; undefined or empty selects the API key. */
  resolveToken: (endpoint: string) => Promise<string | undefined>
  /** Invalidate the exact token rejected by HTTP 401; failures must not replace the request error. */
  rejectToken: (token: string) => Promise<void>
}

/** Authentication values resolved once for an operation. */
export interface DeepSeekWebAuth {
  /** Account token sent to its own base when released; otherwise the API key is sent to the request's base. */
  account?: DeepSeekWebAccountAuth
  /** Literal API key; takes precedence over the credential resolver. */
  apiKey?: string
  /** Resolve the current API key without retaining it. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-key diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Model-facing diagnostic thrown when no API key resolves; the generic one names {@link apiKeyEnv}. */
  missingKeyMessage?: string
  /**
   * A mounted model route the operation depends on and whose settings do not resolve. The operation fails with
   * `WEB_PROVIDER_MISCONFIGURED` and {@link DeepSeekWebInvalidRoute.message} at the stage that would use the route,
   * before resolving its credential or sending anything.
   */
  invalidRoute?: DeepSeekWebInvalidRoute
}

/** A model route whose settings do not resolve, and the stage of an operation that needs it. */
interface DeepSeekWebInvalidRoute {
  /** `account` fails before the account token is read; `api-key` fails where the API key would be resolved. */
  stage: 'account' | 'api-key'
  /** Model-facing diagnostic naming the route and its recoveries. */
  message: string
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
  /** API base the API key is sent to, including its path prefix. */
  baseURL: string
  /** Operation path appended to the base of the credential sent, such as `/search`. */
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
 * Check whether an authentication source exists; does not resolve credentials.
 * @param auth - Sources for the operation.
 * @returns Whether a literal key or resolver is present.
 */
export function hasDeepSeekWebCredential(auth: DeepSeekWebAuth): boolean {
  return (auth.apiKey?.length ?? 0) > 0 || auth.resolveApiKey !== undefined || auth.account !== undefined
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
  /** Absolute dispatch URL under the base of the credential. */
  readonly endpoint: string
  /** Headers carrying the credential. */
  readonly headers: Readonly<Record<string, string>>
  /** Request-bound invalidation, present only when an account token was sent. */
  readonly reject?: () => Promise<void>
}

/** Dispatch one operation using a single settings and credential snapshot.
 * @param options - Authentication sources for this operation.
 * @param request - Resolved endpoint, JSON payload, and response decoder.
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
 * @param options - the caller's snapshot, so the credential and the endpoint it is sent to come from one section.
 * @param request - the resolved request; its path under the account base scopes the account token.
 * @param signal - abort signal for the surrounding operation.
 * @returns the account-token header and account endpoint when a token resolves, otherwise the API-key headers and the
 *   request's endpoint, tagged by credential kind.
 */
async function authHeaders(
  options: DeepSeekWebAuth, request: DeepSeekWebRequest<unknown>, signal?: AbortSignal,
): Promise<SearchAuth> {
  const { account, invalidRoute } = options
  if (invalidRoute?.stage === 'account') throw routeMisconfigured(invalidRoute)
  if (account !== undefined) {
    const endpoint = joinPath(account.baseURL, request.path)
    const token = await resolveCredential(() => account.resolveToken(endpoint), signal)
    if (token !== undefined && token.length > 0) return {
      kind: 'account', endpoint, headers: { 'x-dsh-auth-token': token },
      reject: async () => { await account.rejectToken(token) },
    }
  }
  if (invalidRoute?.stage === 'api-key') throw routeMisconfigured(invalidRoute)
  const apiKey = await resolveApiKey(options, signal)
  return { kind: 'api-key', endpoint: joinPath(request.baseURL, request.path), headers: {
    ...request.apiKeyHeaders?.(apiKey),
    'authorization': `Bearer ${apiKey}`,
  } }
}

/** The failure of an operation that would use a model route whose settings do not resolve. */
function routeMisconfigured(route: DeepSeekWebInvalidRoute): WebError {
  return new WebError(route.message, 'WEB_PROVIDER_MISCONFIGURED')
}

/** Append an operation path to an API base, without doubling a trailing slash. */
function joinPath(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/u, '')}${path}`
}

/* jscpd:ignore-start */
/**
 * Resolve one operation's API key without retaining it on the provider.
 * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
 * @param signal - abort signal for the surrounding operation.
 * @returns the resolved key.
 */
async function resolveApiKey(options: DeepSeekWebAuth, signal?: AbortSignal): Promise<string> {
  throwIfSearchAborted(signal)
  if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
  const { resolveApiKey } = options
  const resolved = resolveApiKey === undefined ? undefined : await resolveCredential(resolveApiKey, signal)
  if (resolved !== undefined && resolved.length > 0) return resolved
  throw new WebError(
    options.missingKeyMessage ?? `DeepSeek web access has no API key for "${options.apiKeyEnv ?? 'DEEPSEEK_API_KEY'}"`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

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
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
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
