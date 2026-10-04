/** Per-DevTools-session read-only DOM projection over Cordis tree snapshots. */

import { realmObjectExpression } from '../../../../shared/cordis/object-registry.ts'
import type { InspectorSourceDescriptor } from '../../../../shared/bridge/messages/observation.ts'
import type { InspectorObjectReference } from '../../../../shared/cordis/object-reference.ts'
import { respondToCdpRequest, type CdpRequest, type CdpTransport } from '../../protocol.ts'
import type { InspectorRealmDescriptor } from '../../../inspection/realm.ts'
import type { RuntimeDomainSession } from '../runtime/index.ts'
import type { RuntimeObjectPresentation } from '../runtime/object-table.ts'
import type { CordisDomBackend, CordisDomChange, CordisDomMutation, CordisDomNode } from './model.ts'
import {
  cdpNumericId,
  cdpStringId,
  type CdpBackendNodeId,
  type CdpNodeId,
  type CdpRemoteObjectId,
} from '../../ids.ts'

const READ_ONLY_METHODS = new Set([
  'DOM.setAttributeValue', 'DOM.setAttributesAsText', 'DOM.setNodeName', 'DOM.setNodeValue',
  'DOM.setOuterHTML', 'DOM.removeNode', 'DOM.moveTo', 'DOM.copyTo',
])

/**
 * Children levels `DOM.getDocument` serves when the caller omits `depth`;
 * deeper levels arrive through `DOM.requestChildNodes` on expand.
 */
const DEFAULT_DOCUMENT_DEPTH = 3

interface BoundDomObject {
  readonly backendNodeId: CdpBackendNodeId
  readonly sourceId: string
  readonly generation: string
}

/**
 * Connection-local NodeId, search, and RemoteObject mapping owner. Node payloads are depth-limited;
 * withheld levels are fetched through `DOM.requestChildNodes` or pushed with the ancestor chain
 * when a NodeId leaves through search or object lookup.
 */
export class CordisDomSession {
  private readonly nodeIdByBackend = new Map<CdpBackendNodeId, CdpNodeId>()
  private readonly backendByNodeId = new Map<CdpNodeId, CdpBackendNodeId>()
  private readonly nodesSent = new Set<CdpBackendNodeId>()
  private readonly childrenSent = new Set<CdpBackendNodeId>()
  private readonly backendByObjectId = new Map<CdpRemoteObjectId, BoundDomObject>()
  private readonly objectIdsByGroup = new Map<string, Set<CdpRemoteObjectId>>()
  private readonly searches = new Map<string, CdpNodeId[]>()
  private readonly unsubscribe: () => void
  private nextNodeId = 1
  private nextSearchId = 1
  private enabled = false

  constructor(
    private readonly transport: CdpTransport,
    private readonly backend: CordisDomBackend,
    private readonly runtime: RuntimeDomainSession,
  ) {
    this.unsubscribe = backend.subscribe((event) => { this.updateDocument(event) })
  }

  /**
   * Handle one DOM command.
   * @param request - Parsed CDP request.
   * @returns Whether this adapter owns the method.
   */
  handle(request: CdpRequest): boolean {
    if (!request.method.startsWith('DOM.')) return false
    this.respond(request, async () => this.execute(request.method, request.params))
    return true
  }

  /**
   * Forget a Runtime object mapping before its owner releases the object.
   * @param objectId - Connection-local Runtime object id.
   */
  releaseObject(objectId: unknown): void {
    if (typeof objectId !== 'string') return
    const id = cdpStringId<'CdpRemoteObjectId'>(objectId, 'objectId')
    this.backendByObjectId.delete(id)
    for (const ids of this.objectIdsByGroup.values()) ids.delete(id)
  }

  /**
   * Recognize a Runtime object from any realm as one current Cordis node.
   * @param objectId - Connection-local CDP object id.
   * @param realm - Realm that exposed the object.
   * @param reference - Realm-local semantic object identity.
   * @param group - Runtime object group retaining the id.
   * @returns Node presentation fields, when the object remains in the current tree.
   */
  bindObject(
    objectId: CdpRemoteObjectId,
    realm: InspectorRealmDescriptor,
    reference: InspectorObjectReference,
    group: string | undefined,
  ): RuntimeObjectPresentation | undefined {
    const node = this.backend.nodeForRealm(realm, reference)
    if (node === undefined) return undefined
    this.bindObjectId(objectId, node, group)
    return presentation(node)
  }

