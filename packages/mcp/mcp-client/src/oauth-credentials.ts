/** Durable MCP OAuth records and refresh serialized by the credential provider. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialKeyId, credentialKeyScope, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { OAuthClientInformationFullSchema, OAuthClientInformationSchema, OAuthMetadataSchema, OAuthTokensSchema, OpenIdProviderMetadataSchema } from '@modelcontextprotocol/core'
import { refreshAuthorization } from '@modelcontextprotocol/client'
import type { AuthProvider, FetchLike, StoredOAuthClientInformation } from '@modelcontextprotocol/client'
import z from 'zod'
import { McpAuthorizationRequired, McpLocalError, oauthFailure } from './diagnostic.ts'
import type { McpOAuthConfig } from './oauth-options.ts'
import { OAuthSchema } from './oauth-options.ts'

const ClientRecordSchema = z.object({
  version: z.literal(1),
  type: z.literal('mcp-oauth-client'),
  issuer: z.string(),
  information: OAuthClientInformationFullSchema.or(OAuthClientInformationSchema),
})

const GrantSchema = z.object({
  version: z.literal(1),
  type: z.literal('mcp-oauth-grant'),
  id: z.uuid(),
  serverUrl: z.url(),
  issuer: z.string(),
  clientKey: z.string(),
  clientId: z.string(),
  configuredClientId: z.string().optional(),
  configuredScope: z.string().optional(),
  resource: z.url().optional(),
  metadata: OAuthMetadataSchema.or(OpenIdProviderMetadataSchema).optional(),
  tokens: OAuthTokensSchema,
  expiresAt: z.number().optional(),
})

/** Committed tokens bound to one authorization identity and resolved MCP endpoint. */
export type McpOAuthGrant = z.infer<typeof GrantSchema>

/**
 * Encode an OAuth payload for the credential provider's opaque record storage.
 * @param payload - validated grant or client information.
 * @returns a JSON-compatible credential record, omitting absent optional fields.
 */
export function oauthRecord(payload: McpOAuthGrant | z.infer<typeof ClientRecordSchema>): CredentialRecord {
  return { kind: 'grant', payload: JSON.parse(JSON.stringify(payload)) }
}

/**
 * Remove upstream error text while retaining actionable authorization reasons.
 * @param error - caught SDK, transport, or local error.
 * @returns a diagnostic safe to expose in status and tool results.
 */
export function safeOAuthError(error: unknown): McpLocalError {
  return oauthFailure(error) ?? (error instanceof McpLocalError ? error : new McpLocalError('MCP OAuth request failed', 'MCP_OAUTH_FAILED'))
}

/**
 * Require HTTPS, or HTTP on a loopback host, for an OAuth request or browser page.
 * @param value - URL the client is about to request or publish.
 * @throws McpLocalError for any other scheme or host.
 */
export function assertOAuthUrl(value: string | URL): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new McpLocalError('MCP OAuth requires HTTPS except for loopback HTTP', 'MCP_OAUTH_FAILED')
  }
}

/**
 * Create cancellable OAuth requests that reject redirects and inherit no resource headers.
 * @param signal - authorization or connection lifetime.
 * @param timeoutMs - per-request deadline in milliseconds.
 * @returns the SDK fetch implementation.
 */
export function oauthFetch(signal: AbortSignal, timeoutMs: number): FetchLike {
  return async (url, init) => {
    signal.throwIfAborted()
    assertOAuthUrl(url)
    return globalThis.fetch(url, { ...init, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs), ...init?.signal ? [init.signal] : []]),
    })
  }
}

/** Owns an entry's grant and compatible client registrations; never starts interactive authorization. */
export class McpOAuthCredentials {
  /** Durable address of the entry's active grant. */
  readonly key: CredentialKey

  constructor(private readonly ctx: Context, private readonly config: McpOAuthConfig) {
    this.key = parseCredentialKey(OAuthSchema(config).credentialKey)
    this.store()
  }

  private store() {
    const store = this.ctx.get('credentials')
    if (store === undefined) throw new McpLocalError('MCP OAuth requires a credentials provider', 'MCP_CREDENTIALS_UNAVAILABLE')
    return store
  }

  /**
   * Address a registration for the configured client ID and scope.
   * @param serverUrl - resolved MCP endpoint.
   * @param issuer - authorization issuer.
   * @param redirectUri - callback URI.
   * @returns the entry-owned registration key.
   */
  clientKey(serverUrl: string, issuer: string, redirectUri: string): CredentialKey {
    const digest = createHash('sha256').update(JSON.stringify([serverUrl, issuer, redirectUri, this.config.clientId, this.config.scope])).digest('hex')
    return credentialKey(credentialKeyScope(this.key), credentialKeyId(this.key) + '-client-' + digest)
  }

  /**
   * Read registration, including its token endpoint authentication method.
   * @param key - registration key.
   * @param issuer - required issuer.
   * @returns registered information, or undefined when absent.
   */
  async client(key: CredentialKey, issuer: string): Promise<StoredOAuthClientInformation | undefined> {
    const record = await this.store().readRecord(key)
    if (record === undefined) return undefined
    const parsed = record.kind === 'grant' ? ClientRecordSchema.safeParse(record.payload) : undefined
    if (!parsed?.success || parsed.data.issuer !== issuer) throw new McpAuthorizationRequired('binding')
    return { ...parsed.data.information, issuer }
  }

