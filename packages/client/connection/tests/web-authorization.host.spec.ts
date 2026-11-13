/** WebServer admission applies Connection source checks once before route dispatch. */
import { request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import WebServer, { type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it, vi } from 'vitest'
import * as Connection from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { for (const root of roots.splice(0)) await root.fiber.dispose() })

async function mounted() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const connection = ctx.plugin(Connection)
  await connection.await()
  return { ctx, connection, origin: ctx.webServer.getOrigin() }
}

it('checks anonymous route sources without authenticating their credentials', async () => {
  const { ctx, origin } = await mounted()
  const authenticate = vi.fn(() => ctx.connection.browserPeer)
  ctx.connection.authentication.register({ authenticate })
  const handler = vi.fn<WebRoute['handler']>((_request, response) => { response.end('public') })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/public', auth: 'anonymous', handler }))
  for (const headers of [{ host: 'untrusted.example' }, { origin: 'http://untrusted.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${origin}/public`, { headers }, (response) => {
        response.resume()
        response.once('end', () => { resolve(response.statusCode) })
      })
      request.once('error', reject)
      request.end()
    })
    expect(status).toBe(403)
  }
  expect(handler).not.toHaveBeenCalled()
  const response = await fetch(`${origin}/public`, { headers: { cookie: 'irrelevant=value' } })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('public')
  expect(authenticate).not.toHaveBeenCalled()
  expect(handler.mock.calls[0]?.[2]).toBeUndefined()
})

it('authenticates once and passes the selected Peer to shared and custom RPC routes', async () => {
  const { ctx, origin } = await mounted()
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  const authenticate = vi.fn(() => peer)
  ctx.connection.authentication.register({ authenticate })
  const handler = vi.fn<Connection.ConnectionRpcHandler>(async (_endpoint, _payload, _signal, caller) => ({ ok: true, value: caller.id }))
  ctx.connection.rpc.intercept('/api', () => true, handler)
  await ctx.plugin({ inject: ['connection', 'webServer'], apply(owner: Context) {
    owner.connection.rpc.handle('/custom', handler)
  } }).await()
  for (const channel of ['/api', '/custom']) {
    const response = await fetch(`${origin}${channel}/fixture/read`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'one', method: 'fixture/read', payload: {} }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: { ok: true, value: peer.id } })
  }
  expect(authenticate).toHaveBeenCalledTimes(2)
  expect(handler).toHaveBeenCalledTimes(2)
  expect(handler.mock.calls.every(call => call[3] === peer)).toBe(true)
})

it('withdraws authorization with Connection and leaves authenticated routes unavailable', async () => {
  const { ctx, connection, origin } = await mounted()
  const handler = vi.fn<WebRoute['handler']>((_request, response) => { response.end('private') })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/private', handler }))
  expect((await fetch(`${origin}/private`)).status).toBe(401)
  await connection.dispose()
  expect((await fetch(`${origin}/private`)).status).toBe(503)
  expect(handler).not.toHaveBeenCalled()
})