  /**
   * Forget every DOM mapping retained under one Runtime object group.
   * @param group - Runtime object-group name.
   */
  releaseObjectGroup(group: unknown): void {
    if (typeof group !== 'string') return
    for (const objectId of this.objectIdsByGroup.get(group) ?? []) this.backendByObjectId.delete(objectId)
    this.objectIdsByGroup.delete(group)
  }

  /** Release connection-owned ids and subscriptions. */
  close(): void {
    this.unsubscribe()
    this.resetDocument()
    this.searches.clear()
  }

  private async execute(method: string, params: Readonly<Record<string, unknown>>): Promise<object> {
    if (READ_ONLY_METHODS.has(method)) throw new Error('Cordis DOM projection is read-only')
    switch (method) {
      case 'DOM.enable':
        this.enabled = true
        return {}
      case 'DOM.disable':
        this.enabled = false
        this.resetDocument()
        return {}
      case 'DOM.getDocument': {
        const depth = depthParam(params.depth, DEFAULT_DOCUMENT_DEPTH)
        this.enabled = true
        this.nodesSent.clear()
        this.childrenSent.clear()
        return { root: this.serialize(this.backend.document().root, 0, depth, true) }
      }
      case 'DOM.requestChildNodes': {
        const node = this.fromNodeId(params.nodeId)
        const depth = depthParam(params.depth, 1)
        this.pushChildNodes(node, depth)
        return {}
      }
      case 'DOM.describeNode': {
        const node = this.selectNode(params)
        return { node: this.serialize(node, this.parentNodeId(node), depthParam(params.depth, 1), false) }
      }
      case 'DOM.getAttributes':
        return { attributes: this.fromNodeId(params.nodeId).attributes.flat() }
      case 'DOM.getOuterHTML':
        return { outerHTML: outerHtml(this.selectNode(params)) }
      case 'DOM.pushNodesByBackendIdsToFrontend': {
        if (!Array.isArray(params.backendNodeIds)) throw new Error('backendNodeIds must be an array')
        return {
          nodeIds: params.backendNodeIds.map((value) => {
            if (!Number.isSafeInteger(value) || (value as number) < 1) return 0
            const node = this.backend.document().byBackendId.get(cdpBackendNodeId(value, 'backendNodeId'))
            if (node === undefined) return 0
            this.pushNodePath(node)
            return this.nodeId(node)
          }),
        }
      }
      case 'DOM.resolveNode':
        return { object: await this.resolveNode(this.selectNode(params), optionalString(params.objectGroup)) }
      case 'DOM.requestNode': {
        const objectId = cdpStringId<'CdpRemoteObjectId'>(stringParam(params.objectId, 'objectId'), 'objectId')
        const binding = this.backendByObjectId.get(objectId)
        if (binding === undefined) throw new Error('RemoteObject is not a current Cordis node')
        const node = this.backend.document().byBackendId.get(binding.backendNodeId)
        if (node === undefined) throw new Error('Cordis node is no longer available')
        this.pushNodePath(node)
        return { nodeId: this.nodeId(node) }
      }
      case 'DOM.performSearch': {
        const query = stringParam(params.query, 'query').toLowerCase()
        const nodes = [...this.backend.document().byBackendId.values()]
          .filter(node => node.name !== '#document' && searchable(node).includes(query))
          .map(node => this.nodeId(node))
        const searchId = `cordis-search-${String(this.nextSearchId++)}`
        this.searches.set(searchId, nodes)
        return { searchId, resultCount: nodes.length }
      }
      case 'DOM.getSearchResults': {
        const ids = this.searches.get(stringParam(params.searchId, 'searchId')) ?? []
        const nodeIds = ids.slice(nonNegativeInteger(params.fromIndex, 'fromIndex'), nonNegativeInteger(params.toIndex, 'toIndex'))
        for (const nodeId of nodeIds) {
          const backendId = this.backendByNodeId.get(nodeId)
          const node = backendId === undefined ? undefined : this.backend.document().byBackendId.get(backendId)
          if (node !== undefined) this.pushNodePath(node)
        }
        return { nodeIds }
      }
      case 'DOM.discardSearchResults':
        this.searches.delete(stringParam(params.searchId, 'searchId'))
        return {}
      case 'DOM.setInspectedNode':
        this.fromNodeId(params.nodeId)
        return {}
      case 'DOM.getBoxModel':
      case 'DOM.getNodeForLocation':
        throw new Error('Cordis semantic nodes do not have browser layout geometry')
      default:
        throw new Error(`Method not found: ${method}`)
    }
  }

