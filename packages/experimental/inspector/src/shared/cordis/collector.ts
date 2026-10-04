/** Shared Host/Client projection from live Cordis objects to a bounded semantic tree. */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import { jsonByteLength, type InspectorJsonValue } from '../json.ts'
import {
  CORDIS_TREE_SCHEMA_VERSION,
  type CordisContextTreeNode,
  type CordisFiberTreeNode,
  type CordisTreeSnapshot,
} from './snapshot.ts'
import type { InspectorObjectHandle } from './ids.ts'
import { RealmObjectRegistry } from './object-registry.ts'

const SHADOW = Symbol.for('cordis.shadow')

/** Bounds applied before one snapshot enters a source frame. */
export interface CordisTreeLimits {
  readonly maxNodes: number
  readonly maxBytes: number
}

interface ContextInfo {
  readonly value: Context
  readonly children: ContextInfo[]
  readonly fiber: Fiber | undefined
}

interface MutableContextNode extends Omit<CordisContextTreeNode, 'children'> {
  readonly children: MutableTreeNode[]
}

interface MutableFiberNode extends Omit<CordisFiberTreeNode, 'children'> {
  readonly children: [MutableContextNode]
}

type MutableTreeNode = MutableContextNode | MutableFiberNode

/** Realm-local collector retaining Contexts without Cordis service-call shadow wrappers. */
export class CordisTreeCollector {
  /** Live-object table replaced atomically with each emitted snapshot. */
  readonly objects = new RealmObjectRegistry()
  private revision = 0

  constructor(private readonly root: Context, private readonly limits: CordisTreeLimits) {}

  /**
   * Capture the current reachable Context/Fiber tree.
   * @returns A detached JSON snapshot whose retained objects replace the prior generation atomically.
   */
  snapshot(): CordisTreeSnapshot {
    const collected = collectContexts(this.root)
    const tree = collected.root
    const objects = this.objects.begin()
    let nodeCount = 0
    let truncated = collected.truncated

    const contextNode = (info: ContextInfo): MutableContextNode | undefined => {
      if (nodeCount >= this.limits.maxNodes) {
        truncated = true
        return undefined
      }
      nodeCount++
      const node: MutableContextNode = {
        kind: 'context',
        objectHandle: objects.retain(info.value).handle,
        children: [],
      }
      for (const child of info.children) {
        if (child.fiber !== undefined && unwrapContext(child.fiber.ctx) === child.value) {
          const projected = fiberNode(child.fiber, child)
          if (projected !== undefined) node.children.push(projected)
        } else {
          const projected = contextNode(child)
          if (projected !== undefined) node.children.push(projected)
        }
      }
      return node
    }
    const fiberNode = (fiber: Fiber, owned: ContextInfo): MutableFiberNode | undefined => {
      if (fiber.uid === null) return undefined
      if (nodeCount + 2 > this.limits.maxNodes) {
        truncated = true
        return undefined
      }
      nodeCount++
      const context = contextNode(owned) as MutableContextNode
      return {
        kind: 'fiber',
        objectHandle: objects.retain(fiber).handle,
        uid: fiber.uid,
        children: [context],
      }
    }

    const root = contextNode(tree)
    if (root === undefined) throw new Error('inspector: maxNodes cannot retain the root Context')
    let snapshot: CordisTreeSnapshot = {
      schemaVersion: CORDIS_TREE_SCHEMA_VERSION,
      revision: ++this.revision,
      objectRegistryId: this.objects.id,
      root,
      truncated,
    }
    while (jsonByteLength(snapshot as unknown as InspectorJsonValue) > this.limits.maxBytes) {
      const removed = pruneLast(root)
      if (removed.length === 0) break
      for (const handle of removed) objects.release(handle)
      snapshot = { ...snapshot, truncated: true }
    }
    if (jsonByteLength(snapshot as unknown as InspectorJsonValue) > this.limits.maxBytes) {
      throw new Error('inspector: Cordis root exceeds the source-frame byte limit')
    }
    objects.commit()
    return snapshot
  }

  /** Release the realm-global resolver and every retained object. */
  close(): void {
    this.objects.close()
  }
}

function collectContexts(root: Context): { readonly root: ContextInfo; readonly truncated: boolean } {
  const contexts = new Map<Context, ContextInfo>()
  let truncated = false
  const ensure = (candidate: unknown, depth = 0): ContextInfo | undefined => {
    if (depth > 100) {
      truncated = true
      return undefined
    }
    const value = unwrapContext(candidate)
    if (!Context.is(value)) return undefined
    const existing = contexts.get(value)
    if (existing !== undefined) return existing
    if (value === root) {
      const info = describeContext(value)
      contexts.set(value, info)
      return info
    }
    const prototype = unwrapContext(Object.getPrototypeOf(value) as unknown)
    const parent = ensure(prototype, depth + 1)
    if (parent === undefined) return undefined
    const info = describeContext(value)
    contexts.set(value, info)
    parent.children.push(info)
    return info
  }

  const rootInfo = ensure(root) as ContextInfo
  for (const runtime of root.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.uid === null) continue
      ensure(fiber.parent)
      ensure(fiber.ctx)
    }
  }
  for (const key of Reflect.ownKeys(root.events._hooks)) {
    for (const hook of root.events._hooks[key] ?? []) ensure(hook.ctx)
  }
  const order = (info: ContextInfo): number => info.fiber?.uid ?? Number.MAX_SAFE_INTEGER
  for (const info of contexts.values()) {
    info.children.sort((left, right) => order(left) - order(right))
  }
  return { root: rootInfo, truncated }
}

function describeContext(value: Context): ContextInfo {
  const fiber = ownValue(value, 'fiber') as Fiber | undefined
  return { value, children: [], fiber }
}

function ownValue(value: object, key: PropertyKey): unknown {
  return Reflect.getOwnPropertyDescriptor(value, key)?.value
}

function unwrapContext(value: unknown): unknown {
  let current = value
  while (typeof current === 'object' && current !== null && Object.hasOwn(current, SHADOW)) {
    current = Object.getPrototypeOf(current)
  }
  return current
}

function pruneLast(context: MutableContextNode): InspectorObjectHandle[] {
  const child = context.children.at(-1)
  if (child === undefined) return []
  if (child.kind === 'context') {
    const nested = pruneLast(child)
    if (nested.length > 0) return nested
    context.children.pop()
    return [child.objectHandle]
  }
  const owned = child.children[0]
  const nested = pruneLast(owned)
  if (nested.length > 0) return nested
  context.children.pop()
  return [child.objectHandle, owned.objectHandle]
}
