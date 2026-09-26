/**
 * Live Typert Remote dispatch over Cordis Services and registered providers.
 * Unary transport and response envelopes belong to Connection; live Remote
 * streams use the Gateway-owned WebSocket mux.
 * @module @deepseek-ai/dsh-api-gateway
 */

import { randomUUID } from 'node:crypto'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import {
  OperatorPeer,
  type ConnectionRpcAttachment,
  type ConnectionRpcHandler,
} from '@deepseek-ai/dsh-client-connection'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-cmdline'
import z from '@deepseek-ai/schemastery'
export type { TypertGatewayFaultDetails } from './remote-error-codes.ts'
import {
  RemoteError,
  isRemoteJsonValue,
  remoteErrorOf,
  remoteMethods,
  type InvocationDescriptor,
  type InvocationParameterDescriptor,
  type PeerScope,
  type RemoteInvocation,
  type TypertCodec,
  type TypertGatewayBinding,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  InvokeRemoteRequest,
  TypertGateway,
  TypertGatewayErrorCode,
  TypertGatewayWireStream,
  TypertRemoteEventDispatch,
  TypertRemoteEventFrame,
  TypertRemoteEventInvocation,
  TypertRemoteEventOutcome,
  TypertRemoteEventSource,
} from './types.ts'
import {
  RemoteStreamMuxServer,
  rejectRemoteStreamUpgrade,
} from './stream-server.ts'
import {
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_EVENT_STREAM_READY,
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_STREAM_MUX_PATH,
  isRemoteEventAgentId,
  parseRemoteEventResult,
  projectRemoteEventRequest,
  restoreRemoteEventRejection,
  type RemoteEventCancellationFrame,
  type RemoteEventClientId,
  type RemoteEventEmitFrame,
  type RemoteEventHostInfo,
  type RemoteEventId,
  type RemoteEventInvocationFrame,
  type RemoteEventReadyFrame,
  type RemoteStreamFailure,
} from './stream-protocol.ts'

export type {
  InvokeRemoteRequest,
  TypertGateway,
  TypertGatewayErrorCode,
  TypertGatewayWireStream,
  TypertRemoteEventContext,
  TypertRemoteEventDispatch,
  TypertRemoteEventFrame,
  TypertRemoteEventInvocation,
  TypertRemoteEventOutcome,
  TypertRemoteEventSource,
} from './types.ts'
export type { RemoteEventHostInfo } from './stream-protocol.ts'

interface GatewayErrorOptions {
  readonly cause?: unknown
  readonly field?: string
}

interface ResolvedBinding {
  readonly binding: TypertGatewayBinding
  readonly original: object
}

interface PreparedInvocation {
  readonly endpoint: string
  readonly descriptor: InvocationDescriptor
  /** Service view bound to a Context carrying `invocation`, so the method reads it as `this.ctx.invocation`. */
  readonly receiver: object
  readonly args: readonly unknown[]
  readonly method: (...args: never[]) => unknown
  readonly invocation: GatewayInvocation
}

/** Carrier inputs `GatewayInvocation.uplink()` decodes on first use. */
interface UplinkSource {
  /** Carrier items; an immediately ended iterable when the carrier has none. */
  readonly source: AsyncIterable<unknown>
  /** Descriptor codec, or the JSON-safety codec when the descriptor declares no uplink. */
  readonly codec: TypertCodec
  readonly endpoint: string
  /** Fail the logical stream with a Remote failure as the reason. */
  readonly abort: (reason: unknown) => void
}

interface RegisteredRemoteEventSource {
  readonly lifetime: AbortController
  readonly done: Promise<void>
  readonly host: RemoteEventHostInfo
}

interface RemoteEventClient {
  readonly id: RemoteEventClientId
  readonly queue: RemoteEventQueue
  readonly deliveries: Map<RemoteEventId, PendingRemoteEvent>
}

interface PendingRemoteEvent {
  readonly id: RemoteEventId
  readonly source: TypertRemoteEventInvocation
  readonly frame: RemoteEventInvocationFrame
  readonly deliveries: Set<RemoteEventClient>
  releaseContext: () => void
  releaseSignal: () => void
}

type ConnectionRpcResult = Awaited<ReturnType<ConnectionRpcHandler>>
type ConnectionRpcError = Extract<ConnectionRpcResult, { readonly ok: false }>['error']
const NEVER_ABORTED_SIGNAL = new AbortController().signal
const DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2_000
const DEFAULT_STREAM_INBOX_BYTES = 262_144
const EMPTY_ASYNC_ITERABLE: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }),
}
const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }
const SRC_JSON_CODEC: TypertCodec = { mode: 'src-json' }

/** Gateway transport configuration. */
export interface Config {
  /** WebSocket Ping interval from 1 through 2,147,483,647 milliseconds. @default 2000 */
  readonly websocketHeartbeatIntervalMs?: number
  /** Buffered uplink frame bytes one logical stream may hold before it fails with `gateway/uplink-overflow`. @default 262144 */
  readonly streamInboxBytes?: number
}

interface ResolvedConfig extends Config {
  readonly websocketHeartbeatIntervalMs: number
  readonly streamInboxBytes: number
}

/**
 * Dispatch failure produced outside the invoked business method. Rides the
 * shared Remote failure vocabulary, so its code crosses the wire instead of
 * folding to `internal`.
 */
export class TypertGatewayError extends RemoteError<TypertGatewayErrorCode> {
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string
  /** Affected wire field when the failure is field-specific. */
  readonly field: string | undefined

  /**
   * Construct a Gateway failure without embedding boundary values in its message.
   * @param code - stable failure category.
   * @param endpoint - canonical Remote endpoint.
   * @param message - correction-oriented diagnostic without sensitive values.
   * @param options - optional field and contained cause.
   */
  constructor(
    code: TypertGatewayErrorCode,
    endpoint: string,
    message: string,
    options: GatewayErrorOptions = {},
  ) {
    super(
      code,
      `typert gateway: ${endpoint}: ${message}`,
      { endpoint, ...options.field === undefined ? {} : { field: options.field } },
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'TypertGatewayError'
    this.endpoint = endpoint
    this.field = options.field
  }
}

/**
 * Resolve strict generated definitions or conservative SRC markers against
 * current Cordis Services and Typert providers.
 * @typert service typertGateway
 */
export class TypertGatewayService extends Service implements TypertGateway {
  static inject = ['typert']
  static Config: z<Config> = z.object({
    websocketHeartbeatIntervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS)
      .default(DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS),
    streamInboxBytes: z.number().step(1).min(1).default(DEFAULT_STREAM_INBOX_BYTES),
  })

  /** Carrier adapter shared by the WebSocket mux and local Host transports. */
  readonly wireStream: TypertGatewayWireStream = {
    open: (endpoint, payload, uplink, peer, signal) =>
      this.openWireStream(endpoint, payload, uplink, peer, signal, new AbortController()),
    failure: error => rpcError(error),
  }

