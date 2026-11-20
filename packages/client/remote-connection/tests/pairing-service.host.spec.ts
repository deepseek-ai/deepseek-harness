/** Anonymous HTTP requests, owner-only approval, and independent Remote browser authentication. */

import { randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Token from '@deepseek-ai/dsh-host-authentication-token'
import WebServer, { type WebEntryUrl, type WebResourceRoute, type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { materializeTlsFixture } from '../../../host/webserver/tests/tls-fixture.ts'
import RemoteConnection from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { PairingTicket } from '../src/types.ts'
import { renderPairingScript } from '../src/anonymous/index.ts'
import { RemoteBrowserAuth } from '../src/remote-auth.ts'
import { PairingRequests } from '../src/pairing-requests.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Non-owner used to check approval independently of Gateway grants. */
    'pairing-test-guest': { readonly kind: 'pairing-test-guest' }
  }
}

const config: Config = {
  cookieMaxAgeDays: 30, ticketLifetimeMs: 120_000, pollIntervalMs: 1000,
  pairing: {
    requestTtlMs: 10_000, maxRequests: 2, requestIntervalMs: 100, pollIntervalMs: 200,
    requestTimeoutMs: 1000, maxRetries: 3, retryMaxDelayMs: 1000,
  },
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function mounted(
  protocol: 'http:' | 'https:' = 'http:',
  storage = new Map<CredentialKey, CredentialRecord>(),
  withToken = false,
  advertisedUrl = `${protocol}//localhost/`,
) {
  const ctx = new Context()
  const root = protocol === 'https:' ? await mkdtemp(join(tmpdir(), 'dsh-pairing-tls-')) : undefined
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })
  class SharedCredentials extends MemoryCredentials {
    override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(storage.get(key)) }
    override async modifyRecord(
      key: CredentialKey,
      mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
    ): Promise<CredentialRecord | undefined> {
      const current = storage.get(key)
      const next = await mutate(current)
      if (next !== undefined) storage.set(key, next)
      return next ?? current
    }
  }
  await ctx.plugin(SharedCredentials)
  const tls = root === undefined ? undefined : await materializeTlsFixture(root)
  await ctx.plugin(WebServer, {
    host: '127.0.0.1', port: 0,
    ...tls === undefined ? {} : { tls: { certFile: tls.certFile, keyFile: tls.keyFile } },
  })
  ctx.provide('webApp', { getAdvertisedUrl: () => advertisedUrl })
  await ctx.plugin(Connection, { trustedHosts: ['pair.test', 'other.test', '192.0.2.40'] })
  const token = withToken ? ctx.plugin(Token, { cookieMaxAgeDays: 30 }) : undefined
  await token?.await()
  const routes: (WebRoute | WebResourceRoute)[] = []
  const register = ctx.webServer.register.bind(ctx.webServer)
  vi.spyOn(ctx.webServer, 'register').mockImplementation((route) => {
    const dispose = register(route)
    routes.push(route)
    return () => { routes.splice(routes.indexOf(route), 1); dispose() }
  })
  const fiber = ctx.plugin(RemoteConnection, config)
  await fiber.await()
  const service = ctx.remoteConnection
  const url = ctx.webServer.getOrigin()
  const headers = { host: 'pair.test', origin: `${protocol}//pair.test`, 'content-type': 'application/json' }
  const transport = protocol === 'https:' ? httpsRequest : httpRequest
  const open = (path: string, method: string, additional: Record<string, string> = {}) => {
    const result = Promise.withResolvers<Response>()
    const request = transport(`${url}${path}`, {
      method, headers: { ...headers, ...additional }, ...tls === undefined ? {} : { ca: tls.ca, servername: 'localhost' },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('error', result.reject)
      response.once('end', () => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') responseHeaders.set(key, value)
          else for (const item of value ?? []) responseHeaders.append(key, item)
        }
        const body = method === 'HEAD' || response.statusCode === 204 ? null : Buffer.concat(chunks)
        result.resolve(new Response(body, { status: response.statusCode!, headers: responseHeaders }))
      })
    })
    request.once('error', result.reject)
    const closed = new Promise<void>((resolve) => { request.once('close', resolve) })
    const settled = result.promise.then(() => undefined, () => undefined)
    cleanups.push(async () => { request.destroy(); await Promise.all([closed, settled]) })
    return { request, response: result.promise }
  }
  const send = (path: string, method = 'GET', additional: Record<string, string> = {}, body?: string) => {
    const pending = open(path, method, additional)
    pending.request.end(body)
    return pending.response
  }
  const openExchange = (operation: string, method: string, additional: Record<string, string> = {}) => open(`/pairing/${operation}`, method, additional)
  const exchange = (operation: string, method: string, body?: string, additional: Record<string, string> = {}) =>
    send(`/pairing/${operation}`, method, additional, body)
  const post = (operation: 'request' | 'status' | 'cancel', body?: object, additional: Record<string, string> = {}) =>
    exchange(operation, 'POST', JSON.stringify(body ?? (operation === 'request' ? { id: randomUUID(), secret: randomBytes(32).toString('base64url') } : undefined)), additional)
  const caller = (principal: Principal = { kind: 'owner' }) => {
    const peer = ctx.connection.createPeer({ principal })
    const invocation: RemoteInvocation = {
      service: 'remoteConnection', request: { namespace: 'remoteConnection', method: 'pairingRequests', args: {} }, signal: peer.signal, peer,
      uplink: <In>(): AsyncIterable<In> => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
      }),
    }
    return { service: ctx.extend({ invocation }).remoteConnection, signal: peer.signal }
  }
  const create = async () => {
    const response = await post('request')
    expect(response.status).toBe(200)
    return await response.json() as PairingTicket
  }
  const onceRequest = (callback: (request: IncomingMessage, response: ServerResponse) => void, before = false) => {
    const dispose = ctx.on('webserver/request', async (request, response, next) => {
      dispose()
      if (before) callback(request, response)
      const task = next()
      if (!before) callback(request, response)
      await task
    })
    cleanups.push(() => { dispose(); return Promise.resolve() })
  }
  const holdPost = async (operation: 'request' | 'status' | 'cancel', ticket: Pick<PairingTicket, 'id' | 'secret'>) => {
    const received = Promise.withResolvers<undefined>()
    onceRequest(() => { received.resolve(undefined) })
    const body = JSON.stringify({ id: ticket.id, secret: ticket.secret })
    const pending = openExchange(operation, 'POST')
    pending.request.write(body.slice(0, -1))
    await received.promise
    return { response: pending.response, finish: () => { pending.request.end(body.slice(-1)) } }
  }
  return { ctx, service, fiber, token, routes, post, exchange, send, holdPost, create, caller, url, headers, onceRequest }
}

