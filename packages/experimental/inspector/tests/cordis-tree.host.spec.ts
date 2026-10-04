/** Host-driven Cordis tree integration. */

import { Context } from '@deepseek-ai/cordis'
import WebSocket, { type RawData } from 'ws'
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest'
import { CordisTreeCollector } from '../src/shared/cordis/collector.ts'
import { observeCordisTree } from '../src/shared/cordis/observer.ts'
import * as inspectorBridge from '../src/host/bridge/controller.ts'
import type { InspectorHandle, InspectorOptions } from '../src/host/bridge/controller.ts'
import { publishCordisTree as publishHostCordisTree } from '../src/host/inspection/cordis.ts'
import { parseCordisTreeSnapshot, type CordisTreeNode } from '../src/shared/cordis/snapshot.ts'
import type { CordisRuntimeTree } from '../src/shared/cordis/model.ts'
import { inspectorId } from '../src/shared/bridge/ids.ts'
import type { InspectorJsonValue } from '../src/shared/json.ts'
import { jsonByteLength } from '../src/shared/json.ts'
import type { InspectorSourceDescriptor } from '../src/shared/bridge/messages/observation.ts'
import { CordisTreeStore } from '../src/worker/inspection/cordis-store.ts'
import { CordisDomBackend, type CordisDomChange } from '../src/worker/cdp/domains/dom/model.ts'
import { CordisDomSession } from '../src/worker/cdp/domains/dom/session.ts'
import { RuntimeDomainSession } from '../src/worker/cdp/domains/runtime/session.ts'
import { InspectorRealmSessionSet } from '../src/worker/cdp/realm-sessions.ts'
import { InspectorRealmRegistry } from '../src/worker/inspection/realm-store.ts'
import { HostInspectorRealm } from '../src/worker/realms/host/index.ts'
import { InspectorSourceRegistry } from '../src/worker/bridge/hub.ts'
import { ClientRuntimeRouter } from '../src/worker/bridge/runtime-rpc.ts'
import { ClientSourceRouter } from '../src/worker/bridge/source-rpc.ts'
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

/** Own pending startup through cancellation; tree assertions do not measure Worker cold-start latency. */
async function startTestInspector(options: InspectorOptions, test: TestContext): Promise<InspectorHandle> {
  const pending = inspectorBridge.startInspector({ ...options, startupTimeoutMs: test.task.timeout })
  test.onTestFinished(async () => {
    // Failed starts terminate their Worker before rejecting.
    const [started] = await Promise.allSettled([pending])
    if (started.status === 'fulfilled') await started.value.close()
  })
  const handle = await pending
  test.signal.throwIfAborted()
  return handle
}

