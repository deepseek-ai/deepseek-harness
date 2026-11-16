/** Worker-owned registry of Host and Client realm definitions. */

import type { ClientRuntimeRouter, ClientRuntimeTargetEvent } from '../bridge/runtime-rpc.ts'
import type { ClientSourceRouter } from '../bridge/source-rpc.ts'
import type { InspectorSourceDescriptor } from '../../shared/bridge/messages/observation.ts'
import { ClientInspectorRealm } from '../realms/client/index.ts'
import type { InspectorRealm } from './realm.ts'

/** Realm admission and removal observed by each DevTools connection. */
export type InspectorRealmEvent =
  | { readonly type: 'opened'; readonly realm: InspectorRealm }
  | { readonly type: 'closed'; readonly realm: InspectorRealm }

/** Authoritative collection of all currently executable realms. */
export class InspectorRealmRegistry {
  private readonly clientsBySource = new Map<string, ClientInspectorRealm>()
  private readonly listeners = new Set<(event: InspectorRealmEvent) => void>()
  private readonly unsubscribeClients: () => void

  constructor(
    readonly host: InspectorRealm,
    private readonly clients: ClientRuntimeRouter,
    private readonly clientSources: ClientSourceRouter,
  ) {
    for (const target of clients.targets()) this.openClient(target)
    this.unsubscribeClients = clients.subscribe((event) => { this.receiveClient(event) })
  }

  /**
   * Return the realm admission order used by every connection-local session set.
   * @returns Host followed by active Clients.
   */
  realms(): InspectorRealm[] {
    return [this.host, ...this.clientsBySource.values()]
  }

  /**
   * Resolve one synthetic Client execution context.
   * @param contextId - Numeric CDP execution-context id.
   * @returns The active realm when the id belongs to a Client.
   */
  byContextId(contextId: number): InspectorRealm | undefined {
    for (const realm of this.clientsBySource.values()) {
      if (realm.context.kind === 'synthetic' && realm.context.id === contextId) return realm
    }
    return undefined
  }

  /**
   * Resolve one globally unique Client execution context.
   * @param uniqueId - CDP unique execution-context id.
   * @returns The active realm when the id belongs to a Client.
   */
  byUniqueContextId(uniqueId: string): InspectorRealm | undefined {
    for (const realm of this.clientsBySource.values()) {
      if (realm.context.kind === 'synthetic' && realm.context.uniqueId === uniqueId) return realm
    }
    return undefined
  }

  /**
   * Resolve the realm for one active source generation.
   * @param source - Source identity retained by a Cordis tree node.
   * @returns The matching active realm.
   */
  bySource(source: InspectorSourceDescriptor): InspectorRealm | undefined {
    if (source.kind === 'host') return this.host
    const realm = this.clientsBySource.get(source.sourceId)
    return realm?.descriptor.generation === source.generation ? realm : undefined
  }

  /**
   * Subscribe to Client realm admission and removal.
   * @param listener - Registry observer.
   * @returns A disposer removing the observer.
   */
  subscribe(listener: (event: InspectorRealmEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Stop observing Client targets and clear registry listeners. */
  close(): void {
    this.unsubscribeClients()
    this.clientsBySource.clear()
    this.listeners.clear()
  }

  private receiveClient(event: ClientRuntimeTargetEvent): void {
    if (event.type === 'opened') {
      const realm = this.openClient(event.target)
      this.emit({ type: 'opened', realm })
      return
    }
    const realm = this.clientsBySource.get(event.target.source.sourceId)
    if (realm === undefined || realm.target !== event.target) return
    this.clientsBySource.delete(event.target.source.sourceId)
    this.emit({ type: 'closed', realm })
  }

  private openClient(target: ClientRuntimeTargetEvent['target']): ClientInspectorRealm {
    const realm = new ClientInspectorRealm(target, this.clients, this.clientSources)
    this.clientsBySource.set(target.source.sourceId, realm)
    return realm
  }

  private emit(event: InspectorRealmEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (_listenerFailed) {
        // One DevTools connection cannot disrupt realm delivery to sibling connections.
      }
    }
  }
}
