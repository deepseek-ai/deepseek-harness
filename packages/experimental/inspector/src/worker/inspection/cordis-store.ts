/** Worker-owned repository of CDP-independent Cordis tree snapshots. */

import {
  parseCordisTreeSnapshot,
  type CordisTreeNode,
  type CordisTreeSnapshot,
} from '../../shared/cordis/snapshot.ts'
import { CORDIS_TREE_TOPIC } from '../../shared/bridge/messages/cordis.ts'
import type { InspectorSourceDescriptor } from '../../shared/bridge/messages/observation.ts'
import type { InspectorSourceGeneration, InspectorSourceId } from '../../shared/bridge/ids.ts'
import type { InspectorObjectReference } from '../../shared/cordis/object-reference.ts'
import {
  projectCordisRuntimeTree,
  type CordisInspectionTree as SharedCordisInspectionTree,
  type CordisTreeSourceSnapshot as SharedCordisTreeSourceSnapshot,
} from '../../shared/cordis/projector.ts'
import type { CordisRuntimeTree } from '../../shared/cordis/model.ts'
import type { IngestedInspectorRecord, InspectorRecordConsumer } from '../bridge/hub.ts'

/** Routed Worker snapshot retaining its complete source-generation descriptor. */
export type CordisTreeSourceSnapshot = SharedCordisTreeSourceSnapshot<InspectorSourceDescriptor>

/** Routed Host and Client snapshots retained by the Worker. */
export type CordisInspectionTree = SharedCordisInspectionTree<InspectorSourceDescriptor>

export type { CordisTreeSourceConnection } from '../../shared/cordis/projector.ts'

/** One object-backed tree node with its owning source generation. */
export interface CordisTreeObjectRoute extends CordisTreeSourceSnapshot {
  readonly node: CordisTreeNode
}

/** Store mutation consumed by presentation adapters. */
export type CordisTreeStoreEvent =
  | { readonly type: 'snapshot-changed'; readonly source: InspectorSourceDescriptor }
  | { readonly type: 'source-disconnected'; readonly source: InspectorSourceDescriptor }

/** Independent bounds for live tree size and retained disconnected snapshots. */
export interface CordisTreeStoreOptions {
  readonly maxNodes: number
  readonly maxDisconnectedTrees: number
}

interface StoredTree extends CordisTreeSourceSnapshot {
  readonly nodesByObject: ReadonlyMap<string, CordisTreeNode>
}

/** Validated latest-value store consumed independently by CDP and future query adapters. */
export class CordisTreeStore implements InspectorRecordConsumer {
  readonly topics = new Set([CORDIS_TREE_TOPIC])
  private readonly trees = new Map<string, StoredTree>()
  private readonly disconnected = new Set<string>()
  private readonly listeners = new Set<(event: CordisTreeStoreEvent) => void>()

  constructor(private readonly options: CordisTreeStoreOptions) {}

  /** Replace all retained state for one source generation. */
  replace(source: InspectorSourceDescriptor, records: readonly IngestedInspectorRecord[]): void {
    const next = this.latest(source, records)
    const changed = next === undefined
      ? this.remove(source.sourceId)
      : this.install(source, next)
    if (changed) this.emit({ type: 'snapshot-changed', source })
  }

  /** Apply later state replacements, ignoring unrelated observation topics. */
  append(source: InspectorSourceDescriptor, records: readonly IngestedInspectorRecord[]): void {
    const next = this.latest(source, records)
    if (next !== undefined && this.install(source, next)) this.emit({ type: 'snapshot-changed', source })
  }

  /** Freeze a closed source generation's last tree and invalidate its object routes. */
  close(source: InspectorSourceDescriptor, reason: string): void {
    const current = this.trees.get(source.sourceId)
    if (current?.source.generation !== source.generation || current.connection.state === 'disconnected') return
    this.trees.set(source.sourceId, {
      ...current,
      connection: { state: 'disconnected', reason },
    })
    this.disconnected.delete(source.sourceId)
    this.disconnected.add(source.sourceId)
    while (this.disconnected.size > this.options.maxDisconnectedTrees) {
      const oldest = this.disconnected.values().next().value
      if (oldest === undefined) break
      this.remove(oldest)
    }
    this.emit({ type: 'source-disconnected', source })
  }

  /**
   * Read all current realm snapshots without CDP identifiers.
   * @returns Snapshots in source admission order.
   */
  snapshots(): CordisTreeSourceSnapshot[] {
    return [...this.trees.values()].map(({ source, snapshot, connection }) => ({ source, snapshot, connection }))
  }

  /**
   * Compose the common realm model into Host and Client slots.
   * @returns A detached view whose Host and Client entries share one type.
   */
  tree(): CordisInspectionTree {
    const snapshots = this.snapshots()
    return {
      host: snapshots.find(tree => tree.source.kind === 'host') ?? null,
      clients: snapshots.filter(tree => tree.source.kind === 'client'),
    }
  }

