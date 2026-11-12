/** QR login credentials, owner-only management, and anonymous exchange. */
import { Context } from '@deepseek-ai/cordis'
import type { WebResourceRoute, WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import * as Token from '@deepseek-ai/dsh-host-authentication-token'
import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import RemoteConnection from '../src/index.ts'
import { LoginTickets } from '../src/login-tickets.ts'
import { RemoteBrowserAuth } from '../src/remote-auth.ts'
import type { RemoteLoginTicket } from '../src/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Non-owner exercising direct QR invitation calls. */
    'qr-test-guest': { readonly kind: 'qr-test-guest' }
  }
}

afterEach(() => { vi.restoreAllMocks() })

function credential(ticket: RemoteLoginTicket): string {
  return new URL(ticket.url).hash.slice(1)
}

function caller(ctx: Context, principal: Principal = { kind: 'owner' }): RemoteConnection {
  const peer = ctx.connection.createPeer({ principal })
  const invocation: RemoteInvocation = {
    request: { namespace: 'remoteConnection', method: 'create', args: {} },
    service: 'remoteConnection', peer, signal: peer.signal,
    uplink: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) }),
  }
  return ctx.extend({ invocation }).remoteConnection
}

async function mount(url = 'https://login.example/ui/', protocol: 'http:' | 'https:' = 'https:') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const routes: (WebRoute | WebResourceRoute)[] = []
  await ctx.plugin(MemoryCredentials)
  ctx.provide('webServer', {
    host: '127.0.0.1', protocol,
    register(route: WebRoute | WebResourceRoute) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  } as WebServer)
  ctx.provide('webApp', { getAdvertisedUrl: () => url })
  await ctx.plugin(Connection, { trustedHosts: ['login.example', 'other.example'] })
  await ctx.plugin(Token, { cookieMaxAgeDays: 30 })
  const fiber = ctx.plugin(RemoteConnection, RemoteConnection.Config({ ticketLifetimeMs: 120_000, pollIntervalMs: 1000 }))
  await fiber
  const registered = routes.find((entry): entry is WebRoute => entry.path === '/remote-login' && 'handler' in entry)!
  const route: WebRoute = {
    ...registered,
    async handler(request, response) {
      const facts = {
        headers: request.headers, method: request.method,
        url: new URL(request.url ?? '/', 'http://fixture.invalid'), transport: 'http' as const, socket: request.socket,
      }
      const policy = typeof registered.auth === 'function' ? registered.auth(facts) : registered.auth ?? 'required'
      const admission = ctx.bail('webserver/authorize', facts, policy)
      if (admission?.kind === 'deny') {
        response.writeHead(admission.status)
        response.end()
        return
      }
      await registered.handler(request, response, admission?.peer)
    },
  }
  return { ctx, routes, fiber, route, registered, service: caller(ctx) }
}

function streamingRequest(method: string, headers: Record<string, string> = {}): IncomingMessage {
  const socket = new Socket()
  const request = Object.assign(new IncomingMessage(socket), {
    method, url: '/remote-login', headers: { host: 'login.example', origin: 'https://login.example', 'content-type': 'text/plain', ...headers },
  })
  onTestFinished(() => { request.destroy(); socket.destroy() })
  return request
}

function request(method: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const result = streamingRequest(method, headers)
  if (body !== '') result.push(Buffer.from(body))
  result.push(null)
  return result
}

function response() {
  const state = { status: 0, headers: {} as Readonly<Record<string, string>>, body: undefined as string | undefined }
  const value = {
    writeHead(status: number, headers: Readonly<Record<string, string>> = {}) {
      state.status = status
      state.headers = headers
      return this
    },
    end(body?: string) { state.body = body; return this },
  } as ServerResponse
  return { value, state }
}

async function exchange(route: WebRoute, token: string, headers?: Record<string, string>) {
  const res = response()
  await route.handler(request('POST', token, headers), res.value)
  return res.state
}

