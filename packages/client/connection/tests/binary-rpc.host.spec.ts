import { request } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { createWebConnectionRpc } from '../src/client/rpc.ts'
import { bridge } from '../src/http-bridge.ts'
import type { ConnectionRpcHandlerResult, ConnectionRpcResult } from '../src/rpc.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

function binaryResponse(rpcId: string, mutate: (parts: FormData) => void = () => {}): Response {
  const parts = new FormData()
  parts.set('metadata', JSON.stringify({
    type: 'server-response', rpcId, result: { ok: true, value: { offset: 7, data: null } },
    attachments: [{ path: ['data'], codec: 'bytes', part: 'bytes-0' }],
  }))
  parts.set('bytes-0', new Blob([new Uint8Array([0, 128, 255])]))
  mutate(parts)
  return new Response(parts)
}

describe('Connection binary RPC', () => {
  it.each(['gzip', 'none'] as const)('preserves %s configuration through the HTTP bridge', async (compression) => {
    const ctx = new Context()
    try {
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression })
      await ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) })
      const connection = ctx.get('connection') as HostConnectionService
      const data = new Uint8Array(1024 * 1024).fill(65)
      data.set([0, 128, 255])
      connection.rpc.intercept('/api', endpoint => endpoint === 'fixture/read', async () => ({
        ok: true,
        value: { data: null, bytes: data.length },
        attachments: [{ path: ['data'], bytes: data }],
      }))
      const handler = connection.createSharedFetchHandler('/api')
      ctx.webServer.register({ kind: 'prefix', path: '/api', handler: (req, res) => bridge(req, res, handler) })
      let transferred = 0
      let encoding: string | undefined
      const rpc = createWebConnectionRpc((path, init) => new Promise((resolve, reject) => {
        const req = request(new URL(path, `http://127.0.0.1:${ctx.webServer.port}`), {
          method: init.method,
          headers: { ...Object.fromEntries(new Headers(init.headers)), 'accept-encoding': 'gzip' },
        }, (response) => {
          void (async () => {
            const chunks: Buffer[] = []
            for await (const chunk of response) chunks.push(chunk as Buffer)
            const body = Buffer.concat(chunks)
            transferred = body.length
            encoding = response.headers['content-encoding']
            return new Response(encoding === 'gzip' ? gunzipSync(body) : body, {
              status: response.statusCode!,
              headers: { 'content-type': response.headers['content-type']! },
            })
          })().then(resolve, reject)
        })
        req.once('error', reject)
        req.end(init.body as string)
      }))
      expect(await rpc.call('/api', 'fixture/read', {})).toEqual({ ok: true, value: { data, bytes: data.length } })
      if (compression === 'gzip') {
        expect(encoding).toBe('gzip')
        expect(transferred).toBeLessThan(data.length / 10)
      } else {
        expect(encoding).toBeUndefined()
        expect(transferred).toBeGreaterThan(data.length)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('roundtrips raw bytes and metadata on the existing channel while JSON results and errors stay JSON', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) })
    await fiber.await()
    try {
      const connection = ctx.get('connection') as HostConnectionService
      const byteValues = [
        new Uint8Array([9, 0, 128, 255, 9]).subarray(1, 4),
        new Uint8Array(new SharedArrayBuffer(3)).fill(255),
        new Uint8Array(),
      ]
      const cases: readonly {
        readonly sent: ConnectionRpcHandlerResult
        readonly expected: ConnectionRpcResult<unknown>
      }[] = [
        ...byteValues.map((data, index) => ({
          sent: {
            ok: true as const,
            value: { data: null, offset: index === 0 ? 7 : 0, eof: index !== 0, bytes: index === 0 ? 42 : data.length },
            attachments: [{ path: ['data'], bytes: data }],
          },
          expected: {
            ok: true as const,
            value: { data, offset: index === 0 ? 7 : 0, eof: index !== 0, bytes: index === 0 ? 42 : data.length },
          },
        })),
        { sent: { ok: true, value: { data: 'AID/', encoding: 'base64' } }, expected: { ok: true, value: { data: 'AID/', encoding: 'base64' } } },
        { sent: { ok: true, value: { count: 4 } }, expected: { ok: true, value: { count: 4 } } },
        { sent: { ok: true, value: null }, expected: { ok: true, value: null } },
        { sent: { ok: true, value: 'plain' }, expected: { ok: true, value: 'plain' } },
        {
          sent: { ok: false, error: { code: 'fixture/denied', message: 'denied', details: { path: 'private' } } },
          expected: { ok: false, error: { code: 'fixture/denied', message: 'denied', details: { path: 'private' } } },
        },
      ]
      let next: ConnectionRpcHandlerResult = cases[0]!.sent
      connection.rpc.intercept('/api', endpoint => endpoint === 'fixture/read', async () => next)
      const shared = connection.createSharedFetchHandler('/api')
      const mediaTypes: (string | null)[] = []
      const rpc = createWebConnectionRpc(async (url, init) => {
        const response = await shared.fetch(new Request(new URL(url, 'http://host'), init))
        mediaTypes.push(response.headers.get('content-type'))
        return response
      })
      for (const { sent, expected } of cases) {
        next = sent
        const received = await rpc.call('/api', 'fixture/read', { args: {} })
        expect(received).toEqual(expected)
        if (received.ok && typeof received.value === 'object' && received.value !== null
          && 'data' in received.value && received.value.data instanceof Uint8Array) {
          expect(received.value.data.buffer).toBeInstanceOf(ArrayBuffer)
        }
      }
      expect(mediaTypes.slice(0, 3).every(type => type?.startsWith('multipart/form-data;'))).toBe(true)
      expect(mediaTypes.slice(3)).toEqual(Array(5).fill('application/json'))
    } finally {
      await fiber.dispose()
    }
  })

  it('frames attachments already projected by the result owner', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) })
    await fiber.await()
    try {
      const connection = ctx.get('connection') as HostConnectionService
      const content = Buffer.from([9, 0, 128, 255, 9]).subarray(1, 4)
      connection.rpc.intercept('/api', () => true, async () => ({
        ok: true,
        value: { content: null, metadata: { count: 1 } },
        attachments: [{ path: ['content'], bytes: content }],
      }))
      const handler = connection.createSharedFetchHandler('/api')
      const rpc = createWebConnectionRpc((url, init) => handler.fetch(new Request(new URL(url, 'http://host'), init)))
      expect(await rpc.call('/api', 'fixture/read', {})).toEqual({
        ok: true, value: { content: new Uint8Array([0, 128, 255]), metadata: { count: 1 } },
      })
    } finally {
      await fiber.dispose()
    }
  })

  it.each([
    ['missing bytes', (p: FormData) => { p.delete('bytes-0') }],
    ['text bytes', (p: FormData) => { p.set('bytes-0', 'AID/') }],
    ['missing metadata', (p: FormData) => { p.delete('metadata') }],
    ['file metadata', (p: FormData) => { p.set('metadata', new Blob(['{}'])) }],
    ['duplicate metadata', (p: FormData) => { p.append('metadata', '{}') }],
    ['duplicate bytes', (p: FormData) => { p.append('bytes-0', new Blob()) }],
    ['extra part', (p: FormData) => { p.set('extra', 'unclaimed') }],
    ['invalid JSON', (p: FormData) => { p.set('metadata', '{') }],
    ['invalid envelope', (p: FormData) => { p.set('metadata', '{}') }],
    ...[
      { ok: false, error: { code: 'fixture/error', message: 'failed', details: {} } },
      { ok: true, value: null },
      { ok: true, value: [] },
      { ok: true, value: { data: 'duplicate' } },
    ].map(result => ['invalid result', (p: FormData) => { p.set('metadata', JSON.stringify({
      type: 'server-response', rpcId: 'fixture', result,
    })) }] as const),
  ] satisfies readonly (readonly [string, (parts: FormData) => void])[])('rejects malformed multipart: %s', async (_name, mutate) => {
    const rpc = createWebConnectionRpc(async (_url, init) => {
      const message = JSON.parse(init.body as string) as { rpcId: string }
      return binaryResponse(message.rpcId, mutate)
    })
    await expect(rpc.call('/api', 'fixture/read', {})).rejects.toThrow(/invalid binary response|invalid server-response|JSON/)
  })

  it('rejects a binary response for another request', async () => {
    const rpc = createWebConnectionRpc(async () => binaryResponse('unrelated'))
    await expect(rpc.call('/api', 'fixture/read', {})).rejects.toThrow('rpcId mismatch')
  })

  it('roundtrips nested, optional and root attachment paths without reserving field names', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) })
    await fiber.await()
    try {
      const data = new Uint8Array([0, 128, 255])
      const second = Buffer.from([9, 2, 3, 9]).subarray(1, 3)
      let next: ConnectionRpcHandlerResult = {
        ok: true,
        value: {
          files: [{ name: 'a.png', content: null }, { name: 'b.png', content: null }, { name: 'empty' }],
          'dots./[]': [null, null, [null]],
          metadata: { attachments: { content: null } },
          ...JSON.parse('{"__proto__":null,"constructor":null}') as object,
        },
        attachments: [
          { path: ['files', 0, 'content'], bytes: data },
          { path: ['files', 1, 'content'], bytes: second },
          { path: ['dots./[]', 0], bytes: new Uint8Array() },
          { path: ['dots./[]', 2, 0], bytes: data },
          { path: ['metadata', 'attachments', 'content'], bytes: data },
          { path: ['__proto__'], bytes: data },
        ],
      }
      const connection = ctx.get('connection') as HostConnectionService
      connection.rpc.intercept('/api', () => true, async () => next)
      const handler = connection.createSharedFetchHandler('/api')
      const rpc = createWebConnectionRpc((url, init) => handler.fetch(new Request(new URL(url, 'http://host'), init)))
      const expected = {
        files: [{ name: 'a.png', content: data }, { name: 'b.png', content: new Uint8Array([2, 3]) }, { name: 'empty' }],
        'dots./[]': [new Uint8Array(), null, [data]],
        metadata: { attachments: { content: data } },
        ...JSON.parse('{"__proto__":null,"constructor":null}') as object,
      }
      Object.defineProperty(expected, '__proto__', { value: data, enumerable: true })
      expect(await rpc.call('/api', 'fixture/read', {})).toEqual({ ok: true, value: expected })
      for (const bytes of [data, Buffer.from([0, 128, 255]), new Uint8Array(new SharedArrayBuffer(3))]) {
        next = { ok: true, value: null, attachments: [{ path: [], bytes }] }
        const response = await rpc.call('/api', 'fixture/read', {})
        expect(response).toEqual({ ok: true, value: new Uint8Array(bytes) })
        if (!response.ok || !(response.value instanceof Uint8Array)) throw new Error('expected root bytes')
        expect(response.value.buffer).toBeInstanceOf(ArrayBuffer)
        expect(Object.isFrozen(response.value)).toBe(false)
      }
      next = {
        ok: true,
        value: [null, [null]],
        attachments: [{ path: [0], bytes: data }, { path: [1, 0], bytes: data }],
      }
      expect(await rpc.call('/api', 'fixture/read', {})).toEqual({ ok: true, value: [data, [data]] })
    } finally {
      await fiber.dispose()
    }
  })

  it.each([
    ['absent table', { attachments: undefined }],
    ['non-array table', { attachments: {} }],
    ['empty table', { attachments: [] }],
    ...[
      null, {}, { path: ['data'], codec: 'numpy', part: 'bytes-0' },
      { path: ['data'], codec: 'bytes', part: 0 },
      { path: ['data'], codec: 'bytes', part: 'metadata' },
      { path: 'data', codec: 'bytes', part: 'bytes-0' },
      ...[['missing'], ['offset', 'child'], ['constructor', 'prototype'], [0], ['files', '0'], ['files', -1], ['files', 0.5], ['files', 1], ['files', false], ['files', null]].map(path => ({ path, codec: 'bytes', part: 'bytes-0' })),
    ].map(attachment => ['invalid attachment', { attachments: [attachment] }] as const),
    ['duplicate part', { attachments: [0, 1].map(() => ({ path: ['data'], codec: 'bytes', part: 'bytes-0' })) }],
    ['duplicate path', { attachments: [0, 1].map(i => ({ path: ['data'], codec: 'bytes', part: `bytes-${i}` })) }],
    ['overlapping path', { attachments: [
      { path: ['data'], codec: 'bytes', part: 'bytes-0' },
      { path: ['data', '0'], codec: 'bytes', part: 'bytes-1' },
    ] }],
    ['occupied placeholder', { result: { ok: true, value: { data: 'AID/' } } }],
  ] satisfies readonly (readonly [string, Record<string, unknown>])[])('rejects malformed attachment metadata: %s', async (_name, overrides) => {
    const rpc = createWebConnectionRpc(async (_url, init) => {
      const { rpcId } = JSON.parse(init.body as string) as { rpcId: string }
      return binaryResponse(rpcId, (parts) => {
        const metadata = JSON.parse(parts.get('metadata') as string) as Record<string, unknown>
        parts.set('metadata', JSON.stringify({ ...metadata, result: { ok: true, value: { data: null, offset: 7, files: [null] } }, ...overrides }))
        if (_name === 'duplicate path' || _name === 'overlapping path') parts.set('bytes-1', new Blob())
      })
    })
    await expect(rpc.call('/api', 'fixture/read', {})).rejects.toThrow('invalid binary response')
  })

  it('rejects truncated multipart and late bytes after caller cancellation', async () => {
    const broken = createWebConnectionRpc(async () => new Response('truncated', {
      headers: { 'content-type': 'multipart/form-data; boundary=fixture' },
    }))
    await expect(broken.call('/api', 'fixture/read', {})).rejects.toThrow()
    const abort = new AbortController()
    const rpc = createWebConnectionRpc(async (_url, init) => {
      const message = JSON.parse(init.body as string) as { rpcId: string }
      abort.abort(new Error('caller left'))
      return binaryResponse(message.rpcId)
    })
    await expect(rpc.call('/api', 'fixture/read', {}, abort.signal)).rejects.toThrow('caller left')
  })
})