  /**
   * Read a detached semantic tree without object-routing or CDP identifiers.
   * @returns The latest retained Host and Client topology.
   */
  readTree(): CordisRuntimeTree {
    return projectCordisRuntimeTree(this.tree())
  }

  /**
   * Resolve a source-local object reference to its semantic tree node.
   * @param source - Active source generation.
   * @param reference - Realm-local registry and object handle.
   * @returns The matching node while its source remains connected.
   */
  resolveObject(source: InspectorSourceDescriptor, reference: InspectorObjectReference): CordisTreeObjectRoute | undefined {
    const tree = this.trees.get(source.sourceId)
    if (tree === undefined
      || tree.source.generation !== source.generation
      || tree.connection.state === 'disconnected') return undefined
    const node = tree.nodesByObject.get(objectKey(reference))
    return node === undefined ? undefined : this.route(tree, node)
  }

  /**
   * Resolve a source-local object without requiring the source's presentation fields.
   * @param sourceId - Logical source identity.
   * @param generation - Active source generation.
   * @param reference - Realm-local object reference.
   * @returns The matching live tree node.
   */
  resolveObjectIdentity(
    sourceId: InspectorSourceId,
    generation: InspectorSourceGeneration,
    reference: InspectorObjectReference,
  ): CordisTreeObjectRoute | undefined {
    const tree = this.trees.get(sourceId)
    if (tree === undefined || tree.source.generation !== generation || tree.connection.state === 'disconnected') {
      return undefined
    }
    const node = tree.nodesByObject.get(objectKey(reference))
    return node === undefined ? undefined : this.route(tree, node)
  }

  /**
   * Resolve a live reference when only its source realm kind is known.
   * @param kind - Host or Client ownership inferred by the Runtime adapter.
   * @param reference - Realm-local registry and object handle.
   * @returns The matching connected node, when present.
   */
  resolveObjectInKind(kind: InspectorSourceDescriptor['kind'], reference: InspectorObjectReference): CordisTreeObjectRoute | undefined {
    for (const tree of this.trees.values()) {
      if (tree.source.kind !== kind || tree.connection.state === 'disconnected') continue
      const node = tree.nodesByObject.get(objectKey(reference))
      if (node !== undefined) return this.route(tree, node)
    }
    return undefined
  }

  /**
   * Subscribe to accepted tree replacements and source availability changes.
   * @param listener - Repository observer.
   * @returns A disposer removing the observer.
   */
  subscribe(listener: (event: CordisTreeStoreEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private latest(
    source: InspectorSourceDescriptor,
    records: readonly IngestedInspectorRecord[],
  ): CordisTreeSnapshot | undefined {
    let snapshot: CordisTreeSnapshot | undefined
    for (const record of records) {
      if (record.topic !== CORDIS_TREE_TOPIC) continue
      const candidate = parseCordisTreeSnapshot(record.payload, this.options.maxNodes)
      if (snapshot === undefined || candidate.revision > snapshot.revision) snapshot = candidate
    }
    if (snapshot === undefined) return undefined
    const current = this.trees.get(source.sourceId)
    if (current?.source.generation === source.generation && current.snapshot.revision >= snapshot.revision) {
      return current.snapshot
    }
    return snapshot
  }

  private install(source: InspectorSourceDescriptor, snapshot: CordisTreeSnapshot): boolean {
    const current = this.trees.get(source.sourceId)
    if (current?.source.generation === source.generation
      && current.snapshot === snapshot
      && current.connection.state === 'connected') return false
    this.disconnected.delete(source.sourceId)
    this.trees.set(source.sourceId, {
      source,
      snapshot,
      connection: { state: 'connected' },
      nodesByObject: new Map(treeNodes(snapshot.root).map(node => [objectKey({
        registryId: snapshot.objectRegistryId,
        handle: node.objectHandle,
      }), node])),
    })
    return true
  }

  private remove(sourceId: string): boolean {
    this.disconnected.delete(sourceId)
    return this.trees.delete(sourceId)
  }

  private route(tree: StoredTree, node: CordisTreeNode): CordisTreeObjectRoute {
    return { source: tree.source, snapshot: tree.snapshot, connection: tree.connection, node }
  }

  private emit(event: CordisTreeStoreEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (_listenerFailed) {
        // One query adapter cannot prevent later repository observers from updating.
      }
    }
  }
}

function objectKey(reference: InspectorObjectReference): string {
  return `${reference.registryId}\0${reference.handle}`
}

function treeNodes(root: CordisTreeNode): CordisTreeNode[] {
  const nodes: CordisTreeNode[] = []
  const pending: CordisTreeNode[] = [root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === undefined) break
    nodes.push(node)
    pending.push(...node.children.toReversed())
  }
  return nodes
}
