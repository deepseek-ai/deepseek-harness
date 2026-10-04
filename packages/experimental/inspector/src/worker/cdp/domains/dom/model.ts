/** Worker projection from Cordis snapshots to a connection-neutral semantic DOM. */

import type { CordisTreeNode } from '../../../../shared/cordis/snapshot.ts'
import type { InspectorSourceId } from '../../../../shared/bridge/ids.ts'
import type { InspectorSourceDescriptor } from '../../../../shared/bridge/messages/observation.ts'
import type { InspectorObjectReference } from '../../../../shared/cordis/object-reference.ts'
import type { InspectorRealmDescriptor } from '../../../inspection/realm.ts'
import { cdpNumericId, type CdpBackendNodeId } from '../../ids.ts'
import type {
  CordisTreeObjectRoute,
  CordisTreeSourceSnapshot,
  CordisTreeStore,
} from '../../../inspection/cordis-store.ts'

/** One backend-owned node independent of any DevTools connection. */
export interface CordisDomNode {
  readonly backendNodeId: CdpBackendNodeId
  readonly key: string
  readonly name: string
  readonly attributes: readonly (readonly [string, string])[]
  readonly description: string
  readonly object?: CordisTreeObjectRoute
  readonly children: readonly CordisDomNode[]
}

/** Immutable document revision shared by the consumers of one backend. */
export interface CordisDomDocument {
  readonly revision: number
  readonly root: CordisDomNode
  readonly byBackendId: ReadonlyMap<CdpBackendNodeId, CordisDomNode>
  readonly parentByBackendId: ReadonlyMap<CdpBackendNodeId, CdpBackendNodeId>
}

/** One structural or attribute mutation between two projected documents. */
export type CordisDomMutation =
  | { readonly type: 'document-updated' }
  | {
    readonly type: 'child-inserted'
    readonly parentBackendNodeId: CdpBackendNodeId
    readonly previousBackendNodeId: CdpBackendNodeId | 0
    readonly node: CordisDomNode
  }
  | {
    readonly type: 'child-removed'
    readonly parentBackendNodeId: CdpBackendNodeId
    readonly node: CordisDomNode
  }
  | {
    readonly type: 'children-replaced'
    readonly parentBackendNodeId: CdpBackendNodeId
    readonly children: readonly CordisDomNode[]
  }
  | {
    readonly type: 'attribute-modified'
    readonly backendNodeId: CdpBackendNodeId
    readonly name: string
    readonly value: string
  }
  | {
    readonly type: 'attribute-removed'
    readonly backendNodeId: CdpBackendNodeId
    readonly name: string
  }

/** A visible incremental mutation or an in-place source availability change. */
export type CordisDomChange =
  | { readonly type: 'tree-mutated'; readonly mutations: readonly CordisDomMutation[] }
  | { readonly type: 'source-disconnected'; readonly source: InspectorSourceDescriptor }

/** Assigns durable backend ids and projects the latest source snapshots. */
export class CordisDomBackend {
  private readonly backendIdByKey = new Map<string, CdpBackendNodeId>()
  private readonly listeners = new Set<(event: CordisDomChange) => void>()
  private documentValue: CordisDomDocument
  private nextBackendNodeId = 1
  private nextRevision = 1
  private readonly unsubscribe: () => void
  private readonly nodeByObject = new Map<string, CordisDomNode>()

  /**
   * @param trees - Shared store; this backend owns only its subscription and projection.
   * @param clientSourceId - Restrict Clients to this source; omission includes every retained Client.
   */
  constructor(private readonly trees: CordisTreeStore, private readonly clientSourceId?: InspectorSourceId) {
    this.documentValue = this.build()
    this.unsubscribe = trees.subscribe((event) => {
      const previous = this.documentValue
      this.documentValue = this.build()
      if (event.type === 'source-disconnected' && this.includesSource(event.source)) {
        this.emit({ type: 'source-disconnected', source: event.source })
      }
      const mutations = diffDocument(previous, this.documentValue)
      if (mutations.length > 0) this.emit({ type: 'tree-mutated', mutations })
    })
  }

  /**
   * Create an independent Host-and-Client projection over the same retained snapshots.
   * @param sourceId - Client source to include across its reconnect generations.
   * @returns A new backend whose caller must close; closing it leaves this backend and the store intact.
   */
  forClient(sourceId: InspectorSourceId): CordisDomBackend {
    return new CordisDomBackend(this.trees, sourceId)
  }

