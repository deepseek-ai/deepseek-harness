// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { ClientRealmSource } from '../src/client/inspection/realm.ts'
import type { InspectorClientBootstrap } from '../src/shared/bridge/messages/control.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly sockets: FakeWebSocket[] = []

  readonly sent: string[] = []
  readonly url: string
  readonly protocol: string
  readyState = FakeWebSocket.CONNECTING
  bufferedAmount = 0

  constructor(url: string | URL, protocols?: string | string[]) {
    super()
    this.url = String(url)
    this.protocol = typeof protocols === 'string' ? protocols : protocols?.[0] ?? ''
    FakeWebSocket.sockets.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }
}

const bootstrap: InspectorClientBootstrap = {
  endpoint: 'ws://127.0.0.1:9230/ingest',
  protocol: 'dsh-inspector-v0-token',
  maxQueuedRecords: 16,
  maxQueuedBytes: 16_384,
  maxRecordsPerFrame: 8,
  maxFrameBytes: 32_768,
  reconnectBaseMs: 10,
  reconnectMaxMs: 20,
  queryTimeoutMs: 100,
  maxRuntimeObjectsPerSession: 100,
  maxRuntimePropertiesPerResult: 100,
  maxClientSourceBytes: 1_048_576,
  maxCordisNodes: 100,
}

