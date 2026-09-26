/** Client observation and Runtime endpoint over the Inspector Worker's ingest WebSocket. */

import type { InspectorClientBootstrap } from '../../shared/bridge/messages/control.ts'
import type {
  ClientRuntimeRequestId,
  ClientRuntimeSessionId,
  InspectorSourceGeneration,
} from '../../shared/bridge/ids.ts'
import { isJsonValue, jsonByteLength } from '../../shared/json.ts'
import {
  INSPECTOR_PROTOCOL_VERSION,
  parseWorkerSourceFrame,
  type SourceCloseFrame,
  type SourceOpenFrame,
} from '../../shared/bridge/messages/observation.ts'
import { InspectorSourceConnection } from '../../shared/bridge/publisher.ts'
import { ClientConsoleObserver } from '../cdp/console.ts'
import { ClientRuntimeExecutor } from '../cdp/runtime.ts'
import {
  ClientSourceCatalog,
  ClientSourceCatalogError,
  discoverInspectorClientSourceCatalog,
} from '../cdp/sources.ts'
import type { ClientSourceRequestFrame, ClientSourceResponseFrame } from '../../shared/bridge/messages/sources/index.ts'
import { ClientRealmSource } from '../inspection/realm.ts'
import { NETWORK_TOPICS } from '../inspection/network.ts'
import { ClientBridgeLifecycle } from './lifecycle.ts'
import { ClientBridgePublisher } from './publisher.ts'
import { ClientBridgeRpc } from './rpc.ts'
import { dispatchBridgeFrame } from './dispatcher.ts'

/** Reconnecting Client source whose bounded queue never blocks page work. */
export class ClientInspectorSource extends InspectorSourceConnection {
  private readonly realmSource: ClientRealmSource
  protected readonly publisher: ClientBridgePublisher
  private socket: WebSocket | undefined
  private generation: InspectorSourceGeneration | undefined
  private accepted = false
  private closed = false
  private readonly runtime: ClientRuntimeExecutor
  private readonly runtimeRequests = new Map<ClientRuntimeRequestId, {
    readonly controller: AbortController
    readonly sessionId: ClientRuntimeSessionId
  }>()
  private readonly console: ClientConsoleObserver
  protected readonly queries: ClientBridgeRpc
  private readonly lifecycle: ClientBridgeLifecycle

  constructor(
    private readonly bootstrap: InspectorClientBootstrap,
    label = document.title || 'Client',
    private readonly sourceCatalog: ClientSourceCatalog | undefined = discoverInspectorClientSourceCatalog(),
    realmSource = new ClientRealmSource(label),
  ) {
    super()
    this.realmSource = realmSource
    this.lifecycle = new ClientBridgeLifecycle(bootstrap.reconnectBaseMs, bootstrap.reconnectMaxMs)
    this.publisher = new ClientBridgePublisher({
      topics: ['*'],
      maxQueuedRecords: bootstrap.maxQueuedRecords,
      maxQueuedBytes: bootstrap.maxQueuedBytes,
      maxRecordsPerFrame: bootstrap.maxRecordsPerFrame,
      maxFrameBytes: bootstrap.maxFrameBytes,
    }, bootstrap.maxQueuedBytes)
    this.runtime = new ClientRuntimeExecutor({
      maxObjectsPerSession: bootstrap.maxRuntimeObjectsPerSession,
      maxPropertiesPerResult: bootstrap.maxRuntimePropertiesPerResult,
      maxResponseBytes: bootstrap.maxFrameBytes,
    }, url => this.sourceCatalog?.scriptKeyForUrl(url))
    this.console = new ClientConsoleObserver(this.runtime, (sessionId, event) => {
      const socket = this.socket
      const generation = this.generation
      if (this.closed
        || !this.accepted
        || socket?.readyState !== WebSocket.OPEN
        || generation === undefined) return
      const frame = {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'client-console/event',
        sourceId: this.realmSource.sourceId,
        generation,
        sessionId,
        event,
      } as const
      if (!isJsonValue(frame) || jsonByteLength(frame) > this.bootstrap.maxFrameBytes) return
      try {
        socket.send(JSON.stringify(frame))
      } catch {
        // The socket close path resets this generation's Runtime and Console state.
      }
    }, url => this.sourceCatalog?.scriptKeyForUrl(url))
    this.queries = new ClientBridgeRpc({
      timeoutMs: bootstrap.queryTimeoutMs,
      maxFrameBytes: bootstrap.maxFrameBytes,
    })
    this.connect()
  }