  private async resolveNode(node: CordisDomNode, objectGroup: string | undefined): Promise<Readonly<Record<string, unknown>>> {
    const route = node.object
    if (route === undefined) throw new Error('Structural Cordis node has no live Runtime object')
    if (route.connection.state === 'disconnected') throw new Error('Cordis realm is disconnected')
    const expression = realmObjectExpression({
      registryId: route.snapshot.objectRegistryId,
      handle: route.node.objectHandle,
    })
    const remote = await this.runtime.resolveObject(route.source, expression, objectGroup)
    const rawObjectId = remote.objectId
    if (typeof rawObjectId !== 'string') throw new Error('Cordis object lookup returned no RemoteObjectId')
    const objectId = cdpStringId<'CdpRemoteObjectId'>(rawObjectId, 'objectId')
    this.bindObjectId(objectId, node, objectGroup)
    return {
      ...remote,
      ...presentation(node),
    }
  }

  private bindObjectId(objectId: CdpRemoteObjectId, node: CordisDomNode, group: string | undefined): void {
    const source = node.object?.source
    if (source === undefined) throw new Error('Structural Cordis node cannot bind a Runtime object')
    this.backendByObjectId.set(objectId, {
      backendNodeId: node.backendNodeId,
      sourceId: source.sourceId,
      generation: source.generation,
    })
    if (group === undefined) return
    let ids = this.objectIdsByGroup.get(group)
    if (ids === undefined) this.objectIdsByGroup.set(group, ids = new Set())
    ids.add(objectId)
  }

  private selectNode(params: Readonly<Record<string, unknown>>): CordisDomNode {
    if (params.nodeId !== undefined) return this.fromNodeId(params.nodeId)
    if (params.backendNodeId !== undefined) {
      const id = cdpBackendNodeId(params.backendNodeId, 'backendNodeId')
      const node = this.backend.document().byBackendId.get(id)
      if (node !== undefined) return node
    }
    if (typeof params.objectId === 'string') {
      const binding = this.backendByObjectId.get(cdpStringId<'CdpRemoteObjectId'>(params.objectId, 'objectId'))
      const node = binding === undefined
        ? undefined
        : this.backend.document().byBackendId.get(binding.backendNodeId)
      if (node !== undefined) return node
    }
    throw new Error('Cordis node is not available')
  }

  private fromNodeId(value: unknown): CordisDomNode {
    const backendId = this.backendByNodeId.get(cdpNodeId(value, 'nodeId'))
    const node = backendId === undefined ? undefined : this.backend.document().byBackendId.get(backendId)
    if (node === undefined) throw new Error('Cordis NodeId is not available in this document')
    return node
  }

  private serialize(node: CordisDomNode, parentId: CdpNodeId | 0, remaining: number, delivery: boolean): object {
    const nodeId = this.nodeId(node)
    const document = node.name === '#document'
    const withChildren = remaining > 0
    // `DOM.describeNode` results are out-of-band descriptions the frontend does not merge into its tree,
    // so only delivery payloads record which nodes already carried their children.
    if (delivery) {
      this.nodesSent.add(node.backendNodeId)
      if (withChildren) this.childrenSent.add(node.backendNodeId)
    }
    return {
      nodeId,
      backendNodeId: node.backendNodeId,
      nodeType: document ? 9 : 1,
      nodeName: document ? '#document' : node.name.toUpperCase(),
      localName: document ? '' : node.name,
      nodeValue: '',
      ...(parentId === 0 ? {} : { parentId }),
      ...(document ? { documentURL: 'dsh://cordis', baseURL: 'dsh://cordis' } : {}),
      childNodeCount: node.children.length,
      ...(withChildren ? { children: node.children.map(child => this.serialize(child, nodeId, remaining - 1, delivery)) } : {}),
      attributes: node.attributes.flat(),
    }
  }

  /** Preserve frontend DOMNode identities by delivering each child list only once. */
  private pushChildNodes(node: CordisDomNode, depth: number): void {
    if (depth <= 0) return
    if (this.childrenSent.has(node.backendNodeId)) {
      for (const child of node.children) this.pushChildNodes(child, depth - 1)
      return
    }
    const parentId = this.nodeId(node)
    this.childrenSent.add(node.backendNodeId)
    this.transport.send({
      method: 'DOM.setChildNodes',
      params: { parentId, nodes: node.children.map(child => this.serialize(child, parentId, depth - 1, true)) },
    })
  }

