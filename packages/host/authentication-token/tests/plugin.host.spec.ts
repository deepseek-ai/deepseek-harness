/** Token plugin owns its HTTP exchange and returns existing Connection Peers. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionAuthentication, type AuthenticationProvider, type HostConnectionHandle, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import type { WebEntryUrl, WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import * as Token from '../src/index.ts'
import { RecordCredentials } from './browser-credentials.ts'
import { BrowserAuth } from '../src/browser-auth.ts'

const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })

async function mounted(secure = false, before?: (ctx: Context) => void) {
  const ctx = new Context(); roots.push(ctx)
  const providers: AuthenticationProvider[] = []
  const routes: WebRoute[] = []
  let sequence = 0
  const createPeer = vi.fn<HostConnectionHandle['createPeer']>((options) => {
    const signal = new AbortController()
    const peer = {
      id: `peer-${++sequence}`, principal: options.principal, interactions: options.interactions ?? 'answer', ctx,
      signal: signal.signal, dispose: async () => { signal.abort() },
    } as PeerScope
    return peer
  })
  const authentication = new ConnectionAuthentication(ctx)
  const connection: HostConnectionHandle = {
    authentication,
    browserPeer: { principal: { kind: 'owner' }, interactions: 'answer', ctx, signal: new AbortController().signal,
      id: 'compat-peer', dispose: async () => {} } as PeerScope,
    allowsRemoteAuthorities: false,
    rpc: {
      handle() { throw new Error('RPC registration is outside this fixture') },
      intercept() { throw new Error('RPC interception is outside this fixture') },
    },
    fetch: { register() { throw new Error('Fetch routes are outside this fixture') } },
    createSharedFetchHandler() { throw new Error('Fetch dispatch is outside this fixture') },
    admit() { throw new Error('Combined admission is outside this fixture') },
    createPeer,
  }
  ctx.provide('credentials', new RecordCredentials())
  ctx.provide('connection', connection)
  ctx.provide('webServer', {
    protocol: secure ? 'https:' : 'http:',
    register(route: WebRoute) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
  } as WebServer)
  before?.(ctx)
  const fiber = ctx.plugin({
    inject: Token.inject,
    async apply(scope: Context) {
      authentication.register = provider => scope.effect(() => {
        providers.push(provider)
        return () => { providers.splice(providers.indexOf(provider), 1) }
      })
      await Token.apply(scope, { cookieMaxAgeDays: 30 })
    },
  })
  await fiber.await()
  const auth = await BrowserAuth.create(ctx[Context.root], ctx.credentials, 30)
  return { ctx, fiber, providers, routes, createPeer, auth }
}
function response() {
  const state: { status?: number; headers?: Readonly<Record<string, string>> | undefined; body?: string | undefined } = {}
  const res = {
    destroyed: false,
    writeHead(status: number, headers?: Readonly<Record<string, string>>) { state.status = status; state.headers = headers },
    end(body?: string) { state.body = body },
  } as ServerResponse
  return { res, state }
}
function request(url: string, method = 'GET'): IncomingMessage {
  return { url, method, headers: { host: 'localhost:3080' }, socket: { destroyed: false } } as IncomingMessage
}

it('keeps login URL construction internal and registers only the standard plugin exports', async () => {
  expect(Object.keys(Token).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
  const { providers, createPeer, auth } = await mounted()
  const url = new URL(auth.authenticatedUrl('http://localhost:3080/mount/?other=1'))
  expect(url.pathname).toBe('/mount/')
  expect(url.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(url.searchParams.get('other')).toBe('1')
  expect(providers).toHaveLength(1)
  expect(providers[0]!.authenticate({ headers: { host: 'localhost:3080' } })).toBeUndefined()
  expect(createPeer).toHaveBeenCalledExactlyOnceWith({ principal: { kind: 'owner' } })
})

it('exchanges a root token, passes other routes on, and keeps browser authentication shared', async () => {
  const { ctx, providers, createPeer, auth } = await mounted()
  const url = new URL(auth.authenticatedUrl('http://localhost:3080/'))
  const reply = response(); const next = vi.fn(async () => {})
  await ctx.waterfall('webserver/request', request(url.pathname + url.search), reply.res, next)
  expect(reply.state.status).toBe(303)
  expect(next).not.toHaveBeenCalled()
  const cookie = reply.state.headers?.['set-cookie']?.split(';', 1)[0]
  expect(cookie).toBeDefined()
  const facts = { headers: { host: 'localhost:3080', cookie } }
  const peer = providers[0]!.authenticate(facts)
  expect(peer).toBe(createPeer.mock.results[0]!.value)
  expect(providers[0]!.authenticate(facts)).toBe(peer)
  await ctx.waterfall('webserver/request', request('/product.html?token=other'), response().res, next)
  expect(next).toHaveBeenCalledTimes(1)
  await ctx.waterfall('webserver/request', request('/'), response().res, next)
  expect(next).toHaveBeenCalledTimes(2)
  const noTarget = request('/')
  noTarget.url = undefined
  await ctx.waterfall('webserver/request', noTarget, response().res, next)
  expect(next).toHaveBeenCalledTimes(3)
  const disconnected = request(url.pathname + url.search)
  Object.assign(disconnected.socket, { destroyed: true })
  const dropped = response()
  await ctx.waterfall('webserver/request', disconnected, dropped.res, next)
  expect(dropped.state.status).toBeUndefined()
})

it('delegates synthetic Worker requests without a native socket', async () => {
  const { ctx, routes, auth } = await mounted()
  const synthetic = request('/plugins/??modules/client.js')
  Reflect.deleteProperty(synthetic, 'socket')
  const next = vi.fn(async () => {})
  await ctx.waterfall('webserver/request', synthetic, response().res, next)
  expect(next).toHaveBeenCalledOnce()

  const url = new URL(auth.authenticatedUrl('http://localhost:3080/connect'))
  const connect = request(url.pathname + url.search)
  Reflect.deleteProperty(connect, 'socket')
  const reply = response()
  await routes[0]!.handler(connect, reply.res)
  expect(reply.state.status).toBe(302)
})

it('creates socket-owned API Peers usable by authenticated routes', async () => {
  const { providers, routes, createPeer, auth } = await mounted()
  const url = new URL(auth.authenticatedUrl('http://localhost:3080/connect'))
  const reply = response()
  await routes[0]!.handler(request(url.pathname + url.search), reply.res)
  expect(reply.state.status).toBe(302)
  expect(createPeer).toHaveBeenLastCalledWith({ principal: { kind: 'owner' }, interactions: 'none' })
  const cookie = reply.state.headers?.['set-cookie']?.split(';', 1)[0]
  const facts = { headers: { host: 'localhost:3080', cookie } }
  expect(routes[0]!.auth).toBe('anonymous')
  expect(providers[0]!.authenticate(facts)).toBe(createPeer.mock.results[1]!.value)
  const before = createPeer.mock.calls.length
  const disconnected = request(url.pathname + url.search)
  Object.assign(disconnected.socket, { destroyed: true })
  await routes[0]!.handler(disconnected, response().res)
  expect(createPeer).toHaveBeenCalledTimes(before)
})

it('does not claim an API Peer when an upgrade has no request target', async () => {
  const { ctx, providers, routes, auth } = await mounted()
  const url = new URL(auth.authenticatedUrl('http://localhost:3080/connect'))
  const reply = response()
  await routes[0]!.handler(request(url.pathname + url.search), reply.res)
  const cookie = reply.state.headers?.['set-cookie']?.split(';', 1)[0]
  const facts = { headers: { host: 'localhost:3080', cookie } }
  const peer = providers[0]!.authenticate(facts)
  if (peer === undefined) throw new Error('fixture API Cookie was refused')
  const incoming = request('/')
  incoming.url = undefined
  const socket = new PassThrough()
  const closed = once(socket, 'close')
  const next = vi.fn(async () => {})
  try {
    await ctx.waterfall('webserver/upgrade', incoming, socket, Buffer.alloc(0), peer, next)
    expect(next).toHaveBeenCalledOnce()
  } finally {
    socket.destroy()
    await closed
  }
  expect(peer.signal.aborted).toBe(false)
  expect(providers[0]!.authenticate(facts)).toBe(peer)
})

it('delegates a queued root request after its token middleware has unloaded', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const { ctx, fiber, auth } = await mounted(false, (owner) => {
    owner.on('webserver/request', async (_request, _response, next) => {
      entered.resolve(undefined)
      await release.promise
      await next()
    })
  })
  const url = new URL(auth.authenticatedUrl('http://localhost:3080/'))
  const reply = response()
  const next = vi.fn(async () => {})
  const pending = ctx.waterfall('webserver/request', request(url.pathname + url.search), reply.res, next)
  await entered.promise
  await fiber.dispose()
  release.resolve(undefined)
  await pending
  expect(reply.state.headers?.['set-cookie']).toBeUndefined()
  expect(next).toHaveBeenCalledOnce()
})

it('refuses invalid API interaction declarations without creating a Peer', async () => {
  const { routes, createPeer, auth } = await mounted()
  const url = new URL(auth.authenticatedUrl('http://localhost:3080/connect?interactions=invalid'))
  const reply = response()
  await routes[0]!.handler(request(url.pathname + url.search), reply.res)
  expect(reply.state.status).toBe(400)
  expect(createPeer).toHaveBeenCalledTimes(1)
})

it('removes all entry registrations on unload', async () => {
  const { fiber, providers, routes } = await mounted()
  const captured = routes[0]!
  await fiber.dispose()
  const stale = response()
  await captured.handler(request('/connect?token=old'), stale.res)
  expect(stale.state.status).toBe(401)
  expect(providers).toHaveLength(0)
  expect(routes).toHaveLength(0)
})


it('contributes its complete login URL only while the provider is mounted', async () => {
  const { ctx, fiber, auth } = await mounted()
  const entries: WebEntryUrl[] = []
  ctx.emit('webserver/entry-url', 'https://public.test/ui/', entries)
  expect(entries).toEqual([{ label: 'dsh web', url: auth.authenticatedUrl('https://public.test/ui/'), open: true }])
  await fiber.dispose()
  const after: WebEntryUrl[] = []
  ctx.emit('webserver/entry-url', 'https://public.test/ui/', after)
  expect(after).toEqual([])
})
