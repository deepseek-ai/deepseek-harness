/** Non-page Clients use one credential across independent HTTP and WebSocket transports. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { installConnection, type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { RemoteResult, RemoteStreamHandle, TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import { apply, inject } from '../src/client/index.ts'
import { parseRemoteStreamClientMessage } from '../src/stream-protocol.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'nodeProbe/read': () => Promise<RemoteResult<string>>
    'nodeProbe/watch': () => RemoteStreamHandle<string, never>
  }
  interface TypertRemoteNamespaceMap {
    nodeProbe: TypertRemoteNamespace<'nodeProbe'>
  }
}

describe('authenticated Node Client', () => {
  it.each(['none', 'answer'] as const)('finishes unary HTTP while the %s lifecycle socket is still connecting', async (interactions) => {
    const fixture = await nodeFixture(interactions)
    try {
      await fixture.upgrading.promise
      await expect(fixture.ctx.remote.nodeProbe.read()).resolves.toEqual({ ok: true, value: 'authenticated' })
      expect(fixture.socket?.readyState).toBe(WebSocket.CONNECTING)
      expect(fixture.cookies).toEqual(['fixture=credential', 'fixture=credential'])
      expect(fixture.endpoints).toEqual([])
      fixture.upgrade()
      await once(fixture.socket!, 'open')
      if (interactions === 'answer') {
        await vi.waitFor(() => { expect(fixture.connection.generation.getSnapshot()?.host.home).toBe('/home/node') })
        expect(fixture.endpoints).toEqual(['$events'])
      } else {
        expect(fixture.connection.generation.getSnapshot()).toBeUndefined()
        expect(() => fixture.ctx.remote.$on('fixture/approval' as never, () => {})).toThrow('interactions=answer')
        const open = vi.fn(() => fixture.ctx.remote.nodeProbe.watch())
        expect(() => fixture.ctx.remote.$stream({ name: 'passive', open, ended: () => new Error('ended') }))
          .toThrow('$stream requires interactions=answer')
        expect(open).not.toHaveBeenCalled()
        expect(fixture.endpoints).toEqual([])
      }
      const stream = fixture.ctx.remote.nodeProbe.watch()
      const iterator = stream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toEqual({ done: false, value: 'stream item' })
      if (interactions === 'none') {
        fixture.socket!.close()
        await expect(iterator.next()).rejects.toThrow('WebSocket closed')
        await expect(fixture.ctx.remote.nodeProbe.watch()[Symbol.asyncIterator]().next()).rejects.toThrow('WebSocket closed')
      } else {
        stream.dispose()
        await iterator.return?.()
      }
    } finally {
      await fixture.close()
    }
  })

  it('finishes unary with no WebSocket upgrade and contains Node cancellation until physical close', async () => {
    const fixture = await nodeFixture('none')
    try {
      await fixture.upgrading.promise
      await expect(fixture.ctx.remote.nodeProbe.read()).resolves.toEqual({ ok: true, value: 'authenticated' })
      const socket = fixture.socket!
      const errors: Error[] = []
      socket.on('error', error => errors.push(error))
      await fixture.ctx.fiber.dispose()
      expect(socket.readyState).toBe(WebSocket.CLOSED)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).toContain('closed before the connection was established')
      expect(fixture.endpoints).toEqual([])
    } finally {
      await fixture.close()
    }
  })

  it('contains a synchronous socket factory failure without blocking unary HTTP', async () => {
    const ctx = new Context()
    installConnection(ctx, {
      transport: {
        streamBaseUrl: 'http://127.0.0.1/',
        createWebSocket: () => { throw new Error('socket factory failed') },
        rpc: { call: async () => ({ ok: true, value: 'local HTTP substitute' }) },
      },
    })
    try {
      await ctx.plugin(TypertRegistry)
      await ctx.plugin({ apply, inject })
      await mount(ctx)
      await expect(ctx.remote.nodeProbe.read()).resolves.toEqual({ ok: true, value: 'local HTTP substitute' })
      await expect(ctx.remote.nodeProbe.watch()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        name: 'RemoteStreamCarrierError', cause: { message: 'socket factory failed' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

async function nodeFixture(interactions: 'none' | 'answer') {
  const ctx = new Context()
  const cookies: Array<string | undefined> = []
  const endpoints: string[] = []
  const upgrading = Promise.withResolvers<undefined>()
  const rawSockets = new Set<Duplex>()
  const mux = new WebSocketServer({ noServer: true })
  let upgrade = (): void => { throw new Error('fixture upgrade has not arrived') }
  let socket: WebSocket | undefined
  const server = createServer((request, response) => {
    cookies.push(request.headers.cookie)
    const receive = async (): Promise<void> => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const envelope = z.object({ rpcId: z.string() }).parse(JSON.parse(body))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: 'authenticated' } }))
    }
    void receive().catch((error: unknown) => { response.destroy(error instanceof Error ? error : undefined) })
  })
  server.on('upgrade', (request, rawSocket, head) => {
    cookies.push(request.headers.cookie)
    rawSockets.add(rawSocket)
    rawSocket.on('error', () => { rawSocket.destroy() })
    rawSocket.once('close', () => { rawSockets.delete(rawSocket) })
    upgrade = () => {
      mux.handleUpgrade(request, rawSocket, head, (peer) => {
        peer.on('error', () => { peer.terminate() })
        peer.on('message', (data) => {
          const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8')
          const frame = parseRemoteStreamClientMessage(text)
          if (frame.type !== 'open') return
          endpoints.push(frame.endpoint)
          peer.send(JSON.stringify({
            type: 'item', streamId: frame.streamId,
            value: frame.endpoint === '$events'
              ? { type: 'ready', clientId: 'node-client', host: { home: '/home/node' } } : 'stream item',
          }))
        })
      })
    }
    upgrading.resolve(undefined)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not acquire a port')
  const base = `http://127.0.0.1:${address.port}/mount/`
  const close = async (): Promise<void> => {
    await ctx.fiber.dispose()
    for (const rawSocket of rawSockets) rawSocket.destroy()
    for (const peer of mux.clients) peer.terminate()
    await new Promise<void>((resolve) => { mux.close(() => { resolve() }) })
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  }
  try {
    installConnection(ctx, {
      interactions,
      transport: {
        streamBaseUrl: base,
        fetch: (input, init) => fetch(new URL(input, base), {
          ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie: 'fixture=credential' },
        }),
        createWebSocket: (url) => { socket = new WebSocket(url, { headers: { cookie: 'fixture=credential' } }); return socket },
      },
    })
    await ctx.plugin(TypertRegistry)
    await ctx.plugin({ apply, inject })
    await mount(ctx)
    return {
      ctx, connection: ctx.get('connection') as ConnectionHandle, cookies, endpoints, upgrading,
      get socket() { return socket }, upgrade: () => { upgrade() }, close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

async function mount(ctx: Context): Promise<void> {
  await ctx.remote.$mount({
    package: '@fixture/node', descriptors: ['read', 'watch'].map(method => ({
      id: `@fixture/node#nodeProbe/${method}`, service: 'nodeProbe', namespace: 'nodeProbe', method,
      invocation: { kind: 'direct' }, parameters: [], ...(method === 'watch' ? { mode: 'stream' as const } : {}),
      result: { mode: 'strict', typeSymbol: '@fixture#String', create: () => z.string() },
    })),
  })
}
