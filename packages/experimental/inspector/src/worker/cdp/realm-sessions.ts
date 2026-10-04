/** Per-DevTools-connection sessions opened from the shared realm registry. */

import { randomUUID } from 'node:crypto'
import { inspectorId } from '../../shared/identity.ts'
import type { InspectorRealmId } from '../../shared/cdp/ids.ts'
import type { InspectorSourceDescriptor } from '../../shared/bridge/messages/observation.ts'
import type { InspectorSourceId } from '../../shared/bridge/ids.ts'
import type { InspectorRealmEvent, InspectorRealmRegistry } from '../inspection/realm-store.ts'
import type { InspectorRealm, InspectorRealmSession } from '../inspection/realm.ts'
import type { InspectorConnectionId } from './ids.ts'

/** Realm-session lifecycle observed by connection-local CDP domains. */
export type InspectorRealmSessionEvent =
  | { readonly type: 'opened'; readonly session: InspectorRealmSession }
  | { readonly type: 'closed'; readonly session: InspectorRealmSession }

/** Owns one backend session per visible realm for one DevTools connection. */
export class InspectorRealmSessionSet {
  /** Opaque identity shared by every domain and object table on this DevTools connection. */
  readonly connectionId: InspectorConnectionId = inspectorId<'InspectorConnectionId'>(randomUUID(), 'connectionId')
  private readonly sessions = new Map<InspectorRealmId, InspectorRealmSession>()
  private readonly listeners = new Set<(event: InspectorRealmSessionEvent) => void>()
  private readonly unsubscribeRealms: () => void
  private closed = false

  constructor(private readonly realms: InspectorRealmRegistry, private readonly clientSourceId?: InspectorSourceId) {
    for (const realm of realms.realms()) if (this.includes(realm)) this.open(realm)
    this.unsubscribeRealms = realms.subscribe((event) => { this.receiveRealm(event) })
  }

  /**
   * Return active sessions in the registry's deterministic order.
   * @returns Host followed by connected Clients included in this connection.
   */
  all(): InspectorRealmSession[] {
    return this.realms.realms()
      .map(realm => this.sessions.get(realm.descriptor.realmId))
      .filter((session): session is InspectorRealmSession => session !== undefined)
  }

  /**
   * Return the required Host session.
   * @returns The connection-local Host realm session.
   */
  host(): InspectorRealmSession {
    const session = this.sessions.get(this.realms.host.descriptor.realmId)
    if (session === undefined) throw new Error('Host Inspector realm session is unavailable')
    return session
  }

  /**
   * Resolve one synthetic Client context.
   * @param contextId - Numeric CDP execution-context id.
   * @returns Its realm session when currently connected.
   */
  byContextId(contextId: number): InspectorRealmSession | undefined {
    const realm = this.realms.byContextId(contextId)
    return realm === undefined ? undefined : this.sessions.get(realm.descriptor.realmId)
  }

  /**
   * Resolve one globally unique Client context.
   * @param uniqueId - CDP unique execution-context id.
   * @returns Its realm session when currently connected.
   */
  byUniqueContextId(uniqueId: string): InspectorRealmSession | undefined {
    const realm = this.realms.byUniqueContextId(uniqueId)
    return realm === undefined ? undefined : this.sessions.get(realm.descriptor.realmId)
  }

  /**
   * Resolve one active source generation to this connection's realm session.
   * @param source - Source identity retained by a Cordis tree node.
   * @returns The matching realm session.
   */
  bySource(source: InspectorSourceDescriptor): InspectorRealmSession | undefined {
    const realm = this.realms.bySource(source)
    return realm === undefined ? undefined : this.sessions.get(realm.descriptor.realmId)
  }

  /**
   * Subscribe to connection-local realm session lifecycle.
   * @param listener - Session observer.
   * @returns A disposer removing the observer.
   */
  subscribe(listener: (event: InspectorRealmSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Close all realm sessions and stop tracking the registry. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribeRealms()
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
    this.listeners.clear()
  }

  private receiveRealm(event: InspectorRealmEvent): void {
    if (!this.includes(event.realm)) return
    if (event.type === 'opened') {
      const session = this.open(event.realm)
      this.emit({ type: 'opened', session })
      return
    }
    const session = this.sessions.get(event.realm.descriptor.realmId)
    if (session === undefined) return
    this.sessions.delete(event.realm.descriptor.realmId)
    session.close()
    this.emit({ type: 'closed', session })
  }

  private includes(realm: InspectorRealm): boolean {
    return this.clientSourceId === undefined || realm.descriptor.kind === 'host' || realm.descriptor.sourceId === this.clientSourceId
  }

  private open(realm: InspectorRealm): InspectorRealmSession {
    const session = realm.openSession()
    this.sessions.set(realm.descriptor.realmId, session)
    return session
  }

  private emit(event: InspectorRealmSessionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // One CDP domain cannot prevent sibling domains from observing realm lifecycle.
      }
    }
  }
}