  /** Permanently stop reconnecting and close the active source generation. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.console.close()
    this.cancelRuntimeRequests()
    this.runtime.reset()
    this.queries.close('Inspector Client source closed')
    this.lifecycle.close()
    this.publisher.close()
    const socket = this.socket
    const generation = this.generation
    try {
      if (socket?.readyState === WebSocket.OPEN && generation !== undefined) {
        const frame: SourceCloseFrame = {
          v: INSPECTOR_PROTOCOL_VERSION,
          t: 'source/close',
          sourceId: this.realmSource.sourceId,
          generation,
        }
        socket.send(JSON.stringify(frame))
        socket.close(1000, 'Client source closed')
      } else {
        socket?.close()
      }
    } finally {
      this.socket = undefined
      this.realmSource.close()
    }
  }

  private connect(): void {
    if (this.closed) return
    this.console.reset()
    this.cancelRuntimeRequests()
    this.runtime.reset()
    this.queries.disconnect('Inspector Client source reconnecting')
    const source = this.realmSource.connect(this.sourceCatalog !== undefined)
    const generation = source.generation
    const socket = new WebSocket(this.bootstrap.endpoint, this.bootstrap.protocol)
    this.socket = socket
    this.generation = generation
    this.accepted = false
    this.publisher.connect(socket, source)
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.closed) return
      const frame: SourceOpenFrame = {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'source/open',
        source,
        topics: ['*', ...NETWORK_TOPICS],
      }
      socket.send(JSON.stringify(frame))
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      try {
        if (new TextEncoder().encode(event.data).byteLength > this.bootstrap.maxFrameBytes) {
          throw new Error(`inspector protocol: Worker frame exceeds ${String(this.bootstrap.maxFrameBytes)} bytes`)
        }
        const value: unknown = JSON.parse(event.data)
        if (this.queries.receive(value)) return
        const frame = parseWorkerSourceFrame(value)
        if (frame.t !== 'source/rejected'
          && (frame.sourceId !== this.realmSource.sourceId || frame.generation !== generation)) return
        dispatchBridgeFrame(frame, {
          accepted: () => {
            this.accepted = true
            this.lifecycle.connected()
            this.queries.connectSocket(source, socket)
            this.publisher.accept(socket)
          },
          acknowledged: () => {},
          resnapshot: () => { this.publisher.replace(socket) },
          rejected: (rejected) => {
            console.error(`[inspector] Client source rejected: ${rejected.message}`)
            socket.close(1008, 'source rejected')
          },
          runtime: (request) => {
            void this.executeRuntime(socket, generation, request).catch((error: unknown) => {
              console.error('[inspector] Client Runtime transport failed:', error)
              socket.close(1011, 'Client Runtime transport failed')
            })
          },
          runtimeCanceled: (canceled) => { this.cancelRuntime(canceled.sessionId, canceled.requestId) },
          runtimeAcknowledged: (acknowledged) => {
            this.acknowledgeRuntime(acknowledged.sessionId, acknowledged.requestId)
          },
          runtimeClosed: (closed) => {
            this.cancelRuntimeSession(closed.sessionId)
            this.console.disable(closed.sessionId)
            this.runtime.closeSession(closed.sessionId)
          },
          consoleEnabled: (enabled) => { this.console.enable(enabled.sessionId) },
          consoleDisabled: (disabled) => { this.console.disable(disabled.sessionId) },
          sources: (request) => {
            void this.executeSourceRequest(socket, generation, request).catch((error: unknown) => {
              console.error('[inspector] Client Sources transport failed:', error)
              socket.close(1011, 'Client Sources transport failed')
            })
          },
          sourcesClosed: () => {},
        })
      } catch (error) {
        console.error('[inspector] invalid Worker control frame:', error)
        socket.close(1008, 'invalid Worker control frame')
      }
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.closed) return
      this.socket = undefined
      this.accepted = false
      this.publisher.disconnect(socket)
      this.console.reset()
      this.cancelRuntimeRequests()
      this.runtime.reset()
      this.queries.disconnect('Inspector Client source disconnected')
      this.lifecycle.reconnect(() => { this.connect() })
    })
    socket.addEventListener('error', () => {
      // `close` owns reconnection and keeps one timer.
    })
  }

  private async executeRuntime(
    socket: WebSocket,
    generation: InspectorSourceGeneration,
    frame: Extract<ReturnType<typeof parseWorkerSourceFrame>, { t: 'client-runtime/request' }>,
  ): Promise<void> {
    const controller = new AbortController()
    const operation = { controller, sessionId: frame.sessionId }
    this.runtimeRequests.set(frame.requestId, operation)
    const response = await this.runtime.execute(frame, controller.signal, true)
    if (this.runtimeRequests.get(frame.requestId) !== operation) return
    if (this.closed || this.socket !== socket || this.generation !== generation || socket.readyState !== WebSocket.OPEN) {
      this.cancelRuntime(frame.sessionId, frame.requestId)
      return
    }
    socket.send(JSON.stringify(response))
  }

  private acknowledgeRuntime(sessionId: ClientRuntimeSessionId, requestId: ClientRuntimeRequestId): void {
    const operation = this.runtimeRequests.get(requestId)
    if (operation === undefined || operation.sessionId !== sessionId) return
    this.runtimeRequests.delete(requestId)
    this.runtime.acknowledge(sessionId, requestId)
  }

  private cancelRuntime(sessionId: ClientRuntimeSessionId, requestId: ClientRuntimeRequestId): void {
    const operation = this.runtimeRequests.get(requestId)
    if (operation === undefined || operation.sessionId !== sessionId) return
    this.runtimeRequests.delete(requestId)
    operation.controller.abort()
    this.runtime.cancel(sessionId, requestId)
  }

  private cancelRuntimeSession(sessionId: ClientRuntimeSessionId): void {
    for (const [requestId, operation] of this.runtimeRequests) {
      if (operation.sessionId !== sessionId) continue
      operation.controller.abort()
      this.runtime.cancel(sessionId, requestId)
      this.runtimeRequests.delete(requestId)
    }
  }

  private cancelRuntimeRequests(): void {
    for (const [requestId, operation] of this.runtimeRequests) {
      operation.controller.abort()
      this.runtime.cancel(operation.sessionId, requestId)
    }
    this.runtimeRequests.clear()
  }

  private async executeSourceRequest(
    socket: WebSocket,
    generation: InspectorSourceGeneration,
    frame: ClientSourceRequestFrame,
  ): Promise<void> {
    let outcome: ClientSourceResponseFrame['outcome']
    try {
      if (this.sourceCatalog === undefined) {
        throw new ClientSourceCatalogError('invalid-request', 'Client source catalog is unavailable')
      }
      outcome = { ok: true, result: await this.sourceCatalog.execute(frame.command, this.bootstrap.maxClientSourceBytes) }
    } catch (error) {
      outcome = {
        ok: false,
        error: {
          code: error instanceof ClientSourceCatalogError ? error.code : 'internal-error',
          message: renderError(error).slice(0, 2_048),
        },
      }
    }
    let response: ClientSourceResponseFrame = {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'client-sources/response',
      sourceId: this.realmSource.sourceId,
      generation,
      sessionId: frame.sessionId,
      requestId: frame.requestId,
      outcome,
    }
    if (!isJsonValue(response) || jsonByteLength(response) > this.bootstrap.maxFrameBytes) {
      response = {
        ...response,
        outcome: {
          ok: false,
          error: { code: 'result-too-large', message: 'Client source result exceeds the source-frame byte limit' },
        },
      }
    }
    if (this.closed || this.socket !== socket || this.generation !== generation || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(response))
  }

}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
