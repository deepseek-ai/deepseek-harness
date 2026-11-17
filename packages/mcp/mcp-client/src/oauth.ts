/** Explicit browser authorization whose callback, flow, and in-flight work share one owner. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type WebServer from '@deepseek-ai/dsh-host-webserver'
import { auth, exchangeAuthorization, extractWWWAuthenticateParams, OAuthError, OAuthErrorCode, validateAuthorizationResponseIssuer } from '@modelcontextprotocol/client'
import type { OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation } from '@modelcontextprotocol/client'
import { McpTemplateBinding } from './credentials.ts'
import { withDeadline } from './deadline.ts'
import { McpLocalError } from './diagnostic.ts'
import { assertOAuthUrl, McpOAuthCredentials, oauthFetch, oauthRecord, safeOAuthError } from './oauth-credentials.ts'
import type { McpOAuthGrant } from './oauth-credentials.ts'
import type { StreamableHttpConfig } from './index.ts'
import type { McpOAuthConfig } from './oauth-options.ts'
import type { McpCloseResult, McpOAuthAttemptId, McpOAuthAttemptView } from './types.ts'

const CLEANUP_FAILED = 'MCP OAuth cleanup failed'
const CLEANUP_UNSETTLED = 'MCP OAuth cleanup did not settle'

const CALLBACK_PAGE = (lines: readonly string[]): string => '<!doctype html><html><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width"><title>DSH</title>'
  + '<style>body{font:15px/1.6 system-ui,sans-serif;max-width:32em;margin:20vh auto;padding:0 1em}</style></head><body>'
  + lines.map(line => '<p>' + line + '</p>').join('') + '</body></html>'
const CALLBACK_PAGES = {
  received: CALLBACK_PAGE([
    '已收到授权。可以关闭此页，回到 DSH 查看连接结果。',
    'Authorization received. You can close this page and check the connection in DSH.',
  ]),
  incomplete: CALLBACK_PAGE([
    '授权未完成。请回到 DSH 重试。',
    'Authorization was not completed. Return to DSH to try again.',
  ]),
}

interface Attempt {
  view: McpOAuthAttemptView
  controller: AbortController
  running: Promise<void>
  done: Promise<void>
  removeCallback?: () => Promise<void>
}

/** Reuses registration, retains the active grant until commit, and drains cancelled attempts before retry. */
export class McpOAuthAuthorization {
  private readonly credentials: McpOAuthCredentials
  /** Resolves templates and redacts every resolved or received secret from failure logs for the owner lifetime. */
  private readonly binding: McpTemplateBinding<StreamableHttpConfig & { oauth: McpOAuthConfig }>
  private attempt: Attempt | undefined
  private closed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: StreamableHttpConfig & { oauth: McpOAuthConfig },
    private readonly changed: () => void,
  ) {
    this.credentials = new McpOAuthCredentials(ctx, config.oauth)
    this.binding = new McpTemplateBinding(ctx, config)
  }

  /**
   * Read authorization progress without starting a flow.
   * @returns a detached view, or undefined before the first attempt.
   */
  current(): McpOAuthAttemptView | undefined {
    return this.attempt === undefined ? undefined : { ...this.attempt.view }
  }

  /**
   * Start explicit authorization or return the active attempt, requiring Authorization and WebServer.
   * Waiting for previous cleanup is bounded by closeTimeoutMs.
   * @returns the attempt view; retired owners reject, and previous cleanup rejects with `MCP OAuth cleanup failed`
   * when it fails or `MCP OAuth cleanup did not settle` when closeTimeoutMs elapses first.
   */
  async start(): Promise<McpOAuthAttemptView> {
    if (this.closed) throw new McpLocalError('MCP OAuth authorization owner is closed', 'MCP_OAUTH_FAILED')
    const previous = this.attempt
    if (previous !== undefined) {
      if (['starting', 'waiting-browser', 'exchanging', 'committing'].includes(previous.view.phase)) return { ...previous.view }
      await withDeadline(previous.done, this.config.closeTimeoutMs, CLEANUP_UNSETTLED)
        .catch((error: unknown) => { throw safeOAuthError(error) })
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Retirement can occur while previous cleanup is awaited.
      if (this.closed) throw new McpLocalError('MCP OAuth authorization owner is closed', 'MCP_OAUTH_FAILED')
      if (this.attempt !== undefined && this.attempt !== previous) return { ...this.attempt.view }
    }
    const authorization = this.ctx.get('authorization')
    const webServer = this.ctx.get('webServer')
    if (authorization === undefined || webServer === undefined) {
      throw new McpLocalError('Starting MCP OAuth requires authorization and WebServer services', 'MCP_OAUTH_FAILED')
    }
    const attempt: Attempt = {
      view: { id: brandString<McpOAuthAttemptId>(randomUUID()), phase: 'starting' },
      controller: new AbortController(), running: Promise.resolve(), done: Promise.resolve(),
    }
    const unregister = authorization.registerFlow({
      key: this.credentials.key, label: this.config.serverName,
      methods: [{ id: 'oauth', label: 'OAuth' }],
      run: session => attempt.running = this.run(attempt, session, webServer),
    })
    this.attempt = attempt
    attempt.done = authorization.begin({
      key: this.credentials.key, signal: attempt.controller.signal,
      interaction: { notify: () => undefined, prompt: () => Promise.reject(new McpLocalError('MCP OAuth does not request text input', 'MCP_OAUTH_FAILED')) },
    }).then(
      (outcome) => { this.update(attempt, { phase: outcome.status }) },
      (error: unknown) => { this.update(attempt, { phase: 'failed', lastError: this.safeFailure(error).message }) },
    ).then(async () => {
      await attempt.running.catch(() => undefined)
      try { await attempt.removeCallback?.() }
      finally { unregister() }
    }).catch(() => { throw new McpLocalError(CLEANUP_FAILED, 'MCP_OAUTH_FAILED') })
    void attempt.done.catch(() => { this.update(attempt, { phase: 'failed', lastError: CLEANUP_FAILED }) })
    this.changed()
    return { ...attempt.view }
  }

  /** Reject new starts immediately, including retries waiting for previous cleanup, and withdraw active work. */
  retire(): void {
    this.closed = true
    this.attempt?.controller.abort()
  }

  /**
   * Cancel a matching attempt and await cleanup; a commit already admitted by Authorization completes.
   * Cleanup rejects with `MCP OAuth cleanup failed` when it fails or `MCP OAuth cleanup did not settle` when closeTimeoutMs elapses first.
   * @param id - selected attempt; stale ids have no effect on later attempts.
   */
  async cancel(id: McpOAuthAttemptId): Promise<void> {
    const attempt = this.attempt
    if (attempt?.view.id !== id) return
    attempt.controller.abort()
    await withDeadline(attempt.done, this.config.closeTimeoutMs, CLEANUP_UNSETTLED)
      .catch((error: unknown) => { throw safeOAuthError(error) })
  }

  /**
   * Retire the owner and await its callback, flow, and request cleanup within closeTimeoutMs.
   * @returns confirmed closure, since the owner holds no transport, with `cleanupError` set to
   * `MCP OAuth cleanup failed` when cleanup settles with a failure or to `MCP OAuth cleanup did not settle`
   * when closeTimeoutMs elapses first.
   */
  async dispose(): Promise<McpCloseResult> {
    this.retire()
    const attempt = this.attempt
    if (attempt === undefined) return { closeConfirmed: true }
    const cleanup = attempt.done.then(
      (): McpCloseResult => ({ closeConfirmed: true }),
      (): McpCloseResult => ({ closeConfirmed: true, cleanupError: CLEANUP_FAILED }),
    )
    return withDeadline(cleanup, this.config.closeTimeoutMs, CLEANUP_UNSETTLED)
      .catch((): McpCloseResult => ({ closeConfirmed: true, cleanupError: CLEANUP_UNSETTLED }))
  }

  private update(attempt: Attempt, view: Omit<McpOAuthAttemptView, 'id'>): void {
    attempt.view = { id: attempt.view.id, ...view }
    if (!this.closed) this.changed()
  }

  /**
   * Replace a failure with its safe attempt text, logging the redacted cause whenever that text omits it.
   * @param error - attempt failure from the flow or the Authorization service.
   * @returns the fixed or local message the attempt view may expose.
   */
  private safeFailure(error: unknown): McpLocalError {
    const safe = safeOAuthError(error)
    if (safe !== error) this.ctx.logger.warn(this.binding.diagnostic(error, 'explicit authorization'))
    return safe
  }

  private async run(attempt: Attempt, session: AuthorizationSession, webServer: WebServer): Promise<void> {
    const deadline = new AbortController()
    const signal = AbortSignal.any([session.signal, deadline.signal])
    const timeout = setTimeout(() => { deadline.abort() }, this.config.oauth.authorizationTimeoutMs)
    const code = Promise.withResolvers<{ code: string; iss: string | undefined }>()
    void code.promise.catch(() => undefined)
    const abort = (): void => { code.reject(new McpLocalError('MCP OAuth authorization ended before callback', 'MCP_OAUTH_FAILED')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    let clientKey: CredentialKey | undefined
    let discovery: OAuthDiscoveryState | undefined
    let information: StoredOAuthClientInformation | undefined
    let resource: string | undefined
    let verifier: string | undefined
    let consumed = false
    const state = randomBytes(32).toString('base64url')
    const path = '/mcp/oauth/callback/' + createHash('sha256').update(this.credentials.key).digest('hex')
    try {
      const redirectUri = webServer.getOrigin() + path
      const redirect = new URL(redirectUri)
      attempt.removeCallback = this.ctx.effect(() => {
        // The authorization server's redirect is a cross-site navigation, which route admission refuses,
        // so the callback answers before route selection and only for the redirect URI's own authority and path.
        const remove = this.ctx.on('webserver/request', async (req, res, next) => {
          let received: URL
          try { received = new URL(req.url ?? '/', `${redirect.protocol}//${req.headers.host ?? ''}`) }
          catch { await next(); return }
          if (received.origin !== redirect.origin || received.pathname !== redirect.pathname) { await next(); return }
          const reply = (status: number, page: keyof typeof CALLBACK_PAGES = 'incomplete'): void => {
            res.writeHead(status, {
              'cache-control': 'no-store',
              'content-type': 'text/html; charset=utf-8',
              'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
            }).end(CALLBACK_PAGES[page])
          }
          const parameters = received.searchParams
          const receivedState = parameters.get('state') ?? ''
          const validState = Buffer.byteLength(receivedState) === Buffer.byteLength(state)
            && timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
          if (req.method !== 'GET' || !validState || parameters.getAll('state').length !== 1
            || parameters.getAll('iss').length > 1 || parameters.getAll('code').length > 1
            || parameters.getAll('error').length > 1 || parameters.has('code') === parameters.has('error')
            || parameters.get('code') === '' || parameters.get('error') === '') {
            reply(400); return
          }
          if (signal.aborted || consumed || attempt.view.phase !== 'waiting-browser') { reply(410); return }
          try {
            validateAuthorizationResponseIssuer({
              iss: parameters.get('iss') ?? undefined,
              expectedIssuer: discovery?.authorizationServerMetadata?.issuer,
              issParameterSupported: discovery?.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true,
            })
          } catch { reply(400); return }
          consumed = true
          const authorizationCode = parameters.get('code')
          if (authorizationCode === null) {
            if (parameters.get('error') === 'access_denied') attempt.controller.abort()
            else if (parameters.get('error') === OAuthErrorCode.InvalidClient) code.reject(new OAuthError(OAuthErrorCode.InvalidClient, 'MCP OAuth client registration was rejected'))
            else code.reject(new McpLocalError('MCP OAuth authorization was rejected', 'MCP_OAUTH_FAILED'))
            reply(200)
            return
          }
          code.resolve({ code: authorizationCode, iss: parameters.get('iss') ?? undefined })
          reply(200, 'received')
        })
        return async () => {
          attempt.controller.abort()
          try { await withDeadline(attempt.running.catch(() => undefined), this.config.closeTimeoutMs, 'MCP OAuth callback cleanup did not settle') }
          finally { remove() }
        }
      }, 'mcp-oauth.callback')
      const resolved = await this.binding.resolve(signal)
      const serverUrl = new URL(resolved.url).href
      const fetch = oauthFetch(signal, this.config.oauth.requestTimeoutMs)
      const challengeResponse = await fetch(serverUrl, { headers: { ...resolved.headers, Accept: 'application/json, text/event-stream' } })
      const challenge = extractWWWAuthenticateParams(challengeResponse)
      await challengeResponse.body?.cancel()
      const issuerKey = (issuer: string) => this.credentials.clientKey(serverUrl, issuer, redirectUri)
      const provider: OAuthClientProvider = {
        redirectUrl: redirectUri,
        clientMetadata: { client_name: 'DeepSeek Harness', redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
          ...this.config.oauth.scope === undefined ? {} : { scope: this.config.oauth.scope },
        },
        state: () => state,
        clientInformation: async (context) => {
          if (context === undefined) throw new McpLocalError('MCP OAuth issuer is unavailable', 'MCP_OAUTH_FAILED')
          clientKey = issuerKey(context.issuer)
          information = await this.credentials.client(clientKey, context.issuer)
          this.binding.remember(information?.client_secret)
          if (information === undefined && this.config.oauth.clientId !== undefined) {
            information = { client_id: this.config.oauth.clientId, issuer: context.issuer }
            await this.credentials.saveClient(clientKey, context.issuer, information, signal)
          }
          return information
        },
        saveClientInformation: async (value, context) => {
          if (context === undefined) throw new McpLocalError('MCP OAuth issuer is unavailable', 'MCP_OAUTH_FAILED')
          this.binding.remember(value.client_secret)
          await this.credentials.saveClient(issuerKey(context.issuer), context.issuer, value, signal)
          information = value
        },
        tokens: () => undefined,
        saveTokens: () => { throw new McpLocalError('MCP OAuth requires an authorization callback before committing', 'MCP_OAUTH_FAILED') },
        saveDiscoveryState: (value) => { discovery = value },
        discoveryState: () => discovery,
        saveResourceUrl: (value) => { resource = value },
        saveCodeVerifier: (value) => { verifier = this.binding.remember(value) },
        codeVerifier: () => {
          if (verifier === undefined) throw new McpLocalError('MCP OAuth verifier is unavailable', 'MCP_OAUTH_FAILED')
          return verifier
        },
        redirectToAuthorization: (url) => {
          signal.throwIfAborted()
          assertOAuthUrl(url)
          this.update(attempt, { phase: 'waiting-browser', authorizationUrl: url.href })
        },
      }
      const scope = this.config.oauth.scope ?? challenge.scope
      await auth(provider, { serverUrl, fetchFn: fetch,
        ...challenge.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: challenge.resourceMetadataUrl },
        ...scope === undefined ? {} : { scope },
      })
      const callback = await code.promise
      this.binding.remember(callback.code)
      signal.throwIfAborted()
      this.update(attempt, { phase: 'exchanging' })
      if (discovery === undefined || information === undefined || verifier === undefined) {
        throw new McpLocalError('MCP OAuth authorization context is incomplete', 'MCP_OAUTH_FAILED')
      }
      const issuer = discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl
      const tokens = await exchangeAuthorization(issuer, {
        ...discovery.authorizationServerMetadata === undefined ? {} : { metadata: discovery.authorizationServerMetadata },
        clientInformation: information, authorizationCode: callback.code,
        ...callback.iss === undefined ? {} : { iss: callback.iss },
        codeVerifier: verifier, redirectUri,
        ...resource === undefined ? {} : { resource },
        fetchFn: fetch,
      })
      this.binding.remember(tokens.access_token)
      this.binding.remember(tokens.refresh_token)
      signal.throwIfAborted()
      const grant: McpOAuthGrant = {
        version: 1, type: 'mcp-oauth-grant', id: randomUUID(), serverUrl, issuer,
        clientKey: issuerKey(issuer), clientId: information.client_id,
        configuredClientId: this.config.oauth.clientId, configuredScope: this.config.oauth.scope,
        resource, metadata: discovery.authorizationServerMetadata, tokens,
        ...tokens.expires_in === undefined ? {} : { expiresAt: Date.now() + tokens.expires_in * 1000 },
      }
      clearTimeout(timeout)
      this.update(attempt, { phase: 'committing' })
      await session.commit(oauthRecord(grant))
    } catch (error) {
      if (deadline.signal.aborted) throw new McpLocalError('MCP OAuth authorization timed out', 'MCP_TIMEOUT')
      // A withdrawn attempt settles as cancelled, so its interrupted work is not a failure to log.
      if (signal.aborted) throw safeOAuthError(error)
      const failure = this.safeFailure(error)
      if (error instanceof OAuthError && error.toResponseObject().error === 'invalid_client' && clientKey !== undefined) {
        await this.credentials.invalidateClient(clientKey)
      }
      throw failure
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }
}