  /**
   * Read the latest connection-neutral semantic document.
   * @returns The current immutable document revision.
   */
  document(): CordisDomDocument {
    return this.documentValue
  }

  /**
   * Subscribe to full document replacements and in-place realm state changes.
   * @param listener - Called after a new backend revision is installed.
   * @returns A disposer removing the listener.
   */
  subscribe(listener: (event: CordisDomChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release only this backend's store subscription and listeners. */
  close(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  /**
   * Resolve one source-local object reference to its current projected node.
   * @param source - Connected source generation that owns the reference.
   * @param reference - Realm-local registry and object handle.
   * @returns The current projected node, when present.
   */
  nodeForObject(source: InspectorSourceDescriptor, reference: InspectorObjectReference): CordisDomNode | undefined {
    return this.nodeByObject.get(objectKey(source, reference))
  }

  /**
   * Resolve a reference when a Runtime route identifies only Host or Client ownership.
   * @param kind - Host or Client ownership inferred by the Runtime adapter.
   * @param reference - Realm-local registry and object handle.
   * @returns The current projected node, when present.
   */
  nodeForObjectKind(kind: InspectorSourceDescriptor['kind'], reference: InspectorObjectReference): CordisDomNode | undefined {
    if (kind === 'client' && this.clientSourceId !== undefined) {
      const tree = this.trees.tree().clients.find(tree => tree.source.sourceId === this.clientSourceId)
      return tree === undefined ? undefined : this.nodeForObject(tree.source, reference)
    }
    const route = this.trees.resolveObjectInKind(kind, reference)
    return route === undefined ? undefined : this.nodeForObject(route.source, reference)
  }

  private includesSource(source: InspectorSourceDescriptor): boolean {
    return this.clientSourceId === undefined || source.kind === 'host' || source.sourceId === this.clientSourceId
  }

  /**
   * Resolve one realm-neutral Runtime reference to its current projected node.
   * @param realm - Realm that exposed the Runtime object.
   * @param reference - Realm-local registry and object handle.
   * @returns The current projected node, when present.
   */
  nodeForRealm(realm: InspectorRealmDescriptor, reference: InspectorObjectReference): CordisDomNode | undefined {
    if (realm.kind === 'host') return this.nodeForObjectKind('host', reference)
    const route = this.trees.resolveObjectIdentity(realm.sourceId, realm.generation, reference)
    return route === undefined ? undefined : this.nodeForObject(route.source, reference)
  }

  private build(): CordisDomDocument {
    const byBackendId = new Map<CdpBackendNodeId, CordisDomNode>()
    const parentByBackendId = new Map<CdpBackendNodeId, CdpBackendNodeId>()
    this.nodeByObject.clear()
    const tree = this.trees.tree()
    const root = this.node('document', '#document', [], '#document')
    const host = this.node('host', 'host', [], '<host>')
    if (tree.host !== null) host.children.push(this.entity(tree.host, tree.host.snapshot.root))
    const clients = this.node('clients', 'clients', [], '<clients>')
    for (const clientTree of tree.clients) {
      if (!this.includesSource(clientTree.source)) continue
      const attributes: readonly (readonly [string, string])[] = clientTree.connection.state === 'disconnected'
        ? [['disconnected', '']]
        : []
      const client = this.node(`client:${clientTree.source.sourceId}`, 'client', attributes, elementDescription('client', attributes))
      client.children.push(this.entity(clientTree, clientTree.snapshot.root))
      clients.children.push(client)
    }
    root.children.push(host, clients)
    const retainedKeys = new Set<string>()
    const freeze = (node: MutableDomNode, parent?: MutableDomNode): CordisDomNode => {
      const value: CordisDomNode = { ...node, children: node.children.map(child => freeze(child, node)) }
      retainedKeys.add(value.key)
      byBackendId.set(value.backendNodeId, value)
      if (parent !== undefined) parentByBackendId.set(value.backendNodeId, parent.backendNodeId)
      if (value.object?.connection.state === 'connected') this.nodeByObject.set(objectKey(value.object.source, {
        registryId: value.object.snapshot.objectRegistryId,
        handle: value.object.node.objectHandle,
      }), value)
      return value
    }
    const frozenRoot = freeze(root)
    for (const key of this.backendIdByKey.keys()) {
      if (!retainedKeys.has(key)) this.backendIdByKey.delete(key)
    }
    return { revision: this.nextRevision++, root: frozenRoot, byBackendId, parentByBackendId }
  }

  private entity(
    tree: CordisTreeSourceSnapshot,
    node: CordisTreeNode,
  ): MutableDomNode {
    const { source, snapshot } = tree
    const key = `entity:${objectKey(source, { registryId: snapshot.objectRegistryId, handle: node.objectHandle })}`
    const object = { ...tree, node }
    const attributes: readonly (readonly [string, string])[] = node.kind === 'fiber'
      ? [['uid', String(node.uid)]]
      : []
    const projected = this.node(key, node.kind, attributes, elementDescription(node.kind, attributes), object)
    projected.children.push(...node.children.map(child => this.entity(tree, child)))
    return projected
  }

  private node(
    key: string,
    name: string,
    attributes: readonly (readonly [string, string])[],
    description: string,
    object?: CordisTreeObjectRoute,
  ): MutableDomNode {
    let backendNodeId = this.backendIdByKey.get(key)
    if (backendNodeId === undefined) {
      backendNodeId = cdpNumericId<'CdpBackendNodeId'>(this.nextBackendNodeId++, 'backendNodeId')
      this.backendIdByKey.set(key, backendNodeId)
    }
    return { backendNodeId, key, name, attributes, description, ...(object === undefined ? {} : { object }), children: [] }
  }

  private emit(change: CordisDomChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch {
        // One closed CDP connection cannot prevent sibling sessions from receiving the document mutation.
      }
    }
  }
}

interface MutableDomNode extends Omit<CordisDomNode, 'children'> {
  readonly children: MutableDomNode[]
}

function elementDescription(name: string, attributes: readonly (readonly [string, string])[]): string {
  const rendered = attributes.map(([key, value]) => value === '' ? key : `${key}=${JSON.stringify(value)}`).join(' ')
  return `<${name}${rendered === '' ? '' : ` ${rendered}`}>`
}

function objectKey(source: InspectorSourceDescriptor, reference: InspectorObjectReference): string {
  return `${source.sourceId}\0${source.generation}\0${reference.registryId}\0${reference.handle}`
}

function diffDocument(previous: CordisDomDocument, current: CordisDomDocument): CordisDomMutation[] {
  const mutations: CordisDomMutation[] = []
  return diffNode(previous.root, current.root, mutations)
    ? mutations
    : [{ type: 'document-updated' }]
}

function diffNode(previous: CordisDomNode, current: CordisDomNode, mutations: CordisDomMutation[]): boolean {
  if (previous.backendNodeId !== current.backendNodeId || previous.name !== current.name) {
    return false
  }
  const previousAttributes = new Map(previous.attributes)
  const currentAttributes = new Map(current.attributes)
  for (const [name, value] of currentAttributes) {
    if (previousAttributes.get(name) === value) continue
    mutations.push({ type: 'attribute-modified', backendNodeId: current.backendNodeId, name, value })
  }
  for (const [name] of previousAttributes) {
    if (!currentAttributes.has(name)) {
      mutations.push({ type: 'attribute-removed', backendNodeId: current.backendNodeId, name })
    }
  }

  const previousIds = previous.children.map(child => child.backendNodeId)
  const currentIds = current.children.map(child => child.backendNodeId)
  const previousSet = new Set(previousIds)
  const currentSet = new Set(currentIds)
  const retainedBefore = previousIds.filter(id => currentSet.has(id))
  const retainedAfter = currentIds.filter(id => previousSet.has(id))
  if (!sameIds(retainedBefore, retainedAfter)) {
    mutations.push({
      type: 'children-replaced',
      parentBackendNodeId: current.backendNodeId,
      children: current.children,
    })
    return true
  }
  for (const child of previous.children) {
    if (!currentSet.has(child.backendNodeId)) {
      mutations.push({ type: 'child-removed', parentBackendNodeId: current.backendNodeId, node: child })
    }
  }
  for (let index = 0; index < current.children.length; index++) {
    const child = current.children[index] as CordisDomNode
    if (previousSet.has(child.backendNodeId)) continue
    mutations.push({
      type: 'child-inserted',
      parentBackendNodeId: current.backendNodeId,
      previousBackendNodeId: index === 0 ? 0 : (current.children[index - 1] as CordisDomNode).backendNodeId,
      node: child,
    })
  }
  const previousById = new Map(previous.children.map(child => [child.backendNodeId, child]))
  for (const child of current.children) {
    const prior = previousById.get(child.backendNodeId)
    if (prior !== undefined && !diffNode(prior, child, mutations)) return false
  }
  return true
}

function sameIds(left: readonly CdpBackendNodeId[], right: readonly CdpBackendNodeId[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
