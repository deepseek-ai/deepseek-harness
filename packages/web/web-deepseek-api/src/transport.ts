/**
 * Authentication and redirect-rejecting transport shared by the Search and
 * Fetch API providers in this package
 * ([rationale](../../../../.agents/notes/implemented/feature/2026-10-15-deepseek-search-fetch-api.md)).
 * @module @deepseek-ai/dsh-web-deepseek-api/transport
 */
import type { DeepSeekAuthCandidate, DeepSeekAuthKind, DeepSeekAuthorization } from '@deepseek-ai/dsh-deepseek-auth'
import { WebError } from '@deepseek-ai/dsh-web'

const USER_AGENT = 'deepseek-harness/0.0.1'

/** One credential an operation can send, bound to the endpoint it is sent to. */
export type DeepSeekWebAuthSource =
  /**
   * A credential kind `ctx.deepseekAuth` bound to the operation's endpoint. It answers presence and releases the
   * request headers per use; read failures reject.
   */
  | DeepSeekAuthCandidate
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
  /** JSON request body. */
  body: object
  /** Protocol headers without credentials. */
  headers?: Readonly<Record<string, string>>
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
 * @returns Whether any source exists: a credential kind bound to the endpoint, or a misconfigured source the
 *   operation reports.
 */
export function hasDeepSeekWebCredential(auth: DeepSeekWebAuth): boolean {
  return auth.sources.length > 0
}

/**
 * Check whether an operation would find a credential, reading the sources in the order {@link dispatchDeepSeekWeb}
 * does. Each source is only asked whether a credential is configured, so a malformed or wrong key counts as ready. A
 * misconfigured source or a failed read answers false without reading later sources, because the operation fails there
 * too. Nothing is sent and nothing is retained.
 * @param auth - Sources for the operation.
 * @returns Whether a source before any misconfigured or unreadable one is present.
 */
export async function isDeepSeekWebAuthReady(auth: DeepSeekWebAuth): Promise<boolean> {
  for (const source of auth.sources) {
    if (source.kind === 'misconfigured') return false
    try { if (await source.configured()) return true }
    catch (_unreadableCredential) { return false /* The operation fails on this read before it tries another source. */ }
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

/** Dispatch one operation using a single settings and credential snapshot: one request, with the first present source.
 * @param options - Ordered authentication sources for this operation.
 * @param request - JSON payload and response decoder.
 * @param signal - Caller cancellation signal.
 * @returns The validated provider result.
 */
export async function dispatchDeepSeekWeb<T>(
  options: DeepSeekWebAuth, request: DeepSeekWebRequest<T>, signal?: AbortSignal,
): Promise<T> {
  const { body, decode, recordRequest, guidance } = request
  const auth = await authorize(options, signal)
  const { endpoint } = auth
  await request.waitToSend?.(signal)
  throwIfSearchAborted(signal)
  recordRequest?.(endpoint)
  throwIfSearchAborted(signal)
  let response: Response
  /* jscpd:ignore-start */
  const live = requestSignal(signal, auth.revoked)
  /**
   * The failure of an interrupted request: the caller's cancellation first, then the withdrawal of the sent credential.
   * @param error - what the interrupted fetch or body read threw.
   * @returns the failure to report, or undefined when `error` is no interruption.
   */
  const interrupted = (error: unknown): WebError | undefined => {
    if (signal?.aborted === true) return searchAborted(signal, error)
    if (auth.revoked?.aborted === true) return credentialWithdrawnError(auth.kind, error)
    return isAbortError(error) ? searchAborted(signal, error) : undefined
  }
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
      ...live !== undefined ? { signal: live } : {},
    })
  } catch (error: unknown) {
    throw interrupted(error) ?? searchEndpointError(
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
      // An interruption mid-body must surface as itself, not be swallowed
      // into a generic HTTP-error message — cancellation is not a provider
      // error (the seam's cancellation contract).
      aborted = interrupted(error)
      // Otherwise: the HTTP status is already captured in `message` above; a
      // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
      // cost a richer provider message, never the real error.
    }
    if (status === 401) {
      // Invalidation can cancel this Session; finish reading the HTTP failure before it does. A cancelled read still
      // invalidates the credential the status rejected.
      try { await auth.reject?.() }
      catch (_invalidationFailed) { /* The HTTP rejection stays the reported failure when the invalidation itself fails. */ }
      // The account service released its credential only for its inference origin, so the endpoint is not what the
      // user must change.
      if (auth.kind === 'account') throw aborted ?? accountRejectedError(message)
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
    const stopped = interrupted(error)
    if (stopped !== undefined) throw stopped
    const message = error instanceof WebError
      ? error.message
      : `DeepSeek returned an unprocessable response body: ${String(error)}`
    throw searchEndpointError(guidance, endpoint, message, error)
  }
}