  private srcClaims: ReadonlySet<string> | undefined
  private inProcessOperator: PeerScope | undefined
  private remoteEvents: RegisteredRemoteEventSource | undefined
  private readonly remoteEventClients = new Map<RemoteEventClientId, RemoteEventClient>()
  private readonly pendingRemoteEvents = new Map<RemoteEventId, PendingRemoteEvent>()

  /**
   * Register the Gateway against the active Typert registry.
   * WebSocket admission waits for launcher-owned application readiness when supplied;
   * direct invocation and in-process streams remain available independently.
   * @param ctx - owning Host Context with Typert registry access.
   * @param config - validated Gateway transport configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'typertGateway')
    const resolved = config as ResolvedConfig
    ctx.on('internal/service', () => {
      this.srcClaims = undefined
    })
    ctx.inject(['connection'], (connectionCtx) => {
      connectionCtx.connection.rpc.intercept(
        '/api',
        endpoint => this.claimsEndpoint(endpoint),
        (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer),
      )
    })
    ctx.inject(['connection', 'webServer'], (webCtx) => {
      const listen = (): void => {
        const mux = new RemoteStreamMuxServer(
          (endpoint, payload, uplink, peer, control) =>
            this.openWireStream(endpoint, payload, uplink, peer, control.signal, control),
          this.wireStream.failure,
          resolved.websocketHeartbeatIntervalMs,
          resolved.streamInboxBytes,
        )
        webCtx.effect(function* () {
          yield () => mux.close()
          const route: WebUpgradeRoute = {
            path: REMOTE_STREAM_MUX_PATH,
            handler: (req, socket, head) => {
              const admission = webCtx.connection.admit(req)
              if ('rejection' in admission) {
                rejectRemoteStreamUpgrade(socket, admission.rejection)
                return
              }
              mux.handleUpgrade(req, socket, head, admission.peer)
            },
          }
          yield webCtx.webServer.registerUpgrade(route)
        }, `api-gateway: ${REMOTE_STREAM_MUX_PATH} WebSocket`)
      }
      // Existing pages reconnect before the new Host prints its URL. No stream
      // may enter until the launcher has activated and audited its controllers.
      const ready = webCtx.get('appReady')
      if (ready === undefined) listen()
      else webCtx.effect(() => {
        let closed = false
        const cancel = ready.onReady(() => { if (!closed) listen() })
        return () => {
          closed = true
          cancel()
        }
      }, 'api-gateway: application readiness')
    })
  }

  /**
   * Register the sole application-selected forwarded-event source.
   * @param source - stream factory installed by the Remote assembly.
   * @param host - stable Host facts included in each Client generation's opening frame.
   * @returns disposer removing this source and cancelling its active streams.
   */
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void> {
    if (this.remoteEvents !== undefined) {
      throw new Error('typert gateway: forwarded Remote event source is already registered')
    }
    const lifetime = new AbortController()
    const stream = source(lifetime.signal)
    const done = this.consumeRemoteEvents(stream, lifetime.signal).catch((error: unknown) => {
      if (this.remoteEvents?.lifetime !== lifetime || lifetime.signal.aborted) return
      this.closeRemoteEvents(error)
      this.remoteEvents = undefined
      lifetime.abort(error)
    })
    const registration: RegisteredRemoteEventSource = { lifetime, done, host: { home: host.home } }
    this.remoteEvents = registration
    return async () => {
      if (this.remoteEvents === registration) {
        this.remoteEvents = undefined
        const error = new Error('typert gateway: forwarded Remote event source was removed')
        registration.lifetime.abort(error)
        this.closeRemoteEvents(error)
      }
      await registration.done
    }
  }

  private claimsEndpoint(endpoint: string): boolean {
    if (endpoint === REMOTE_EVENT_RESULT_ENDPOINT) return true
    const segments = endpoint.split('/')
    if (segments.length !== 2 || segments[0] === '' || segments[1] === '') return false
    if (this.ctx.typert.local.get(endpoint) !== undefined || this.ctx.typert.local.hasSeen(endpoint)) return true
    this.srcClaims ??= this.collectSrcClaims()
    return this.srcClaims.has(endpoint)
  }

  private collectSrcClaims(): ReadonlySet<string> {
    const claims = new Set<string>()
    for (const [serviceKey, definition] of Object.entries(this.ctx.reflect.props)) {
      if (definition.type !== 'service') continue
      const receiver: unknown = this.ctx.get(serviceKey)
      if (!isObject(receiver)) continue
      const original = originalOf(receiver)
      const binding: unknown = Reflect.get(original, 'typertRemote')
      if (!isObject(binding) || typeof Reflect.get(binding, 'namespace') !== 'string') continue
      const namespace = Reflect.get(binding, 'namespace') as string
      for (const candidate of remoteMethods(original)) {
        claims.add(endpointOf(namespace, candidate.exportName ?? candidate.method))
      }
    }
    return claims
  }

  /**
   * Invoke one live Remote method through strict generated reflection or SRC markers.
   * @param request - decoded endpoint and exact named wire arguments.
   * @returns the business result without output decoding.
   * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures; lookup-policy and business errors retain identity.
   */
  async invoke(request: InvokeRemoteRequest): Promise<unknown> {
    return this.invokePrepared(await this.prepareInvocation(request, new AbortController()))
  }

  private async invokePrepared(prepared: PreparedInvocation): Promise<unknown> {
    if (prepared.descriptor.mode !== undefined) {
      throw new TypertGatewayError(
        'gateway/signature-invalid',
        prepared.endpoint,
        'stream Remote methods must be opened through the stream carrier',
      )
    }

    try {
      return await Reflect.apply(prepared.method, prepared.receiver, prepared.args) as unknown
    } catch (error) {
      if (prepared.invocation.signal.aborted) throw remoteCancelled(prepared.endpoint, error)
      throw error
    } finally {
      // A unary call's uplink is readable only while the method runs.
      await prepared.invocation.close()
    }
  }

  /**
   * Open one live stream Remote method without assuming a physical carrier.
   * @param request - decoded endpoint, named wire arguments, and the Client uplink when the carrier has one.
   * @returns a cancellation-aware iterable over the business results.
   */
  async stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>> {
    return this.openStream(request, new AbortController())
  }