it.each(['http:', 'https:'] as const)('delivers a valid Remote Cookie without Token only to the approved applicant over %s', async (protocol) => {
  const fixture = await mounted(protocol)
  vi.useFakeTimers({ toFake: ['Date'] })
  const { ctx, create, post, caller } = fixture
  const ticket = await create()
  const owner = caller()
  expect(owner.service.status(null).availability).toBe('unreachable-host')
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([{
    id: ticket.id, code: ticket.code, authority: `${protocol}//pair.test`, sourceIp: '127.0.0.1', expiresInMs: 10_000,
  }])
  expect(owner.service.decidePairing(ticket.id, 'allow', owner.signal)).toBe('approved')
  vi.setSystemTime(Date.now() + 200)
  const stolen = await post('status', { id: ticket.id, secret: 'A'.repeat(43) })
  expect(await stolen.json()).toEqual({ status: 'expired' })
  expect(stolen.headers.get('set-cookie')).toBeNull()
  const response = await post('status', { id: ticket.id, secret: ticket.secret })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'completed' })
  const cookie = response.headers.get('set-cookie')!
  expect(cookie).toContain('HttpOnly')
  expect(cookie.includes('; Secure')).toBe(protocol === 'https:')
  expect(response.headers.get('cache-control')).toBe('no-store')
  const admitted = ctx.connection.admit({ headers: { host: 'pair.test', cookie: cookie.split(';', 1)[0]! } })
  if ('rejection' in admitted) throw new Error('Remote pairing Cookie was rejected')
  expect(admitted.peer).not.toBe(ctx.connection.browserPeer)
  expect(admitted.peer.principal).toEqual({ kind: 'owner' })
  vi.setSystemTime(Date.now() + 200)
  const retry = await post('status', { id: ticket.id, secret: ticket.secret })
  expect(retry.headers.get('set-cookie')).toBe(cookie)
  expect(await retry.json()).toEqual({ status: 'completed' })
})

it('keeps anonymous polls pending until approval and validates their authority', async () => {
  const { create, post, caller } = await mounted()
  vi.useFakeTimers({ toFake: ['Date'] })
  const ticket = await create()
  const body = { id: ticket.id, secret: ticket.secret }
  expect((await post('status', body)).status).toBe(429)
  vi.setSystemTime(Date.now() + 200)
  const pending = await post('status', body)
  expect(await pending.json()).toEqual({ status: 'pending' })
  expect(pending.headers.get('set-cookie')).toBeNull()
  const wrongHost = await post('status', body, { host: 'other.test', origin: 'http://other.test' })
  expect(await wrongHost.json()).toEqual({ status: 'expired' })
  const owner = caller()
  owner.service.decidePairing(ticket.id, 'deny', owner.signal)
  vi.setSystemTime(Date.now() + 200)
  const denied = await post('status', body)
  expect(await denied.json()).toEqual({ status: 'denied' })
  expect(denied.headers.get('set-cookie')).toBeNull()
})