  /**
   * Persist registration after checking cancellation under the write lock.
   * @param key - registration key.
   * @param issuer - authorization issuer.
   * @param information - SDK client information.
   * @param signal - attempt lifetime.
   */
  async saveClient(key: CredentialKey, issuer: string, information: StoredOAuthClientInformation, signal: AbortSignal): Promise<void> {
    await this.store().modifyRecord(key, (current) => {
      signal.throwIfAborted()
      if (current !== undefined && (current.kind !== 'grant' || !ClientRecordSchema.safeParse(current.payload).success)) {
        throw new McpLocalError('MCP OAuth client record is incompatible', 'MCP_OAUTH_FAILED')
      }
      return Promise.resolve(oauthRecord({ version: 1, type: 'mcp-oauth-client', issuer, information }))
    })
  }

  /**
   * Delete a rejected dynamic registration; preserve a configured client identity.
   * @param key - rejected registration key.
   */
  async invalidateClient(key: CredentialKey): Promise<void> {
    if (this.config.clientId === undefined) await this.store().deleteRecord(key)
  }

  private parse(record: CredentialRecord | undefined, serverUrl: string): McpOAuthGrant {
    if (record === undefined) throw new McpAuthorizationRequired('missing')
    const parsed = record.kind === 'grant' ? GrantSchema.safeParse(record.payload) : undefined
    if (!parsed?.success) throw new McpAuthorizationRequired('binding')
    const grant = parsed.data
    if (grant.serverUrl !== serverUrl || grant.configuredClientId !== this.config.clientId || grant.configuredScope !== this.config.scope) {
      throw new McpAuthorizationRequired('binding')
    }
    try { parseCredentialKey(grant.clientKey) }
    catch { throw new McpAuthorizationRequired('binding') }
    return grant
  }

  /**
   * Reject missing grants or incompatible endpoint and OAuth options.
   * @param serverUrl - resolved MCP endpoint.
   * @param signal - caller lifetime.
   * @returns the compatible grant.
   */
  async read(serverUrl: string, signal: AbortSignal): Promise<McpOAuthGrant> {
    const record = await this.store().readRecord(this.key)
    signal.throwIfAborted()
    return this.parse(record, serverUrl)
  }

  private async refresh(bound: McpOAuthGrant, token: string, signal: AbortSignal): Promise<McpOAuthGrant> {
    const record = await this.store().modifyRecord(this.key, async (record) => {
      signal.throwIfAborted()
      const current = this.parse(record, bound.serverUrl)
      if (current.id !== bound.id) throw new McpAuthorizationRequired('binding')
      if (current.tokens.access_token !== token) return undefined
      if (current.tokens.refresh_token === undefined) throw new McpAuthorizationRequired('expired')
      const client = await this.client(parseCredentialKey(current.clientKey), current.issuer)
      if (client?.client_id !== current.clientId) throw new McpAuthorizationRequired('binding')
      const tokens = await refreshAuthorization(current.issuer, {
        ...current.metadata === undefined ? {} : { metadata: current.metadata },
        clientInformation: client,
        refreshToken: current.tokens.refresh_token,
        ...current.resource === undefined ? {} : { resource: current.resource },
        fetchFn: oauthFetch(signal, this.config.requestTimeoutMs),
      })
      const { expiresAt: _expiresAt, ...retained } = current
      return oauthRecord({ ...retained, tokens: { ...tokens, scope: tokens.scope ?? current.tokens.scope },
        ...tokens.expires_in === undefined ? {} : { expiresAt: Date.now() + tokens.expires_in * 1000 },
      })
    })
    signal.throwIfAborted()
    return this.parse(record, bound.serverUrl)
  }

  /**
   * Bind requests and serialized refresh to one grant identity.
   * @param bound - initial grant.
   * @param signal - connection lifetime.
   * @param send - template-bound resource fetch.
   * @returns passive SDK authentication and fetch callbacks.
   */
  transport(bound: McpOAuthGrant, signal: AbortSignal, send: FetchLike): { authProvider: Required<AuthProvider>; fetch: FetchLike } {
    const requests = new WeakMap<Response, { token: string; signal: AbortSignal }>()
    const current = async (): Promise<McpOAuthGrant> => {
      const grant = await this.read(bound.serverUrl, signal)
      if (grant.id !== bound.id) throw new McpAuthorizationRequired('binding')
      return grant
    }
    return {
      authProvider: {
        token: async () => {
          try {
            let grant = await current()
            if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) {
              grant = await this.refresh(bound, grant.tokens.access_token, signal)
            }
            return grant.tokens.access_token
          } catch (error) { throw safeOAuthError(error) }
        },
        onUnauthorized: async ({ response }) => {
          try {
            const request = requests.get(response)
            if (request === undefined) throw new McpLocalError('MCP OAuth response has no credential binding', 'MCP_OAUTH_FAILED')
            await this.refresh(bound, request.token, request.signal)
          } catch (error) { throw safeOAuthError(error) }
        },
      },
      fetch: async (url, init) => {
        try {
          assertOAuthUrl(url)
          await current()
          const requestSignal = AbortSignal.any([signal, ...init?.signal ? [init.signal] : []])
          const authorization = new Headers(init?.headers).get('authorization')
          if (!authorization?.startsWith('Bearer ')) throw new McpLocalError('MCP OAuth request has no bearer token', 'MCP_OAUTH_FAILED')
          const response = await send(url, { ...init, signal: requestSignal, redirect: 'error' })
          requests.set(response, { token: authorization.slice(7), signal: requestSignal })
          return response
        } catch (error) { throw safeOAuthError(error) }
      },
    }
  }
}