  /**
   * `control` belongs to the logical stream: a rejected uplink item aborts it
   * with the Remote failure as the reason so the carrier delivers that failure.
   */
  private async openStream(request: InvokeRemoteRequest, control: AbortController): Promise<AsyncIterable<unknown>> {
    const prepared = await this.prepareInvocation(request, control)
    if (prepared.descriptor.mode === undefined) {
      await prepared.invocation.close()
      throw new TypertGatewayError(
        'gateway/signature-invalid',
        prepared.endpoint,
        'unary Remote methods cannot be opened through the stream carrier',
      )
    }
    let source: unknown
    try {
      source = Reflect.apply(prepared.method, prepared.receiver, prepared.args) as unknown
    } catch (error) {
      await prepared.invocation.close()
      if (prepared.invocation.signal.aborted) throw remoteCancelled(prepared.endpoint, error)
      throw error
    }
    if (!isIterable(source)) {
      await prepared.invocation.close()
      throw new TypertGatewayError(
        'gateway/result-invalid',
        prepared.endpoint,
        'stream Remote method did not return Iterable or AsyncIterable',
        { field: 'result' },
      )
    }
    return cancellableStream(source, prepared.endpoint, prepared.invocation)
  }

  private async dispatchRpc(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    peer: PeerScope,
  ): Promise<ConnectionRpcResult> {
    if (endpoint === REMOTE_EVENT_RESULT_ENDPOINT) {
      try {
        const result = parseRemoteEventResultPayload(payload)
        const client = this.remoteEventClients.get(result.clientId)
        if (client === undefined) {
          throw new Error('typert gateway: Remote event result identifies no active event stream')
        }
        this.receiveRemoteEventResult(client, result)
        return { ok: true, value: undefined }
      } catch (error) {
        return rpcFailure(error)
      }
    }
    return this.invokeRpc(endpoint, payload, signal, peer)
  }

  private async openWireStream(
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    peer: PeerScope | undefined,
    signal: AbortSignal,
    control: AbortController,
  ): Promise<AsyncIterable<unknown>> {
    if (endpoint === REMOTE_EVENT_STREAM_ENDPOINT) {
      // A Gateway-owned stream reads no uplink: releasing it now keeps its items out of the bounded inbox.
      releaseUplink(uplink)
      return this.openRemoteEvents(payload, signal)
    }
    return this.openStream({ ...remoteRequest(endpoint, payload, signal, peer), uplink }, control)
  }

  /**
   * The Peer an in-process carrier speaks for when it names none: the
   * operator's Peer when Connection is mounted, otherwise an operator scope the
   * Gateway owns for its own lifetime.
   * @returns the operator Peer.
   */
  private operatorPeer(): PeerScope {
    const connection = this.ctx.get('connection')
    if (connection !== undefined) return connection.operator
    this.inProcessOperator ??= new OperatorPeer(this.ctx)
    return this.inProcessOperator
  }