it('shares Remote authentication with QR behind an advertised HTTPS proxy while retaining the listener authority', async () => {
  const { ctx, create, caller, post, send } = await mounted('http:', new Map(), false, 'https://pair.test/')
  vi.useFakeTimers({ toFake: ['Date'] })
  const ticket = await create()
  expect(ticket.authority).toBe('http://pair.test')
  const owner = caller()
  owner.service.decidePairing(ticket.id, 'allow', owner.signal)
  vi.setSystemTime(Date.now() + config.pairing.pollIntervalMs)
  const response = await post('status', { id: ticket.id, secret: ticket.secret }, { 'x-forwarded-proto': 'https' })
  expect(await response.json()).toEqual({ status: 'completed' })
  const cookie = response.headers.get('set-cookie')!
  expect(cookie).toContain('; Secure')
  const paired = ctx.connection.admit({ headers: { host: 'pair.test', cookie: cookie.split(';', 1)[0]! } })
  if ('rejection' in paired) throw new Error('Remote pairing Cookie was rejected at the listener authority')
  const qr = owner.service.create()
  const exchanged = await send('/?login=qr', 'POST', { 'content-type': 'text/plain' }, new URL(qr.url).hash.slice(1))
  expect(exchanged.status).toBe(204)
  const qrCookie = exchanged.headers.get('set-cookie')!.split(';', 1)[0]!
  expect(ctx.connection.admit({ headers: { host: 'pair.test', cookie: qrCookie } })).toEqual({ peer: paired.peer })
  expect(() => owner.service.loginUrl()).toThrow(expect.objectContaining({ code: 'remote-connection/token-unavailable' }))
})

it.each(['allow', 'deny'] as const)('delivers the first owner decision %s when opposite decisions precede an in-flight poll body', async (first) => {
  const { ctx, create, caller, holdPost } = await mounted()
  vi.useFakeTimers({ toFake: ['Date'] })
  const ticket = await create()
  const owner = caller()
  const other = caller()
  vi.setSystemTime(Date.now() + config.pairing.pollIntervalMs)
  const pending = await holdPost('status', ticket)
  const decision = first === 'allow' ? 'approved' : 'denied'
  expect(owner.service.decidePairing(ticket.id, first, owner.signal)).toBe(decision)
  expect(other.service.decidePairing(ticket.id, first === 'allow' ? 'deny' : 'allow', other.signal)).toBe(decision)
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([])
  pending.finish()
  const response = await pending.response
  expect(await response.json()).toEqual({ status: first === 'allow' ? 'completed' : 'denied' })
  const cookie = response.headers.get('set-cookie')
  if (first === 'allow') {
    expect(cookie).not.toBeNull()
    expect(ctx.connection.admit({ headers: { host: 'pair.test', cookie: cookie!.split(';', 1)[0]! } })).toHaveProperty('peer')
  } else {
    expect(cookie).toBeNull()
    expect(ctx.connection.admit({ headers: { host: 'pair.test' } })).toEqual({ rejection: 401 })
  }
})

it.each(['allow', 'deny'] as const)('finishes an in-flight cancellation after the owner chooses %s without issuing a Cookie', async (decision) => {
  const { ctx, create, caller, holdPost, post } = await mounted()
  vi.useFakeTimers({ toFake: ['Date'] })
  const ticket = await create()
  const owner = caller()
  const pending = await holdPost('cancel', ticket)
  expect(owner.service.decidePairing(ticket.id, decision, owner.signal)).toBe(decision === 'allow' ? 'approved' : 'denied')
  pending.finish()
  const response = await pending.response
  const status = decision === 'allow' ? 'cancelled' : 'denied'
  expect(await response.json()).toEqual({ status })
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([])
  vi.setSystemTime(Date.now() + config.pairing.pollIntervalMs)
  const after = await post('status', { id: ticket.id, secret: ticket.secret })
  expect(await after.json()).toEqual({ status })
  expect(after.headers.get('set-cookie')).toBeNull()
  expect(ctx.connection.admit({ headers: { host: 'pair.test' } })).toEqual({ rejection: 401 })
})

