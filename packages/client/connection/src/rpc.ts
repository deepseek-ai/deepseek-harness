/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Correlation id minted by a caller and echoed by the Connection response. */
export type RpcId = Branded<'rpc-id'>

/**
 * Brand one validated string as a Connection correlation id.
 * @param id - validated wire identity.
 * @returns the same string with the correlation-id brand.
 */
export function RpcId(id: string): RpcId {
  return id as RpcId
}

/** Carrier-neutral failure returned by one logical RPC endpoint. */
export interface ConnectionRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Carrier-neutral result returned by one logical RPC endpoint. */
export type ConnectionRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** Historical short name for a generic Connection result. */
export type RpcResult<T> = ConnectionRpcResult<T>

/**
 * Convert a rejected transport operation into a generic failure result.
 * @param error - rejected transport value.
 * @returns an `internal` failure preserving the available message.
 */
export function transportError<T>(error: unknown): RpcResult<T> {
  return {
    ok: false,
    error: {
      code: 'gateway/internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/** Narrow request form used by direct fixture adapters. */
export interface RpcRequest<P> {
  readonly rpcId: RpcId
  readonly payload: P
}

/** Narrow response form used by direct fixture adapters. */
export interface RpcResponse<T> {
  readonly rpcId: RpcId
  readonly result: RpcResult<T>
}

/** Full request envelope carried by Connection RPC transports. */
export interface ClientRequest {
  readonly type: 'client-request'
  readonly rpcId: RpcId
  readonly method: string
  readonly payload: unknown
}

/** Full response envelope carried by Connection RPC transports. */
export interface ServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcId
  readonly result: ConnectionRpcResult<unknown>
}

/** Complete Connection RPC envelope union. */
export type RpcMessage = ClientRequest | ServerResponse

/** HTTP request facts consumed by browser trust and authentication. */
export interface ConnectionTrustRequest {
  /** Request headers supplied by either the Fetch or node:http representation. */
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
}

/** HTTP status returned before dispatch, or undefined when the request may proceed. */
export type ConnectionRequestRejection = 401 | 403 | undefined

/** Root/index request facts used by the browser-token exchange. */
export interface ConnectionIndexRequest extends ConnectionTrustRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
}

/** Root/index response operations owned by the browser-token exchange. */
export interface ConnectionIndexResponse {
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
  end(body?: string): unknown
}

/** Handler invoked after Connection has decoded the transport envelope. */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ConnectionRpcResult<unknown>>

/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** HTTP methods supported by exact Fetch routes on the shared API channel. */
export type ConnectionFetchMethod = 'GET' | 'HEAD' | 'POST'

/** How the node:http bridge presents one request body to its Fetch route. */
export type ConnectionRequestBodyMode = 'buffered' | 'streaming'

/** One exact, transport-independent Fetch route owned by a Host feature. */
export interface ConnectionFetchRoute {
  /** Absolute path below `/api`; query parameters remain available on the request URL. */
  readonly path: string
  /** Methods this route owns. Other methods continue through normal shared-channel dispatch. */
  readonly methods: readonly ConnectionFetchMethod[]
  /** Buffered requests obey the configured JSON cap; streaming requests arrive with backpressure and no aggregate cap. */
  readonly requestBody: ConnectionRequestBodyMode
  /** Handle one request after the physical carrier has applied its trust and authentication policy. */
  readonly fetch: (request: Request) => Promise<Response>
}

/** Host registry for exact Fetch routes that cannot use JSON Remote invocation. */
export interface HostConnectionFetch {
  /**
   * Register one exact route on the shared API channel.
   * @param route - path, methods, and Fetch-shaped implementation.
   * @returns asynchronous disposer removing this exact contribution.
   */
  register(route: ConnectionFetchRoute): () => Promise<void>
}

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one authenticated absolute channel prefix.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param matches - synchronous endpoint ownership test.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void>
}

/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
  /** Exact Fetch routes for streaming or browser-native responses. */
  readonly fetch: HostConnectionFetch

  /**
   * Compose exact Fetch routes and the shared-channel RPC interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler for trusted, authenticated requests.
   */
  createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler

  /**
   * Apply Connection's Host/Origin checks and browser authentication to
   * another Web route.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns rejection status, or undefined when the route may accept the request.
   */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection

  /**
   * Authenticate one frontend index request, owning a token redirect or 401.
   * @param request - root or configured-index HTTP request.
   * @param response - response owned when the result is false.
   * @returns true only when the frontend may serve index.html.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean

  /**
   * Add the fresh process token to an ordinary Web application URL.
   * @param baseUrl - clean canonical browser origin.
   * @returns root URL accepted by {@link authorizeIndex} for initial login.
   */
  authenticatedUrl(baseUrl: string): string
}

/** Transport-independent Fetch handler used by HTTP and worker carriers. */
export interface ConnectionFetchHandler {
  /**
   * Resolve body handling before the bridge reads any request bytes.
   * @param request - request method and URL available from node:http headers.
   * @returns the registered route's body handling mode.
   */
  requestBodyMode(request: { readonly method: string; readonly url: URL }): ConnectionRequestBodyMode

  /**
   * Dispatch one already-authenticated request.
   * @param request - Fetch request below the shared channel.
   * @returns the registered response or a 404 response.
   */
  fetch(request: Request): Promise<Response>
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the endpoint-owned success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<ConnectionRpcResult<unknown>>

  /**
   * Open an in-process logical stream when the selected carrier supplies one.
   * Browser transports omit this method; API Gateway owns their WebSocket mux.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `session/follow`.
   * @param payload - channel-owned request payload.
   * @param signal - caller cancellation for this logical stream.
   * @returns decoded stream values from the in-process carrier.
   */
  readonly open?: (
    channel: string,
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ) => AsyncIterable<unknown>
}