  private async *openRemoteEvents(
    payload: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<
    RemoteEventEmitFrame | RemoteEventInvocationFrame | RemoteEventCancellationFrame
    | RemoteEventReadyFrame
  > {
    if (!isObject(payload)
      || !isPlainObject(payload)
      || Reflect.ownKeys(payload).length !== 1
      || !Object.hasOwn(payload, 'args')
      || !isObject(payload.args)
      || !isPlainObject(payload.args)
      || Reflect.ownKeys(payload.args).length !== 0) {
      throw new TypertGatewayError(
        'gateway/arguments-invalid',
        REMOTE_EVENT_STREAM_ENDPOINT,
        'forwarded Remote event stream requires an empty args object',
      )
    }
    const registration = this.remoteEvents
    if (registration === undefined) {
      throw new TypertGatewayError(
        'gateway/service-unavailable',
        REMOTE_EVENT_STREAM_ENDPOINT,
        'forwarded Remote event source is unavailable',
      )
    }
    const lifetime = AbortSignal.any([signal, registration.lifetime.signal])
    let clientId = randomUUID() as RemoteEventClientId
    while (this.remoteEventClients.has(clientId)) clientId = randomUUID() as RemoteEventClientId
    const client: RemoteEventClient = {
      id: clientId,
      queue: new RemoteEventQueue(),
      deliveries: new Map(),
    }
    this.remoteEventClients.set(clientId, client)
    for (const pending of this.pendingRemoteEvents.values()) this.deliverRemoteEvent(pending, client)
    try {
      yield { ...REMOTE_EVENT_STREAM_READY, clientId, host: registration.host }
      yield* client.queue.iterate(lifetime)
    } finally {
      this.removeRemoteEventClient(client)
    }
  }

  private async consumeRemoteEvents(
    source: AsyncIterable<TypertRemoteEventDispatch>,
    signal: AbortSignal,
  ): Promise<void> {
    for await (const dispatch of source) {
      if (signal.aborted) {
        if ('context' in dispatch) dispatch.reject(signal.reason)
        return
      }
      if ('context' in dispatch) this.startRemoteEvent(dispatch)
      else this.broadcastRemoteEvent(dispatch)
    }
    if (!signal.aborted) {
      throw new Error('typert gateway: forwarded Remote event source ended unexpectedly')
    }
  }

  private broadcastRemoteEvent(frame: TypertRemoteEventFrame): void {
    assertRemoteEventFrame(frame)
    const wire: RemoteEventEmitFrame = {
      type: 'emit',
      event: frame.event,
      args: frame.args,
    }
    for (const client of this.remoteEventClients.values()) client.queue.push(wire)
  }

  private startRemoteEvent(source: TypertRemoteEventInvocation): void {
    try {
      assertRemoteEventName(source)
      if (!isRemoteEventAgentId(source.context.agentId)) {
        throw new TypeError(
          'typert gateway: scoped Remote events require a non-empty Agent identity',
        )
      }
      const projected = projectRemoteEventRequest(source.request, source.context.subject)
      let id = randomUUID() as RemoteEventId
      while (this.pendingRemoteEvents.has(id)) id = randomUUID() as RemoteEventId
      let releaseContext: () => void
      try {
        const dispose = source.context.value.effect(
          () => () => {
            this.cancelRemoteEvent(
              pending,
              new Error('typert gateway: Remote event Agent Context was released'),
            )
          },
          `api-gateway: Remote event ${JSON.stringify(source.event)}`,
        )
        releaseContext = () => { void dispose() }
      } catch {
        source.resolve({ kind: 'next' })
        return
      }
      const signals = new Set(projected.signal === undefined ? [] : [projected.signal])
      const abort = (): void => {
        const reason: unknown = [...signals].find(signal => signal.aborted)?.reason
        this.cancelRemoteEvent(pending, reason instanceof Error
          ? reason
          : new Error('typert gateway: Remote event was cancelled', { cause: reason }))
      }
      const pending: PendingRemoteEvent = {
        id,
        source,
        frame: {
          type: 'waterfall',
          event: source.event,
          eventId: id,
          agentId: source.context.agentId,
          request: projected.request,
        },
        deliveries: new Set(),
        releaseContext,
        releaseSignal: () => {
          for (const signal of signals) signal.removeEventListener('abort', abort)
        },
      }
      this.pendingRemoteEvents.set(id, pending)
      for (const signal of signals) signal.addEventListener('abort', abort, { once: true })
      if ([...signals].some(signal => signal.aborted)) abort()
      else for (const client of this.remoteEventClients.values()) this.deliverRemoteEvent(pending, client)
    } catch (error) {
      source.reject(error)
    }
  }

  private deliverRemoteEvent(pending: PendingRemoteEvent, client: RemoteEventClient): void {
    pending.deliveries.add(client)
    client.deliveries.set(pending.id, pending)
    client.queue.push(pending.frame)
  }

  private receiveRemoteEventResult(
    client: RemoteEventClient,
    result: ReturnType<typeof parseRemoteEventResult>,
  ): void {
    const pending = this.pendingRemoteEvents.get(result.eventId)
    // Settlement and Client replacement may race the result request. Results
    // from a completed event or a superseded delivery are idempotent no-ops.
    if (pending === undefined || !pending.deliveries.has(client)) return
    this.removeRemoteEventDelivery(pending, client)
    if (result.outcome.kind === 'result') {
      this.settleRemoteEvent(pending, {
        kind: 'result',
        value: result.outcome.value,
      })
    } else if (result.outcome.kind === 'rejected') {
      this.cancelRemoteEvent(pending, restoreRemoteEventRejection(result.outcome.error))
    } else if (pending.deliveries.size === 0) {
      this.settleRemoteEvent(pending, { kind: 'next' })
    }
  }

  private removeRemoteEventDelivery(pending: PendingRemoteEvent, client: RemoteEventClient): void {
    pending.deliveries.delete(client)
    client.deliveries.delete(pending.id)
  }

  private removeRemoteEventClient(client: RemoteEventClient): void {
    this.remoteEventClients.delete(client.id)
    for (const pending of [...client.deliveries.values()]) this.removeRemoteEventDelivery(pending, client)
    client.queue.end()
  }

  private settleRemoteEvent(pending: PendingRemoteEvent, outcome: TypertRemoteEventOutcome): void {
    this.finishRemoteEvent(pending)
    pending.source.resolve(outcome)
  }

  private cancelRemoteEvent(pending: PendingRemoteEvent, reason: unknown): void {
    if (this.pendingRemoteEvents.get(pending.id) !== pending) return
    this.finishRemoteEvent(pending)
    pending.source.reject(reason)
  }

  private finishRemoteEvent(pending: PendingRemoteEvent): void {
    this.pendingRemoteEvents.delete(pending.id)
    pending.releaseSignal()
    pending.releaseContext()
    const clients = new Set(pending.deliveries)
    for (const client of clients) this.removeRemoteEventDelivery(pending, client)
    const cancellation: RemoteEventCancellationFrame = {
      type: 'cancel',
      eventId: pending.id,
    }
    for (const client of clients) client.queue.push(cancellation)
  }

  private closeRemoteEvents(reason: unknown): void {
    for (const pending of [...this.pendingRemoteEvents.values()]) {
      this.cancelRemoteEvent(pending, reason)
    }
    for (const client of [...this.remoteEventClients.values()]) client.queue.end()
  }

  private async invokeRpc(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    peer: PeerScope,
  ): Promise<ConnectionRpcResult> {
    try {
      const prepared = await this.prepareInvocation(
        remoteRequest(endpoint, payload, signal, peer),
        new AbortController(),
      )
      const value = await this.invokePrepared(prepared)
      // A void or explicitly absent business result carries no `value` field;
      // JSON has no `undefined`, and the envelope's optional slot is the one
      // representation of absence that both args and results already use.
      return encodeRpcResult(value, prepared.descriptor.result)
    } catch (error) {
      return rpcFailure(error)
    }
  }

  /** `control` fails the logical stream when an uplink item is rejected; unary calls hand over an inert one. */
  private async prepareInvocation(
    request: InvokeRemoteRequest,
    control: AbortController,
  ): Promise<PreparedInvocation> {
    const endpoint = endpointOf(request.namespace, request.method)
    const descriptor = this.resolveDescriptor(request.namespace, request.method, endpoint)
    assertExactArguments(request.args, descriptor, endpoint)
    const receiverContext = await this.resolveReceiverContext(descriptor, request.args, endpoint)
    const receiver: unknown = receiverContext.get(descriptor.service)
    if (!isObject(receiver)) {
      throw new TypertGatewayError(
        'gateway/service-unavailable',
        endpoint,
        `active Service ${JSON.stringify(descriptor.service)} is unavailable`,
      )
    }
    validateBinding(receiver, descriptor.service, descriptor.namespace, endpoint)
    const args = await Promise.all(descriptor.parameters.map(parameter =>
      this.resolveParameter(parameter, request.args, endpoint)))
    const signal = methodSignal(request, control)
    const invocation = new GatewayInvocation(
      { namespace: request.namespace, method: request.method, args: request.args },
      descriptor.service,
      request.peer ?? this.operatorPeer(),
      signal,
      {
        source: request.uplink ?? EMPTY_ASYNC_ITERABLE,
        codec: descriptor.uplink?.codec ?? SRC_JSON_CODEC,
        endpoint,
        abort: (reason) => { control.abort(reason) },
      },
    )
    if (descriptor.cancellation !== undefined) args.push(signal)
    // The method runs on a Service view bound to a Context carrying this call:
    // Cordis rebinds `this.ctx` to the accessing Context, so `this.ctx.invocation`
    // is this call and nothing travels through the parameter list. The view
    // resolves the Service the plain read above already found.
    const callReceiver = receiverContext.extend({ invocation }).get(descriptor.service) as object
    const implementation = descriptor.implementation ?? descriptor.method
    const method: unknown = Reflect.get(callReceiver, implementation)
    if (typeof method !== 'function') {
      throw new TypertGatewayError(
        'gateway/method-unavailable',
        endpoint,
        `active Service ${JSON.stringify(descriptor.service)} has no callable method ${JSON.stringify(implementation)}`,
      )
    }
    return {
      endpoint,
      descriptor,
      receiver: callReceiver,
      args,
      method: method as (...args: never[]) => unknown,
      invocation,
    }
  }

  private resolveDescriptor(namespace: string, method: string, endpoint: string): InvocationDescriptor {
    const strict = this.ctx.typert.local.get(endpoint)
    if (strict !== undefined) return strict
    if (this.ctx.typert.local.hasSeen(endpoint)) {
      throw new TypertGatewayError(
        'gateway/definition-unavailable',
        endpoint,
        'its strict definition was withdrawn and SRC fallback is forbidden',
      )
    }
    return this.resolveSrcDescriptor(namespace, method, endpoint)
  }

  private resolveSrcDescriptor(namespace: string, method: string, endpoint: string): InvocationDescriptor {
    const candidates: InvocationDescriptor[] = []
    for (const [serviceKey, definition] of Object.entries(this.ctx.reflect.props)) {
      if (definition.type !== 'service') continue
      const receiver: unknown = this.ctx.get(serviceKey)
      if (!isObject(receiver)) continue
      const original = originalOf(receiver)
      const value: unknown = Reflect.get(original, 'typertRemote')
      if (value === undefined) continue
      const binding = readBinding(value, original, serviceKey, endpoint)
      if (binding.namespace !== namespace) continue
      const marker = remoteMethods(original).find(candidate => (candidate.exportName ?? candidate.method) === method)
      if (marker === undefined) continue
      candidates.push(this.srcDescriptor(binding, marker, method, endpoint))
    }
    if (candidates.length === 0) {
      throw new TypertGatewayError('gateway/invocation-unavailable', endpoint, 'no active Remote method exports this endpoint')
    }
    if (candidates.length > 1) {
      throw new TypertGatewayError(
        'gateway/ambiguous-endpoint',
        endpoint,
        `multiple active Services export this endpoint: ${candidates.map(candidate => candidate.service).sort().join(', ')}`,
      )
    }
    return candidates[0] as InvocationDescriptor
  }

  private srcDescriptor(
    binding: TypertGatewayBinding,
    marker: ReturnType<typeof remoteMethods>[number],
    method: string,
    endpoint: string,
  ): InvocationDescriptor {
    const names = methodParameterNames(binding.service, marker.method, endpoint)
    const signalIndex = names.indexOf('signal')
    if (signalIndex >= 0 && signalIndex !== names.length - 1) {
      throw new TypertGatewayError(
        'gateway/signature-invalid',
        endpoint,
        'SRC cancellation parameter signal must be the final parameter',
        { field: 'signal' },
      )
    }
    const cancellation = signalIndex >= 0
      ? { parameter: 'signal' as const }
      : undefined
    const businessNames = cancellation === undefined ? names : names.slice(0, -1)
    const parameters: InvocationParameterDescriptor[] = []
    const wires = new Set<string>()
    for (const name of businessNames) {
      const matches = this.ctx.typert.lookups.definitions()
        .filter(definition => definition.parameter === name)
      if (matches.length > 1) {
        throw new TypertGatewayError(
          'gateway/signature-invalid',
          endpoint,
          `parameter ${JSON.stringify(name)} matches multiple lookup providers`,
          { field: name },
        )
      }
      const match = matches[0]
      const parameter: InvocationParameterDescriptor = match === undefined
        ? { name, wire: name, source: 'json', codec: { mode: 'src-json' } }
        : {
          name,
          wire: match.wire,
          source: 'lookup',
          lookup: match.key,
          codec: { mode: 'src-json' },
        }
      if (wires.has(parameter.wire)) {
        throw new TypertGatewayError(
          'gateway/signature-invalid',
          endpoint,
          `multiple parameters use wire field ${JSON.stringify(parameter.wire)}`,
          { field: parameter.wire },
        )
      }
      wires.add(parameter.wire)
      parameters.push(parameter)
    }

    let receiver: InvocationDescriptor['invocation'] = { kind: 'direct' }
    if (marker.invocation.kind === 'context') {
      const provider = this.ctx.typert.contexts.getHost(marker.invocation.context)
      if (provider === undefined) {
        throw new TypertGatewayError(
          'gateway/context-unavailable',
          endpoint,
          `Context provider ${JSON.stringify(marker.invocation.context)} is unavailable`,
        )
      }
      if (wires.has(provider.wire)) {
        throw new TypertGatewayError(
          'gateway/signature-invalid',
          endpoint,
          `Context identity conflicts with wire field ${JSON.stringify(provider.wire)}`,
          { field: provider.wire },
        )
      }
      receiver = {
        kind: 'context',
        context: marker.invocation.context,
        wire: provider.wire,
        codec: { mode: 'src-json' },
      }
    }

    return {
      id: `src:${binding.serviceKey}#${endpoint}`,
      service: binding.serviceKey,
      namespace: binding.namespace,
      method,
      ...(marker.method === method ? {} : { implementation: marker.method }),
      ...(marker.mode === undefined ? {} : { mode: marker.mode }),
      invocation: receiver,
      parameters,
      ...(cancellation === undefined ? {} : { cancellation }),
      result: { mode: 'src-json' },
    }
  }

  private async resolveReceiverContext(
    descriptor: InvocationDescriptor,
    args: Readonly<Record<string, unknown>>,
    endpoint: string,
  ): Promise<Context> {
    if (descriptor.invocation.kind === 'direct') return this.ctx
    const invocation = descriptor.invocation
    const provider = this.ctx.typert.contexts.getHost(invocation.context)
    if (provider === undefined) {
      throw new TypertGatewayError(
        'gateway/context-unavailable',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} is unavailable`,
      )
    }
    if (provider.wire !== invocation.wire
      || (invocation.codec.mode === 'strict' && provider.wireTypeSymbol !== invocation.codec.typeSymbol)) {
      throw new TypertGatewayError(
        'gateway/provider-mismatch',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} does not match its strict definition`,
        { field: invocation.wire },
      )
    }
    const identity = decode(invocation.codec, args[invocation.wire], endpoint, invocation.wire)
    let context: Context | undefined
    try {
      context = await provider.resolve(identity)
    } catch (cause) {
      if (remoteErrorOf(cause) !== undefined) throw cause
      throw new TypertGatewayError(
        'gateway/context-failed',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} failed`,
        { cause, field: invocation.wire },
      )
    }
    if (context === undefined) {
      throw new TypertGatewayError(
        'gateway/context-not-found',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} did not resolve the requested identity`,
        { field: invocation.wire },
      )
    }
    return context
  }

  private async resolveParameter(
    parameter: InvocationParameterDescriptor,
    args: Readonly<Record<string, unknown>>,
    endpoint: string,
  ): Promise<unknown> {
    // An absent field reached assertExactArguments' allowance, so this parameter
    // takes undefined; a present-but-undefined field is not JSON-safe input and
    // still fails decode. Lookup ids are never omissible, so absence here only
    // ever belongs to a json parameter.
    if (!Object.hasOwn(args, parameter.wire)) return undefined
    const value = decode(parameter.codec, args[parameter.wire], endpoint, parameter.wire)
    if (parameter.source === 'json') return value
    const key = parameter.lookup
    /* v8 ignore next -- registry validation rejects strict descriptors without a key, and SRC derivation always supplies one. */
    if (key === undefined) {
      throw new TypertGatewayError(
        'gateway/lookup-unavailable',
        endpoint,
        `lookup parameter ${JSON.stringify(parameter.name)} has no provider key`,
        { field: parameter.wire },
      )
    }
    const provider = this.ctx.typert.lookups.get(key)
    if (provider === undefined) {
      throw new TypertGatewayError(
        'gateway/lookup-unavailable',
        endpoint,
        `lookup provider ${JSON.stringify(key)} is unavailable`,
        { field: parameter.wire },
      )
    }
    if (provider.wire !== parameter.wire
      || (parameter.codec.mode === 'strict' && provider.wireTypeSymbol !== parameter.codec.typeSymbol)) {
      throw new TypertGatewayError(
        'gateway/provider-mismatch',
        endpoint,
        `lookup provider ${JSON.stringify(key)} does not match its strict definition`,
        { field: parameter.wire },
      )
    }
    let resolved: unknown
    try {
      resolved = await provider.resolve(value)
    } catch (cause) {
      if (remoteErrorOf(cause) !== undefined) throw cause
      throw new TypertGatewayError(
        'gateway/lookup-failed',
        endpoint,
        `lookup provider ${JSON.stringify(key)} failed`,
        { cause, field: parameter.wire },
      )
    }
    if (resolved === undefined) {
      throw new TypertGatewayError(
        'gateway/lookup-not-found',
        endpoint,
        `lookup provider ${JSON.stringify(key)} did not resolve the requested identity`,
        { field: parameter.wire },
      )
    }
    return resolved
  }
}