  /** Deliver the not-yet-sent ancestor levels of one node so its NodeId attaches to the frontend tree. */
  private pushNodePath(node: CordisDomNode): void {
    const document = this.backend.document()
    const chain: CordisDomNode[] = []
    let backendId = document.parentByBackendId.get(node.backendNodeId)
    while (backendId !== undefined) {
      const parent = document.byBackendId.get(backendId)
      if (parent === undefined) break
      chain.unshift(parent)
      backendId = document.parentByBackendId.get(parent.backendNodeId)
    }
    for (const ancestor of chain) this.pushChildNodes(ancestor, 1)
  }

  private forgetSubtree(node: CordisDomNode): void {
    this.nodesSent.delete(node.backendNodeId)
    this.childrenSent.delete(node.backendNodeId)
    for (const child of node.children) this.forgetSubtree(child)
  }

  private nodeId(node: CordisDomNode): CdpNodeId {
    let nodeId = this.nodeIdByBackend.get(node.backendNodeId)
    if (nodeId === undefined) {
      nodeId = cdpNumericId<'CdpNodeId'>(this.nextNodeId++, 'nodeId')
      this.nodeIdByBackend.set(node.backendNodeId, nodeId)
      this.backendByNodeId.set(nodeId, node.backendNodeId)
    }
    return nodeId
  }

  private parentNodeId(node: CordisDomNode): CdpNodeId | 0 {
    const parent = this.backend.document().parentByBackendId.get(node.backendNodeId)
    if (parent === undefined) return 0
    const nodeValue = this.backend.document().byBackendId.get(parent)
    return nodeValue === undefined ? 0 : this.nodeId(nodeValue)
  }

  private resetDocument(): void {
    this.nodeIdByBackend.clear()
    this.backendByNodeId.clear()
    this.backendByObjectId.clear()
    this.objectIdsByGroup.clear()
    this.searches.clear()
    this.nodesSent.clear()
    this.childrenSent.clear()
  }

  private updateDocument(event: CordisDomChange): void {
    if (event.type === 'source-disconnected') {
      this.releaseSourceObjects(event.source)
      return
    }
    if (this.enabled) {
      const changedCounts = new Set<CdpBackendNodeId>()
      for (const mutation of event.mutations) {
        if ('parentBackendNodeId' in mutation && !this.childrenSent.has(mutation.parentBackendNodeId)) {
          changedCounts.add(mutation.parentBackendNodeId)
        } else {
          this.sendMutation(mutation)
        }
      }
      for (const backendNodeId of changedCounts) {
        const nodeId = this.sentNodeId(backendNodeId)
        const node = this.backend.document().byBackendId.get(backendNodeId)
        if (nodeId === undefined || node === undefined) continue
        this.transport.send({
          method: 'DOM.childNodeCountUpdated',
          params: { nodeId, childNodeCount: node.children.length },
        })
      }
    }
    this.pruneDocumentState()
  }

  private sentNodeId(backendNodeId: CdpBackendNodeId): CdpNodeId | undefined {
    return this.nodesSent.has(backendNodeId) ? this.nodeIdByBackend.get(backendNodeId) : undefined
  }

  private sendMutation(mutation: CordisDomMutation): void {
    switch (mutation.type) {
      case 'document-updated':
        this.resetDocument()
        this.transport.send({ method: 'DOM.documentUpdated', params: {} })
        return
      case 'child-inserted': {
        const parentNodeId = this.sentNodeId(mutation.parentBackendNodeId)
        if (parentNodeId === undefined) return
        const previousNodeId = mutation.previousBackendNodeId === 0
          ? 0
          : this.sentNodeId(mutation.previousBackendNodeId)
        if (previousNodeId === undefined) return
        // A reconnected source reuses backend ids; the collapsed payload resets any earlier delivery record.
        this.forgetSubtree(mutation.node)
        this.transport.send({
          method: 'DOM.childNodeInserted',
          params: {
            parentNodeId,
            previousNodeId,
            node: this.serialize(mutation.node, parentNodeId, 0, true),
          },
        })
        return
      }
      case 'child-removed': {
        const parentNodeId = this.sentNodeId(mutation.parentBackendNodeId)
        const nodeId = this.sentNodeId(mutation.node.backendNodeId)
        this.forgetSubtree(mutation.node)
        if (parentNodeId === undefined || nodeId === undefined) return
        this.transport.send({ method: 'DOM.childNodeRemoved', params: { parentNodeId, nodeId } })
        return
      }
      case 'children-replaced': {
        const parentNodeId = this.sentNodeId(mutation.parentBackendNodeId)
        if (parentNodeId === undefined) return
        // Replacement payloads carry no grandchildren, so the frontend forgets any it knew below this parent.
        for (const child of mutation.children) this.forgetSubtree(child)
        this.childrenSent.add(mutation.parentBackendNodeId)
        this.transport.send({
          method: 'DOM.setChildNodes',
          params: {
            parentId: parentNodeId,
            nodes: mutation.children.map(child => this.serialize(child, parentNodeId, 0, true)),
          },
        })
        return
      }
      case 'attribute-modified': {
        const nodeId = this.sentNodeId(mutation.backendNodeId)
        if (nodeId !== undefined) {
          this.transport.send({
            method: 'DOM.attributeModified',
            params: { nodeId, name: mutation.name, value: mutation.value },
          })
        }
        return
      }
      case 'attribute-removed': {
        const nodeId = this.sentNodeId(mutation.backendNodeId)
        if (nodeId !== undefined) {
          this.transport.send({ method: 'DOM.attributeRemoved', params: { nodeId, name: mutation.name } })
        }
        return
      }
      default:
        return assertNever(mutation)
    }
  }

