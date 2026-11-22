/** Remote-owned QR authentication and an independent shortcut to Token login. */
import { isIPv4 } from 'node:net'
import { FiberState, Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-web-app'
import type {} from '@deepseek-ai/dsh-credentials'
import type { PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { WebEntryUrl } from '@deepseek-ai/dsh-host-webserver'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { LoginTickets } from './login-tickets.ts'
import { handleLogin, isQrLogin } from './host-route.ts'
import { RemoteBrowserAuth } from './remote-auth.ts'
import { renderAuthenticationPage } from './login-page.ts'
import { PairingRequests } from './pairing-requests.ts'
import { registerPairingRoutes } from './pairing-routes.ts'
import { registerAnonymousPairing } from './anonymous-assets.ts'
import type { RemoteConnectionStatus, RemoteLoginId, RemoteLoginState, RemoteLoginTicket } from './types.ts'
import type { PairingDecision, PairingDecisionResult, PairingRequestId, PairingRequestsValue } from './pairing-types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** QR invitations, private login links, and owner-approved browser pairing. */
    remoteConnection: RemoteConnection
  }
}

/** Deployment timing and limits for remote browser login. */
export interface Config {
  /** Absolute lifetime in days for Remote browser credentials; default 30. */
  cookieMaxAgeDays: number
  /** Invitation lifetime in milliseconds; expiry never renews an existing browser session. */
  ticketLifetimeMs: number
  /** Interval in milliseconds between the settings panel's status reads. */
  pollIntervalMs: number
  /** Limits for anonymous requests and approval delivery. */
  pairing: {
    /** Lifetime in milliseconds, including retries of approved delivery. Default: 300000. */
    requestTtlMs: number
    /** Maximum retained requests, including terminal requests until expiry. Default: 32. */
    maxRequests: number
    /** Minimum interval between anonymous creations across this process. Default: 1000. */
    requestIntervalMs: number
    /** Minimum applicant polling interval and periodic approval-list refresh interval. Default: 2000. */
    pollIntervalMs: number
    /** Complete anonymous HTTP request timeout in milliseconds. Default: 10000. */
    requestTimeoutMs: number
    /** Additional attempts after network, timeout, rate-limit, or server failures. Default: 3. */
    maxRetries: number
    /** Maximum exponential retry delay in milliseconds; at least pollIntervalMs. Default: 10000. */
    retryMaxDelayMs: number
  }
}

/** Owner-authorized browser login through QR codes, private links, or pairing requests. */
export default class RemoteConnection extends TypertRemoteService {
  static inject = ['connection', 'connection.authentication', 'credentials', 'webServer', 'webApp']
  static Config: z<Partial<Omit<Config, 'pairing'>> & { pairing?: Partial<Config['pairing']> }, Config> = z.object({
    cookieMaxAgeDays: z.natural().min(1).default(30),
    ticketLifetimeMs: z.natural().min(1).max(2_147_483_647).default(120_000),
    pollIntervalMs: z.natural().min(100).max(2_147_483_647).default(1000),
    pairing: z.object({
      requestTtlMs: z.natural().min(1).max(2_147_483_647).default(300_000),
      maxRequests: z.natural().min(1).default(32),
      requestIntervalMs: z.natural().min(1).default(1_000),
      pollIntervalMs: z.natural().min(1).max(2_147_483_647).default(2_000),
      requestTimeoutMs: z.natural().min(1).max(2_147_483_647).default(10_000),
      maxRetries: z.natural().default(3),
      retryMaxDelayMs: z.natural().min(1).max(2_147_483_647).default(10_000),
    }),
  })

  private readonly tickets = new LoginTickets()
  private readonly pairing: PairingRequests
  private readonly owner: Context
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly requests = new Set<import('node:http').IncomingMessage>()
  private disposed = false