it('withdraws approval while the applicant collection body is still incomplete', async () => {
  const { create, caller, holdPost, post } = await mounted()
  vi.useFakeTimers({ toFake: ['Date'] })
  const ticket = await create()
  const owner = caller()
  expect(owner.service.decidePairing(ticket.id, 'allow', owner.signal)).toBe('approved')
  vi.setSystemTime(Date.now() + config.pairing.pollIntervalMs)
  const pending = await holdPost('status', ticket)
  const cancelled = await post('cancel', { id: ticket.id, secret: ticket.secret })
  expect(await cancelled.json()).toEqual({ status: 'cancelled' })
  expect(cancelled.headers.get('set-cookie')).toBeNull()
  vi.setSystemTime(Date.now() + config.pairing.pollIntervalMs)
  pending.finish()
  const response = await pending.response
  expect(await response.json()).toEqual({ status: 'cancelled' })
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(owner.service.decidePairing(ticket.id, 'allow', owner.signal)).toBe('unavailable')
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([])
})

it('expires approval at the exact deadline while a collection body is still incomplete', async () => {
  const { create, caller, holdPost } = await mounted()
  vi.useFakeTimers({ toFake: ['Date'] })
  const createdAt = Date.now()
  const ticket = await create()
  const owner = caller()
  expect(owner.service.decidePairing(ticket.id, 'allow', owner.signal)).toBe('approved')
  vi.setSystemTime(createdAt + config.pairing.requestTtlMs - 1)
  const pending = await holdPost('status', ticket)
  vi.setSystemTime(createdAt + config.pairing.requestTtlMs)
  pending.finish()
  const response = await pending.response
  expect(await response.json()).toEqual({ status: 'expired' })
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(owner.service.decidePairing(ticket.id, 'allow', owner.signal)).toBe('unavailable')
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([])
})

it('keeps an issued Cookie valid after cancellation, a later denial, and the ticket deadline', async () => {
  const { ctx, create, caller, post } = await mounted()
  vi.useFakeTimers({ toFake: ['Date'] })
  const createdAt = Date.now()
  const ticket = await create()
  const body = { id: ticket.id, secret: ticket.secret }
  const owner = caller()
  owner.service.decidePairing(ticket.id, 'allow', owner.signal)
  vi.setSystemTime(createdAt + config.pairing.pollIntervalMs)
  const delivered = await post('status', body)
  expect(await delivered.json()).toEqual({ status: 'completed' })
  const cookie = delivered.headers.get('set-cookie')!
  const cancelled = await post('cancel', body)
  expect(await cancelled.json()).toEqual({ status: 'completed' })
  expect(cancelled.headers.get('set-cookie')).toBe(cookie)
  expect(owner.service.decidePairing(ticket.id, 'deny', owner.signal)).toBe('unavailable')
  vi.setSystemTime(createdAt + config.pairing.requestTtlMs)
  const expired = await post('status', body)
  expect(await expired.json()).toEqual({ status: 'expired' })
  expect(expired.headers.get('set-cookie')).toBeNull()
  expect(ctx.connection.admit({ headers: { host: 'pair.test', cookie: cookie.split(';', 1)[0]! } })).toHaveProperty('peer')
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([])
})

it.each(['plugin reload', 'new Host activation'] as const)('forgets approved tickets but preserves issued Cookies after %s', async (mode) => {
  const storage = new Map<CredentialKey, CredentialRecord>()
  const original = await mounted('http:', storage)
  vi.useFakeTimers({ toFake: ['Date'] })
  const ticket = await original.create()
  const owner = original.caller()
  owner.service.decidePairing(ticket.id, 'allow', owner.signal)
  vi.setSystemTime(Date.now() + config.pairing.pollIntervalMs)
  const delivered = await original.post('status', { id: ticket.id, secret: ticket.secret })
  expect(await delivered.json()).toEqual({ status: 'completed' })
  const cookie = delivered.headers.get('set-cookie')!
  const uncollected = await original.create()
  expect(owner.service.decidePairing(uncollected.id, 'allow', owner.signal)).toBe('approved')
  let current = original
  if (mode === 'plugin reload') {
    await original.fiber.dispose()
    await original.ctx.plugin(RemoteConnection, config).await()
  } else {
    await original.ctx.fiber.dispose()
    current = await mounted('http:', storage)
  }
  const resumed = current.caller()
  expect(resumed.service.pairingRequests(resumed.signal).requests).toEqual([])
  for (const previous of [ticket, uncollected]) {
    expect(resumed.service.decidePairing(previous.id, 'allow', resumed.signal)).toBe('unavailable')
    const response = await current.post('status', { id: previous.id, secret: previous.secret })
    expect(await response.json()).toEqual({ status: 'expired' })
    expect(response.headers.get('set-cookie')).toBeNull()
  }
  expect(current.ctx.connection.admit({ headers: { host: 'pair.test', cookie: cookie.split(';', 1)[0]! } })).toHaveProperty('peer')
})

