/** Connect lifecycle and event ownership through real Loader, HTTP and WebSocket composition. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { z } from 'zod'
import { parseRemoteStreamServerMessage, type RemoteStreamServerMessage } from '../src/stream-protocol.ts'
import { RemoteStreamMuxServer } from '../src/stream-server.ts'
import OperatorConnectFixture from './operator-connect-fixture.ts'

interface SocketClient {
  readonly socket: WebSocket
  readonly closed: Promise<void>
  readonly frames: RemoteStreamServerMessage[]
  readonly errors: Error[]
}
interface Host {
  readonly ctx: Context
  readonly origin: string
  readonly fixture: OperatorConnectFixture
}
const roots: string[] = []
const hosts: Host[] = []
const clients: SocketClient[] = []
const readySchema = z.object({ type: z.literal('ready'), clientId: z.string(), host: z.object({ home: z.string() }) })
const deliverySchema = z.object({
  type: z.literal('waterfall'), eventId: z.string(), request: z.object({ prompt: z.string() }),
})

afterEach(async () => {
  for (const host of hosts) {
    host.fixture.streamCleanup.resolve(undefined)
    for (const finish of host.fixture.holds.values()) finish()
  }
  await Promise.all(clients.splice(0).map(async (client) => {
    if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate()
    await client.closed
  }))
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  for (const root of roots.splice(0)) {
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-operator-connect-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  }
})

describe('operator connect through Loader composition', () => {
  it('admits HTTP before attachment and releases the Operator before slow stream cleanup', async () => {
    const host = await boot()
    const cookie = await exchange(host, 'none')
    await success(host, cookie, 'fixture/identity', { label: 'before' })
    expect(call(host, 'before').peer.interactions).toBe('none')
    expect(call(host, 'before').peer === host.ctx.connection.browserPeer).toBe(false)
    const client = await mux(host, cookie)
    expect(await refusedMux(host, cookie)).toBe(409)
    await success(host, cookie, 'fixture/identity', { label: 'owner-alive' })
    host.fixture.delayStreamCleanup = true
    open(client, 'follow', 'fixture/follow', { label: 'follow' })
    await frame(client, 'follow', 'item')
    await close(client)
    await vi.waitFor(() => { expect(call(host, 'follow').signal.aborted).toBe(true) })
    expect(call(host, 'follow').finished).toBe(false)
    expect((await rpc(host, cookie, 'fixture/identity', { label: 'after' })).status).toBe(401)
    expect(await refusedMux(host, cookie)).toBe(401)
    expect(host.fixture.calls.has('after')).toBe(false)
    await vi.waitFor(() => { expect(host.fixture.effects.size).toBe(0) })
    host.fixture.streamCleanup.resolve(undefined)
    await vi.waitFor(() => { expect(call(host, 'follow').finished).toBe(true) })
  })

  it('reports failed Operator release without retaining its credential or blocking shutdown', async () => {
    const host = await boot()
    const cookie = await exchange(host, 'none')
    await success(host, cookie, 'fixture/identity', { label: 'release-failure' })
    const peer = call(host, 'release-failure').peer
    const dispose = peer.dispose.bind(peer)
    const failure = new Error('fixture Operator disposal failure')
    const disposing = vi.spyOn(peer, 'dispose').mockImplementationOnce(async () => {
      await dispose()
      throw failure
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await close(await mux(host, cookie))
      await vi.waitFor(() => {
        expect(report).toHaveBeenCalledWith('[api-gateway] Peer release failed:', failure)
      })
      expect((await rpc(host, cookie, 'fixture/identity', { label: 'refused' })).status).toBe(401)
      expect(host.fixture.calls.has('refused')).toBe(false)
      expect(host.fixture.effects.size).toBe(0)
      await host.ctx.fiber.dispose()
      expect(disposing).toHaveBeenCalledOnce()
    } finally {
      disposing.mockRestore()
      report.mockRestore()
    }
  })

  it('releases admission when the underlying socket is destroyed before upgrade', async () => {
    const host = await boot()
    const cookie = await exchange(host, 'none')
    const admit = host.ctx.connection.admitConnection.bind(host.ctx.connection)
    const admission = vi.spyOn(host.ctx.connection, 'admitConnection').mockImplementationOnce((request) => {
      const result = admit(request)
      if (!(request instanceof IncomingMessage)) throw new Error('fixture expected a Node upgrade request')
      request.socket.destroy()
      return result
    })
    const upgrade = vi.spyOn(RemoteStreamMuxServer.prototype, 'handleUpgrade')
    try {
      const client = socketClient(host, cookie)
      await client.closed
      expect(client.socket.readyState).toBe(WebSocket.CLOSED)
      expect(upgrade).not.toHaveBeenCalled()
      expect((await rpc(host, cookie, 'fixture/identity', { label: 'refused' })).status).toBe(401)
      expect(host.fixture.calls.has('refused')).toBe(false)
    } finally {
      admission.mockRestore()
      upgrade.mockRestore()
    }
  })

  it('releases admission and closes the socket when the WebSocket upgrade throws', async () => {
    const host = await boot()
    const cookie = await exchange(host, 'none')
    const failure = new Error('fixture WebSocket upgrade failure')
    const upgrade = vi.spyOn(RemoteStreamMuxServer.prototype, 'handleUpgrade').mockImplementationOnce(() => {
      throw failure
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const client = socketClient(host, cookie)
      await client.closed
      expect(client.socket.readyState).toBe(WebSocket.CLOSED)
      expect(report).toHaveBeenCalledWith('[api-gateway] Remote stream upgrade failed:', failure)
      expect((await rpc(host, cookie, 'fixture/identity', { label: 'refused' })).status).toBe(401)
      expect(host.fixture.calls.has('refused')).toBe(false)
      await close(await mux(host, await exchange(host, 'none')))
    } finally {
      upgrade.mockRestore()
      report.mockRestore()
    }
  })

  it('lets an admitted unary finish after its lifecycle socket closes', async () => {
    const host = await boot()
    const cookie = await exchange(host, 'none')
    const client = await mux(host, cookie)
    const pending = rpc(host, cookie, 'fixture/hold', { label: 'inflight' })
    await vi.waitFor(() => { expect(host.fixture.holds.has('inflight')).toBe(true) })
    await close(client)
    expect((await rpc(host, cookie, 'fixture/identity', { label: 'refused' })).status).toBe(401)
    expect(call(host, 'inflight').signal.aborted).toBe(false)
    expect(call(host, 'inflight').finished).toBe(false)
    host.fixture.holds.get('inflight')?.()
    await expect(pending).resolves.toMatchObject({ status: 200, body: { result: { ok: true, value: 'completed' } } })
    expect(call(host, 'inflight').signal.aborted).toBe(false)
  })

  it('forbids passive subscription and results, enforces stream ownership, and accepts an answering page', async () => {
    const host = await boot()
    const passiveCookie = await exchange(host, 'none')
    const passive = await mux(host, passiveCookie)
    const pageCookie = await exchange(host, 'html')
    const page = await mux(host, pageCookie)
    await success(host, pageCookie, 'fixture/identity', { label: 'browser' })
    expect(call(host, 'browser').peer === host.ctx.connection.browserPeer).toBe(true)
    const ready = await events(page)
    const otherCookie = await exchange(host, 'answer')
    const other = await mux(host, otherCookie)
    await events(other)
    open(passive, 'forbidden', '$events', {})
    expect(await frame(passive, 'forbidden', 'error')).toMatchObject({ error: { code: 'gateway/interactions-forbidden' } })
    const pending = host.fixture.pending('approval')
    const delivery = await invocation(page, 'approval')
    const args = { clientId: ready.clientId, eventId: delivery.eventId, outcome: { kind: 'result', value: 'allowed' } }
    for (const cookie of [passiveCookie, otherCookie]) {
      expect(await rpc(host, cookie, '$events/result', args)).toMatchObject({
        body: { result: { ok: false, error: { code: 'gateway/interactions-forbidden' } } },
      })
    }
    await success(host, pageCookie, '$events/result', args)
    await expect(pending).resolves.toEqual({ kind: 'result', value: 'allowed' })
    expect(passive.frames.filter(item => item.type === 'item')).toEqual([])
  })

})

async function boot(): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-operator-connect-'))
  roots.push(root)
  const distIndex = join(root, 'index.html')
  await writeFile(distIndex, '<head></head><body>operator fixture</body>')
  const configPath = join(root, 'cordis.yml')
  const rows = [
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(root, '.credentials.yaml'), watch: false } },
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-client-connection' },
    { name: '@deepseek-ai/dsh-host-frontend-static', config: { distIndex } },
    { name: '@deepseek-ai/dsh-typert-registry' },
    { name: '@deepseek-ai/dsh-api-remote-access' },
    { name: '@deepseek-ai/dsh-api-gateway' },
    { name: '@fixture/operator-connect' },
  ]
  await writeFile(configPath, rows.map(row => `- ${JSON.stringify({ ...row, name: `cordis:${row.name}` })}`).join('\n') + '\n')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  try {
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include,
      '@deepseek-ai/dsh-credentials-local': LocalCredentials,
      '@deepseek-ai/dsh-host-webserver': WebServer,
      '@deepseek-ai/dsh-client-connection': Connection,
      '@deepseek-ai/dsh-host-frontend-static': FrontendStatic,
      '@deepseek-ai/dsh-typert-registry': TypertRegistry,
      '@deepseek-ai/dsh-api-remote-access': RemoteAccess,
      '@deepseek-ai/dsh-api-gateway': TypertGateway,
      '@fixture/operator-connect': OperatorConnectFixture,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect(ctx.webServer.port).toBeGreaterThan(0)
    const host = { ctx, origin: `http://127.0.0.1:${ctx.webServer.port}`, fixture: ctx.operatorConnectFixture }
    hosts.push(host)
    return host
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function exchange(host: Host, mode: 'html' | 'none' | 'answer'): Promise<string> {
  const target = new URL(host.ctx.connection.authenticatedUrl(`${host.origin}${mode === 'html' ? '/' : '/connect'}`))
  if (mode !== 'html') target.searchParams.set('interactions', mode)
  const response = await fetch(target, { redirect: 'manual', headers: { accept: mode === 'html' ? 'text/html' : 'application/json' } })
  expect(response.status).toBe(mode === 'html' ? 303 : 302)
  const cookie = response.headers.get('set-cookie')
  await response.text()
  if (cookie === null) throw new Error('connect omitted its signed cookie')
  return cookie.split(';', 1)[0]!
}

function socketClient(host: Host, cookie: string): SocketClient {
  const socket = new WebSocket(`${host.origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: { cookie } })
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  const frames: RemoteStreamServerMessage[] = []
  const errors: Error[] = []
  socket.on('error', error => errors.push(error))
  socket.on('message', (data) => {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8')
    frames.push(parseRemoteStreamServerMessage(text))
  })
  const client = { socket, closed, frames, errors }
  clients.push(client)
  return client
}

async function mux(host: Host, cookie: string): Promise<SocketClient> {
  const client = socketClient(host, cookie)
  await once(client.socket, 'open')
  return client
}

async function refusedMux(host: Host, cookie: string): Promise<number> {
  const client = socketClient(host, cookie)
  const status = await new Promise<number>((resolve, reject) => {
    client.socket.once('open', () => { reject(new Error('forbidden Mux was admitted')) })
    client.socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
      client.socket.terminate()
    })
    client.socket.once('error', reject)
  })
  await client.closed
  return status
}

async function close(client: SocketClient): Promise<void> {
  client.socket.close()
  await client.closed
  expect(client.errors).toEqual([])
}

function open(client: SocketClient, streamId: string, endpoint: string, args: object): void {
  client.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
}

async function frame(client: SocketClient, streamId: string, type: RemoteStreamServerMessage['type']): Promise<RemoteStreamServerMessage> {
  await vi.waitFor(() => { expect(client.frames.some(frame => frame.streamId === streamId && frame.type === type)).toBe(true) })
  return client.frames.find(frame => frame.streamId === streamId && frame.type === type)!
}

async function events(client: SocketClient): Promise<z.infer<typeof readySchema>> {
  open(client, 'events', '$events', {})
  const ready = await frame(client, 'events', 'item')
  if (ready.type !== 'item') throw new Error('event stream failed to open')
  return readySchema.parse(ready.value)
}

async function invocation(client: SocketClient, label: string): Promise<z.infer<typeof deliverySchema>> {
  let delivery: z.infer<typeof deliverySchema> | undefined
  await vi.waitFor(() => {
    for (const frame of client.frames) {
      if (frame.type !== 'item') continue
      const parsed = deliverySchema.safeParse(frame.value)
      if (parsed.success && parsed.data.request.prompt === label) delivery = parsed.data
    }
    expect(delivery).toBeDefined()
  })
  return delivery!
}

async function rpc(
  host: Host, cookie: string, endpoint: string, args: object,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${host.origin}/api/${endpoint}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  })
  return { status: response.status, body: response.status === 200 ? await response.json() : await response.text() }
}

async function success(host: Host, cookie: string, endpoint: string, args: object): Promise<void> {
  expect(await rpc(host, cookie, endpoint, args)).toMatchObject({ status: 200, body: { result: { ok: true } } })
}

function call(host: Host, label: string) {
  const observation = host.fixture.calls.get(label)
  if (observation === undefined) throw new Error(`fixture call was not admitted: ${label}`)
  return observation
}