function encodeRpcResult(value: unknown, codec: TypertCodec): ConnectionRpcResult {
  const attachments: ConnectionRpcAttachment[] = []
  const writeBytes = (bytes: Uint8Array, path: readonly (string | number)[]): null => {
    attachments.push({ path: [...path], bytes })
    return null
  }
  const encoded = codec.mode === 'strict'
    ? codec.encode?.(value, writeBytes) ?? value
    : encodeRuntimeResult(value, writeBytes)
  return { ok: true, value: encoded, ...(attachments.length === 0 ? {} : { attachments }) }
}

function encodeRuntimeResult(
  input: unknown,
  writeBytes: (bytes: Uint8Array, path: readonly (string | number)[]) => null,
): unknown {
  const path: (string | number)[] = []
  const ancestors = new Set<object>()
  const extract = (input: unknown, key: string): unknown => {
    // Capture accessors and toJSON once, before materializing the JSON metadata.
    let value = input
    if (input !== null && typeof input === 'object' && !(input instanceof Uint8Array)) {
      const toJSON: unknown = Reflect.get(input, 'toJSON')
      if (typeof toJSON === 'function') value = Reflect.apply(toJSON, input, [key])
    }
    if (value instanceof Uint8Array) return writeBytes(value, path)
    if (typeof value !== 'object' || value === null) return value
    if (value instanceof Number || value instanceof String || value instanceof Boolean) return value.valueOf()
    if (ancestors.has(value)) throw new TypeError('gateway: circular RPC result')
    ancestors.add(value)
    let copy: object
    if (Array.isArray(value)) {
      const items: unknown[] = []
      // JSON arrays include every index, even holes and non-enumerable elements.
      for (let index = 0, length = value.length; index < length; index++) items.push(child(value[index], index))
      copy = items
    } else {
      const fields: Record<string, unknown> = {}
      for (const key of Object.keys(value)) {
        const item: unknown = Reflect.get(value, key)
        // A toJSON method on the projected object must not run a second time.
        if (key === 'toJSON' && typeof item === 'function') continue
        const extracted = child(item, key)
        if (key === '__proto__') Object.defineProperty(fields, key, { value: extracted, enumerable: true })
        else fields[key] = extracted
      }
      copy = fields
    }
    ancestors.delete(value)
    return copy
  }
  const child = (value: unknown, key: string | number): unknown => {
    if (typeof value !== 'object' || value === null) return value
    path.push(key)
    const extracted = extract(value, String(key))
    path.pop()
    return extracted
  }
  return extract(input, 'value')
}

