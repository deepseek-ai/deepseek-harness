/** Provider, tenant, and subject triple that identifies one person across providers. */
export interface IdentityTriple {
  /** Identity provider that owns the subject. */
  readonly providerId: string
  /** Provider tenant that contains the subject. */
  readonly tenantId: string
  /** Provider-scoped subject id. */
  readonly subjectId: string
}

/** Provider-neutral viewer identity resolved by a Relay. */
export interface IdentityActor extends IdentityTriple {
  readonly displayName: string
  /**
   * Provider-issued avatar URL, when the provider publishes one. Presentation only: it carries no
   * credential, and a provider that issues none leaves it absent rather than inventing a value.
   */
  readonly avatarUrl?: string
}

/** Request facts needed to build one provider authorization redirect. */
export interface IdentityAuthorizationRequest {
  readonly state: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
  readonly loginHint?: string
}

/** Request facts needed to exchange a provider callback code. */
export interface IdentityExchangeRequest {
  readonly code: string
  readonly redirectUri: string
}

/** Generic browser OAuth contract a deployment's identity adapter implements; the protocol's mock implements it for local runs. */
export interface IdentityProvider {
  readonly id: string
  readonly scopes: readonly string[]
  authorizationUrl(request: IdentityAuthorizationRequest): URL
  exchange(request: IdentityExchangeRequest): Promise<IdentityActor>
}
