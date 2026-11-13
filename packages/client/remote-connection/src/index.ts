/** Remote-owned QR authentication and an independent shortcut to Token login. */
import { FiberState, Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-web-app'
import type {} from '@deepseek-ai/dsh-credentials'
import type { PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { WebEntryUrl } from '@deepseek-ai/dsh-host-webserver'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { LoginTickets } from './login-tickets.ts'
import { handleLogin, isQrLogin } from './host-route.ts'
import { RemoteBrowserAuth } from './remote-auth.ts'
import { renderAuthenticationPage } from './login-page.ts'
import type { RemoteConnectionStatus, RemoteLoginId, RemoteLoginState, RemoteLoginTicket } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Short-lived QR login invitations. */
    remoteConnection: RemoteConnection
  }
}

/** Deployment timing for QR login and its settings status. */
export interface Config {
  /** Absolute lifetime in days for Remote browser credentials; default 30. */
  cookieMaxAgeDays: number
  /** Invitation lifetime in milliseconds; expiry never renews an existing browser session. */
  ticketLifetimeMs: number
  /** Interval in milliseconds between the settings panel's status reads. */
  pollIntervalMs: number
}

/** One outstanding invitation, issued by an owner and consumed by a new browser. */
export default class RemoteConnection extends TypertRemoteService {
  static inject = ['connection', 'connection.authentication', 'credentials', 'webServer', 'webApp']
  static Config: z<Partial<Config>, Config> = z.object({
    cookieMaxAgeDays: z.natural().min(1).default(30),
    ticketLifetimeMs: z.natural().min(1).max(2_147_483_647).default(120_000),
    pollIntervalMs: z.natural().min(100).max(2_147_483_647).default(1000),
  })

  private readonly tickets = new LoginTickets()
  private readonly owner: Context
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly requests = new Set<import('node:http').IncomingMessage>()
  private disposed = false

  /**
   * Register the anonymous exchange independently of the authenticated application page.
   * @param ctx - Host containing the existing browser authentication and advertised URL.
   * @param config - validated deployment timing.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'remoteConnection')
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
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
      }
      if ('rejection' in admission && admission.rejection !== 401) return new Response('authentication unavailable', { status: admission.rejection, headers })
      const html = renderAuthenticationPage({
        tokenLoginEnabled: this.tokenLoginUrl(this.owner.webApp.getAdvertisedUrl()) !== undefined,
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
    const deployment = this.availableDeployment()
    return this.tickets.create(deployment.url, this.config.ticketLifetimeMs)
  }

  /**
   * Read the advertised URL carrying the process launch token; QR invitations are unchanged.
   * @returns owner-only login URL, reusable until the Host process restarts; never persist or log it.
   */
  @Remote
  loginUrl(): string {
    this.requireOwner()
    const url = this.tokenLoginUrl(this.availableDeployment().url)
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

  private requireOwner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('remote-connection/owner-required', 'Only an authenticated owner can manage login codes.', {})
    }
    if (this.stopped) throw new RemoteError('remote-connection/disposed', 'Remote login is no longer available.', {})
  }

  private availableDeployment(): Pick<RemoteConnectionStatus, 'url' | 'availability'> {
    const deployment = this.deployment()
    if (deployment.availability !== 'available') {
      throw new RemoteError('remote-connection/unavailable', 'Configure a reachable, trusted URL before signing in remotely.', {
        reason: deployment.availability,
      })
    }
    return deployment
  }

  private deployment(): Pick<RemoteConnectionStatus, 'url' | 'availability'> {
    const url = this.ctx.webApp.getAdvertisedUrl()
    const root = new URL(url)
    const hostname = root.hostname
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]'
      || hostname === '[::]' || hostname === '0.0.0.0' || /^127\./.test(hostname)) {
      return { url, availability: 'unreachable-host' }
    }
    const admission = this.owner.bail(this.owner.webServer, 'webserver/authorize', {
      headers: { host: root.host, origin: root.origin }, method: 'GET', url: root, transport: 'http',
    }, 'anonymous')
    if (admission?.kind === 'deny') {
      return { url, availability: 'untrusted-host' }
    }
    return { url, availability: 'available' }
  }
}
