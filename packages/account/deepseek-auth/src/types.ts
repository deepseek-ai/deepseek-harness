/**
 * Types of DeepSeek request authentication. Host-only: an authorization carries a secret, so none of these values
 * crosses a Remote boundary or enters a log.
 * @module @deepseek-ai/dsh-deepseek-auth/types
 */
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** A way to authenticate a DeepSeek API request: the API key, or the account sign-in. */
export type DeepSeekAuthKind = 'api-key' | 'account'

/** Which credential pays for an operation: one kind only, or `auto`, which follows the conversation's model route. */
export type DeepSeekAuthBilling = 'auto' | DeepSeekAuthKind

/** Request header an API key is sent in: `authorization` as `Bearer <key>`, `x-api-key` as the bare key. */
export type DeepSeekApiKeyHeader = 'authorization' | 'x-api-key'

/** The deployment the credential of one kind belongs to and, for the API key, where the key is read. */
export interface DeepSeekAuthConnection {
  /** Base URL of the deployment; the credential is sent only to destinations under its origin. */
  readonly baseURL: string
  /** API key only: the credential reference the key is read under; `DEEPSEEK_API_KEY` when omitted. */
  readonly reference?: CredentialRef
  /**
   * API key only: the settings namespace or package name prefixed to the diagnostic of an unusable key; the
   * request's `consumer` when omitted.
   */
  readonly owner?: string
}

/**
 * Where one request goes: a path appended to the origin of the chosen kind's deployment, or one absolute URL, which a
 * kind serves only when the URL is under the origin of that kind's deployment and embeds no credentials.
 */
export type DeepSeekAuthDestination = { readonly path: string } | { readonly url: string }

/** One DeepSeek API request that needs authentication. */
export interface DeepSeekAuthRequest {
  /** Name of the requesting plugin, prefixed to the diagnostic of an unusable key whose connection names no owner. */
  readonly consumer: string
  /** Kinds the destination API accepts; a kind outside this list is never a candidate. */
  readonly accepts: readonly DeepSeekAuthKind[]
  /** Which credential pays; `auto` when omitted. */
  readonly billing?: DeepSeekAuthBilling
  /** Provider route of the model request this operation serves; only `auto` billing reads it. */
  readonly route?: string | undefined
  /** Where the request goes. */
  readonly destination: DeepSeekAuthDestination
  /**
   * The caller's own connection of a kind, used in place of the connected or default one: the configuration
   * generation a model route captured for one request, or a consumer's own endpoint and key.
   */
  readonly connections?: Readonly<Partial<Record<DeepSeekAuthKind, DeepSeekAuthConnection>>>
  /** Headers an API key is sent in; `authorization` when omitted. The account sign-in chooses its own header. */
  readonly apiKeyHeaders?: readonly DeepSeekApiKeyHeader[]
}

/** The credential of one kind released for one request, ready to send. */
export interface DeepSeekAuthorization {
  /** Kind of the credential. */
  readonly kind: DeepSeekAuthKind
  /** Absolute URL the request is sent to. */
  readonly endpoint: string
  /** Request headers carrying the credential. */
  readonly headers: Readonly<Record<string, string>>
  /** API key only: the reference the key was read under, for diagnostics that tell the user where to configure it. */
  readonly reference?: CredentialRef
  /**
   * Invalidate this exact credential after the destination rejected it with HTTP 401, so no later request resends
   * it. Absent for kinds without invalidation. The owner contains storage failures: the caller reports the
   * destination's rejection, never a failure of this call.
   * @returns settlement after the invalidation attempt.
   */
  reject?(): Promise<void>
  /**
   * Aborts when the owner withdraws the credential while requests may carry it, as an account sign-out does. A
   * consumer ends each request it authenticated with this authorization and reports that end as its own failure,
   * not as the caller's cancellation. Absent for kinds that are never withdrawn.
   */
  readonly revoked?: AbortSignal
}

/** One kind a request can authenticate with, in the order the billing chose. Nothing is read until asked. */
export interface DeepSeekAuthCandidate {
  /** Kind of the credential. */
  readonly kind: DeepSeekAuthKind
  /** Absolute URL a request authenticated with this kind is sent to. */
  readonly endpoint: string
  /** API key only: the reference the key is read under. */
  readonly reference?: CredentialRef
  /**
   * Whether {@link resolve} would release a credential, checked without validating it or contacting the
   * destination. Store failures reject.
   * @returns whether a credential of this kind is configured for the endpoint.
   */
  configured(): Promise<boolean>
  /**
   * Release the credential, or `undefined` when none is configured. Store failures and an unusable key reject.
   * @param signal - cancellation for the lookup.
   * @returns the authorization, or `undefined`.
   */
  resolve(signal?: AbortSignal): Promise<DeepSeekAuthorization | undefined>
}

/** A kind the billing chose whose connection does not resolve; an operation that reaches it stops there. */
export interface DeepSeekAuthUnresolved {
  /** Kind of the credential. */
  readonly kind: DeepSeekAuthKind
  /**
   * What did not resolve: the `connection` a model route plugin connected or the caller supplied, or the `deployment`
   * the launch environment names for the account sign-in without a connected account route.
   */
  readonly unresolved: 'connection' | 'deployment'
  /** The failure. */
  readonly error: unknown
}
