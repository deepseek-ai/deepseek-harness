/** Authentication providers return existing Peers through their independent service. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { HostConnectionService } from '../src/rpc-host.ts'
import { ConnectionAuthentication } from '../src/authentication.ts'
import { Peer } from '../src/peer.ts'

const roots: Context[] = []
afterEach(async () => { for (const root of roots.splice(0)) await root.fiber.dispose() })
function setup(): { ctx: Context; connection: HostConnectionService; authentication: ConnectionAuthentication } {
  const ctx = new Context()
  roots.push(ctx)
  const authentication = new ConnectionAuthentication(ctx)
  return { ctx, connection: new HostConnectionService(ctx, []), authentication }
}
const request = { headers: { host: 'localhost' } }

it('requires a WebServer for a physical RPC channel', () => {
  const { connection } = setup()
  expect(() => connection.rpc.handle('/custom', async () => ({ ok: true, value: null })))
    .toThrow('RPC channels require a WebServer')
})

it('checks each request and takes the first live Peer returned by a provider', () => {
  const { connection, authentication } = setup()
  const first = connection.createPeer({ principal: { kind: 'owner' } })
  const second = connection.createPeer({ principal: { kind: 'owner' } })
  let calls = 0
  authentication.register({ authenticate() { calls++; return undefined } })
  authentication.register({ authenticate() { return first } })
  authentication.register({ authenticate() { throw new Error('should not run') } })
  expect(authentication.authenticate(request)).toEqual({ peer: first })
  expect(authentication.authenticate(request)).toEqual({ peer: first })
  expect(calls).toBe(2)
  expect(first).not.toBe(second)
})

it('continues after failure and removes a registration through its disposer', async () => {
  const { connection, authentication } = setup()
  const peer = connection.createPeer({ principal: { kind: 'owner' } })
  authentication.register({ authenticate() { throw new Error('unavailable') } })
  const remove = authentication.register({ authenticate: () => peer })
  expect(authentication.authenticate(request)).toEqual({ peer })
  const removing = remove()
  expect(authentication.authenticate(request)).toEqual({ rejection: 503 })
  await removing
})

it('rejects a cancelled request and skips disposed Peers', async () => {
  const { connection, authentication } = setup()
  const peer = connection.createPeer({ principal: { kind: 'owner' } })
  let calls = 0
  authentication.register({ authenticate() { calls++; return peer } })
  const cancellation = new AbortController()
  cancellation.abort()
  expect(authentication.authenticate({ ...request, signal: cancellation.signal })).toEqual({ rejection: 401 })
  expect(calls).toBe(0)
  await peer.dispose()
  expect(authentication.authenticate(request)).toEqual({ rejection: 401 })
})

it('withdraws registrations with their plugin scope while retaining a separately owned Peer', async () => {
  const { ctx, connection, authentication } = setup()
  const peer = connection.createPeer({ principal: { kind: 'owner' } })
  const plugin = ctx.plugin({
    inject: ['connection', 'connection.authentication'],
    apply(scope: Context) {
      scope.connection.authentication.register({ authenticate: () => peer })
    },
  })
  await plugin.await()
  expect(authentication.authenticate(request)).toEqual({ peer })
  await plugin.dispose()
  expect(authentication.authenticate(request)).toEqual({ rejection: 401 })
  expect(peer.signal.aborted).toBe(false)
})

it('skips a provider withdrawn by an earlier verifier', async () => {
  const { connection, authentication } = setup()
  const peer = connection.createPeer({ principal: { kind: 'owner' } })
  let removing: Promise<void> | undefined
  authentication.register({ authenticate() { removing = remove(); return undefined } })
  const authenticate = vi.fn(() => peer)
  const remove = authentication.register({ authenticate })
  expect(authentication.authenticate(request)).toEqual({ rejection: 401 })
  expect(authenticate).not.toHaveBeenCalled()
  await removing
})

it.each(['request', 'socket'] as const)('rejects a %s that ends inside provider verification', (ended) => {
  const { connection, authentication } = setup()
  const peer = connection.createPeer({ principal: { kind: 'owner' } })
  const controller = new AbortController()
  const socket = { destroyed: false }
  authentication.register({ authenticate() {
    if (ended === 'request') controller.abort()
    else socket.destroyed = true
    return peer
  } })
  expect(authentication.authenticate({ ...request, signal: controller.signal, socket })).toEqual({ rejection: 401 })
  expect(peer.signal.aborted).toBe(false)
})

it('rejects new work after the Connection owner unloads', async () => {
  const ctx = new Context()
  roots.push(ctx)
  const plugin = ctx.plugin((owner) => { new ConnectionAuthentication(owner); new HostConnectionService(owner, []) })
  await plugin.await()
  const connection = ctx.get('connection') as HostConnectionService
  const authentication = ctx['connection.authentication']
  const peer = connection.createPeer({ principal: { kind: 'owner' } })
  authentication.register({ authenticate: () => peer })
  await plugin.dispose()
  expect(authentication.authenticate(request)).toEqual({ rejection: 401 })
  expect(connection.admit(request)).toEqual({ rejection: 401 })
  expect(() => connection.createPeer({ principal: { kind: 'owner' } })).toThrow('cannot create a Peer after disposal')
  expect(() => authentication.register({ authenticate: () => peer })).toThrow('authentication registry is disposed')
})

it('ignores a provider withdrawn during its own verification', async () => {
  const { connection, authentication } = setup()
  const peer = connection.createPeer({ principal: { kind: 'owner' } })
  let removing: Promise<void> | undefined
  const remove = authentication.register({ authenticate() { removing = remove(); return peer } })
  expect(authentication.authenticate(request)).toEqual({ rejection: 401 })
  await removing
})


it('authenticates without a Connection transport or source policy', () => {
  const ctx = new Context()
  roots.push(ctx)
  const authentication = new ConnectionAuthentication(ctx)
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  authentication.register({ authenticate: () => peer })
  expect(authentication.name).toBe('connection.authentication')
  expect(ctx.get('connectionAuthentication')).toBeUndefined()
  expect(ctx.get('connection')).toBeUndefined()
  expect(authentication.authenticate({ headers: {} })).toEqual({ peer })
})

it('refuses admission when its service owner is disposed inside verification', async () => {
  const ctx = new Context()
  roots.push(ctx)
  const plugin = ctx.plugin(ConnectionAuthentication)
  await plugin.await()
  const authentication = ctx['connection.authentication']
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  let disposed: Promise<void> | undefined
  authentication.register({ authenticate() {
    disposed = plugin.dispose()
    return peer
  } })
  expect(authentication.authenticate(request)).toEqual({ rejection: 401 })
  await disposed
  expect(peer.signal.aborted).toBe(false)
})

it('withdraws a dependent Connection before its authentication service leaves', async () => {
  const ctx = new Context()
  roots.push(ctx)
  const service = ctx.plugin(ConnectionAuthentication)
  await service.await()
  const consumer = ctx.plugin({
    inject: ['connection.authentication'],
    apply(owner: Context) { new HostConnectionService(owner, []) },
  })
  await consumer.await()
  const connection = ctx.connection
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  ctx['connection.authentication'].register({ authenticate: () => peer })
  expect(connection.admit(request)).toEqual({ peer })
  await service.dispose()
  expect(ctx.get('connection')).toBeUndefined()
  expect(connection.admit(request)).toEqual({ rejection: 401 })
})