it('issues a prefix-preserving one-use invitation and a Remote-owned browser cookie', async () => {
  const { ctx, route, service } = await mount()
  expect(service.status(null)).toEqual({ url: 'https://login.example/ui/', availability: 'available', ticket: 'none', pollIntervalMs: 1000 })
  const ticket = service.create()
  expect(ticket.lifetimeMs).toBe(120_000)
  expect(ticket.url).toMatch(/^https:\/\/login\.example\/ui\/remote-login#[A-Za-z0-9_-]{43}$/)
  expect(ticket.url).not.toContain('token=')
  expect(service.status(ticket.id).ticket).toBe('pending')
  const result = await exchange(route, credential(ticket))
  expect(result.status).toBe(204)
  expect(result.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict; Secure')
  expect(result.headers['set-cookie']).toContain('Max-Age=2592000')
  const cookie = result.headers['set-cookie']!.split(';', 1)[0]!
  const admitted = ctx.connection.admit({ headers: { host: 'login.example', cookie } })
  if ('rejection' in admitted) throw new Error('Remote Cookie was rejected')
  expect(admitted.peer).not.toBe(ctx.connection.browserPeer)
  expect(admitted.peer.principal).toEqual({ kind: 'owner' })
  expect(ctx.connection.admit({ headers: { host: 'other.example', cookie } })).toEqual({ rejection: 401 })
  expect(service.status(ticket.id).ticket).toBe('used')
  expect(service.cancel(ticket.id)).toBe('used')
  expect(service.status(ticket.id).ticket).toBe('used')
  expect((await exchange(route, credential(ticket))).status).toBe(410)
  expect(ctx.connection.admit({ headers: { host: 'login.example', cookie } })).toEqual(admitted)
})

it('never consumes a ticket on page reads or malformed and cross-origin requests', async () => {
  const { route, service } = await mount()
  const ticket = service.create()
  for (const method of ['GET', 'HEAD']) {
    const res = response()
    await route.handler(request(method), res.value)
    expect(res.state.status).toBe(200)
    expect(res.state.headers['cache-control']).toBe('no-store')
    expect(res.state.headers['referrer-policy']).toBe('no-referrer')
    expect(res.state.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.state.headers['set-cookie']).toBeUndefined()
    if (method === 'HEAD') expect(res.state.body).toBeUndefined()
    else expect(res.state.body).toContain('<html')
  }
  const put = response()
  await route.handler(request('PUT'), put.value)
  expect(put.state.status).toBe(405)
  for (const headers of [
    { host: 'evil.example' },
    { host: 'other.example', origin: 'https://other.example' },
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    expect((await exchange(route, credential(ticket), headers)).status).toBe(403)
  }
  expect((await exchange(route, credential(ticket), { 'content-type': 'application/json' })).status).toBe(400)
  for (const invalid of ['', 'short', 'é'.repeat(20)]) expect((await exchange(route, invalid)).status).toBe(400)
  expect((await exchange(route, 'x'.repeat(43))).status).toBe(410)
  expect(service.status(ticket.id).ticket).toBe('pending')
  expect((await exchange(route, credential(ticket), { host: 'login.example:443' })).status).toBe(204)
})

it('returns the process-token login URL without consuming or replacing the QR invitation', async () => {
  const { service } = await mount()
  const ticket = service.create()
  const link = service.loginUrl()
  expect(new URL(link).origin + new URL(link).pathname).toBe('https://login.example/ui/')
  expect(new URL(link).searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(service.loginUrl()).toBe(link)
  expect(service.status(ticket.id)).toMatchObject({ ticket: 'pending', url: 'https://login.example/ui/' })
  expect(JSON.stringify(service.status(ticket.id))).not.toContain(new URL(link).searchParams.get('token'))
})

it('bounds declared and streamed credential bodies without consuming a ticket', async () => {
  const { route, service } = await mount()
  const ticket = service.create()
  expect((await exchange(route, credential(ticket), { 'content-length': '44' })).status).toBe(413)
  expect((await exchange(route, 'x'.repeat(44))).status).toBe(413)
  expect(service.status(ticket.id).ticket).toBe('pending')
})

it('allows exactly one of two overlapping exchanges', async () => {
  const { route, service } = await mount()
  const ticket = service.create()
  const streams = [streamingRequest('POST'), streamingRequest('POST')]
  const responses = [response(), response()]
  const pending = streams.map((stream, index) => Promise.resolve(route.handler(stream, responses[index]!.value)))
  for (const stream of streams) { stream.push(Buffer.from(credential(ticket))); stream.push(null) }
  await Promise.all(pending)
  expect(responses.map(res => res.state.status).sort()).toEqual([204, 410])
  expect(responses.filter(res => res.state.headers['set-cookie'] !== undefined)).toHaveLength(1)
})

it('does not expose a session when the Remote credential signer refuses issuance', async () => {
  const { route, service } = await mount()
  const ticket = service.create()
  const issuance = vi.spyOn(RemoteBrowserAuth.prototype, 'createSessionCookie').mockReturnValue(undefined)
  const result = await exchange(route, credential(ticket))
  expect(result.status).toBe(403)
  expect(result.headers['set-cookie']).toBeUndefined()
  expect(service.status(ticket.id).ticket).toBe('used')
  issuance.mockRestore()
  expect((await exchange(route, credential(ticket))).status).toBe(410)
})

it('rejects expired, cancelled and replaced invitations and preserves the replacement on stale cancellation', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const { route, service } = await mount()
  const expired = service.create()
  now.mockReturnValue(1000 + expired.lifetimeMs)
  expect((await exchange(route, credential(expired))).status).toBe(410)
  expect(service.status(expired.id).ticket).toBe('expired')
  expect(service.cancel(expired.id)).toBe('expired')
  const cancelled = service.create()
  expect(service.cancel(cancelled.id)).toBe('cancelled')
  expect(service.status(cancelled.id).ticket).toBe('cancelled')
  expect((await exchange(route, credential(cancelled))).status).toBe(410)
  const old = service.create()
  const replacement = service.create()
  expect(service.status(old.id).ticket).toBe('replaced')
  expect(service.cancel(old.id)).toBe('replaced')
  expect(service.status(replacement.id).ticket).toBe('pending')
  expect((await exchange(route, credential(old))).status).toBe(410)
  expect((await exchange(route, credential(replacement))).status).toBe(204)
})

it('requires an owner even when a caller bypasses the generated Remote gateway', async () => {
  const { ctx, service } = await mount()
  const ticket = service.create()
  for (const denied of [ctx.remoteConnection, caller(ctx, { kind: 'qr-test-guest' })]) {
    expect(() => denied.status(null)).toThrow(expect.objectContaining({ code: 'remote-connection/owner-required' }))
    expect(() => denied.create()).toThrow(expect.objectContaining({ code: 'remote-connection/owner-required' }))
    expect(() => denied.loginUrl()).toThrow(expect.objectContaining({ code: 'remote-connection/owner-required' }))
    expect(() => denied.cancel(ticket.id)).toThrow(expect.objectContaining({ code: 'remote-connection/owner-required' }))
  }
  expect(service.status(ticket.id).ticket).toBe('pending')
})

it.each([
  ['http://localhost/', 'unreachable-host'],
  ['http://unknown.example/', 'untrusted-host'],
  ['https://localhost/', 'unreachable-host'],
  ['https://app.localhost/', 'unreachable-host'],
  ['https://127.0.0.2/', 'unreachable-host'],
  ['https://[::1]/', 'unreachable-host'],
  ['https://[::]/', 'unreachable-host'],
  ['https://0.0.0.0/', 'unreachable-host'],
  ['https://unknown.example/', 'untrusted-host'],
] as const)('reports the unmet prerequisite for %s', async (url, availability) => {
  const { service } = await mount(url)
  expect(service.status(null).availability).toBe(availability)
  expect(() => service.create()).toThrow(expect.objectContaining({ code: 'remote-connection/unavailable', details: { reason: availability } }))
  expect(() => service.loginUrl()).toThrow(expect.objectContaining({ code: 'remote-connection/unavailable', details: { reason: availability } }))
})

it('marks QR cookies Secure behind an HTTPS proxy while preserving the upstream cookie audience', async () => {
  const { ctx, route, service } = await mount('https://login.example/ui/', 'http:')
  const result = await exchange(route, credential(service.create()))
  expect(result.status).toBe(204)
  expect(result.headers['set-cookie']).toContain('; Secure')
  const cookie = result.headers['set-cookie']!.split(';', 1)[0]!
  const admitted = ctx.connection.admit({ headers: { host: 'login.example', cookie } })
  if ('rejection' in admitted) throw new Error('Remote proxy Cookie was rejected')
  expect(admitted.peer).not.toBe(ctx.connection.browserPeer)
})

it('signs in over HTTP with a non-Secure Remote cookie and rejects replay', async () => {
  const { ctx, route, service } = await mount('http://login.example/ui/', 'http:')
  expect(service.status(null).availability).toBe('available')
  const ticket = service.create()
  expect(ticket.url).toMatch(/^http:\/\/login\.example\/ui\/remote-login#[A-Za-z0-9_-]{43}$/)
  expect((await exchange(route, credential(ticket), { origin: 'http://evil.example' })).status).toBe(403)
  expect(service.status(ticket.id).ticket).toBe('pending')
  const headers = { host: 'login.example:80', origin: 'http://login.example' }
  const result = await exchange(route, credential(ticket), headers)
  expect(result.status).toBe(204)
  expect(result.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict')
  expect(result.headers['set-cookie']).not.toContain('; Secure')
  const cookie = result.headers['set-cookie']!.split(';', 1)[0]!
  const admitted = ctx.connection.admit({ headers: { ...headers, cookie } })
  if ('rejection' in admitted) throw new Error('Remote HTTP Cookie was rejected')
  expect(admitted.peer).not.toBe(ctx.connection.browserPeer)
  const replay = await exchange(route, credential(ticket), headers)
  expect(replay.status).toBe(410)
  expect(replay.headers['set-cookie']).toBeUndefined()
})

it('refuses anonymous exchanges while the advertised deployment is unreachable', async () => {
  const { route } = await mount('http://localhost/', 'http:')
  expect((await exchange(route, 'a'.repeat(43), { host: 'localhost', origin: 'http://localhost' })).status).toBe(403)
})

it('removes the route and invalidates pending requests when the plugin unloads', async () => {
  const { route, registered, routes, fiber, service } = await mount()
  const ticket = service.create()
  const stream = streamingRequest('POST')
  const res = response()
  const pending = route.handler(stream, res.value)
  const disposing = fiber.dispose()
  stream.push(Buffer.from(credential(ticket)))
  stream.push(null)
  await Promise.all([disposing, pending])
  expect(res.state.status).toBe(410)
  expect(res.state.headers['set-cookie']).toBeUndefined()
  expect(routes).not.toContain(registered)
  expect(() => service.create()).toThrow(expect.objectContaining({ code: 'remote-connection/disposed' }))
  expect(() => service.loginUrl()).toThrow(expect.objectContaining({ code: 'remote-connection/disposed' }))
})

it('rejects QR URLs above the byte-mode capacity without replacing an outstanding invitation', () => {
  const tickets = new LoginTickets()
  const ticket = tickets.create('https://login.example', 120_000)
  expect(() => tickets.create(`https://login.example/${'a'.repeat(2331)}/`, 120_000)).toThrow(expect.objectContaining({ code: 'remote-connection/url-too-long' }))
  expect(tickets.state(ticket.id)).toBe('pending')
  tickets.dispose()
  expect(tickets.consume(credential(ticket))).toBe(false)
})