it.each([
  ['PAIR.test:80', 'http://pair.test', 'http://pair.test'],
  ['[::1]:80', 'http://[::1]', 'http://[::1]'],
  ['pair.test:9090', 'http://pair.test:9090', 'http://pair.test:9090'],
])('normalizes accepted Host %s using the listener protocol', async (host, origin, authority) => {
  const { post } = await mounted()
  const response = await post('request', undefined, { host, origin })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ authority })
})

it('records the HTTP peer instead of the destination Host or forwarded addresses', async () => {
  const { post, caller } = await mounted()
  const response = await post('request', undefined, {
    host: '192.0.2.40', origin: 'http://192.0.2.40',
    'x-forwarded-for': '198.51.100.77', 'x-real-ip': '198.51.100.78', forwarded: 'for=198.51.100.79',
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ authority: 'http://192.0.2.40', sourceIp: '127.0.0.1' })
  const owner = caller()
  expect(owner.service.pairingRequests(owner.signal).requests).toMatchObject([{
    authority: 'http://192.0.2.40', sourceIp: '127.0.0.1',
  }])
})

it.each([
  ['192.0.2.24', '192.0.2.24'],
  ['::ffff:192.0.2.24', '192.0.2.24'],
  ['2001:db8:abcd:1234::24', '2001:db8:abcd:1234::24'],
  [undefined, null],
])('records the socket IP %s in the ticket and approval list', async (remoteAddress, sourceIp) => {
  const { onceRequest, create, caller } = await mounted()
  onceRequest((request) => {
    Object.defineProperty(request.socket, 'remoteAddress', { configurable: true, value: remoteAddress })
  }, true)
  const ticket = await create()
  expect(ticket.sourceIp).toBe(sourceIp)
  const owner = caller()
  expect(owner.service.pairingRequests(owner.signal).requests).toMatchObject([{ id: ticket.id, sourceIp }])
})

it('captures the connection IP before awaiting the request body', async () => {
  const { onceRequest, create } = await mounted()
  onceRequest((request) => {
    Object.defineProperty(request.socket, 'remoteAddress', { configurable: true, value: undefined })
  })
  expect((await create()).sourceIp).toBe('127.0.0.1')
})

it('checks request trust and method before anonymous allocation', async () => {
  const { post, exchange, caller } = await mounted()
  const allocate = vi.spyOn(PairingRequests.prototype, 'create')
  const poll = vi.spyOn(PairingRequests.prototype, 'poll')
  const issue = vi.spyOn(RemoteBrowserAuth.prototype, 'createSessionCookie')
  for (const operation of ['request', 'status', 'cancel'] as const) {
    for (const headers of [{ host: 'untrusted.test' }, { origin: 'http://foreign.test' }, { 'sec-fetch-site': 'cross-site' }]) {
      const rejected = await post(operation, undefined, headers)
      expect(rejected.status).toBe(403)
      expect(await rejected.text()).toBe('forbidden')
    }
  }
  expect(allocate).not.toHaveBeenCalled()
  expect(poll).not.toHaveBeenCalled()
  expect(issue).not.toHaveBeenCalled()
  const get = await exchange('request', 'GET')
  expect(get.status).toBe(405)
  expect(get.headers.get('allow')).toBe('POST')
  const owner = caller()
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([])
})