type RemoteEventWireFrame =
  | RemoteEventEmitFrame
  | RemoteEventInvocationFrame
  | RemoteEventCancellationFrame

/** Pull-driven queue owned by one connected Client event generation. */
class RemoteEventQueue {
  private readonly frames = new Deque<RemoteEventWireFrame>()
  private waiter: (() => void) | undefined
  private closed = false

  push(frame: RemoteEventWireFrame): void {
    if (this.closed) return
    this.frames.pushBack(frame)
    this.waiter?.()
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    this.waiter?.()
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<RemoteEventWireFrame> {
    const abort = (): void => { this.end() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        while (this.frames.size > 0) yield this.frames.popFront() as RemoteEventWireFrame
        if (this.closed || signal.aborted) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}

function assertRemoteEventFrame(frame: TypertRemoteEventFrame): void {
  assertRemoteEventName(frame)
  if (!Array.isArray(frame.args) || !isRemoteJsonValue(frame.args)) {
    throw new TypeError(`typert gateway: Remote event ${JSON.stringify(frame.event)} arguments are not lossless JSON data`)
  }
}

function assertRemoteEventName(frame: { readonly event: unknown }): void {
  if (typeof frame.event !== 'string' || frame.event.length === 0) {
    throw new TypeError('typert gateway: Remote event name must be a nonempty string')
  }
}

function parseRemoteEventResultPayload(payload: unknown): ReturnType<typeof parseRemoteEventResult> {
  if (!isObject(payload)
    || !isPlainObject(payload)
    || Reflect.ownKeys(payload).length !== 1
    || !Object.hasOwn(payload, 'args')) {
    throw new Error('typert gateway: Remote event result requires exactly one plain-object args field')
  }
  return parseRemoteEventResult(payload.args)
}

function remoteRequest(
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer?: PeerScope,
): InvokeRemoteRequest {
  const segments = endpoint.split('/')
  if (segments.length !== 2 || segments[0] === '' || segments[1] === '') {
    throw new Error(`invalid Remote endpoint ${JSON.stringify(endpoint)}`)
  }
  const [namespace, method] = segments as [string, string]
  if (!isObject(payload)
    || !isPlainObject(payload)
    || Reflect.ownKeys(payload).length !== 1
    || !Object.hasOwn(payload, 'args')
    || !isObject(payload.args)
    || !isPlainObject(payload.args)) {
    throw new Error('Remote payload must contain exactly one plain-object args field')
  }
  return { namespace, method, args: payload.args, signal, ...(peer === undefined ? {} : { peer }) }
}

/**
 * The signal a method observes. A carrier that supplies an uplink fails the
 * stream through `control` when an item is rejected, so that invocation joins
 * `control` with the carrier signal; every other invocation keeps the carrier
 * signal's identity.
 */
function methodSignal(request: InvokeRemoteRequest, control: AbortController): AbortSignal {
  const carrier = request.signal
  if (request.uplink === undefined) return carrier ?? NEVER_ABORTED_SIGNAL
  if (carrier === undefined || carrier === control.signal) return control.signal
  return AbortSignal.any([carrier, control.signal])
}

function isIterable(value: unknown): value is Iterable<unknown> | AsyncIterable<unknown> {
  return isObject(value)
    && (typeof Reflect.get(value, Symbol.iterator) === 'function'
      || typeof Reflect.get(value, Symbol.asyncIterator) === 'function')
}

async function *cancellableStream(
  source: Iterable<unknown> | AsyncIterable<unknown>,
  endpoint: string,
  invocation: GatewayInvocation,
): AsyncGenerator {
  const { signal } = invocation
  const asyncFactory: unknown = Reflect.get(source, Symbol.asyncIterator)
  const syncFactory: unknown = Reflect.get(source, Symbol.iterator)
  const iterator = typeof asyncFactory === 'function'
    ? Reflect.apply(asyncFactory, source, []) as AsyncIterator<unknown>
    : Reflect.apply(syncFactory as (...args: never[]) => Iterator<unknown>, source, [])
  let rejectAbort: ((error: unknown) => void) | undefined
  const onAbort = (): void => {
    rejectAbort?.(streamAbortFailure(endpoint, signal.reason))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw streamAbortFailure(endpoint, signal.reason)
      // Reusing a pending cancellation promise retains every completed race.
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
      // next() can abort and throw synchronously before the race subscribes.
      void aborted.catch(() => undefined)
      const next = await Promise.race([Promise.resolve(iterator.next()), aborted])
      rejectAbort = undefined
      if (next.done === true) return
      yield next.value
    }
  } finally {
    rejectAbort = undefined
    signal.removeEventListener('abort', onAbort)
    // The uplink closes first so a method blocked on `uplink.next()` unwinds
    // before its iterator is asked to return.
    await invocation.close()
    await iterator.return?.()
  }
}

/**
 * The failure a stream surfaces for its abort: a Remote failure used as the
 * reason is the Gateway or carrier failing the stream itself (a rejected,
 * overflowing, or misplaced uplink item); any other abort is a cancellation.
 */
function streamAbortFailure(endpoint: string, reason: unknown): unknown {
  return remoteErrorOf(reason) === undefined ? remoteCancelled(endpoint, reason) : reason
}

/** Carrier-signal cancellation as the shared failure vocabulary expresses it. */
function remoteCancelled(endpoint: string, cause: unknown): RemoteError<'gateway/cancelled'> {
  return new RemoteError('gateway/cancelled', `Remote invocation "${endpoint}" was aborted`, {}, { cause })
}

/**
 * The iterable `invocation.uplink()` returns. Each uplink item passes the
 * descriptor codec, or the JSON-safety check when the descriptor declares no
 * uplink, before delivery; a rejected item fails the whole logical stream.
 * Iteration ends when the Client half-closes or the downlink finishes, and
 * fails when the stream is cancelled, so a method blocked on the uplink always
 * wakes.
 */
class UplinkDecoder implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly source: AsyncIterator<unknown>
  private readonly interrupted = new Set<PromiseWithResolvers<IteratorResult<unknown>>>()
  private readonly onAbort = (): void => {
    const failure = streamAbortFailure(this.endpoint, this.signal.reason)
    for (const read of this.interrupted) read.reject(failure)
  }
  private closed = false

  constructor(
    uplink: AsyncIterable<unknown>,
    private readonly codec: TypertCodec,
    private readonly endpoint: string,
    private readonly signal: AbortSignal,
    private readonly abort: (reason: unknown) => void,
  ) {
    this.source = uplink[Symbol.asyncIterator]()
    signal.addEventListener('abort', this.onAbort, { once: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }

  async next(): Promise<IteratorResult<unknown>> {
    // A cancelled stream reports the cancellation on every read, closed or not.
    if (this.signal.aborted) throw streamAbortFailure(this.endpoint, this.signal.reason)
    if (this.closed) return UPLINK_DONE
    // Only pending reads belong to the decoder; finish() must wake all of them.
    const interrupted = Promise.withResolvers<IteratorResult<unknown>>()
    this.interrupted.add(interrupted)
    // The source can abort and throw synchronously before the race subscribes.
    void interrupted.promise.catch(() => undefined)
    let next: IteratorResult<unknown>
    try {
      next = await Promise.race([this.source.next(), interrupted.promise])
    } finally {
      this.interrupted.delete(interrupted)
    }
    if (next.done === true) {
      this.finish()
      return UPLINK_DONE
    }
    let value: unknown
    try {
      // A top-level `undefined` is the absent `value` of its frame: without a codec it is the item itself.
      value = next.value === undefined && this.codec.mode === 'src-json'
        ? undefined
        : decode(this.codec, next.value, this.endpoint, 'uplink')
    } catch (failure) {
      // The codec failure (`gateway/input-invalid`, field `uplink`) fails the whole logical stream.
      this.abort(failure)
      throw failure
    }
    return { value, done: false }
  }

  /** Downlink finished or the method stopped reading: unread uplink items are dropped. */
  return(): Promise<IteratorResult<unknown>> {
    if (!this.closed) {
      this.finish()
      // The carrier owns the source iterator; a generator blocked in next()
      // completes this return once it yields, so it is not awaited here.
      void Promise.resolve().then(() => this.source.return?.()).catch(() => undefined)
    }
    return Promise.resolve(UPLINK_DONE)
  }

  private finish(): void {
    this.closed = true
    this.signal.removeEventListener('abort', this.onAbort)
    for (const read of this.interrupted) read.resolve(UPLINK_DONE)
  }
}

/**
 * The context of one Remote call as the receiving method reads it through
 * `this.ctx.invocation`. The uplink is decoded on first use and released when
 * the call's downlink finishes.
 */
class GatewayInvocation implements RemoteInvocation {
  private decoder: UplinkDecoder | undefined
  private taken = false

  /**
   * @param request - decoded endpoint and wire arguments.
   * @param service - Cordis service key of the receiver.
   * @param peer - Peer the call speaks for.
   * @param signal - the signal the method observes.
   * @param uplink - carrier items and the codec that decodes them.
   */
  constructor(
    readonly request: RemoteInvocation['request'],
    readonly service: string,
    readonly peer: PeerScope,
    readonly signal: AbortSignal,
    private readonly uplink_: UplinkSource,
  ) {}

  uplink<In = unknown>(): AsyncIterable<In> {
    if (this.taken) {
      throw new Error(`typert gateway: ${this.uplink_.endpoint}: invocation.uplink() is available once per call`)
    }
    this.taken = true
    const { source, codec, endpoint, abort } = this.uplink_
    this.decoder = new UplinkDecoder(source, codec, endpoint, this.signal, abort)
    // The descriptor codec decides what arrives; `In` is the caller's assertion.
    return this.decoder as AsyncIterable<In>
  }

  /**
   * The downlink finished: release the uplink. Unread items are dropped, and a
   * carrier iterable the method never took is returned so it stops producing;
   * a later `uplink()` throws like a second one would.
   * @returns settles once a taken uplink has closed.
   */
  async close(): Promise<void> {
    if (this.decoder !== undefined) {
      await this.decoder.return()
      return
    }
    this.taken = true
    releaseUplink(this.uplink_.source)
  }
}

/**
 * Return a carrier uplink nobody will read, so it drops later items instead of
 * buffering them. The carrier owns the iterator and `return()` is not awaited:
 * a generator blocked in `next()` completes it only once it yields.
 * @param source - the carrier's uplink iterable.
 */
function releaseUplink(source: AsyncIterable<unknown>): void {
  void Promise.resolve().then(() => source[Symbol.asyncIterator]().return?.()).catch(() => undefined)
}

function rpcFailure(error: unknown): ConnectionRpcResult {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) {
    return { ok: false, error: { code: remote.code, message: remote.message, details: remote.details } }
  }
  return {
    ok: false,
    error: {
      code: 'gateway/internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

function rpcError(error: unknown): ConnectionRpcError & RemoteStreamFailure {
  return (rpcFailure(error) as Extract<ConnectionRpcResult, { readonly ok: false }>).error
}

function endpointOf(namespace: string, method: string): string {
  return `${namespace}/${method}`
}

function validateBinding(
  receiver: object,
  serviceKey: string,
  namespace: string,
  endpoint: string,
): ResolvedBinding {
  const original = originalOf(receiver)
  const value: unknown = Reflect.get(original, 'typertRemote')
  if (value === undefined) {
    throw new TypertGatewayError(
      'gateway/binding-invalid',
      endpoint,
      `Service ${JSON.stringify(serviceKey)} has no visible typertRemote binding`,
    )
  }
  return {
    binding: readBinding(value, original, serviceKey, endpoint, namespace),
    original,
  }
}

function readBinding(
  value: unknown,
  original: object,
  serviceKey: string,
  endpoint: string,
  namespace?: string,
): TypertGatewayBinding {
  if (!isObject(value)
    || Reflect.get(value, 'service') !== original
    || Reflect.get(value, 'serviceKey') !== serviceKey
    || typeof Reflect.get(value, 'namespace') !== 'string'
    || (namespace !== undefined && Reflect.get(value, 'namespace') !== namespace)) {
    throw new TypertGatewayError(
      'gateway/binding-invalid',
      endpoint,
      `Service ${JSON.stringify(serviceKey)} has an inconsistent typertRemote binding`,
    )
  }
  return value as TypertGatewayBinding
}

function originalOf(receiver: object): object {
  const original: unknown = Reflect.get(receiver, symbols.original)
  return isObject(original) ? original : receiver
}

function methodParameterNames(service: object, method: string, endpoint: string): readonly string[] {
  let prototype: object | null = Object.getPrototypeOf(service) as object | null
  let implementation: ((this: object, ...args: never[]) => unknown) | undefined
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
    if (descriptor !== undefined) {
      if ('value' in descriptor && typeof descriptor.value === 'function') {
        implementation = descriptor.value as (this: object, ...args: never[]) => unknown
      }
      break
    }
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  if (implementation === undefined) {
    throw new TypertGatewayError(
      'gateway/method-unavailable',
      endpoint,
      `Remote marker has no prototype method ${JSON.stringify(method)}`,
    )
  }
  const source = Function.prototype.toString.call(implementation)
  const open = source.indexOf('(')
  const close = source.indexOf(')', open + 1)
  /* v8 ignore next -- standard public class-method syntax always contains a parenthesized parameter list. */
  if (open < 0 || close < 0) return invalidSignature(endpoint, method)
  const body = source.slice(open + 1, close).trim()
  if (body.length === 0) return []
  const parts = body.split(',').map(part => part.trim())
  const names = new Set<string>()
  for (const part of parts) {
    if (!/^[$A-Z_a-z][$\w]*$/u.test(part) || names.has(part)) return invalidSignature(endpoint, method)
    names.add(part)
  }
  return [...names]
}

function invalidSignature(endpoint: string, method: string): never {
  throw new TypertGatewayError(
    'gateway/signature-invalid',
    endpoint,
    `SRC method ${JSON.stringify(method)} must use unique identifier parameters without destructuring, defaults, or rest`,
  )
}

function assertExactArguments(
  args: Readonly<Record<string, unknown>>,
  descriptor: InvocationDescriptor,
  endpoint: string,
): void {
  if (!isPlainObject(args)) {
    throw new TypertGatewayError('gateway/arguments-invalid', endpoint, 'args must be a plain object')
  }
  const expected = new Set(descriptor.parameters.map(parameter => parameter.wire))
  if (descriptor.invocation.kind === 'context') expected.add(descriptor.invocation.wire)
  const actual = Reflect.ownKeys(args)
  const extra = actual.filter(key => typeof key !== 'string' || !expected.has(key))
  // A JSON field may be omitted when the strict descriptor declares absence,
  // and always under SRC: a weak descriptor reads parameter names from the
  // JavaScript signature and cannot see which are optional, so LIB is where an
  // omitted required argument is caught. Lookup ids are never omissible.
  const acceptsMissing = new Set(descriptor.parameters
    .filter(parameter => parameter.source === 'json'
      && (parameter.acceptsUndefined === true || parameter.codec.mode === 'src-json'))
    .map(parameter => parameter.wire))
  const missing = [...expected].filter(key => !Object.hasOwn(args, key) && !acceptsMissing.has(key))
  if (extra.length === 0 && missing.length === 0) return
  const clauses: string[] = []
  if (missing.length > 0) clauses.push(`missing ${missing.map(key => JSON.stringify(key)).join(', ')}`)
  if (extra.length > 0) clauses.push(`unexpected ${extra.map(key => JSON.stringify(String(key))).join(', ')}`)
  throw new TypertGatewayError('gateway/arguments-invalid', endpoint, `args fields do not match the descriptor: ${clauses.join('; ')}`)
}

function decode(
  codec: TypertCodec,
  value: unknown,
  endpoint: string,
  field: string,
): unknown {
  try {
    if (codec.mode === 'strict') {
      value = codec.create().parse(value)
      /* v8 ignore next -- generated optional-input codecs are the only strict codecs that return undefined. */
      if (value === undefined) return value
    }
    assertJsonValue(value, new Set())
    return value
  } catch (cause) {
    throw new TypertGatewayError(
      'gateway/input-invalid',
      endpoint,
      `wire field ${JSON.stringify(field)} failed boundary validation`,
      { cause, field },
    )
  }
}

function assertJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new TypeError('non-finite number is not JSON-safe')
  }
  if (!isObject(value)) throw new TypeError(`${typeof value} is not JSON-safe`)
  if (ancestors.has(value)) throw new TypeError('cyclic value is not JSON-safe')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(value).length !== value.length) {
        throw new TypeError('sparse or decorated array is not JSON-safe')
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse array is not JSON-safe')
        assertJsonValue(value[index], ancestors)
      }
      return
    }
    if (!isPlainObject(value)) throw new TypeError('non-plain object is not JSON-safe')
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('symbol property is not JSON-safe')
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      /* v8 ignore next -- ownKeys() just returned this key; only a hostile same-process Proxy can delete it between operations. */
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('non-data property is not JSON-safe')
      }
      assertJsonValue(descriptor.value, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  if (Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === null || prototype === Object.prototype
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

export default TypertGatewayService