/**
 * The signal one request runs under: the caller's cancellation and the withdrawal of the credential it carries.
 * @param signal - caller cancellation, when the caller supplies one.
 * @param revoked - withdrawal of the sent credential, when its authorization offers one.
 * @returns the composed signal, or undefined when neither exists.
 */
function requestSignal(signal: AbortSignal | undefined, revoked: AbortSignal | undefined): AbortSignal | undefined {
  if (signal === undefined || revoked === undefined) return signal ?? revoked
  return AbortSignal.any([signal, revoked])
}

/**
 * Report a request that ended because the owner withdrew the credential it carried. The caller did not cancel, so the
 * failure is the provider's.
 * @param kind - kind of the withdrawn credential.
 * @param cause - what the interrupted fetch or body read threw.
 * @returns the provider failure, with sign-in guidance for an account credential.
 */
function credentialWithdrawnError(kind: DeepSeekAuthKind, cause: unknown): WebError {
  return new WebError(
    kind === 'account'
      ? 'The DeepSeek account signed out before this web request finished. Guide the user to sign in to DeepSeek again;'
        + ' the endpoint does not need changing.'
      : 'The credential this web request carried was withdrawn before the request finished. Guide the user to check that'
        + ' credential on the Models page.',
    'WEB_PROVIDER_ERROR',
    { cause },
  )
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
 * Release the credential of the first present source without retaining it on the provider.
 * @param auth - the caller's ordered sources, each bound to the endpoint its credential is sent to.
 * @param signal - abort signal for the surrounding operation.
 * @returns the authorization of the first present source.
 * @throws {@link WebError} `WEB_PROVIDER_MISCONFIGURED` at a misconfigured source, `WEB_PROVIDER_ERROR` when a read
 *   fails, `WEB_ABORTED` on cancellation, and `WEB_PROVIDER_CREDENTIAL_MISSING` when no source is present.
 */
async function authorize(auth: DeepSeekWebAuth, signal?: AbortSignal): Promise<DeepSeekAuthorization> {
  throwIfSearchAborted(signal)
  for (const source of auth.sources) {
    throwIfSearchAborted(signal)
    if (source.kind === 'misconfigured') throw new WebError(source.message, 'WEB_PROVIDER_MISCONFIGURED')
    const authorization = await resolveCredential(() => source.resolve(signal), signal)
    if (authorization !== undefined) return authorization
  }
  throw new WebError(
    auth.missingCredentialMessage ?? 'DeepSeek web access has no credential to send',
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/* jscpd:ignore-start */
/**
 * Run one credential resolver under the search's cancellation signal. An
 * already-cancelled search never starts the resolver.
 * @param resolve - the resolver; a synchronous throw is mapped like a rejection.
 * @param signal - abort signal for the surrounding search.
 * @returns the resolved credential, or undefined when the resolver supplied none.
 * @throws {@link WebError} `WEB_ABORTED` on cancellation, `WEB_PROVIDER_ERROR` when the resolver fails.
 */
async function resolveCredential<T>(resolve: () => Promise<T>, signal?: AbortSignal): Promise<T> {
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
  if (signal.aborted) {
    // The operation began before this check and can still reject: a credential read that cancels its caller, then
    // fails. Observing it keeps that rejection from being unhandled.
    void operation.catch(() => {})
    return Promise.reject(searchAborted(signal))
  }
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
