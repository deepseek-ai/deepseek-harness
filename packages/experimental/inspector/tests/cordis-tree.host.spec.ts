/** Host-driven Cordis tree integration. */

import { Context } from '@deepseek-ai/cordis'
import WebSocket, { type RawData } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CordisTreeCollector } from '../src/shared/cordis/collector.ts'
import { observeCordisTree } from '../src/shared/cordis/observer.ts'
import { startInspector, type InspectorHandle } from '../src/host/bridge/controller.ts'
import { publishCordisTree as publishHostCordisTree } from '../src/host/inspection/cordis.ts'
import { parseCordisTreeSnapshot, type CordisTreeNode } from '../src/shared/cordis/snapshot.ts'
import { inspectorId } from '../src/shared/bridge/ids.ts'
import type { InspectorJsonValue } from '../src/shared/json.ts'
import { jsonByteLength } from '../src/shared/json.ts'
import type { InspectorSourceDescriptor } from '../src/shared/bridge/messages/observation.ts'
import { CordisTreeStore } from '../src/worker/inspection/cordis-store.ts'
import { CordisDomBackend, type CordisDomChange } from '../src/worker/cdp/domains/dom/model.ts'
import { InspectorClientFixture } from './fixtures/client-source.host.ts'

interface CdpMessage {
  readonly id?: number
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: Record<string, unknown>
  readonly error?: { message: string }
}

interface CdpNode {
  readonly nodeId: number
  readonly backendNodeId: number
  readonly localName: string
  readonly attributes?: string[]
  readonly childNodeCount?: number
  readonly children?: CdpNode[]
}

class CdpClient {
  private nextId = 0
  private readonly pending = new Map<number, (message: CdpMessage) => void>()
  readonly events: CdpMessage[] = []

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(rawText(data)) as CdpMessage
      if (message.id !== undefined) this.pending.get(message.id)?.(message)
      else this.events.push(message)
    })
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', reject)
    })
    return new CdpClient(socket)
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`CDP call timed out: ${method}`)) }, 5_000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(message)
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    const closed = new Promise<void>((resolve) => { this.socket.once('close', () => { resolve() }) })
    this.socket.close()
    await closed
  }
}

