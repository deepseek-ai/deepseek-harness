/** One DevTools connection: explicit local-domain routing plus a private Host V8 session. */

import { cdpError, parseCdpRequest, type CdpTransport } from './protocol.ts'
import { NetworkDomain, type NetworkSink } from './domains/network/session.ts'
import { CDP_METHOD_NOT_HANDLED, handleScaffold, type CdpTargetDescriptor } from './target.ts'
import { RuntimeDomainSession } from './domains/runtime/index.ts'
import { DebuggerDomainSession } from './domains/debugger/index.ts'
import { CordisDomSession, type CordisDomBackend } from './domains/dom/index.ts'
import type { InspectorSourceRegistry } from '../bridge/hub.ts'
import { HostNativeDomainSession } from './domains/native.ts'
import { InspectorRealmSessionSet } from './realm-sessions.ts'
import type { InspectorRealmRegistry } from '../inspection/realm-store.ts'
import type { CordisRuntimeTreeReader } from '../../shared/cordis/reader.ts'
import { cordisRuntimeSourceId, type CordisRuntimeTree } from '../../shared/cordis/model.ts'
import type { InspectorSourceId } from '../../shared/bridge/ids.ts'

/** Per-connection CDP dispatcher with optional Client selection; Host remains visible. */
export class CdpSession implements NetworkSink {
  private readonly realms: InspectorRealmSessionSet
  private readonly nativeDomains: HostNativeDomainSession
  private readonly runtime: RuntimeDomainSession
  private readonly debugger: DebuggerDomainSession
  private readonly dom: CordisDomSession
  private readonly scopedDom: CordisDomBackend | undefined
  private diagnosticsEnabled = false
  private readonly unsubscribeSources: () => void

  constructor(
    private readonly transport: CdpTransport,
    private readonly target: CdpTargetDescriptor,
    private readonly sources: InspectorSourceRegistry,
    private readonly network: NetworkDomain,
    realmRegistry: InspectorRealmRegistry,
    domBackend: CordisDomBackend,
    private readonly cordisTrees: CordisRuntimeTreeReader,
    private readonly clientSourceId?: InspectorSourceId,
  ) {
    this.realms = new InspectorRealmSessionSet(realmRegistry, clientSourceId)
    const native = this.realms.host().nativeDomains
    if (native.state === 'unsupported') throw new Error(native.reason)
    this.nativeDomains = new HostNativeDomainSession(transport, native.backend)
    this.runtime = new RuntimeDomainSession(transport, this.realms)
    this.debugger = new DebuggerDomainSession(transport, this.realms, this.runtime)
    this.scopedDom = clientSourceId === undefined ? undefined : domBackend.forClient(clientSourceId)
    this.dom = new CordisDomSession(transport, this.scopedDom ?? domBackend, this.runtime)
    this.runtime.setObjectObserver((objectId, realm, reference, group) =>
      this.dom.bindObject(objectId, realm, reference, group))
    this.unsubscribeSources = sources.subscribeStatus(() => {
      if (this.diagnosticsEnabled) this.sendEvent('DSHInspector.sourcesChanged', { sources: this.visibleSources() })
    })
  }

  /**
   * Parse and dispatch one raw CDP request. Invalid frames close this client only.
   * @param value - Untrusted decoded WebSocket payload.
   */
  receive(value: unknown): void {
    let request
    try {
      request = parseCdpRequest(value)
    } catch {
      this.transport.close()
      return
    }
    try {
      if (request.method === 'Runtime.releaseObject') this.dom.releaseObject(request.params.objectId)
      if (request.method === 'Runtime.releaseObjectGroup') this.dom.releaseObjectGroup(request.params.objectGroup)
      if (this.dom.handle(request)) return
      if (this.runtime.handle(request)) return
      if (this.debugger.handle(request)) return
      if (this.nativeDomains.owns(request.method)) {
        this.nativeDomains.handle({ ...request, params: this.runtime.nativeParameters(request.params) })
        return
      }
      let result: unknown
      if (request.method.startsWith('Network.')) {
        result = this.network.handle(request.method, request.params, this)
      } else if (request.method === 'DSHInspector.enable') {
        this.diagnosticsEnabled = true
        result = { sources: this.visibleSources() }
      } else if (request.method === 'DSHInspector.disable') {
        this.diagnosticsEnabled = false
        result = {}
      } else if (request.method === 'DSHInspector.getSources') {
        result = { sources: this.visibleSources() }
      } else if (request.method === 'DSHInspector.getCordisTree') {
        void this.cordisTrees.getTree().then(
          (tree) => { this.transport.send({ id: request.id, result: { tree: this.visibleTree(tree) } }) },
          (error: unknown) => {
            this.transport.send(cdpError(request.id, -32000, error instanceof Error ? error.message : String(error)))
          },
        )
        return
      } else {
        result = handleScaffold(request, this.target)
        if (result === CDP_METHOD_NOT_HANDLED) {
          this.transport.send(cdpError(request.id, -32601, `Method not found: ${request.method}`))
          return
        }
      }
      this.transport.send({ id: request.id, result })
    } catch (error) {
      this.transport.send(cdpError(request.id, -32000, error instanceof Error ? error.message : String(error)))
    }
  }

  private visibleSources(): ReturnType<InspectorSourceRegistry['describe']> {
    return this.sources.describe().filter(source => this.clientSourceId === undefined
      || source.kind === 'host' || source.sourceId === this.clientSourceId)
  }

  private visibleTree(tree: CordisRuntimeTree): CordisRuntimeTree {
    if (this.clientSourceId === undefined) return tree
    const sourceId = cordisRuntimeSourceId(this.clientSourceId)
    return { ...tree, clients: tree.clients.filter(client => client.source.sourceId === sourceId) }
  }

  /** Push one CDP event. */
  sendEvent(method: string, params: Readonly<Record<string, unknown>>): void {
    this.transport.send({ method, params })
  }

  /** Release every connection-owned V8 and domain resource. */
  close(): void {
    this.unsubscribeSources()
    this.network.detach(this)
    this.dom.close()
    this.scopedDom?.close()
    this.runtime.close()
    this.debugger.close()
    this.nativeDomains.close()
    this.realms.close()
  }
}