describe('experimental Inspector Client plugin', () => {
  const nativeWebSocket = globalThis.WebSocket
  const nativeFetch = globalThis.fetch

  afterEach(() => {
    vi.restoreAllMocks()
    FakeWebSocket.sockets.length = 0
    globalThis.WebSocket = nativeWebSocket
    globalThis.fetch = nativeFetch
    sessionStorage.clear()
    delete globalThis.__DSH_INSPECTOR__
    Reflect.deleteProperty(globalThis, '__DSH_BOOT__')
  })

  it('provides ctx.inspector and sends observations after the Worker accepts the source', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.__DSH_INSPECTOR__ = bootstrap
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const socket = FakeWebSocket.sockets[0]!
    expect(socket.url).toBe(bootstrap.endpoint)
    expect(socket.protocol).toBe(bootstrap.protocol)
    socket.open()
    const open = JSON.parse(socket.sent[0]!) as {
      source: { sourceId: string; generation: string }
    }
    socket.receive({
      v: 0,
      t: 'source/accepted',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
    })
    expect(JSON.parse(socket.sent[1]!) as unknown).toMatchObject({
      t: 'source/replace',
      records: [{ topic: 'cordis/tree', payload: { schemaVersion: 0, truncated: false } }],
    })

    const treePromise = ctx.inspector.cordis.getTree()
    const treeRequest = socket.sent.map(value => JSON.parse(value) as { t: string; requestId?: string })
      .find(frame => frame.t === 'query/request')
    expect(treeRequest?.requestId).toBeTypeOf('string')
    socket.receive({
      v: 0,
      t: 'query/response',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
      requestId: treeRequest!.requestId,
      outcome: {
        ok: true,
        result: { op: 'cordis-tree/get', tree: { schemaVersion: 0, host: null, clients: [] } },
      },
    })
    await expect(treePromise).resolves.toEqual({ schemaVersion: 0, host: null, clients: [] })

    ctx.inspector.publish('client/probe', { ready: true }, 7)
    const append = socket.sent.map(value => JSON.parse(value) as {
      t: string
      records: Array<{ topic: string; monotonicMs: number; payload: unknown }>
    }).find(frame => frame.t === 'source/append'
      && frame.records.some(record => record.topic === 'client/probe'))
    expect(append).toMatchObject({
      t: 'source/append',
      records: [{ topic: 'client/probe', monotonicMs: 7, payload: { ready: true } }],
    })

    document.title = 'Inspector Client Realm'
    socket.receive({
      v: 0,
      t: 'client-runtime/request',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
      sessionId: 'devtools-1',
      requestId: 'runtime-1',
      command: { op: 'evaluate', expression: 'document.title', returnByValue: true },
    })
    await vi.waitFor(() => {
      const response = socket.sent.map(value => JSON.parse(value) as { requestId?: string })
        .find(frame => frame.requestId === 'runtime-1')
      expect(response).toMatchObject({
        t: 'client-runtime/response',
        sessionId: 'devtools-1',
        requestId: 'runtime-1',
        outcome: {
          ok: true,
          result: { op: 'evaluate', completion: { result: { descriptor: { value: 'Inspector Client Realm' } } } },
        },
      })
    })

    await fiber.dispose()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ t: 'source/close' })
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('keeps the realm source id and rotates the transport generation on reconnect', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.__DSH_INSPECTOR__ = bootstrap
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const firstSocket = FakeWebSocket.sockets[0]!
    firstSocket.open()
    const firstOpen = JSON.parse(firstSocket.sent[0]!) as {
      source: { sourceId: string; generation: string }
    }

    firstSocket.close()
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(2) })
    const secondSocket = FakeWebSocket.sockets[1]!
    secondSocket.open()
    const secondOpen = JSON.parse(secondSocket.sent[0]!) as {
      source: { sourceId: string; generation: string }
    }
    expect(secondOpen.source.sourceId).toBe(firstOpen.source.sourceId)
    expect(secondOpen.source.generation).not.toBe(firstOpen.source.generation)

    await fiber.dispose()
  })

  it('keeps the logical source id when the Client plugin is recreated after a page refresh', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.__DSH_INSPECTOR__ = bootstrap
    const firstContext = new Context()
    const firstFiber = firstContext.plugin({ apply })
    await firstFiber.await()
    const firstSocket = FakeWebSocket.sockets[0]!
    firstSocket.open()
    const firstOpen = JSON.parse(firstSocket.sent[0]!) as {
      source: { sourceId: string; generation: string }
    }
    await firstFiber.dispose()

    const secondContext = new Context()
    const secondFiber = secondContext.plugin({ apply })
    await secondFiber.await()
    const secondSocket = FakeWebSocket.sockets[1]!
    secondSocket.open()
    const secondOpen = JSON.parse(secondSocket.sent[0]!) as {
      source: { sourceId: string; generation: string }
    }

    expect(secondOpen.source.sourceId).toBe(firstOpen.source.sourceId)
    expect(secondOpen.source.generation).not.toBe(firstOpen.source.generation)
    await secondFiber.dispose()
  })

  it('rotates a copied session identity while its original page remains live', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
    const held = new Set<string>()
    const request = async (
      name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => unknown,
    ): Promise<unknown> => {
      const acquired = !held.has(name)
      if (acquired) held.add(name)
      try {
        return await callback(acquired ? { name, mode: 'exclusive' } : null)
      } finally {
        if (acquired) held.delete(name)
      }
    }
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    })
    let first: ClientRealmSource | undefined
    let duplicate: ClientRealmSource | undefined
    let refreshed: ClientRealmSource | undefined
    try {
      first = await ClientRealmSource.claim('first')
      duplicate = await ClientRealmSource.claim('duplicate')
      expect(duplicate.sourceId).not.toBe(first.sourceId)

      first.close()
      await vi.waitFor(() => { expect(held.size).toBe(1) })
      sessionStorage.setItem('dsh.experimental-inspector.client-source-id.v0', first.sourceId)
      refreshed = await ClientRealmSource.claim('refreshed')
      expect(refreshed.sourceId).toBe(first.sourceId)
    } finally {
      first?.close()
      duplicate?.close()
      refreshed?.close()
      if (descriptor === undefined) Reflect.deleteProperty(navigator, 'locks')
      else Object.defineProperty(navigator, 'locks', descriptor)
    }
  })

  it('falls back to a page-lifetime source id when session storage is unavailable', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.__DSH_INSPECTOR__ = bootstrap
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('storage disabled', 'SecurityError')
    })
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const socket = FakeWebSocket.sockets[0]!
    socket.open()
    const open = JSON.parse(socket.sent[0]!) as { source: { sourceId: string } }

    expect(open.source.sourceId).toMatch(/^client-/u)
    await fiber.dispose()
  })

  it('cancels an outstanding Client Runtime operation without sending a late response', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.__DSH_INSPECTOR__ = bootstrap
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const socket = FakeWebSocket.sockets[0]!
    socket.open()
    const open = JSON.parse(socket.sent[0]!) as {
      source: { sourceId: string; generation: string }
    }
    socket.receive({
      v: 0,
      t: 'source/accepted',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
    })
    socket.receive({
      v: 0,
      t: 'client-runtime/request',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
      sessionId: 'devtools-cancel',
      requestId: 'runtime-cancel',
      command: { op: 'evaluate', expression: 'new Promise(() => {})', awaitPromise: true },
    })
    socket.receive({
      v: 0,
      t: 'client-runtime/cancel',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
      sessionId: 'devtools-cancel',
      requestId: 'runtime-cancel',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(socket.sent.map(value => JSON.parse(value) as { requestId?: string })
      .some(frame => frame.requestId === 'runtime-cancel')).toBe(false)

    socket.receive({
      v: 0,
      t: 'client-runtime/request',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
      sessionId: 'devtools-cancel',
      requestId: 'runtime-after-cancel',
      command: { op: 'evaluate', expression: '42', returnByValue: true },
    })
    await vi.waitFor(() => {
      expect(socket.sent.map(value => JSON.parse(value) as { requestId?: string })
        .some(frame => frame.requestId === 'runtime-after-cancel')).toBe(true)
    })

    await fiber.dispose()
  })

  it('does not report queue loss again after a replacement absorbs it', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.__DSH_INSPECTOR__ = { ...bootstrap, maxQueuedRecords: 1 }
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const socket = FakeWebSocket.sockets[0]!

    ctx.inspector.publish('client/first', { ordinal: 1 })
    ctx.inspector.publish('client/second', { ordinal: 2 })
    socket.open()
    const open = JSON.parse(socket.sent[0]!) as {
      source: { sourceId: string; generation: string }
    }
    socket.receive({
      v: 0,
      t: 'source/accepted',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
    })

    const replacement = JSON.parse(socket.sent[1]!) as { nextSequence: number }
    const append = JSON.parse(socket.sent[2]!) as {
      firstSequence: number
      droppedBefore: number
      records: Array<{ topic: string }>
    }
    expect(append).toMatchObject({
      firstSequence: replacement.nextSequence,
      droppedBefore: 0,
      records: [{ topic: 'client/second' }],
    })

    await fiber.dispose()
  })

  it('discovers and serves its built Client bundle through the source protocol', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.__DSH_INSPECTOR__ = bootstrap
    Reflect.set(globalThis, '__DSH_BOOT__', {
      rev: 'graph',
      entries: [{
        id: '@deepseek-ai/dsh-experimental-inspector',
        url: 'plugins/@deepseek-ai/dsh-experimental-inspector/client.js?rev=bundle-rev',
        rev: 'bundle-rev',
      }],
    })
    const source = 'const clientBundleMarker = "你好"\n'
    const sourceMap = '{"version":3,"sources":["client/index.ts"]}'
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return new Response(url.includes('.js.map') ? sourceMap : source)
    })

    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const socket = FakeWebSocket.sockets[0]!
    socket.open()
    const open = JSON.parse(socket.sent[0]!) as {
      source: { sourceId: string; generation: string; capabilities: Array<{ type: string }> }
    }
    expect(open.source.capabilities).toEqual(expect.arrayContaining([{ type: 'client-sources' }]))
    socket.receive({
      v: 0,
      t: 'source/accepted',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
    })
    socket.receive({
      v: 0,
      t: 'client-sources/request',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
      sessionId: 'source-session-1',
      requestId: 'source-request-1',
      command: { op: 'list-scripts' },
    })

    let scriptKey: string | undefined
    await vi.waitFor(() => {
      const response = socket.sent.map(value => JSON.parse(value) as {
        requestId?: string
        outcome?: { result?: { scripts?: Array<{ scriptKey: string; url: string; sourceMapUrl: string }> } }
      }).find(frame => frame.requestId === 'source-request-1')
      const script = response?.outcome?.result?.scripts?.[0]
      expect(script?.url).toContain('/plugins/@deepseek-ai/dsh-experimental-inspector/client.js?rev=bundle-rev')
      expect(script?.sourceMapUrl)
        .toContain('/plugins/@deepseek-ai/dsh-experimental-inspector/client.js.map?rev=bundle-rev')
      scriptKey = script?.scriptKey
    })
    socket.receive({
      v: 0,
      t: 'client-sources/request',
      sourceId: open.source.sourceId,
      generation: open.source.generation,
      sessionId: 'source-session-1',
      requestId: 'source-request-2',
      command: { op: 'get-content-chunk', scriptKey, content: 'source', offset: 0, maxBytes: 1_024 },
    })
    await vi.waitFor(() => {
      const response = socket.sent.map(value => JSON.parse(value) as {
        requestId?: string
        outcome?: { result?: { data?: string; eof?: boolean } }
      }).find(frame => frame.requestId === 'source-request-2')
      expect(response?.outcome?.result?.eof).toBe(true)
      const bytes = Uint8Array.from(atob(response?.outcome?.result?.data ?? ''), character => character.charCodeAt(0))
      expect(new TextDecoder().decode(bytes)).toBe(source)
    })

    await fiber.dispose()
  })

  it('fails loud when the Host did not inject a bootstrap', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await expect(fiber).rejects.toThrow('Host bootstrap is missing; reload the page after enabling the Inspector')
    await fiber.dispose()
  })

  it('closes the Client source when a later plugin registration fails', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.__DSH_INSPECTOR__ = bootstrap
    const ctx = new Context()
    ctx.provide('inspector', {
      publish: () => undefined,
      cordis: { getTree: () => Promise.reject(new Error('unused test service')) },
    })

    const fiber = ctx.plugin({ apply })
    await expect(fiber.await()).rejects.toThrow('service "inspector" has been registered')
    expect(FakeWebSocket.sockets).toHaveLength(1)
    expect(FakeWebSocket.sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED)
    await fiber.dispose()
  })
})
