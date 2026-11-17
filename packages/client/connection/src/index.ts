/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { HostConnectionService } from './rpc-host.ts'
import { ConnectionAuthentication } from './authentication.ts'
import { ConnectionRecoveryConfigSchema, resolveConnectionConfig, type ConnectionRecoveryConfig } from './recovery-config.ts'
import type { ConnectionConfig } from './types.ts'

export type {
  AuthenticationProvider,
  PeerAdmission,
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcAttachment,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcHandlerResult,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export type { PeerId, PeerScope, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
export { RpcId, transportError } from './rpc.ts'
export { Peer } from './peer.ts'
export type { PeerOptions } from './peer.ts'
export { CONNECT_PATH, type ConnectionInteractions } from './connect-protocol.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'
export { ConnectionAuthentication } from './authentication.ts'

export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Admit or wrap an authenticated shared API request, including body transfer.
     * Existing requests continue when a listener refuses subsequent requests.
     * @param request - Authenticated incoming HTTP request.
     * @param response - Response owned until the delegated bridge settles.
     * @param next - Delegate to the next listener or the shared API bridge.
     * @mode waterfall
     */
    'connection/request'(request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void>
  }
}

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection. */
export const inject: string[] = []

export type { ConnectionConfig } from './types.ts'

/** Host request limits and trusted authorities; `recovery` is synced to the browser. */
export const Config: z<Omit<ConnectionConfig, 'recovery'> & { recovery?: ConnectionRecoveryConfig }, ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}).volatile(),
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin applies Host/Origin checks and registered authentication
 * to WebServer routes and mounts the `/api` browser transport.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  // Config boundary: the schema admits a NaN backoff factor, which the synced Config projection cannot carry as lossless
  // JSON; rejecting it at load keeps a row with an unprojectable recovery value off the graph.
  resolveConnectionConfig(config?.recovery?.get())
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  new ConnectionAuthentication(ctx)
  ctx.inject(['connection.authentication'], (connectionCtx) => {
    const connection = new HostConnectionService(connectionCtx, trustedHosts)
    connectionCtx.inject(['webServer'], (webCtx) => {
      assertImageBodyCapacity(webCtx, maxRequestBodyBytes)
      const fetchHandler = connection.createSharedFetchHandler(API_PATH)
      const route: WebRoute = {
        kind: 'prefix',
        path: API_PATH,
        auth: 'required',
        handler: async (req, res, peer) => {
          if (peer === undefined || res.destroyed) return
          await webCtx.waterfall('connection/request', req, res, () => bridge(req, res, fetchHandler, peer, maxRequestBodyBytes))
        },
      }
      webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route')
    })
  })
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}