it('keeps paired Remote credentials independent from Token through provider unload and reload', async () => {
  const { ctx, fiber, token, create, post, caller, send } = await mounted('http:', new Map(), true)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/private',
    handler(_request, response, peer) { response.end(peer?.id) },
  }))
  const entries: WebEntryUrl[] = []
  ctx.emit(ctx.webServer, 'webserver/entry-url', 'http://pair.test/', entries)
  const entry = entries.find(candidate => new URL(candidate.url).searchParams.has('token'))
  if (entry === undefined) throw new Error('Token entry URL was not published')
  const tokenResponse = await send(new URL(entry.url).pathname + new URL(entry.url).search)
  expect(tokenResponse.status).toBe(303)
  const tokenCookie = tokenResponse.headers.get('set-cookie')!.split(';', 1)[0]!
  const tokenAdmission = ctx.connection.admit({ headers: { host: 'pair.test', cookie: tokenCookie } })
  if ('rejection' in tokenAdmission) throw new Error('Token Cookie was rejected')

  vi.useFakeTimers({ toFake: ['Date'] })
  const ticket = await create()
  const owner = caller()
  expect(owner.service.decidePairing(ticket.id, 'allow', owner.signal)).toBe('approved')
  vi.setSystemTime(Date.now() + config.pairing.pollIntervalMs)
  const paired = await post('status', { id: ticket.id, secret: ticket.secret })
  expect(await paired.json()).toEqual({ status: 'completed' })
  const remoteCookie = paired.headers.get('set-cookie')!.split(';', 1)[0]!
  expect(remoteCookie.split('=', 1)[0]).not.toBe(tokenCookie.split('=', 1)[0])
  const remoteAdmission = ctx.connection.admit({ headers: { host: 'pair.test', cookie: remoteCookie } })
  if ('rejection' in remoteAdmission) throw new Error('Remote pairing Cookie was rejected')
  expect(remoteAdmission.peer).not.toBe(tokenAdmission.peer)
  expect(await (await send('/private', 'GET', { cookie: remoteCookie })).text()).toBe(remoteAdmission.peer.id)

  await fiber.dispose()
  expect(remoteAdmission.peer.signal.aborted).toBe(true)
  expect(tokenAdmission.peer.signal.aborted).toBe(false)
  expect((await send('/private', 'GET', { cookie: remoteCookie })).status).toBe(401)
  expect(await (await send('/private', 'GET', { cookie: tokenCookie })).text()).toBe(tokenAdmission.peer.id)
  await ctx.plugin(RemoteConnection, config)
  const restored = ctx.connection.admit({ headers: { host: 'pair.test', cookie: remoteCookie } })
  if ('rejection' in restored) throw new Error('Remote pairing Cookie did not survive reload')
  expect(restored.peer).not.toBe(remoteAdmission.peer)
  expect(await (await send('/private', 'GET', { cookie: remoteCookie })).text()).toBe(restored.peer.id)
  await token?.dispose()
  expect(tokenAdmission.peer.signal.aborted).toBe(true)
  expect(restored.peer.signal.aborted).toBe(false)
  expect((await send('/private', 'GET', { cookie: tokenCookie })).status).toBe(401)
  expect((await send('/private', 'GET', { cookie: remoteCookie })).status).toBe(200)
})

it('refuses malformed, oversized, and extra credential fields without changing requests', async () => {
  const { create, post, exchange, caller } = await mounted()
  const ticket = await create()
  const body = { id: ticket.id, secret: ticket.secret }
  expect((await post('status', body, { 'content-type': 'text/plain' })).status).toBe(400)
  expect((await post('status', body, { 'content-type': 'application/jsonp' })).status).toBe(400)
  expect((await post('status', { ...body, secret: ticket.code })).status).toBe(400)
  expect((await post('status', { ...body, approved: true })).status).toBe(400)
  expect((await post('status', { ...body, id: 'not-a-uuid' })).status).toBe(400)
  expect((await post('request', {})).status).toBe(400)
  expect((await post('request', { sourceIp: '198.51.100.80' })).status).toBe(400)
  const malformed = await exchange('status', 'POST', '{')
  expect(malformed.status).toBe(400)
  const oversized = await exchange('status', 'POST', 'x'.repeat(1025))
  expect(oversized.status).toBe(413)
  const owner = caller()
  expect(owner.service.pairingRequests(owner.signal).requests).toHaveLength(1)
  expect(owner.service.pairingRequests(owner.signal).requests[0]?.sourceIp).toBe('127.0.0.1')
})

it('bounds requests and expires cancelled tickets without granting a session', async () => {
  const { create, post, caller } = await mounted()
  vi.useFakeTimers({ toFake: ['Date'] })
  const ticket = await create()
  expect((await post('request')).status).toBe(429)
  const cancelled = await post('cancel', { id: ticket.id, secret: ticket.secret })
  expect(await cancelled.json()).toEqual({ status: 'cancelled' })
  expect(cancelled.headers.get('set-cookie')).toBeNull()
  const owner = caller()
  expect(owner.service.decidePairing(ticket.id, 'allow', owner.signal)).toBe('unavailable')
  vi.setSystemTime(Date.now() + 10_000)
  const expired = await post('status', { id: ticket.id, secret: ticket.secret })
  expect(await expired.json()).toEqual({ status: 'expired' })
})