describe('Cordis tree inspection', () => {
  let inspector: InspectorHandle | undefined
  let cdp: CdpClient | undefined
  let secondCdp: CdpClient | undefined
  let clientSource: InspectorClientFixture | undefined
  const observers: Array<() => void> = []
  const fibers: Array<{ dispose(): Promise<void> }> = []

  it('closes a late-starting Worker after test cancellation without returning its handle', async (test) => {
    const release = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const cleanups: Array<Parameters<TestContext['onTestFinished']>[0]> = []
    let starting: Promise<InspectorHandle> | undefined
    const start = inspectorBridge.startInspector
    const spy = vi.spyOn(inspectorBridge, 'startInspector').mockImplementation(async (options) => {
      starting = start(options)
      const handle = await starting
      await release.promise
      return handle
    })
    test.onTestFinished(async () => {
      release.resolve(undefined)
      spy.mockRestore()
      if (starting === undefined) return
      const [started] = await Promise.allSettled([starting])
      if (started.status === 'fulfilled') await started.value.close()
    })
    const pending = startTestInspector({ port: 0, captureFetch: false }, {
      ...test,
      signal: controller.signal,
      onTestFinished: (cleanup) => { cleanups.push(cleanup) },
    })
    const result = pending.then(
      handle => ({ status: 'fulfilled' as const, handle }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )
    if (starting === undefined) throw new Error('Inspector startup was not called')
    const handle = await starting
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ startupTimeoutMs: test.task.timeout }))
    expect(cleanups).toHaveLength(1)
    const cancelled = new Error('test cancelled during startup')
    controller.abort(cancelled)
    release.resolve(undefined)
    const outcome = await result
    expect(outcome.status).toBe('rejected')
    expect('reason' in outcome ? outcome.reason : undefined).toBe(cancelled)
    await cleanups[0]!(test)
    await expect(fetch(handle.endpoint.httpUrl)).rejects.toThrow()
  })

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
    const hooks = root.events._hooks as Record<PropertyKey, Array<{ ctx: unknown }> | undefined>
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

  it('projects Host and Client trees and resolves both node kinds to RemoteObjects', async (test) => {
    inspector = await startTestInspector({ port: 0, captureFetch: false, maxCordisNodes: 100 }, test)
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
      expect(events).toContainEqual({
        method: 'DOM.attributeModified',
        params: { nodeId: clientContainers(document)[0]!.nodeId, name: 'disconnected', value: '' },
      })
      expect(events.some(event => event.method === 'DOM.documentUpdated')).toBe(false)
    })

    const disconnectedDocument = (await cdp.call('DOM.getDocument', { depth: -1 })).result?.root as CdpNode
    const disconnectedClient = clientContainers(disconnectedDocument)[0]
    expect(disconnectedClient).toBeDefined()
    expect(disconnectedClient?.attributes).toEqual(['disconnected', ''])
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

  it('emits only node-level DOM changes for Client snapshots', async (test) => {
    inspector = await startTestInspector({ port: 0, captureFetch: false, maxCordisNodes: 100 }, test)
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

  it('serves three document levels by default and withheld levels on demand', async (test) => {
    inspector = await startTestInspector({ port: 0, captureFetch: false, maxCordisNodes: 100 }, test)
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
    expect(recursive?.params?.parentId).toBe(outerContext!.nodeId)
    const recursiveFiber = (recursive?.params?.nodes as CdpNode[])[0]
    expect(recursiveFiber).toMatchObject({
      localName: 'fiber',
      attributes: ['uid', String(innerUid)],
      children: [{ localName: 'context' }],
    })
    offset = cdp.events.length
    await cdp.call('DOM.requestChildNodes', { nodeId: outerNode!.nodeId })
    await cdp.call('DOM.requestChildNodes', { nodeId: outerContext!.nodeId, depth: -1 })
    expect(cdp.events.slice(offset).filter(event => event.method?.startsWith('DOM.'))).toEqual([])
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

  it.for(['initial', 'getDocument', 'pushNodes'] as const)(
    'keeps withheld children expandable after %s and live mutations',
    async (delivery, test) => {
      inspector = await startTestInspector({ port: 0, captureFetch: false, maxCordisNodes: 100 }, test)
      const host = new Context()
      const outer = host.plugin({
        name: 'outer',
        apply(ctx: Context) { ctx.isolate('original').plugin({ name: 'original-child', apply() {} }) },
      })
      fibers.push(outer)
      await outer.await()
      observers.push(publishHostCordisTree(host, inspector.source, { maxNodes: 100, maxBytes: 64 * 1_024 }))
      cdp = await CdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)

      let outerNode: CdpNode | undefined
      await vi.waitFor(async () => {
        const document = (await cdp!.call('DOM.getDocument', {
          depth: delivery === 'getDocument' ? -1 : 3,
        })).result?.root as CdpNode
        outerNode = hostContainer(document)?.children?.[0]?.children
          ?.find(node => node.localName === 'fiber' && node.attributes?.includes(String(outer.uid)))
        expect(outerNode?.attributes).toEqual(['uid', String(outer.uid)])
      })

      let parent: CdpNode
      if (delivery === 'getDocument') {
        const document = (await cdp.call('DOM.getDocument', { depth: 4 })).result?.root as CdpNode
        parent = walk(document).find(node => node.backendNodeId === outerNode!.backendNodeId)!.children![0]!
      } else if (delivery === 'initial') {
        const offset = cdp.events.length
        await cdp.call('DOM.requestChildNodes', { nodeId: outerNode!.nodeId })
        const expanded = cdp.events.slice(offset).find(event => event.method === 'DOM.setChildNodes')
        parent = (expanded?.params?.nodes as CdpNode[])[0]!
      } else {
        const described = (await cdp.call('DOM.describeNode', { nodeId: outerNode!.nodeId })).result?.node as CdpNode
        const offset = cdp.events.length
        await cdp.call('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [described.children![0]!.backendNodeId] })
        const expanded = cdp.events.slice(offset).find(event => event.method === 'DOM.setChildNodes')
        parent = (expanded?.params?.nodes as CdpNode[])[0]!
      }
      expect(parent).toMatchObject({ localName: 'context', childNodeCount: 1 })
      expect(parent.children).toBeUndefined()
      expect((await cdp.call('DOM.getDocument', { depth: 0 })).error?.message).toContain('depth')

      // Descriptions allocate ids without attaching those nodes to the Elements document.
      await cdp.call('DOM.describeNode', { nodeId: parent.nodeId, depth: -1 })
      secondCdp = await CdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
      await secondCdp.call('DOM.enable')
      await secondCdp.call('DOM.describeNode', { backendNodeId: parent.backendNodeId, depth: -1 })

      const waitForChildren = async (count: number): Promise<void> => {
        await vi.waitFor(async () => {
          const tree = (await cdp!.call('DSHInspector.getCordisTree')).result?.tree as CordisRuntimeTree
          const projected = tree.host?.root.children.find(node => node.kind === 'fiber' && node.uid === outer.uid)
          expect(projected?.children[0]?.children).toHaveLength(count)
        })
      }
      let offset = cdp.events.length
      const first = outer.ctx.plugin({ name: 'first-direct-child', apply() {} })
      const second = outer.ctx.plugin({ name: 'second-direct-child', apply() {} })
      await Promise.all([first.await(), second.await()])
      await waitForChildren(3)
      expect(cdp.events.slice(offset).filter(event => event.method?.startsWith('DOM.'))).toEqual([{
        method: 'DOM.childNodeCountUpdated',
        params: { nodeId: parent.nodeId, childNodeCount: 3 },
      }])
      expect(secondCdp.events.filter(event => event.method?.startsWith('DOM.'))).toEqual([])

      offset = cdp.events.length
      await first.dispose()
      await waitForChildren(2)
      expect(cdp.events.slice(offset).filter(event => event.method?.startsWith('DOM.'))).toEqual([{
        method: 'DOM.childNodeCountUpdated',
        params: { nodeId: parent.nodeId, childNodeCount: 2 },
      }])
      expect(secondCdp.events.filter(event => event.method?.startsWith('DOM.'))).toEqual([])

      offset = cdp.events.length
      await cdp.call('DOM.requestChildNodes', { nodeId: parent.nodeId, depth: -1 })
      const expanded = cdp.events.slice(offset).find(event => event.method === 'DOM.setChildNodes')
      const children = expanded?.params?.nodes as CdpNode[]
      expect(children).toHaveLength(2)
      expect(children[0]).toMatchObject({ localName: 'fiber', attributes: ['uid', String(second.uid)] })
      expect(children[1]).toMatchObject({ localName: 'context', children: [{ localName: 'fiber' }] })

      offset = cdp.events.length
      await second.dispose()
      await waitForChildren(1)
      expect(cdp.events.slice(offset).filter(event => event.method?.startsWith('DOM.'))).toEqual([{
        method: 'DOM.childNodeRemoved',
        params: { parentNodeId: parent.nodeId, nodeId: children[0]!.nodeId },
      }])
    },
  )

  it('restores a disconnected Client tree from a new transport generation', async (test) => {
    inspector = await startTestInspector({
      port: 0,
      captureFetch: false,
      maxCordisNodes: 100,
      clientReconnectBaseMs: 10,
      clientReconnectMaxMs: 20,
    }, test)
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
    const clientNodeId = clientContainers(document)[0]!.nodeId
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
      expect(events.slice(0, created).filter(event => event.method?.startsWith('DOM.'))).toEqual([{
        method: 'DOM.attributeModified', params: { nodeId: clientNodeId, name: 'disconnected', value: '' },
      }])
      expect(events).toContainEqual({
        method: 'DOM.attributeRemoved', params: { nodeId: clientNodeId, name: 'disconnected' },
      })
      expect(events.some(event => event.method === 'DOM.documentUpdated')).toBe(false)
    })

    await vi.waitFor(async () => {
      const current = (await cdp!.call('DOM.getDocument')).result?.root as CdpNode
      expect(clientContainers(current)).toHaveLength(1)
      expect(clientContainers(current)[0]?.attributes).toEqual([])
      expect(clientContainers(current)[0]?.nodeId).toBe(clientNodeId)
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

describe('Client-scoped Cordis DOM', () => {
  for (const mode of ['full', 'scoped'] as const) {
    it(`publishes disconnected attributes and removes them on reconnect (${mode})`, async (test) => {
      const h = scopedTreeFixture(test)
      h.publish(h.host, 1001)
      h.publish(h.b, 2002)
      h.publish(h.a, 3003)
      const backend = mode === 'full' ? h.global : h.scope(h.a)
      const events: CdpMessage[] = []
      const call = scopedDomCalls(backend, test, events)
      const document = (await call('DOM.getDocument', { depth: -1 })).result?.root as CdpNode
      const wrapper = backend.document().root.children[1]!.children.find(node => node.key === `client:${h.a.sourceId}`)!
      const client = clientContainers(document).find(node => node.backendNodeId === wrapper.backendNodeId)!
      const entity = client.children![0]!
      expect(client.attributes).toEqual([])
      expect(wrapper.description).toBe('<client>')

      h.store.close(h.a, 'Client closed')
      expect(events).toEqual([{
        method: 'DOM.attributeModified', params: { nodeId: client.nodeId, name: 'disconnected', value: '' },
      }])
      expect((await call('DOM.getAttributes', { nodeId: client.nodeId })).result?.attributes).toEqual(['disconnected', ''])
      expect(backend.document().byBackendId.get(wrapper.backendNodeId)?.description).toBe('<client disconnected>')
      expect((await call('DOM.describeNode', { nodeId: entity.nodeId })).result?.node)
        .toMatchObject({ nodeId: entity.nodeId, backendNodeId: entity.backendNodeId })
      expect((await call('DOM.resolveNode', { nodeId: entity.nodeId })).error?.message).toContain('Cordis realm is disconnected')
      expect(backend.nodeForObject(h.a, h.reference)).toBeUndefined()
      expect(backend.document().root.children[0]!.attributes).toEqual([])
      if (mode === 'full') {
        expect(backend.document().root.children[1]!.children.find(node => node.key === `client:${h.b.sourceId}`)?.attributes).toEqual([])
      }

      events.length = 0
      h.publish(source('scope-a', 'generation-2'), 3004)
      expect(events.filter(event => event.method?.startsWith('DOM.attribute'))).toEqual([{
        method: 'DOM.attributeRemoved', params: { nodeId: client.nodeId, name: 'disconnected' },
      }])
      expect(events.some(event => event.method === 'DOM.documentUpdated')).toBe(false)
      expect((await call('DOM.getAttributes', { nodeId: client.nodeId })).result?.attributes).toEqual([])
      expect(backend.document().byBackendId.get(wrapper.backendNodeId)?.description).toBe('<client>')
      expect((await call('DOM.describeNode', { nodeId: client.nodeId })).result?.node)
        .toMatchObject({ nodeId: client.nodeId, backendNodeId: client.backendNodeId })
      expect((await call('DOM.describeNode', { nodeId: entity.nodeId })).error).toBeDefined()
    })
  }

  it('indexes only Host and the selected Client without changing the global backend', (test) => {
    const h = scopedTreeFixture(test)
    h.publish(h.host, 1001)
    h.publish(h.b, 2002)
    h.publish(h.a, 3003)
    const scoped = h.scope(h.a)
    const sourceIds = (backend: CordisDomBackend) => new Set([...backend.document().byBackendId.values()]
      .flatMap(node => node.object === undefined ? [] : [node.object.source.sourceId]))
    expect(sourceIds(h.global)).toEqual(new Set([h.host.sourceId, h.a.sourceId, h.b.sourceId]))
    expect(sourceIds(scoped)).toEqual(new Set([h.host.sourceId, h.a.sourceId]))
    expect(scoped.document().root.children[1]!.children).toHaveLength(1)
    for (const [child, parent] of scoped.document().parentByBackendId) {
      expect(scoped.document().byBackendId.has(child)).toBe(true)
      expect(scoped.document().byBackendId.has(parent)).toBe(true)
    }
    expect(scoped.nodeForObject(h.b, h.reference)).toBeUndefined()
    expect(scoped.nodeForRealm({ ...h.b, realmId: inspectorId<'InspectorRealmId'>('realm-b', 'realmId') }, h.reference)).toBeUndefined()
    expect(scoped.nodeForRealm({ ...h.a, realmId: inspectorId<'InspectorRealmId'>('realm-a', 'realmId') }, h.reference)?.object?.source)
      .toBe(h.a)
    // Registry and handle text are source-local; B intentionally precedes A with the same values.
    expect(h.global.nodeForObjectKind('client', h.reference)?.object?.source).toBe(h.b)
    expect(scoped.nodeForObjectKind('client', h.reference)?.object?.source).toBe(h.a)
    expect(scoped.nodeForObjectKind('host', h.reference)?.object?.source).toBe(h.host)
  })

  it('keeps DOM searches and frontend NodeIds inside the selected projection', async (test) => {
    const h = scopedTreeFixture(test)
    h.publish(h.host, 1001)
    h.publish(h.b, 2002)
    h.publish(h.a, 3003)
    const scoped = h.scope(h.a)
    const call = scopedDomCalls(scoped, test)
    const response = await call('DOM.getDocument', { depth: -1 })
    const root = response.result?.root as CdpNode
    expect(clientContainers(root)).toHaveLength(1)
    const fibers = walk(root).filter(node => node.localName === 'fiber')
    expect(fibers.map(node => node.attributes)).toEqual([['uid', '1001'], ['uid', '3003']])
    const backendIds = new Set<number>(scoped.document().byBackendId.keys())
    for (const node of walk(root)) expect(backendIds.has(node.backendNodeId)).toBe(true)
    expect((await call('DOM.performSearch', { query: 'uid="2002"' })).result?.resultCount).toBe(0)
    const search = await call('DOM.performSearch', { query: 'uid="3003"' })
    expect(search.result?.resultCount).toBe(1)
    const matches = await call('DOM.getSearchResults', { searchId: search.result?.searchId, fromIndex: 0, toIndex: 1 })
    expect(matches.result?.nodeIds).toEqual([fibers[1]!.nodeId])
    expect((await call('DOM.describeNode', { nodeId: fibers[1]!.nodeId })).result?.node)
      .toMatchObject({ localName: 'fiber', attributes: ['uid', '3003'] })
  })

  it('suppresses unrelated Client notifications while retaining selected node identities', (test) => {
    const h = scopedTreeFixture(test)
    h.publish(h.host, 1001)
    h.publish(h.a, 3003)
    const scoped = h.scope(h.a)
    const selectedId = scoped.nodeForObject(h.a, h.reference)!.backendNodeId
    const changes: CordisDomChange[] = []
    scoped.subscribe((event) => { changes.push(event) })
    h.publish(h.b, 2002)
    h.publish(h.b, 2003, 2)
    h.store.close(h.b, 'other Client closed')
    expect(changes).toEqual([])
    expect(scoped.nodeForObject(h.a, h.reference)?.backendNodeId).toBe(selectedId)
    h.publish(h.host, 1002, 2)
    expect(changes).toMatchObject([{ type: 'tree-mutated', mutations: [{ type: 'attribute-modified', value: '1002' }] }])
    changes.length = 0
    h.store.close(h.host, 'Host closed')
    expect(changes).toMatchObject([{ type: 'source-disconnected', source: h.host }])
  })

  it('retains a disconnected Client tree and replaces object routes on reconnect', (test) => {
    const h = scopedTreeFixture(test)
    const scoped = h.scope(h.a)
    expect(scoped.nodeForObjectKind('client', h.reference)).toBeUndefined()
    h.publish(h.a, 3003)
    const oldId = scoped.nodeForObject(h.a, h.reference)!.backendNodeId
    const changes: CordisDomChange[] = []
    scoped.subscribe((event) => { changes.push(event) })
    h.store.close(h.a, 'Client closed')
    expect(changes).toMatchObject([
      { type: 'source-disconnected', source: h.a },
      { type: 'tree-mutated', mutations: [{ type: 'attribute-modified', name: 'disconnected', value: '' }] },
    ])
    expect(scoped.document().byBackendId.get(oldId)?.object?.connection).toEqual({ state: 'disconnected', reason: 'Client closed' })
    expect(scoped.nodeForObject(h.a, h.reference)).toBeUndefined()
    expect(scoped.nodeForObjectKind('client', h.reference)).toBeUndefined()
    const reconnected = source('scope-a', 'generation-2')
    h.publish(reconnected, 3004)
    expect(scoped.document().root.children[1]!.children).toHaveLength(1)
    expect(scoped.nodeForObject(h.a, h.reference)).toBeUndefined()
    expect(scoped.document().byBackendId.has(oldId)).toBe(false)
    expect(scoped.nodeForObjectKind('client', h.reference)?.object?.source).toBe(reconnected)
    expect(scoped.nodeForObject(reconnected, h.reference)?.backendNodeId).not.toBe(oldId)
    changes.length = 0
    h.store.close(h.a, 'late old-generation close')
    expect(changes).toEqual([])
  })

  it('observes selected snapshot eviction caused by another Client without forwarding its disconnect', (test) => {
    const h = scopedTreeFixture(test)
    h.publish(h.a, 3003)
    const scoped = h.scope(h.a)
    h.store.close(h.a, 'selected Client closed')
    const changes: CordisDomChange[] = []
    scoped.subscribe((event) => { changes.push(event) })
    h.publish(h.b, 2002)
    expect(changes).toEqual([])
    h.store.close(h.b, 'other Client closed')
    expect(scoped.document().root.children[1]!.children).toEqual([])
    expect(changes).toMatchObject([{ type: 'tree-mutated', mutations: [{ type: 'child-removed' }] }])
    expect(h.store.tree().clients.map(tree => tree.source.sourceId)).toEqual([h.b.sourceId])
  })

  it('closes each scoped subscription independently of its parent, siblings, and shared store', (test) => {
    const h = scopedTreeFixture(test)
    h.publish(h.a, 3003)
    h.publish(h.b, 2002)
    const a = h.scope(h.a)
    const b = h.scope(h.b)
    const closedDocument = a.document()
    const changes: CordisDomChange[] = []
    a.subscribe((event) => { changes.push(event) })
    a.close()
    a.close()
    h.publish(h.a, 3004, 2)
    expect(a.document()).toBe(closedDocument)
    expect(changes).toEqual([])
    expect(h.global.nodeForObject(h.a, h.reference)?.children[0]?.attributes).toEqual([['uid', '3004']])
    const globalDocument = h.global.document()
    h.global.close()
    h.publish(h.b, 2003, 2)
    expect(h.global.document()).toBe(globalDocument)
    expect(b.nodeForObject(h.b, h.reference)?.children[0]?.attributes).toEqual([['uid', '2003']])
    expect(h.store.tree().clients).toHaveLength(2)
  })
})

function scopedTreeFixture(test: TestContext) {
  const store = new CordisTreeStore({ maxNodes: 100, maxDisconnectedTrees: 1 })
  const global = new CordisDomBackend(store)
  test.onTestFinished(() => { global.close() })
  const snapshot = (uid: number, revision: number): InspectorJsonValue => ({
    schemaVersion: 0, revision, objectRegistryId: 'shared-registry', truncated: false,
    root: { kind: 'context', objectHandle: 'root', children: [
      { kind: 'fiber', uid, objectHandle: 'fiber', children: [{ kind: 'context', objectHandle: 'context', children: [] }] },
    ] },
  })
  const parsed = parseCordisTreeSnapshot(snapshot(1, 1), 100)
  return {
    store, global,
    a: source('scope-a', 'generation-1'), b: source('scope-b', 'generation-1'),
    host: { ...source('scope-host', 'generation-1'), kind: 'host' as const },
    reference: { registryId: parsed.objectRegistryId, handle: parsed.root.objectHandle },
    publish(subject: InspectorSourceDescriptor, uid: number, revision = 1) {
      store.append(subject, [{ sequence: revision, monotonicMs: revision, topic: 'cordis/tree', payload: snapshot(uid, revision) }])
    },
    scope(subject: InspectorSourceDescriptor) {
      const backend = global.forClient(subject.sourceId)
      test.onTestFinished(() => { backend.close() })
      return backend
    },
  }
}

function scopedDomCalls(backend: CordisDomBackend, test: TestContext, events: CdpMessage[] = []) {
  const disposers: (() => void)[] = []
  test.onTestFinished(() => { for (const dispose of disposers.reverse()) dispose() })
  const sources = new InspectorSourceRegistry([], 16_384, 100)
  disposers.push(() => { sources.close() })
  const clients = new ClientRuntimeRouter(sources, test.task.timeout)
  disposers.push(() => { clients.close() })
  const clientSources = new ClientSourceRouter(sources, test.task.timeout, 16_384, 16_384)
  disposers.push(() => { clientSources.close() })
  const registry = new InspectorRealmRegistry(new HostInspectorRealm('Host'), clients, clientSources)
  disposers.push(() => { registry.close() })
  const realms = new InspectorRealmSessionSet(registry)
  disposers.push(() => { realms.close() })
  let nextId = 0
  const pending = new Map<number, (response: CdpMessage) => void>()
  const transport = {
    send(payload: unknown) {
      const message = payload as CdpMessage
      if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id) }
      else events.push(message)
    },
    close() {},
  }
  const runtime = new RuntimeDomainSession(transport, realms)
  disposers.push(() => { runtime.close() })
  const dom = new CordisDomSession(transport, backend, runtime)
  disposers.push(() => { dom.close() })
  return (method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> => {
    const id = ++nextId
    return new Promise((resolve) => { pending.set(id, resolve); dom.handle({ id, method, params }) })
  }
}

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
