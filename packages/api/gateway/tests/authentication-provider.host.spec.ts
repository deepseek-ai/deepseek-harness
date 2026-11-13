/** External authentication providers use existing Peer scopes over real HTTP and WebSocket. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import WebSocket from 'ws'
import { parseRemoteStreamServerMessage, type RemoteStreamServerMessage } from '../src/stream-protocol.ts'
import OperatorConnectFixture from './operator-connect-fixture.ts'

it('uses the provider-owned Peer for HTTP and streams, then closes only its scope on unload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-provider-transport-'))
  const ctx = new Context()
  const clients: { socket: WebSocket; closed: Promise<void>; errors: Error[] }[] = []
  onTestFinished(async () => {
    await Promise.all(clients.map(async ({ socket, closed }) => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
      await closed
    }))
    await ctx.fiber.dispose()
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-provider-transport-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  })
  const peers = new Map<string, PeerScope>()
  const provider = (cookie: string) => ({
    inject: ['connection', 'connection.authentication'],
    apply(scope: Context) {
      const peer = scope.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
      peers.set(cookie, peer)
      scope.connection.authentication.register({
        authenticate(request) {
          const header = request.headers instanceof Headers ? request.headers.get('cookie') : request.headers.cookie
          return header === cookie ? peer : undefined
        },
      })
    },
  })
  const rows = [
    { name: 'credentials', config: { path: join(root, '.credentials.yaml'), watch: false } },
    { name: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: 'connection' },
    { name: 'registry' },
    { name: 'access' },
    { name: 'gateway' },
    { name: 'fixture' },
    { id: 'provider-a', name: 'provider-a' },
    { id: 'provider-b', name: 'provider-b' },
  ]
  const config = join(root, 'cordis.yml')
  await writeFile(config, rows.map(row => `- ${JSON.stringify({ ...row, name: `cordis:${row.name}` })}`).join('\n') + '\n')
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, credentials: LocalCredentials, webserver: WebServer,
    connection: Connection, registry: TypertRegistry, access: RemoteAccess,
    gateway: TypertGateway, fixture: OperatorConnectFixture,
    'provider-a': provider('provider-a=valid'), 'provider-b': provider('provider-b=valid'),
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const fixture = ctx.operatorConnectFixture
  const peerA = peers.get('provider-a=valid')
  const peerB = peers.get('provider-b=valid')
  expect(peerA).toBeDefined()
  expect(peerB).toBeDefined()
  expect(peerA).not.toBe(peerB)
  expect(peerA).not.toBe(ctx.connection.browserPeer)

  const identity = async (cookie: string, label: string): Promise<number> => {
    const response = await fetch(`${origin}/api/fixture/identity`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'fixture/identity', payload: { args: { label } } }),
    })
    await response.text()
    return response.status
  }
  const follow = async (cookie: string, label: string): Promise<WebSocket> => {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: { cookie } })
    const closed = new Promise<void>((done) => { socket.once('close', () => { done() }) })
    const errors: Error[] = []
    const frames: RemoteStreamServerMessage[] = []
    clients.push({ socket, closed, errors })
    socket.on('error', error => errors.push(error))
    socket.on('message', (data) => {
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8')
      frames.push(parseRemoteStreamServerMessage(text))
    })
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'open', streamId: label, endpoint: 'fixture/follow', payload: { args: { label } } }))
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ type: 'item', streamId: label, value: `${label}:ready` })
    })
    return socket
  }
  expect(await identity('provider-a=invalid', 'rejected')).toBe(401)
  expect(fixture.calls.has('rejected')).toBe(false)
  expect(await identity('provider-a=valid', 'http-a')).toBe(200)
  expect(await identity('provider-b=valid', 'http-b')).toBe(200)
  const socketA = await follow('provider-a=valid', 'stream-a')
  const socketB = await follow('provider-b=valid', 'stream-b')
  expect(fixture.calls.get('http-a')?.peer).toBe(peerA)
  expect(fixture.calls.get('stream-a')?.peer).toBe(peerA)
  expect(fixture.calls.get('http-b')?.peer).toBe(peerB)
  expect(fixture.calls.get('stream-b')?.peer).toBe(peerB)

  const entry = [...ctx.loader.entries()].find(item => item.options.id === 'provider-a')
  if (entry?.fiber === undefined) throw new Error('provider fixture did not activate')
  await entry.fiber.dispose()
  await vi.waitFor(() => { expect(socketA.readyState).toBe(WebSocket.CLOSED) })
  expect(peerA?.signal.aborted).toBe(true)
  expect(peerB?.signal.aborted).toBe(false)
  expect(socketB.readyState).toBe(WebSocket.OPEN)
  await vi.waitFor(() => { expect(fixture.calls.get('stream-a')?.finished).toBe(true) })
  expect(await identity('provider-a=valid', 'after-a')).toBe(401)
  expect(await identity('provider-b=valid', 'after-b')).toBe(200)
  expect(fixture.calls.get('after-b')?.peer).toBe(peerB)
  for (const client of clients) expect(client.errors).toEqual([])
})
