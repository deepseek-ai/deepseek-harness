import { normalizeIdentity } from './keys.ts'
import type {
  IdentityActor,
  IdentityAuthorizationRequest,
  IdentityExchangeRequest,
  IdentityProvider,
} from './types.ts'

/** One fixed local identity used by tests and loopback demos. */
export interface MockIdentityPersona {
  readonly id: string
  readonly tenantId?: string
  readonly displayName?: string
  /** Avatar a provider would publish; absent stands for a provider that issues none. */
  readonly avatarUrl?: string
}

/** Deterministic provider for tests; not an authentication boundary. */
export class MockIdentityProvider implements IdentityProvider {
  readonly scopes: readonly string[] = []

  constructor(
    readonly id: string,
    private readonly personas: readonly MockIdentityPersona[],
  ) {
    if (id === '') throw new Error('mock identity provider id must not be empty')
    if (personas.length === 0) throw new Error('mock identity provider requires at least one persona')
  }

  /** Redirect back to the Relay callback with the selected fixed persona code. */
  authorizationUrl(request: IdentityAuthorizationRequest): URL {
    const selected = request.loginHint ?? this.personas[0]?.id
    if (selected === undefined) throw new Error('mock identity provider has no selectable persona')
    const url = new URL(request.redirectUri)
    url.searchParams.set('code', selected)
    url.searchParams.set('state', request.state)
    return url
  }

  /** Resolve a fixed persona code into a provider-neutral actor. */
  exchange(request: IdentityExchangeRequest): Promise<IdentityActor> {
    const persona = this.personas.find(candidate => candidate.id === request.code)
    if (persona === undefined) return Promise.reject(new Error('mock identity callback code is unknown'))
    const actor = normalizeIdentity({
      providerId: this.id,
      subjectId: persona.id,
      tenantId: persona.tenantId ?? 'mock',
      displayName: persona.displayName ?? persona.id,
      ...(persona.avatarUrl === undefined ? {} : { avatarUrl: persona.avatarUrl }),
    }, 'mock')
    if (actor === undefined) return Promise.reject(new Error('mock identity persona id must not be empty'))
    return Promise.resolve(actor)
  }
}