  private pruneDocumentState(): void {
    const document = this.backend.document()
    for (const [backendNodeId, nodeId] of this.nodeIdByBackend) {
      if (document.byBackendId.has(backendNodeId)) continue
      this.nodeIdByBackend.delete(backendNodeId)
      this.backendByNodeId.delete(nodeId)
      this.nodesSent.delete(backendNodeId)
    }
    for (const backendNodeId of this.childrenSent) {
      if (!document.byBackendId.has(backendNodeId)) this.childrenSent.delete(backendNodeId)
    }
    for (const [objectId, binding] of this.backendByObjectId) {
      const node = document.byBackendId.get(binding.backendNodeId)
      const source = node?.object?.source
      if (source?.sourceId === binding.sourceId && source.generation === binding.generation) continue
      this.backendByObjectId.delete(objectId)
      for (const [group, objectIds] of this.objectIdsByGroup) {
        objectIds.delete(objectId)
        if (objectIds.size === 0) this.objectIdsByGroup.delete(group)
      }
    }
    for (const [searchId, nodeIds] of this.searches) {
      this.searches.set(searchId, nodeIds.filter((nodeId) => {
        const backendNodeId = this.backendByNodeId.get(nodeId)
        return backendNodeId !== undefined && document.byBackendId.has(backendNodeId)
      }))
    }
  }

  private releaseSourceObjects(source: InspectorSourceDescriptor): void {
    for (const [objectId, binding] of this.backendByObjectId) {
      if (binding.sourceId !== source.sourceId || binding.generation !== source.generation) continue
      this.backendByObjectId.delete(objectId)
      for (const [group, objectIds] of this.objectIdsByGroup) {
        objectIds.delete(objectId)
        if (objectIds.size === 0) this.objectIdsByGroup.delete(group)
      }
    }
  }

  private respond(request: CdpRequest, operation: () => Promise<object>): void {
    respondToCdpRequest(this.transport, request, operation)
  }
}

function outerHtml(node: CordisDomNode, indent = ''): string {
  const attributes = node.attributes.map(([name, value]) => ` ${name}=${JSON.stringify(value)}`).join('')
  if (node.children.length === 0) return `${indent}<${node.name}${attributes} />`
  const children = node.children.map(child => outerHtml(child, `${indent}  `)).join('\n')
  return `${indent}<${node.name}${attributes}>\n${children}\n${indent}</${node.name}>`
}

function searchable(node: CordisDomNode): string {
  return `${node.name} ${node.description} ${node.attributes.flat().join(' ')}`.toLowerCase()
}

function numberParam(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`)
  return value as number
}

function depthParam(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (value === -1) return Number.POSITIVE_INFINITY
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('depth must be -1 or a positive integer')
  return value as number
}

function cdpNodeId(value: unknown, name: string): CdpNodeId {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`)
  return cdpNumericId<'CdpNodeId'>(value as number, name)
}

function cdpBackendNodeId(value: unknown, name: string): CdpBackendNodeId {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`)
  return cdpNumericId<'CdpBackendNodeId'>(value as number, name)
}

function nonNegativeInteger(value: unknown, name: string): number {
  return numberParam(value, name)
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return stringParam(value, 'objectGroup')
}

function presentation(node: CordisDomNode): RuntimeObjectPresentation {
  return {
    subtype: 'node',
    className: node.object?.node.kind === 'fiber' ? 'Fiber' : 'Context',
    description: node.description,
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Cordis DOM mutation: ${JSON.stringify(value)}`)
}