  /**
   * Register anonymous login routes independently of the authenticated application page.
   * @param ctx - Host containing browser authentication, anonymous pages, and the advertised URL.
   * @param config - validated deployment limits; pairing lifetime must exceed its polling interval.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'remoteConnection')
    if (config.pairing.requestTtlMs <= config.pairing.pollIntervalMs) {
      throw new HarnessError('remote-connection: pairing.requestTtlMs must exceed pairing.pollIntervalMs', 'REMOTE_PAIRING_INVALID_CONFIG')
    }
    if (config.pairing.retryMaxDelayMs < config.pairing.pollIntervalMs) {
      throw new HarnessError('remote-connection: pairing.retryMaxDelayMs must be at least pairing.pollIntervalMs', 'REMOTE_PAIRING_INVALID_CONFIG')
    }
    this.pairing = new PairingRequests(config.pairing)
    this.owner = ctx
  }

  /** Prepare durable Remote credentials before publishing anonymous routes. */
  async [Service.init](): Promise<void> {
    const ctx = this.owner
    const auth = await RemoteBrowserAuth.create(ctx.credentials, this.config.cookieMaxAgeDays)
    if (this.stopped) return
    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
    ctx.effect(function* (this: RemoteConnection) {
      yield ctx.connection.authentication.register({
        authenticate: request => !this.stopped && auth.isAuthenticated(request, ctx.webServer.protocol === 'https:') ? peer : undefined,
      })
      yield ctx.on('webserver/request', async (request, response, next) => {
        /* v8 ignore next -- node:http always supplies the incoming request URL. */
        const url = new URL(request.url ?? '/', 'http://dsh.invalid')
        if (request.method !== 'POST' || url.pathname !== '/' || !isQrLogin(url) || this.stopped) {
          await next()
          return
        }
        const disconnected = new AbortController()
        const signal = AbortSignal.any([disconnected.signal, this.lifetime.signal])
        const onClose = (): void => { disconnected.abort() }
        response.once('close', onClose)
        try {
          const admission = ctx.bail(ctx.webServer, 'webserver/authorize', {
            headers: request.headers, method: request.method, url, transport: 'http', signal, socket: request.socket,
          }, 'anonymous')
          if (signal.aborted || request.socket.destroyed || response.destroyed) return
          if (admission === undefined || admission.kind === 'deny') {
            response.writeHead(admission?.status ?? 503, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          this.requests.add(request)
          const task = handleLogin({
            root: ctx.webApp.getAdvertisedUrl(),
            available: this.deployment().availability === 'available',
            consume: token => !this.stopped && this.tickets.consume(token),
            issueCookie: facts => auth.createSessionCookie(facts, ctx.webServer.protocol === 'https:'),
            signal,
          }, request, response)
          this.pending.add(task)
          try { await task } finally { this.pending.delete(task); this.requests.delete(request) }
        } finally {
          response.off('close', onClose)
        }
      })
      registerAnonymousPairing(ctx, this.config.pairing)
      yield registerPairingRoutes(ctx, this.pairing, this.lifetime, request => auth.createSessionCookie(request, ctx.webServer.protocol === 'https:'))
      yield ctx.webServer.register({
        kind: 'exact', path: '/', auth: 'anonymous',
        resource: async (request, admitted) => {
          const task = this.readRoot(request, admitted)
          this.pending.add(task)
          try { return await task } finally { this.pending.delete(task) }
        },
      })
      yield ctx.effect(() => async () => {
        this.disposed = true
        this.lifetime.abort()
        this.tickets.dispose()
        for (const request of this.requests) request.destroy()
        await Promise.allSettled([...this.pending])
      }, 'remote-connection: active requests')
    }.bind(this))
  }

  private get stopped(): boolean {
    return this.disposed || this.owner.fiber.uid === null || this.owner.fiber.state === FiberState.UNLOADING
  }

  private async readRoot(request: Request, admitted?: PeerScope): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const admission = admitted === undefined
      ? this.owner.connection.authentication.authenticate({ headers: request.headers, method: request.method, url: request.url, signal })
      : { peer: admitted }
    const qrLogin = isQrLogin(new URL(request.url))
    if ('rejection' in admission || qrLogin) {
      const headers = {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
      }
      if ('rejection' in admission && admission.rejection !== 401) return new Response('authentication unavailable', { status: admission.rejection, headers })
      const html = renderAuthenticationPage({
        tokenLoginEnabled: this.tokenLoginUrl(this.owner.webApp.getAdvertisedUrl()) !== undefined,
        pairingEnabled: true,
      })
      return new Response(request.method === 'HEAD' ? null : html, { status: qrLogin ? 200 : 401, headers })
    }
    // The Web application owns index.html; the explicit Peer avoids a second authentication pass.
    return this.owner.webServer.readResource(new Request(new URL('index.html', request.url), { method: request.method, headers: request.headers, signal }), admission.peer)
  }

  private tokenLoginUrl(baseUrl: string): string | undefined {
    const entries: WebEntryUrl[] = []
    this.owner.emit(this.owner.webServer, 'webserver/entry-url', baseUrl, entries)
    const root = new URL(baseUrl)
    const entry = entries.find((candidate) => {
      const url = new URL(candidate.url)
      return url.origin === root.origin && url.pathname === root.pathname
        && url.searchParams.getAll('token').length === 1 && Boolean(url.searchParams.get('token'))
    })
    return entry?.url
  }

  /**
   * Read prerequisites and the state of one invitation without disclosing its credential.
   * @param id - invitation to inspect, or null to inspect only deployment prerequisites.
   * @returns deployment availability and invitation state, with the polling interval.
   */
  @Remote
  status(id: RemoteLoginId | null): RemoteConnectionStatus {
    this.requireOwner()
    return { ...this.deployment(), ticket: this.tickets.state(id), pollIntervalMs: this.config.pollIntervalMs }
  }

  /**
   * Authorize a new browser by generating a one-use login invitation; replaces any older invitation.
   * @returns the invitation credential and its fixed expiry.
   */
  @Remote
  create(): RemoteLoginTicket {
    this.requireOwner()
    return this.tickets.create(this.loginBaseUrl('qr'), this.config.ticketLifetimeMs)
  }

  /**
   * Read the advertised URL carrying the process launch token; QR invitations are unchanged.
   * @returns owner-only login URL, reusable until the Host process restarts; never persist or log it.
   */
  @Remote
  loginUrl(): string {
    this.requireOwner()
    const url = this.tokenLoginUrl(this.loginBaseUrl('token'))
    if (url === undefined) throw new RemoteError('remote-connection/token-unavailable', 'Token login is not enabled for this Host.', {})
    return url
  }

  /**
   * Cancel an unused invitation; this never revokes a browser session already issued.
   * @param id - invitation being cancelled; an older ID cannot cancel a replacement.
   * @returns the invitation's final state, including used when a redemption won the race.
   */
  @Remote
  cancel(id: RemoteLoginId): RemoteLoginState {
    this.requireOwner()
    this.tickets.cancel(id)
    return this.tickets.state(id)
  }

  /**
   * Read pending requests without the credentials used to collect their sessions.
   * @param signal - current Remote call's cancellation.
   * @returns pending codes and the deployment's refresh interval.
   */
  @Remote
  pairingRequests(signal: AbortSignal): PairingRequestsValue {
    signal.throwIfAborted()
    this.requireOwner()
    return { requests: this.pairing.list(), pollIntervalMs: this.config.pairing.pollIntervalMs }
  }

  /**
   * Approve or deny one displayed code; the first decision is retained across retries.
   * @param id - request selected after comparing its code with the applicant's screen.
   * @param decision - allow or deny full owner access for the requesting browser.
   * @param signal - current Remote call's cancellation before the decision commits.
   * @returns committed decision, or unavailable after cancellation, expiry, or collection.
   */
  @Remote
  decidePairing(id: PairingRequestId, decision: PairingDecision, signal: AbortSignal): PairingDecisionResult {
    signal.throwIfAborted()
    this.requireOwner()
    return this.pairing.decide(id, decision)
  }

  private requireOwner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('remote-connection/owner-required', 'Only an authenticated owner can authorize browser access.', {})
    }
    if (this.stopped) throw new RemoteError('remote-connection/disposed', 'Remote login is no longer available.', {})
  }

  private loginBaseUrl(method: 'qr' | 'token'): string {
    const deployment = this.deployment()
    if (deployment.availability !== 'available' && (method === 'qr' || !deployment.loginUrlAllowed)) {
      throw new RemoteError('remote-connection/unavailable', 'Configure a reachable, trusted URL before signing in remotely.', {
        reason: deployment.availability,
      })
    }
    return deployment.url
  }

  private deployment(): Pick<RemoteConnectionStatus, 'url' | 'availability' | 'loginUrlAllowed'> {
    const url = this.ctx.webApp.getAdvertisedUrl()
    const root = new URL(url)
    const hostname = root.hostname
    if (hostname.endsWith('.localhost') || hostname === '[::]' || hostname === '0.0.0.0') {
      return { url, availability: 'unreachable-host', loginUrlAllowed: false }
    }
    const admission = this.owner.bail(this.owner.webServer, 'webserver/authorize', {
      headers: { host: root.host, origin: root.origin }, method: 'GET', url: root, transport: 'http',
    }, 'anonymous')
    const loginUrlAllowed = admission?.kind === 'allow'
    if (hostname === 'localhost' || hostname === '[::1]' || (hostname.startsWith('127.') && isIPv4(hostname))) {
      return { url, availability: 'unreachable-host', loginUrlAllowed }
    }
    return { url, availability: loginUrlAllowed ? 'available' : 'untrusted-host', loginUrlAllowed }
  }
}