it.each(['declared', 'chunked'] as const)('closes an oversized %s request without waiting for its body to finish', async (mode) => {
  const { url, headers, onceRequest, caller } = await mounted()
  const serverClosed = new Promise<void>((resolve) => {
    onceRequest((incoming) => { incoming.socket.once('close', () => { resolve() }) })
  })
  const request = httpRequest(`${url}/pairing/request`, {
    method: 'POST', headers: {
      ...headers, connection: 'keep-alive',
      ...(mode === 'declared' ? { 'content-length': '1025' } : { 'transfer-encoding': 'chunked' }),
    },
  })
  cleanups.push(() => { request.destroy(); return Promise.resolve() })
  const clientClosed = new Promise<void>((resolve) => { request.once('close', () => { resolve() }) })
  const result = new Promise<{ response: IncomingMessage; body: string }>((resolve, reject) => {
    request.once('error', reject)
    request.once('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.once('error', reject)
      response.once('end', () => { resolve({ response, body: Buffer.concat(chunks).toString('utf8') }) })
    })
  })
  request.flushHeaders()
  if (mode === 'chunked') request.write('x'.repeat(1025))
  const { response, body } = await result
  expect(response.statusCode).toBe(413)
  expect(response.headers.connection).toBe('close')
  expect(response.headers['set-cookie']).toBeUndefined()
  expect(JSON.parse(body)).toEqual({ status: 'invalid' })
  expect(request.writableEnded).toBe(false)
  await Promise.all([serverClosed, clientClosed])
  const owner = caller()
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([])
})

it('enforces owner approval even when called outside Gateway dispatch', async () => {
  const { create, caller, service } = await mounted()
  const ticket = await create()
  const guest = caller({ kind: 'pairing-test-guest' })
  expect(() => guest.service.pairingRequests(guest.signal)).toThrow(expect.objectContaining({ code: 'remote-connection/owner-required' }))
  expect(() => guest.service.decidePairing(ticket.id, 'allow', guest.signal)).toThrow(expect.objectContaining({ code: 'remote-connection/owner-required' }))
  expect(() => service.pairingRequests(guest.signal)).toThrow(expect.objectContaining({ code: 'remote-connection/owner-required' }))
  const owner = caller()
  const cancelled = AbortSignal.abort(new Error('cancelled'))
  expect(() => owner.service.decidePairing(ticket.id, 'allow', cancelled)).toThrow('cancelled')
  expect(owner.service.pairingRequests(owner.signal).requests).toHaveLength(1)
})

it('embeds pairing directly in the anonymous Remote page and removes its contributions on unload', async () => {
  const { fiber, routes, caller, send } = await mounted()
  const response = await send('/')
  expect(response.status).toBe(401)
  const html = await response.text()
  expect(html).toContain('<dsh-device-pairing>')
  expect(html).toContain('<script defer src="./pairing/client.js"></script>')
  expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
  expect(html).not.toContain('name="token"')
  const head = await send('/', 'HEAD')
  expect(head.status).toBe(401)
  expect(await head.text()).toBe('')
  const owner = caller()
  await fiber.dispose()
  expect(routes.some(route => route.path.startsWith('/pairing/'))).toBe(false)
  expect(routes.some(route => route.path === '/')).toBe(false)
  expect((await send('/')).status).toBe(404)
  expect(() => owner.service.pairingRequests(owner.signal)).toThrow(expect.objectContaining({ code: 'remote-connection/disposed' }))
})

it('serves its public browser asset without a cookie and removes the route on unload', async () => {
  const { send, fiber } = await mounted()
  const asset = '/pairing/client.js'
  const response = await send(asset)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(await response.text()).toBe(renderPairingScript(config.pairing))
  const head = await send(asset, 'HEAD')
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  const post = await send(asset, 'POST')
  expect(post.status).toBe(405)
  expect(post.headers.get('allow')).toBe('GET, HEAD')
  await fiber.dispose()
  expect((await send(asset)).status).toBe(404)
})

it('joins an unfinished request body on unload without allocating a ticket', async () => {
  const { fiber, url, headers, onceRequest, caller } = await mounted()
  const received = new Promise<void>((resolve) => { onceRequest(() => { resolve() }) })
  const request = httpRequest(`${url}/pairing/request`, { method: 'POST', headers })
  const outcome = new Promise<number | undefined>((resolve, reject) => {
    request.once('response', (response) => { response.resume(); response.once('end', () =>{  resolve(response.statusCode) }) })
    request.once('error', reject)
  })
  request.flushHeaders()
  request.write('{')
  await received
  const owner = caller()
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([])
  await fiber.dispose()
  request.end()
  expect(await outcome).toBe(503)
})

it('contains an applicant disconnect while its body is incomplete', async () => {
  const { url, headers, onceRequest, caller } = await mounted()
  const received = new Promise<void>((resolve) => { onceRequest((incoming) => { incoming.once('close', resolve) }) })
  const request = httpRequest(`${url}/pairing/request`, { method: 'POST', headers })
  const connected = new Promise<void>((resolve) => { onceRequest(() => { resolve() }) })
  const closed = new Promise<void>((resolve) => { request.once('error', () => {}); request.once('close', resolve) })
  request.write('{')
  await connected
  request.destroy()
  await Promise.all([received, closed])
  const owner = caller()
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([])
})

