/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PeerId, PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionInteractions } from './connect-protocol.ts'
import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge } from './http-bridge.ts'
import { isRemoteAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type { BrowserAuth } from './browser-auth.ts'
import { Peer } from './peer.ts'
import type {
  PeerAdmission,
  ConnectionAdmission,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface PeerRecord {
  readonly peer: Peer
  ownsSocket: boolean
}

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: ConnectionFetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  /** The Peer every authenticated browser connection shares. */
  readonly browserPeer: PeerScope
  private readonly peers = new Map<PeerId, PeerRecord>()
  private readonly owner: Context
  private disposed = false
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()

  readonly allowsRemoteAuthorities: boolean

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param browserAuth - process token and persistent browser-session owner.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
  ) {
    super(ctx, 'connection')
    this.owner = ctx
    this.browserPeer = new Peer(ctx, { principal: { kind: 'owner' } })
    ctx.effect(() => async () => {
      this.disposed = true
      const peers = [this.browserPeer, ...Array.from(this.peers.values(), record => record.peer)]
      this.peers.clear()
      await Promise.all(peers.map(peer => peer.dispose()))
    }, 'client-connection: Peer scopes')
    this.allowsRemoteAuthorities = trustedHosts.some(isRemoteAuthority)
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** Apply the Host/Origin fence and require an authenticated live Peer. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    const admission = this.admit(request)
    return 'rejection' in admission ? admission.rejection : undefined
  }

  /** Browser requests share an owner Peer; API HTTP does not depend on an attached socket. */
  admit(request: ConnectionTrustRequest): PeerAdmission {
    if (!this.isTrusted(request)) return { rejection: 403 }
    if (this.disposed) return { rejection: 401 }
    const secure = this.owner.get('webServer')?.protocol === 'https:'
    if (this.browserAuth.isAuthenticated(request, secure)) return { peer: this.browserPeer }
    const id = this.browserAuth.authenticateApi(request, secure)
    const record = id === undefined ? undefined : this.peers.get(id)
    return record === undefined ? { rejection: 401 } : { peer: record.peer }
  }

  /** Create one in-process Peer owned by the Context that read this service. */
  createPeer(options: { readonly principal: Principal; readonly interactions?: ConnectionInteractions }): PeerScope {
    return new Peer(this.ctx, options)
  }

  /** Claim API socket ownership synchronously; callers release on termination or failed upgrade. */
  admitConnection(request: ConnectionTrustRequest): ConnectionAdmission {
    const admission = this.admit(request)
    if ('rejection' in admission) return admission
    const record = this.peers.get(admission.peer.id)
    if (record === undefined) return { ...admission, release: () => Promise.resolve() }
    if (record.ownsSocket) return { rejection: 409 }
    record.ownsSocket = true
    let released: Promise<void> | undefined
    return {
      peer: record.peer,
      release: () => {
        if (released !== undefined) return released
        this.peers.delete(record.peer.id)
        released = record.peer.dispose()
        return released
      },
    }
  }

  private isTrusted(request: ConnectionTrustRequest): boolean {
    const carrier = this.owner.get('webServer')
    return isTrustedApiRequest(request, this.trustedHosts, carrier?.host, carrier?.protocol ?? 'http:')
  }

  private publishPeer(interactions: ConnectionInteractions): PeerId {
    const peer = new Peer(this.owner, { principal: { kind: 'owner' }, interactions })
    this.peers.set(peer.id, { peer, ownsSocket: false })
    return peer.id
  }

  /**
   * Authenticate and publish a credential before sending the connect redirect.
   * @param request - launch-token request on /connect.
   * @param response - response owned to completion.
   */
  authorizeConnect(request: ConnectionIndexRequest, response: ConnectionIndexResponse): void {
    if (!this.isTrusted(request) || this.disposed) {
      response.writeHead(this.disposed ? 401 : 403)
      response.end(this.disposed ? 'unauthorized' : 'forbidden')
      return
    }
    this.browserAuth.authorizeConnect(request, response,
      this.owner.get('webServer')?.protocol === 'https:', interactions => this.publishPeer(interactions))
  }

  /**
   * Authenticate an index request; native TLS listeners mint Secure cookies.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    return this.browserAuth.authorizeIndex(request, response, this.ctx.get('webServer')?.protocol === 'https:')
  }

  /** Add this process's launch token to the clean application URL. */
  authenticatedUrl(baseUrl: string): string {
    return this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: (request, peer) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) {
          // Exact routes bypass Gateway access checks, so only the owner reaches them.
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
          if (peer.principal.kind !== 'owner') return Promise.resolve(new Response('forbidden', { status: 403 }))
          return route.fetch(request)
        }
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request, peer)
      },
    }
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, handler)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const admission = this.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, fetchHandler, admission.peer)
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler),
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request, peer: PeerScope): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal, peer)
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: Awaited<ReturnType<ConnectionRpcHandler>>): Response {
  if (!result.ok) {
    const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
    return Response.json(body)
  }
  const { attachments, ...success } = result
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result: success }
  if (attachments === undefined || attachments.length === 0) return Response.json(body)
  const parts = new FormData()
  const attachmentMetadata = attachments.map((attachment, index) => {
    const part = `bytes-${index}`
    // FileSystem bytes may have SharedArrayBuffer backing, which BlobPart excludes.
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]))
    return { path: [...attachment.path], codec: 'bytes' as const, part }
  })
  parts.set('metadata', JSON.stringify({ ...body, attachments: attachmentMetadata }))
  return new Response(parts)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