describe('Cordis tree inspection', () => {
  let inspector: InspectorHandle | undefined
  let cdp: CdpClient | undefined
  let secondCdp: CdpClient | undefined
  let clientSource: InspectorClientFixture | undefined
  const observers: Array<() => void> = []
  const fibers: Array<{ dispose(): Promise<void> }> = []

  afterEach(async () => {
    for (const dispose of observers.splice(0).reverse()) dispose()
    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
    await clientSource?.close()
    clientSource = undefined
    await cdp?.close()
    cdp = undefined
    await secondCdp?.close()
    secondCdp = undefined
    await inspector?.close()
    inspector = undefined
    Reflect.deleteProperty(globalThis, '__cordisHostProbe')
  })

  it('preserves separate Fiber and Context identities in one shared snapshot model', async () => {
    const root = new Context()
    const parent = root.isolate('probe')
    const fiber = parent.plugin({ name: 'child', apply() {} })
    await fiber.await()
    const collector = new CordisTreeCollector(root, { maxNodes: 100, maxBytes: 64 * 1_024 })

    const snapshot = collector.snapshot()
    expect(parseCordisTreeSnapshot(snapshot, 100)).toEqual(snapshot)
    const nodes = treeNodes(snapshot.root)
    const fiberNode = nodes.find(node => node.kind === 'fiber' && node.uid === fiber.uid)
    if (fiberNode === undefined) throw new Error('expected child Fiber node')
    expect(nodes.every(node => !('id' in node) && !('parentId' in node))).toBe(true)
    expect(() => parseCordisTreeSnapshot({
      ...snapshot,
      root: { ...snapshot.root, children: [{ ...fiberNode, children: [] }] },
    }, 100)).toThrow('exactly one Context')
    const contextNode = fiberNode.children[0]
    const isolateNode = nodes.find(node => node.kind === 'context'
      && collector.objects.resolve(node.objectHandle) === parent)

    expect(snapshot.root.kind).toBe('context')
    expect(nodes.some(node => node.kind === 'fiber' && node.uid === 0)).toBe(false)
    expect(isolateNode?.children).toContain(fiberNode)
    const retainedFiber = collector.objects.resolve(fiberNode.objectHandle)
    expect(Reflect.get(retainedFiber ?? {}, 'uid')).toBe(fiber.uid)
    expect(Reflect.get(retainedFiber ?? {}, 'ctx') === fiber.ctx).toBe(true)
    expect(collector.objects.resolve(contextNode.objectHandle) === fiber.ctx).toBe(true)
    const identifiedFiber = collector.objects.identify(fiber)
    expect(identifiedFiber).toEqual({
      registryId: snapshot.objectRegistryId,
      handle: fiberNode.objectHandle,
    })
    expect(collector.objects.identify(Object.create(parent) as object)).toBeUndefined()

    collector.close()
    await fiber.dispose()
  })

  it('marks snapshots truncated when a Context ancestry exceeds the traversal limit', async () => {
    const root = new Context()
    let context = root
    for (let depth = 0; depth < 102; depth++) context = context.isolate(`depth-${String(depth)}`)
    const fiber = context.plugin({ name: 'deep-child', apply() {} })
    await fiber.await()
    const collector = new CordisTreeCollector(root, { maxNodes: 1_000, maxBytes: 1024 * 1024 })

    expect(collector.snapshot().truncated).toBe(true)

    collector.close()
    await fiber.dispose()
  })

  it('bounds snapshots by node count and encoded byte size', async () => {
    const root = new Context()
    const parent = root.isolate('parent')
    const child = parent.isolate('child')
    const fiber = child.plugin({ name: 'bounded-child', apply() {} })
    await fiber.await()
    const completeCollector = new CordisTreeCollector(root, { maxNodes: 100, maxBytes: 64 * 1_024 })
    const complete = completeCollector.snapshot()
    const rootOnlyBytes = jsonByteLength({
      ...complete,
      objectRegistryId: 'x'.repeat(complete.objectRegistryId.length),
      root: { ...complete.root, children: [] },
      truncated: true,
    })
    completeCollector.close()

    const nodeBound = new CordisTreeCollector(root, { maxNodes: 1, maxBytes: 64 * 1_024 })
    expect(nodeBound.snapshot()).toMatchObject({ truncated: true, root: { children: [] } })
    nodeBound.close()

    const directRoot = new Context()
    const directFiber = directRoot.plugin({ name: 'direct-child', apply() {} })
    await directFiber.await()
    const fiberBound = new CordisTreeCollector(directRoot, { maxNodes: 2, maxBytes: 64 * 1_024 })
    expect(fiberBound.snapshot()).toMatchObject({ truncated: true, root: { children: [] } })
    fiberBound.close()

    const byteBound = new CordisTreeCollector(root, { maxNodes: 100, maxBytes: rootOnlyBytes })
    expect(byteBound.snapshot()).toMatchObject({ truncated: true, root: { children: [] } })
    byteBound.close()

    const nestedRoot = new Context()
    const outerFiber = nestedRoot.plugin({ name: 'outer', apply() {} })
    await outerFiber.await()
    const innerFiber = outerFiber.ctx.isolate('nested').plugin({ name: 'inner', apply() {} })
    await innerFiber.await()
    const nestedComplete = new CordisTreeCollector(nestedRoot, { maxNodes: 100, maxBytes: 64 * 1_024 })
    const nestedBytes = jsonByteLength(nestedComplete.snapshot() as unknown as InspectorJsonValue)
    nestedComplete.close()
    const nestedBound = new CordisTreeCollector(nestedRoot, { maxNodes: 100, maxBytes: nestedBytes - 1 })
    const nestedSnapshot = nestedBound.snapshot()
    expect(nestedSnapshot.truncated).toBe(true)
    expect(treeNodes(nestedSnapshot.root)
      .some(node => node.kind === 'fiber' && node.uid === innerFiber.uid)).toBe(false)
    nestedBound.close()

    const impossible = new CordisTreeCollector(root, { maxNodes: 0, maxBytes: 1 })
    expect(() => impossible.snapshot()).toThrow('maxNodes cannot retain the root Context')
    impossible.close()

    const rootTooLarge = new CordisTreeCollector(new Context(), { maxNodes: 2, maxBytes: 1 })
    expect(() => rootTooLarge.snapshot()).toThrow('Cordis root exceeds the source-frame byte limit')
    rootTooLarge.close()
    await innerFiber.dispose()
    await outerFiber.dispose()
    await directFiber.dispose()
    await fiber.dispose()
  })

  it('coalesces Cordis notifications and ignores a queued publication after disposal', async () => {
    const root = new Context()
    const listener = vi.fn()
    const dispose = observeCordisTree(root, listener, { maxNodes: 100, maxBytes: 64 * 1_024 })
    expect(listener).toHaveBeenCalledTimes(1)

    root.emit('internal/plugin', root.fiber)
    root.emit('internal/plugin', root.fiber)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(2)

    root.emit('internal/plugin', root.fiber)
    dispose()
    dispose()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('ignores disposed Fibers and non-Context listener owners while unwrapping Cordis shadows', async () => {
    const root = new Context()
    const fiber = root.plugin({ name: 'temporarily-disposed', apply() {} })
    await fiber.await()
    const runtimeFiber = fiber.ctx.fiber
    const uidDescriptor = Object.getOwnPropertyDescriptor(runtimeFiber, 'uid')
    Object.defineProperty(runtimeFiber, 'uid', { ...uidDescriptor, value: null })
    const hooks = root.events._hooks as unknown as Record<PropertyKey, Array<{ ctx: unknown }> | undefined>
    const probe = Symbol('inspector-collector-probe')
    const empty = Symbol('inspector-collector-empty')
    const shadow = Object.create(root) as object
    Object.defineProperty(shadow, Symbol.for('cordis.shadow'), { value: true })
    hooks[probe] = [{ ctx: {} }, { ctx: shadow }, { ctx: runtimeFiber.ctx }]
    hooks[empty] = undefined
    const collector = new CordisTreeCollector(root, { maxNodes: 100, maxBytes: 64 * 1_024 })
    try {
      expect(collector.snapshot().root.kind).toBe('context')
    } finally {
      collector.close()
      Reflect.deleteProperty(hooks, probe)
      Reflect.deleteProperty(hooks, empty)
      if (uidDescriptor !== undefined) Object.defineProperty(runtimeFiber, 'uid', uidDescriptor)
      await fiber.dispose()
    }
  })

  it('freezes a disconnected snapshot and replaces it with the reconnect generation', () => {
    const root = new Context()
    const collector = new CordisTreeCollector(root, { maxNodes: 100, maxBytes: 64 * 1_024 })
    const snapshot = collector.snapshot()
    const store = new CordisTreeStore({ maxNodes: 100, maxDisconnectedTrees: 1 })
    const first = source('client-a', 'generation-1')
    store.replace(first, [{ sequence: 1, monotonicMs: 1, topic: 'cordis/tree', payload: asJson(snapshot) }])

    const object = snapshot.root
    expect(store.resolveObject(first, {
      registryId: snapshot.objectRegistryId,
      handle: object.objectHandle,
    })).toBeDefined()
    store.close(first, 'transport closed')
    expect(store.snapshots()[0]?.connection).toEqual({ state: 'disconnected', reason: 'transport closed' })
    expect(store.resolveObject(first, {
      registryId: snapshot.objectRegistryId,
      handle: object.objectHandle,
    })).toBeUndefined()

    const reconnected = source('client-a', 'generation-2')
    store.replace(reconnected, [{
      sequence: 1,
      monotonicMs: 2,
      topic: 'cordis/tree',
      payload: asJson({ ...snapshot, revision: snapshot.revision + 1 }),
    }])
    expect(store.snapshots()).toEqual([
      expect.objectContaining({ source: reconnected, connection: { state: 'connected' } }),
    ])

    store.close(reconnected, 'transport closed again')
    const other = source('client-b', 'generation-1')
    store.replace(other, [{ sequence: 1, monotonicMs: 3, topic: 'cordis/tree', payload: asJson(snapshot) }])
    store.close(other, 'other transport closed')
    const retained = store.snapshots()
    expect(retained).toHaveLength(1)
    expect(retained[0]?.source).toEqual(other)
    expect(retained[0]?.connection.state).toBe('disconnected')
    collector.close()
  })

  it('diffs snapshots into local DOM mutations and suppresses revision-only updates', () => {
    const store = new CordisTreeStore({ maxNodes: 100, maxDisconnectedTrees: 1 })
    const backend = new CordisDomBackend(store)
    const changes: CordisDomChange[] = []
    backend.subscribe((event) => { changes.push(event) })
    const host = { ...source('host', 'generation-1'), kind: 'host' as const }
    const context = (objectHandle: string, children: unknown[] = []): Record<string, unknown> => ({
      kind: 'context',
      objectHandle,
      children,
    })
    const fiber = (uid: number, objectHandle: string): Record<string, unknown> => ({
      kind: 'fiber',
      uid,
      objectHandle,
      children: [context(`${objectHandle}-context`)],
    })
    const snapshot = (revision: number, children: unknown[]): InspectorJsonValue => ({
      schemaVersion: 0,
      revision,
      objectRegistryId: 'registry',
      root: context('root', children),
      truncated: false,
    }) as InspectorJsonValue
    const replace = (revision: number, children: unknown[]): void => {
      store.append(host, [{ sequence: revision, monotonicMs: revision, topic: 'cordis/tree', payload: snapshot(revision, children) }])
    }

    replace(1, [fiber(1, 'fiber-1')])
    expect(changes.at(-1)).toMatchObject({ type: 'tree-mutated', mutations: [{ type: 'child-inserted' }] })
    changes.length = 0
    replace(2, [fiber(1, 'fiber-1')])
    expect(changes).toEqual([])

    replace(3, [fiber(2, 'fiber-1')])
    expect(changes).toEqual([
      expect.objectContaining({ type: 'tree-mutated', mutations: [expect.objectContaining({ type: 'attribute-modified', name: 'uid', value: '2' })] }),
    ])
    changes.length = 0

    replace(4, [fiber(2, 'fiber-1'), context('context-2')])
    expect(changes).toEqual([
      expect.objectContaining({ type: 'tree-mutated', mutations: [expect.objectContaining({ type: 'child-inserted' })] }),
    ])
    changes.length = 0
    replace(5, [fiber(2, 'fiber-1')])
    expect(changes).toEqual([
      expect.objectContaining({ type: 'tree-mutated', mutations: [expect.objectContaining({ type: 'child-removed' })] }),
    ])

    changes.length = 0
    replace(6, [context('context-a'), context('context-b')])
    changes.length = 0
    replace(7, [context('context-b'), context('context-a')])
    expect(changes).toEqual([
      expect.objectContaining({ type: 'tree-mutated', mutations: [expect.objectContaining({ type: 'children-replaced' })] }),
    ])

    changes.length = 0
    replace(8, [{ kind: 'fiber', uid: 3, objectHandle: 'context-a', children: [context('changed-kind')] }])
    expect(changes).toEqual([
      expect.objectContaining({ type: 'tree-mutated', mutations: [{ type: 'document-updated' }] }),
    ])
    backend.close()
  })

  it('projects Host and Client trees and resolves both node kinds to RemoteObjects', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false, maxCordisNodes: 100 })
    const host = new Context()
    const hostFiber = host.plugin({ name: 'host-child', apply() {} })
    fibers.push(hostFiber)
    await hostFiber.await()
    Reflect.set(globalThis, '__cordisHostProbe', host)
    observers.push(publishHostCordisTree(host, inspector.source, { maxNodes: 100, maxBytes: 64 * 1_024 }))

    clientSource = await InspectorClientFixture.start(inspector.endpoint.client, { label: 'Tree Client' })
    cdp = await CdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await cdp.call('Runtime.enable')

    let document: CdpNode | undefined
    await vi.waitFor(async () => {
      const response = await cdp!.call('DOM.getDocument', { depth: -1 })
      expect(response.error).toBeUndefined()
      document = response.result?.root as CdpNode
      expect(hostContainer(document)).toBeDefined()
      expect(clientContainers(document)).toHaveLength(1)
    })
    if (document === undefined) throw new Error('DOM.getDocument returned no root')
    expect(document.children?.map(node => node.localName)).toEqual(['host', 'clients'])
    expect(document.children?.every(node => (node.attributes ?? []).length === 0)).toBe(true)

    const stored = await cdp.call('DSHInspector.getCordisTree')
    const model = stored.result?.tree as {
      host: { root: Record<string, unknown> } | null
      clients: Array<{ root: Record<string, unknown> }>
    }
    expect(model.host?.root).toMatchObject({ kind: 'context' })
    expect(model.clients).toHaveLength(1)
    expect(model.clients[0]?.root).toMatchObject({ kind: 'context' })
    expect(model.host?.root).not.toHaveProperty('nodeId')
    expect(model.host?.root).not.toHaveProperty('backendNodeId')

    const realms = [
      ['host', hostContainer(document)],
      ['client', clientContainers(document)[0]],
    ] as const
    for (const [realmKind, realm] of realms) {
      expect(realm?.attributes ?? []).toEqual([])
      const rootContext = realm?.children?.[0]
      expect(rootContext?.localName).toBe('context')
      expect(rootContext?.children?.[0]?.localName).toBe('fiber')
      expect(rootContext?.children?.[0]?.children?.[0]?.localName).toBe('context')
      for (const entityKind of ['context', 'fiber']) {
        const node = realm === undefined ? undefined : walk(realm).find(item => item.localName === entityKind)
        if (node === undefined) throw new Error(`missing ${realmKind} ${entityKind} node`)
        expect(node.attributes ?? []).toEqual(entityKind === 'fiber'
          ? ['uid', expect.stringMatching(/^\d+$/u)]
          : [])
        expect(node.nodeId).toBeGreaterThan(0)
        expect(node.backendNodeId).toBeGreaterThan(0)
        const objectGroup = `tree-${realmKind}-${entityKind}`
        const resolved = await cdp.call('DOM.resolveNode', { nodeId: node.nodeId, objectGroup })
        expect(resolved.error).toBeUndefined()
        const remote = resolved.result?.object as Record<string, unknown>
        expect(remote).toMatchObject({
          type: 'object',
          subtype: 'node',
          className: entityKind === 'fiber' ? 'Fiber' : 'Context',
        })
        expect(typeof remote.objectId).toBe('string')
        const properties = await cdp.call('Runtime.getProperties', { objectId: remote.objectId, ownProperties: true })
        expect(properties.error).toBeUndefined()
        await expect(cdp.call('DOM.requestNode', { objectId: remote.objectId })).resolves.toMatchObject({
          result: { nodeId: node.nodeId },
        })
        await cdp.call('Runtime.releaseObjectGroup', { objectGroup })
      }
    }

    const hostNode = walk(hostContainer(document)!).find(item => item.localName === 'context')!
    const hostEvaluated = await cdp.call('Runtime.evaluate', { expression: 'globalThis.__cordisHostProbe' })
    expect(hostEvaluated.result?.result).toMatchObject({ type: 'object', subtype: 'node', className: 'Context' })
    await expect(cdp.call('DOM.requestNode', {
      objectId: (hostEvaluated.result?.result as Record<string, unknown>).objectId,
    })).resolves.toMatchObject({ result: { nodeId: hostNode.nodeId } })
    const hostThrown = await cdp.call('Runtime.evaluate', { expression: 'throw globalThis.__cordisHostProbe' })
    const hostException = hostThrown.result?.exceptionDetails as Record<string, unknown>
    const hostExceptionObject = hostException.exception as Record<string, unknown>
    expect(hostExceptionObject).toMatchObject({ subtype: 'node', className: 'Context' })
    await expect(cdp.call('DOM.requestNode', { objectId: hostExceptionObject.objectId }))
      .resolves.toMatchObject({ result: { nodeId: hostNode.nodeId } })

    let clientContextId: number | undefined
    await vi.waitFor(() => {
      const event = cdp!.events.find(item => item.method === 'Runtime.executionContextCreated'
        && String((item.params?.context as { name?: string } | undefined)?.name).startsWith('Client'))
      clientContextId = (event?.params?.context as { id?: number } | undefined)?.id
      expect(clientContextId).toBeTypeOf('number')
    })
    const clientNode = walk(clientContainers(document)[0]!).find(item => item.localName === 'context')!
    const clientEvaluated = await cdp.call('Runtime.evaluate', {
      expression: 'globalThis.__cordisClientProbe',
      contextId: clientContextId,
    })
    expect(clientEvaluated.result?.result).toMatchObject({ type: 'object', subtype: 'node', className: 'Context' })
    await expect(cdp.call('DOM.requestNode', {
      objectId: (clientEvaluated.result?.result as Record<string, unknown>).objectId,
    })).resolves.toMatchObject({ result: { nodeId: clientNode.nodeId } })
    const clientThrown = await cdp.call('Runtime.evaluate', {
      expression: 'throw globalThis.__cordisClientProbe',
      contextId: clientContextId,
    })
    const clientException = clientThrown.result?.exceptionDetails as Record<string, unknown>
    const clientExceptionObject = clientException.exception as Record<string, unknown>
    expect(clientExceptionObject).toMatchObject({ subtype: 'node', className: 'Context' })
    await expect(cdp.call('DOM.requestNode', { objectId: clientExceptionObject.objectId }))
      .resolves.toMatchObject({ result: { nodeId: clientNode.nodeId } })

    const consoleOffset = cdp.events.length
    await clientSource.logCordis('cordis-client-console')
    let consoleObject: Record<string, unknown> | undefined
    let consoleFiber: Record<string, unknown> | undefined
    await vi.waitFor(() => {
      const event = cdp!.events.slice(consoleOffset).find((candidate) => {
        const params = candidate.params
        if (params === undefined
          || candidate.method !== 'Runtime.consoleAPICalled'
          || params.executionContextId !== clientContextId
          || !Array.isArray(params.args)) return false
        return params.args.some(argument => (argument as { value?: unknown }).value === 'cordis-client-console')
      })
      const args = event?.params?.args
      consoleObject = Array.isArray(args) ? args[0] as Record<string, unknown> | undefined : undefined
      consoleFiber = Array.isArray(args) ? args[1] as Record<string, unknown> | undefined : undefined
      expect(consoleObject).toMatchObject({ type: 'object', subtype: 'node', className: 'Context' })
      expect(consoleFiber).toMatchObject({ type: 'object', subtype: 'node', className: 'Fiber' })
    })
    await expect(cdp.call('DOM.requestNode', { objectId: consoleObject!.objectId }))
      .resolves.toMatchObject({ result: { nodeId: clientNode.nodeId } })
    const requestedFiber = await cdp.call('DOM.requestNode', { objectId: consoleFiber!.objectId })
    const requestedFiberId = (requestedFiber.result as { nodeId?: number } | undefined)?.nodeId
    const clientFiberNode = walk(clientContainers(document)[0]!).find(node => node.nodeId === requestedFiberId)
    expect(clientFiberNode).toMatchObject({
      localName: 'fiber',
      attributes: ['uid', String(clientSource.fiberUid)],
    })

    const firstResolved = await cdp.call('DOM.resolveNode', { backendNodeId: clientNode.backendNodeId })
    const firstObjectId = (firstResolved.result?.object as Record<string, unknown>).objectId
    secondCdp = await CdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    const secondDocument = (await secondCdp.call('DOM.getDocument', { depth: -1 })).result?.root as CdpNode
    const secondNode = walk(secondDocument).find(node => node.backendNodeId === clientNode.backendNodeId)
    expect(secondNode).toBeDefined()
    const secondResolved = await secondCdp.call('DOM.resolveNode', { backendNodeId: clientNode.backendNodeId })
    const secondObjectId = (secondResolved.result?.object as Record<string, unknown>).objectId
    expect(secondObjectId).not.toBe(firstObjectId)
    expect((await secondCdp.call('DOM.requestNode', { objectId: firstObjectId })).error).toBeDefined()

    const eventOffset = cdp.events.length
    await clientSource.close()
    clientSource = undefined
    await vi.waitFor(() => {
      const events = cdp!.events.slice(eventOffset)
      expect(events.some(event => event.method === 'Runtime.executionContextDestroyed'
        && event.params?.executionContextId === clientContextId)).toBe(true)
      expect(events.some(event => event.method === 'DOM.documentUpdated')).toBe(false)
    })

    const disconnectedDocument = (await cdp.call('DOM.getDocument', { depth: -1 })).result?.root as CdpNode
    const disconnectedClient = clientContainers(disconnectedDocument)[0]
    expect(disconnectedClient).toBeDefined()
    expect(walk(disconnectedClient!).find(node => node.backendNodeId === clientNode.backendNodeId)?.nodeId)
      .toBe(clientNode.nodeId)
    expect((await cdp.call('DOM.resolveNode', { nodeId: clientNode.nodeId })).error?.message)
      .toContain('Cordis realm is disconnected')
    expect((await cdp.call('DOM.requestNode', {
      objectId: (clientEvaluated.result?.result as Record<string, unknown>).objectId,
    })).error).toBeDefined()
    const disconnectedTree = (await cdp.call('DSHInspector.getCordisTree')).result?.tree as {
      clients: Array<{ connection: { state: string } }>
    }
    expect(disconnectedTree.clients[0]?.connection.state).toBe('disconnected')
  })

  it('emits only node-level DOM changes for Client snapshots', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false, maxCordisNodes: 100 })
    cdp = await CdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    const initialDocument = (await cdp.call('DOM.getDocument')).result?.root as CdpNode
    const clientsNode = initialDocument.children?.find(node => node.localName === 'clients')
    if (clientsNode === undefined) throw new Error('DOM document has no clients container')

    let offset = cdp.events.length
    clientSource = await InspectorClientFixture.start(inspector.endpoint.client, { label: 'Incremental Client' })
    let insertedClient: CdpNode | undefined
    await vi.waitFor(() => {
      const events = cdp!.events.slice(offset)
      const inserted = events.find(event => event.method === 'DOM.childNodeInserted')
      expect(inserted?.params?.parentNodeId).toBe(clientsNode.nodeId)
      expect(inserted?.params?.node).toMatchObject({ localName: 'client' })
      expect(events.some(event => event.method === 'DOM.documentUpdated')).toBe(false)
      insertedClient = inserted?.params?.node as CdpNode
    })
    // The collapsed insert payload withholds the realm subtree; expand it to follow deeper changes.
    expect(insertedClient?.children).toBeUndefined()
    await cdp.call('DOM.requestChildNodes', { nodeId: insertedClient!.nodeId, depth: -1 })

    const firstTree = (await cdp.call('DSHInspector.getCordisTree')).result?.tree as {
      clients: Array<{ revision: number }>
    }
    const firstRevision = firstTree.clients[0]?.revision
    offset = cdp.events.length
    await clientSource.refreshTree()
    await vi.waitFor(async () => {
      const tree = (await cdp!.call('DSHInspector.getCordisTree')).result?.tree as {
        clients: Array<{ revision: number }>
      }
      expect(tree.clients[0]?.revision).toBeGreaterThan(firstRevision ?? 0)
    })
    expect(cdp.events.slice(offset).some(event => event.method?.startsWith('DOM.'))).toBe(false)

    offset = cdp.events.length
    const uid = await clientSource.addFiber()
    let insertedNodeId: number | undefined
    await vi.waitFor(() => {
      const inserted = cdp!.events.slice(offset).find(event => event.method === 'DOM.childNodeInserted'
        && (event.params?.node as CdpNode | undefined)?.localName === 'fiber'
        && (event.params?.node as CdpNode | undefined)?.attributes?.includes(String(uid)))
      insertedNodeId = (inserted?.params?.node as CdpNode | undefined)?.nodeId
      expect(insertedNodeId).toBeTypeOf('number')
      expect(cdp!.events.slice(offset).some(event => event.method === 'DOM.documentUpdated')).toBe(false)
    })

    offset = cdp.events.length
    await clientSource.removeFiber()
    await vi.waitFor(() => {
      const events = cdp!.events.slice(offset)
      const removed = events.find(event => event.method === 'DOM.childNodeRemoved')
      expect(removed?.params?.nodeId).toBe(insertedNodeId)
      expect(events.some(event => event.method === 'DOM.documentUpdated')).toBe(false)
    })
  })

  it('serves three document levels by default and withheld levels on demand', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false, maxCordisNodes: 100 })
    const host = new Context()
    let innerFiber: { uid: number | null } | undefined
    const outer = host.plugin({
      name: 'outer',
      apply(ctx: Context) { innerFiber = ctx.plugin({ name: 'inner', apply() {} }) },
    })
    fibers.push(outer)
    await outer.await()
    const innerUid = innerFiber?.uid
    if (innerFiber === undefined || innerUid === null || innerUid === undefined) {
      throw new Error('nested plugin did not register a uid')
    }
    observers.push(publishHostCordisTree(host, inspector.source, { maxNodes: 100, maxBytes: 64 * 1_024 }))
    cdp = await CdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)

    // Default document depth ends at the first Fiber layer: children withheld, count advertised.
    let outerNode: CdpNode | undefined
    await vi.waitFor(async () => {
      const document = (await cdp!.call('DOM.getDocument')).result?.root as CdpNode
      outerNode = hostContainer(document)?.children?.[0]?.children
        ?.find(node => node.localName === 'fiber' && node.attributes?.includes(String(outer.uid)))
      expect(outerNode).toBeDefined()
    })
    expect(outerNode?.children).toBeUndefined()
    expect(outerNode?.childNodeCount).toBe(1)

    // Expanding serves exactly one more level by default.
    let offset = cdp.events.length
    await cdp.call('DOM.requestChildNodes', { nodeId: outerNode!.nodeId })
    const expanded = cdp.events.slice(offset).find(event => event.method === 'DOM.setChildNodes')
    expect(expanded?.params?.parentId).toBe(outerNode!.nodeId)
    const outerContext = (expanded?.params?.nodes as CdpNode[])[0]
    expect(outerContext).toMatchObject({ localName: 'context', childNodeCount: 1 })
    expect(outerContext?.children).toBeUndefined()

    // Expand-recursively requests the entire subtree.
    offset = cdp.events.length
    await cdp.call('DOM.requestChildNodes', { nodeId: outerNode!.nodeId, depth: -1 })
    const recursive = cdp.events.slice(offset).find(event => event.method === 'DOM.setChildNodes')
    const recursiveContext = (recursive?.params?.nodes as CdpNode[])[0]
    expect(recursiveContext?.children?.[0]).toMatchObject({
      localName: 'fiber',
      attributes: ['uid', String(innerUid)],
    })
    expect((await cdp.call('DOM.getDocument', { depth: 0 })).error?.message).toContain('depth')

    // A NodeId leaving through search or object lookup pushes the not-yet-sent ancestor levels first.
    secondCdp = await CdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await secondCdp.call('Runtime.enable')
    const secondDocument = (await secondCdp.call('DOM.getDocument')).result?.root as CdpNode
    const secondOuter = walk(secondDocument).find(node => node.attributes?.includes(String(outer.uid)))
    const described = (await secondCdp.call('DOM.describeNode', { nodeId: secondOuter?.nodeId })).result?.node as CdpNode
    expect(described.children?.[0]?.localName).toBe('context')
    expect(described.children?.[0]?.children).toBeUndefined()

    const search = await secondCdp.call('DOM.performSearch', { query: `uid=${JSON.stringify(String(innerUid))}` })
    expect(search.result?.resultCount).toBe(1)
    offset = secondCdp.events.length
    const results = await secondCdp.call('DOM.getSearchResults', {
      searchId: search.result?.searchId,
      fromIndex: 0,
      toIndex: 1,
    })
    const innerNodeId = (results.result?.nodeIds as number[])[0]
    const pushed = secondCdp.events.slice(offset).filter(event => event.method === 'DOM.setChildNodes')
    expect(pushed).toHaveLength(2)
    await expect(secondCdp.call('DOM.getAttributes', { nodeId: innerNodeId })).resolves.toMatchObject({
      result: { attributes: ['uid', String(innerUid)] },
    })

    Reflect.set(globalThis, '__cordisHostProbe', innerFiber)
    const evaluated = await secondCdp.call('Runtime.evaluate', { expression: 'globalThis.__cordisHostProbe' })
    expect(evaluated.result?.result).toMatchObject({ subtype: 'node', className: 'Fiber' })
    offset = secondCdp.events.length
    await expect(secondCdp.call('DOM.requestNode', {
      objectId: (evaluated.result?.result as Record<string, unknown>).objectId,
    })).resolves.toMatchObject({ result: { nodeId: innerNodeId } })
    expect(secondCdp.events.slice(offset).some(event => event.method === 'DOM.setChildNodes')).toBe(false)
  })

  it('restores a disconnected Client tree from a new transport generation', async () => {
    inspector = await startInspector({
      port: 0,
      captureFetch: false,
      maxCordisNodes: 100,
      clientReconnectBaseMs: 10,
      clientReconnectMaxMs: 20,
    })
    clientSource = await InspectorClientFixture.start(inspector.endpoint.client, { label: 'Reconnect Client' })
    cdp = await CdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await cdp.call('Runtime.enable')

    let document: CdpNode | undefined
    let contextId: number | undefined
    await vi.waitFor(async () => {
      document = (await cdp!.call('DOM.getDocument')).result?.root as CdpNode
      expect(clientContainers(document)).toHaveLength(1)
      const created = cdp!.events.find(event => event.method === 'Runtime.executionContextCreated'
        && String((event.params?.context as { name?: string } | undefined)?.name).startsWith('Client'))
      contextId = (created?.params?.context as { id?: number } | undefined)?.id
      expect(contextId).toBeTypeOf('number')
    })
    const initialTree = (await cdp.call('DSHInspector.getCordisTree')).result?.tree as {
      clients: Array<{ source: { sourceId: string } }>
    }
    const sourceId = initialTree.clients[0]?.source.sourceId
    const eventOffset = cdp.events.length
    await clientSource.disconnect()

    await vi.waitFor(() => {
      const events = cdp!.events.slice(eventOffset)
      const destroyed = events.findIndex(event => event.method === 'Runtime.executionContextDestroyed'
        && event.params?.executionContextId === contextId)
      const created = events.findIndex((event) => {
        if (event.method !== 'Runtime.executionContextCreated') return false
        const context = event.params?.context as { id?: number } | undefined
        return typeof context?.id === 'number' && context.id !== contextId
      })
      const removed = events.findIndex(event => event.method === 'DOM.childNodeRemoved')
      const inserted = events.findIndex(event => event.method === 'DOM.childNodeInserted')
      expect(destroyed).toBeGreaterThanOrEqual(0)
      expect(created).toBeGreaterThan(destroyed)
      expect(removed).toBeGreaterThan(created)
      expect(inserted).toBeGreaterThan(removed)
      expect(events.slice(0, created).some(event => event.method?.startsWith('DOM.'))).toBe(false)
      expect(events.some(event => event.method === 'DOM.documentUpdated')).toBe(false)
    })

    await vi.waitFor(async () => {
      const current = (await cdp!.call('DOM.getDocument')).result?.root as CdpNode
      expect(clientContainers(current)).toHaveLength(1)
      expect(clientContainers(current)[0]?.children?.[0]?.localName).toBe('context')
      const tree = (await cdp!.call('DSHInspector.getCordisTree')).result?.tree as {
        clients: Array<{
          source: { sourceId: string }
          connection: { state: string }
        }>
      }
      expect(tree.clients).toHaveLength(1)
      expect(tree.clients[0]?.source.sourceId).toBe(sourceId)
      expect(tree.clients[0]?.connection.state).toBe('connected')
    })
  })
})

function source(sourceId: string, generation: string): InspectorSourceDescriptor {
  return {
    sourceId: inspectorId<'InspectorSourceId'>(sourceId, 'sourceId'),
    generation: inspectorId<'InspectorSourceGeneration'>(generation, 'generation'),
    kind: 'client',
    label: sourceId,
    timeOriginMs: 0,
    capabilities: [],
  }
}

function hostContainer(root: CdpNode | undefined): CdpNode | undefined {
  return root?.children?.find(node => node.localName === 'host')
}

function clientContainers(root: CdpNode | undefined): CdpNode[] {
  return root?.children?.find(node => node.localName === 'clients')?.children
    ?.filter(node => node.localName === 'client') ?? []
}

function walk(root: CdpNode): CdpNode[] {
  return [root, ...(root.children ?? []).flatMap(walk)]
}

function treeNodes(root: CordisTreeNode): CordisTreeNode[] {
  return [root, ...root.children.flatMap(treeNodes)]
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function asJson(value: object): InspectorJsonValue {
  return value as unknown as InspectorJsonValue
}