it('refuses a body that fails while being read', async () => {
  const { onceRequest, post, caller } = await mounted()
  onceRequest((request) => { request.emit('error', new Error('body transport failure')) })
  const response = await post('request')
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ status: 'invalid' })
  const owner = caller()
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([])
})

it('keeps an approval retryable when Remote refuses or fails to sign', async () => {
  const { ctx, create, post, caller } = await mounted()
  vi.useFakeTimers({ toFake: ['Date'] })
  const ticket = await create()
  const owner = caller()
  owner.service.decidePairing(ticket.id, 'allow', owner.signal)
  const issuer = vi.spyOn(RemoteBrowserAuth.prototype, 'createSessionCookie')
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  try {
    vi.setSystemTime(Date.now() + 200)
    issuer.mockReturnValueOnce(undefined)
    const unavailable = await post('status', { id: ticket.id, secret: ticket.secret })
    expect(unavailable.status).toBe(503)
    expect(unavailable.headers.get('set-cookie')).toBeNull()
    vi.setSystemTime(Date.now() + 200)
    issuer.mockImplementationOnce(() => { throw new Error('signing unavailable') })
    const failed = await post('status', { id: ticket.id, secret: ticket.secret })
    expect(failed.status).toBe(503)
    expect(failed.headers.get('set-cookie')).toBeNull()
    vi.setSystemTime(Date.now() + 200)
    const retry = await post('status', { id: ticket.id, secret: ticket.secret })
    expect(await retry.json()).toEqual({ status: 'completed' })
    expect(retry.headers.get('set-cookie')).toContain('HttpOnly')
  } finally { issuer.mockRestore(); warn.mockRestore() }
})

it('refuses a retained HTTP callback after its plugin has unloaded', async () => {
  const { ctx, fiber, routes, post } = await mounted()
  const callback = routes.find(route => route.path === '/pairing/request')!
  await fiber.dispose()
  ctx.effect(() => ctx.webServer.register(callback))
  const response = await post('request')
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ status: 'unavailable' })
})

it('rejects a lifetime too short to allow its first poll', async () => {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  expect(() => new RemoteConnection(ctx, { ...config, pairing: { ...config.pairing, requestTtlMs: config.pairing.pollIntervalMs } }))
    .toThrow('pairing.requestTtlMs must exceed pairing.pollIntervalMs')
})

it.each(['request', 'status'] as const)('keeps a delayed old %s separate from a replacement on the same connection IP', async (operation) => {
  const { create, post, caller, holdPost } = await mounted()
  vi.useFakeTimers({ toFake: ['Date'] })
  const owner = caller()
  const identity = { id: randomUUID() as PairingTicket['id'], secret: randomBytes(32).toString('base64url') }
  const first = operation === 'status' ? await create() : identity
  const delayed = await holdPost(operation, first)
  if (operation === 'request') expect((await post('request', first)).status).toBe(200)
  expect(await (await post('cancel', { id: first.id, secret: first.secret })).json()).toEqual({ status: 'cancelled' })
  vi.setSystemTime(Date.now() + config.pairing.requestIntervalMs)
  const replacement = await create()
  expect(replacement.id).not.toBe(first.id)
  expect(owner.service.pairingRequests(owner.signal).requests.map(row => row.id)).toEqual([replacement.id])
  expect(owner.service.decidePairing(first.id, 'allow', owner.signal)).toBe('unavailable')
  vi.setSystemTime(Date.now() + config.pairing.pollIntervalMs)
  delayed.finish()
  const oldResponse = await delayed.response
  expect(oldResponse.headers.has('set-cookie')).toBe(false)
  expect(await oldResponse.json()).toMatchObject(operation === 'request' ? { id: first.id } : { status: 'cancelled' })
  expect(owner.service.pairingRequests(owner.signal).requests).toEqual([expect.objectContaining({ id: replacement.id, sourceIp: '127.0.0.1' })])
  const freshStatus = await post('status', { id: replacement.id, secret: replacement.secret })
  expect(await freshStatus.json()).toEqual({ status: 'pending' })
  expect(freshStatus.headers.has('set-cookie')).toBe(false)
  expect(owner.service.decidePairing(replacement.id, 'allow', owner.signal)).toBe('approved')
  vi.setSystemTime(Date.now() + config.pairing.pollIntervalMs)
  expect((await post('status', { id: replacement.id, secret: replacement.secret })).headers.has('set-cookie')).toBe(true)
})

it('rejects a retry delay cap below the applicant polling interval', () => {
  const ctx = new Context()
  expect(() => new RemoteConnection(ctx, { ...config, pairing: { ...config.pairing, retryMaxDelayMs: 1 } }))
    .toThrow('pairing.retryMaxDelayMs must be at least pairing.pollIntervalMs')
})
