/** Remote's public root page and independent credentials over real HTTP admission. */
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import * as Token from '@deepseek-ai/dsh-host-authentication-token'
import WebServer, { type WebEntryUrl } from '@deepseek-ai/dsh-host-webserver'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { PeerScope, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import RemoteConnection from '../src/index.ts'

afterEach(() => { vi.restoreAllMocks() })

interface Reply {
  readonly status: number | undefined
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

function owner(ctx: Context): RemoteConnection {
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  const invocation: RemoteInvocation = {
    request: { namespace: 'remoteConnection', method: 'create', args: {} },
    service: 'remoteConnection', peer, signal: peer.signal,
    uplink: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) }),
  }
  return ctx.extend({ invocation }).remoteConnection
}

function cookie(reply: Reply): string {
  const value = reply.headers['set-cookie']?.[0]?.split(';', 1)[0]
  if (value === undefined) throw new Error('login did not issue a Cookie')
  return value
}

async function mounted(withToken = false, releaseHeldRead?: () => void) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-root-'))
  const ctx = new Context()
  onTestFinished(async () => {
    releaseHeldRead?.()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const index = join(root, 'index.html')
  await writeFile(index, '<!doctype html><html><head></head><body>PRIVATE_APPLICATION</body></html>')
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const origin = ctx.webServer.getOrigin()
  const authority = `remote.example:${String(ctx.webServer.port)}`
  const publicUrl = `http://${authority}/`
  ctx.provide('webApp', { getAdvertisedUrl: () => publicUrl })
  await ctx.plugin(Connection, { trustedHosts: ['remote.example'] })
  const renderedPeers: PeerScope[] = []
  ctx.on('webserver/index-inject', (rows, peer) => {
    renderedPeers.push(peer)
    rows.push({ kind: 'script', placement: 'head', text: 'window.PRIVATE_BOOT_DATA = true' })
  })
  await ctx.plugin(FrontendStatic, { distIndex: index })
  const token = withToken ? ctx.plugin(Token, { cookieMaxAgeDays: 30 }) : undefined
  await token?.await()
  const config = RemoteConnection.Config({ ticketLifetimeMs: 120_000, pollIntervalMs: 1000 })
  const remote = ctx.plugin(RemoteConnection, config)
  await remote.await()
  const service = owner(ctx)
  const send = (path: string, method = 'GET', headers: Record<string, string> = {}, body?: string): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const request = httpRequest(new URL(path, origin), {
        method,
        headers: { host: authority, ...headers },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        response.once('error', reject)
        response.once('end', () => {
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') })
        })
      })
      request.once('error', reject)
      request.end(body)
    })
  const redeem = async () => {
    const ticket = service.create()
    return send('/?login=qr', 'POST', { 'content-type': 'text/plain', origin: publicUrl.slice(0, -1) }, new URL(ticket.url).hash.slice(1))
  }
  return { ctx, config, origin, authority, publicUrl, remote, token, service, send, redeem, renderedPeers }
}

it('offers an anonymous root page without Token and renders the admitted Remote Peer after QR login', async () => {
  const { ctx, authority, send, redeem, service, renderedPeers } = await mounted()
  const authenticate = vi.spyOn(ctx.connection.authentication, 'authenticate')
  const anonymous = await send('/')
  expect(anonymous.status).toBe(401)
  expect(anonymous.headers['content-type']).toContain('text/html')
  expect(anonymous.headers['cache-control']).toBe('no-store')
  expect(anonymous.body).toContain('<html')
  expect(anonymous.body).not.toContain('name="token"')
  expect(anonymous.body).not.toContain('PRIVATE_APPLICATION')
  expect(anonymous.body).not.toContain('PRIVATE_BOOT_DATA')
  expect(authenticate).toHaveBeenCalledTimes(1)
  expect(renderedPeers).toHaveLength(0)
  expect(() => service.loginUrl()).toThrow(expect.objectContaining({ code: 'remote-connection/token-unavailable' }))
  expect((await send('/', 'HEAD')).status).toBe(401)
  expect((await send('/index.html')).status).toBe(401)

  const exchanged = await redeem()
  expect(exchanged.status).toBe(204)
  const remoteCookie = cookie(exchanged)
  const admission = ctx.connection.admit({ headers: { host: authority, cookie: remoteCookie } })
  if ('rejection' in admission) throw new Error('Remote Cookie was rejected')
  expect(admission.peer).not.toBe(ctx.connection.browserPeer)
  authenticate.mockClear()
  const page = await send('/', 'GET', { cookie: remoteCookie })
  expect(page.status).toBe(200)
  expect(page.body).toContain('PRIVATE_APPLICATION')
  expect(page.body).toContain('PRIVATE_BOOT_DATA')
  expect(renderedPeers.at(-1)).toBe(admission.peer)
  expect(authenticate).toHaveBeenCalledTimes(1)
  authenticate.mockClear()
  const head = await send('/', 'HEAD', { cookie: remoteCookie })
  expect(head.status).toBe(200)
  expect(head.body).toBe('')
  expect(authenticate).toHaveBeenCalledTimes(1)
})

it('serves QR mode from the root even to a browser already authenticated through Token', async () => {
  const { service, send, renderedPeers } = await mounted(true)
  const ticket = service.create()
  const entry = new URL(ticket.url)
  expect(entry.pathname).toBe('/')
  expect(entry.search).toBe('?login=qr')
  const token = new URL(service.loginUrl())
  const authenticated = cookie(await send(token.pathname + token.search))
  const application = await send('/', 'GET', { cookie: authenticated })
  expect(application.status).toBe(200)
  expect(application.body).toContain('PRIVATE_APPLICATION')
  const rendered = renderedPeers.length
  for (const headers of [{}, { cookie: authenticated }]) {
    const page = await send('/?login=qr', 'GET', headers)
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(page.body).toContain('<dsh-device-pairing>')
    expect(page.body).toContain('./pairing/client.js')
    expect(page.body).toContain('<h1 id="title">Connect to this Host</h1>')
    expect(page.body).toContain('id="token-form"')
    expect(page.body).toContain('id="qr-notice"')
    expect(page.body).toContain('id="status"')
    expect(page.body).not.toContain('PRIVATE_APPLICATION')
    expect(page.body).not.toContain('PRIVATE_BOOT_DATA')
    expect(page.headers['set-cookie']).toBeUndefined()
    const head = await send('/?login=qr', 'HEAD', headers)
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(service.status(ticket.id).ticket).toBe('pending')
  }
  expect(renderedPeers).toHaveLength(rendered)
  const exchanged = await send('/?login=qr', 'POST', {
    'content-type': 'text/plain', cookie: authenticated,
  }, entry.hash.slice(1))
  expect(exchanged.status).toBe(204)
  expect(cookie(exchanged)).toMatch(/^dsh-remote-/u)
  expect(service.status(ticket.id).ticket).toBe('used')
})

it('keeps Token sign-in and pairing available after a QR invitation is rejected', async () => {
  const { send, renderedPeers } = await mounted(true)
  const rejected = await send('/?login=qr', 'POST', { 'content-type': 'text/plain' }, 'a'.repeat(43))
  expect(rejected.status).toBe(410)
  expect(rejected.headers['set-cookie']).toBeUndefined()
  const page = await send('/?login=qr')
  expect(page.status).toBe(200)
  expect(page.body).toContain('id="token-form"')
  expect(page.body).toContain('<dsh-device-pairing>')
  expect(page.body).toContain('./pairing/client.js')
  expect(page.body).not.toContain('PRIVATE_APPLICATION')
  expect(renderedPeers).toHaveLength(0)
})

it('keeps source refusals outside the root page and invitation exchange', async () => {
  const { ctx, publicUrl, send, service, renderedPeers } = await mounted()
  const ticket = service.create()
  const authenticate = vi.spyOn(ctx.connection.authentication, 'authenticate')
  const secret = new URL(ticket.url).hash.slice(1)
  for (const headers of [
    { host: 'untrusted.example' },
    { origin: 'http://untrusted.example' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    const page = await send('/', 'GET', headers)
    expect(page.status).toBe(403)
    const qrPage = await send('/?login=qr', 'GET', headers)
    expect(qrPage.status).toBe(403)
    expect(qrPage.body).not.toContain('<html')
    expect(page.body).not.toContain('<html')
    expect((await send('/?login=qr', 'POST', { 'content-type': 'text/plain', ...headers }, secret)).status).toBe(403)
    expect(service.status(ticket.id).ticket).toBe('pending')
  }
  expect(authenticate).not.toHaveBeenCalled()
  expect(renderedPeers).toHaveLength(0)
  const exchanged = await send('/?login=qr', 'POST', { 'content-type': 'text/plain', origin: publicUrl.slice(0, -1) }, secret)
  expect(exchanged.status).toBe(204)
})

it('keeps Token entries and source refusals within their WebServer isolation', async () => {
  const { ctx, authority, publicUrl, service, send } = await mounted()
  const isolated = ctx.isolate('webServer')
  await isolated.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const deny = vi.fn((): { kind: 'deny'; status: 403 } => ({ kind: 'deny', status: 403 }))
  isolated.on('webserver/authorize', deny, { prepend: true })
  isolated.effect(() => isolated.webServer.register({
    kind: 'exact', path: '/probe', auth: 'anonymous',
    handler(_request, response) { response.end('isolated') },
  }))
  await isolated.plugin(Token, { cookieMaxAgeDays: 30 })
  const isolatedEntries: WebEntryUrl[] = []
  isolated.emit(isolated.webServer, 'webserver/entry-url', publicUrl, isolatedEntries)
  expect(isolatedEntries).toHaveLength(1)
  expect(new URL(isolatedEntries[0]!.url).searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/u)

  expect(service.status(null)).toMatchObject({ url: publicUrl, availability: 'available' })
  expect(() => service.loginUrl()).toThrow(expect.objectContaining({ code: 'remote-connection/token-unavailable' }))
  const anonymous = await send('/')
  expect(anonymous.status).toBe(401)
  expect(anonymous.body).not.toContain('name="token"')
  expect(deny).not.toHaveBeenCalled()
  expect((await fetch(`${isolated.webServer.getOrigin()}/probe`)).status).toBe(403)
  expect(deny).toHaveBeenCalledOnce()

  await ctx.plugin(Token, { cookieMaxAgeDays: 30 })
  const link = new URL(service.loginUrl())
  expect(link.origin).toBe(new URL(publicUrl).origin)
  expect(link.pathname).toBe(new URL(publicUrl).pathname)
  const withOwnToken = await send('/')
  expect(withOwnToken.status).toBe(401)
  expect(withOwnToken.body).toContain('name="token"')
  const exchanged = await send(link.pathname + link.search)
  expect(exchanged.status).toBe(303)
  const ownCookie = cookie(exchanged)
  const admitted = ctx.connection.admit({ headers: { host: authority, cookie: ownCookie } })
  if ('rejection' in admitted) throw new Error('The owning WebServer refused its Token Cookie')
  expect((await send('/', 'GET', { cookie: ownCookie })).status).toBe(200)
  expect(deny).toHaveBeenCalledOnce()
})

it('keeps copied Token links and Remote credentials independent across provider unloads', async () => {
  const { ctx, authority, config, remote, token, service, send, redeem } = await mounted(true)
  const ticket = service.create()
  const link = new URL(service.loginUrl())
  const tokenSecret = link.searchParams.get('token')!
  expect(tokenSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(service.status(ticket.id).ticket).toBe('pending')
  const anonymous = await send('/')
  expect(anonymous.status).toBe(401)
  expect(anonymous.body).toContain('name="token"')
  expect(anonymous.body).not.toContain(tokenSecret)
  const tokenExchange = await send(link.pathname + link.search)
  expect(tokenExchange.status).toBe(303)
  const tokenCookie = cookie(tokenExchange)
  const tokenAdmission = ctx.connection.admit({ headers: { host: authority, cookie: tokenCookie } })
  if ('rejection' in tokenAdmission) throw new Error('Token Cookie was rejected')
  const remoteExchange = await redeem()
  expect(remoteExchange.status).toBe(204)
  const remoteCookie = cookie(remoteExchange)
  expect(remoteCookie.split('=', 1)[0]).not.toBe(tokenCookie.split('=', 1)[0])
  const remoteAdmission = ctx.connection.admit({ headers: { host: authority, cookie: remoteCookie } })
  if ('rejection' in remoteAdmission) throw new Error('Remote Cookie was rejected')
  expect(remoteAdmission.peer).not.toBe(tokenAdmission.peer)
  await remote.dispose()
  expect(remoteAdmission.peer.signal.aborted).toBe(true)
  expect(tokenAdmission.peer.signal.aborted).toBe(false)
  expect(ctx.connection.admit({ headers: { host: authority, cookie: remoteCookie } })).toEqual({ rejection: 401 })
  expect((await send('/', 'GET', { cookie: tokenCookie })).status).toBe(200)

  const resumed = ctx.plugin(RemoteConnection, config)
  await resumed.await()
  const restored = ctx.connection.admit({ headers: { host: authority, cookie: remoteCookie } })
  if ('rejection' in restored) throw new Error('Remote Cookie did not survive provider reload')
  expect(restored.peer).not.toBe(remoteAdmission.peer)
  expect((await send('/', 'GET', { cookie: remoteCookie })).status).toBe(200)
  await token?.dispose()
  expect(tokenAdmission.peer.signal.aborted).toBe(true)
  expect(restored.peer.signal.aborted).toBe(false)
  expect(ctx.connection.admit({ headers: { host: authority, cookie: tokenCookie } })).toEqual({ rejection: 401 })
  expect((await send('/', 'GET', { cookie: remoteCookie })).status).toBe(200)
  const otherTicket = owner(ctx).create()
  expect((await send('/?login=qr', 'POST', { 'content-type': 'text/plain' }, new URL(otherTicket.url).hash.slice(1))).status).toBe(204)
})

it('trusts an explicitly admitted in-process Peer without authenticating it again', async () => {
  const { ctx, origin, renderedPeers } = await mounted()
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  const authenticate = vi.spyOn(ctx.connection.authentication, 'authenticate')
  const page = await ctx.webServer.readResource(new Request(new URL('/', origin)), peer)
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('PRIVATE_APPLICATION')
  expect(renderedPeers.at(-1)).toBe(peer)
  expect(authenticate).not.toHaveBeenCalled()
})

it('waits for its admitted root read before completing Remote disposal', async () => {
  const release = Promise.withResolvers<undefined>()
  const { ctx, authority, remote, send, redeem, renderedPeers } = await mounted(false, () => { release.resolve(undefined) })
  const anonymous = await send('/')
  expect(anonymous.status).toBe(401)
  expect(anonymous.body).not.toContain('PRIVATE_APPLICATION')
  expect(anonymous.body).not.toContain('PRIVATE_BOOT_DATA')
  const remoteCookie = cookie(await redeem())
  const admission = ctx.connection.admit({ headers: { host: authority, cookie: remoteCookie } })
  if ('rejection' in admission) throw new Error('Remote Cookie was rejected')
  const reached = Promise.withResolvers<{ readonly request: Request; readonly peer: PeerScope | undefined }>()
  const read = ctx.webServer.readResource.bind(ctx.webServer)
  const readResource = vi.spyOn(ctx.webServer, 'readResource').mockImplementationOnce(async (request, peer) => {
    const response = await read(request, peer)
    reached.resolve({ request, peer })
    await release.promise
    return response
  })
  const authenticate = vi.spyOn(ctx.connection.authentication, 'authenticate')
  const pending = send('/', 'GET', { cookie: remoteCookie })
  let disposing: Promise<void> | undefined
  try {
    const held = await reached.promise
    expect(new URL(held.request.url).pathname).toBe('/index.html')
    expect(held.peer).toBe(admission.peer)
    expect(renderedPeers.at(-1)).toBe(admission.peer)
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(readResource).toHaveBeenCalledOnce()
    let disposed = false
    disposing = remote.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(held.request.signal.aborted).toBe(true) })
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await disposing
    const page = await pending
    expect(page.status).toBe(200)
    expect(page.body).toContain('PRIVATE_APPLICATION')
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(admission.peer.signal.aborted).toBe(true)
    expect(ctx.connection.admit({ headers: { host: authority, cookie: remoteCookie } })).toEqual({ rejection: 401 })
    const after = await send('/', 'GET', { cookie: remoteCookie })
    expect(after.status).toBe(401)
    expect(after.body).not.toContain('PRIVATE_APPLICATION')
    expect(after.body).not.toContain('PRIVATE_BOOT_DATA')
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([pending, ...disposing === undefined ? [] : [disposing]])
  }
})

it('does not publish routes or a Peer after disposal interrupts credential initialization', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const ctx = new Context()
  onTestFinished(async () => {
    release.resolve(undefined)
    await ctx.fiber.dispose()
  })
  class PausedCredentials extends MemoryCredentials {
    override async modifyRecord(
      key: CredentialKey,
      mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
    ): Promise<CredentialRecord | undefined> {
      entered.resolve(undefined)
      await release.promise
      return super.modifyRecord(key, mutate)
    }
  }
  await ctx.plugin(PausedCredentials)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  ctx.provide('webApp', { getAdvertisedUrl: () => 'http://remote.example/' })
  await ctx.plugin(Connection, { trustedHosts: ['remote.example'] })
  const registerRoute = vi.spyOn(ctx.webServer, 'register')
  const registerProvider = vi.spyOn(ctx.connection.authentication, 'register')
  const createPeer = vi.spyOn(ctx.connection, 'createPeer')
  const remote = ctx.plugin(RemoteConnection, RemoteConnection.Config({}))
  const initializing = Promise.allSettled([remote.await()])
  await entered.promise
  const disposing = remote.dispose()
  release.resolve(undefined)
  await disposing
  expect((await initializing).map(result => result.status)).toEqual(['fulfilled'])
  expect(registerRoute).not.toHaveBeenCalled()
  expect(registerProvider).not.toHaveBeenCalled()
  expect(createPeer).not.toHaveBeenCalled()
  expect(ctx.connection.admit({ headers: { host: 'remote.example' } })).toEqual({ rejection: 401 })
})

it('does not write a second response when an applicant disconnects during its credential body', async () => {
  const { ctx, origin, authority, publicUrl, service, send } = await mounted()
  const entered = Promise.withResolvers<{ readonly response: ServerResponse; readonly writes: () => number }>()
  const handled = Promise.withResolvers<undefined>()
  ctx.on('webserver/request', async (request, response, next) => {
    if (request.url !== '/?login=qr') { await next(); return }
    const writes = vi.spyOn(response, 'writeHead')
    entered.resolve({ response, writes: () => writes.mock.calls.length })
    try { await next() } finally { handled.resolve(undefined) }
  }, { prepend: true })
  const ticket = service.create()
  const secret = new URL(ticket.url).hash.slice(1)
  const errors: Error[] = []
  const request = httpRequest(new URL('/?login=qr', origin), {
    method: 'POST', headers: { host: authority, origin: publicUrl.slice(0, -1), 'content-type': 'text/plain' },
  })
  request.on('error', error => errors.push(error))
  const closed = new Promise<void>((resolve) => { request.once('close', resolve) })
  request.write(secret.slice(0, -1))
  try {
    const accepted = await entered.promise
    request.destroy()
    await Promise.all([closed, handled.promise])
    expect(accepted.response.destroyed).toBe(true)
    expect(accepted.writes()).toBe(0)
    expect(errors.every(error => Reflect.get(error, 'code') === 'ECONNRESET')).toBe(true)
    expect(service.status(ticket.id).ticket).toBe('pending')
    const completed = await send('/?login=qr', 'POST', { 'content-type': 'text/plain' }, secret)
    expect(completed.status).toBe(204)
  } finally {
    request.destroy()
    await closed
  }
})

it('reports provider faults as unavailable without rendering a login page or private data', async () => {
  const { ctx, send, renderedPeers } = await mounted()
  ctx.connection.authentication.register({ authenticate() { throw new Error('unavailable fixture provider') } })
  for (const path of ['/', '/?login=qr']) {
    const page = await send(path)
    expect(page.status).toBe(503)
    expect(page.body).not.toContain('<html')
    expect(page.body).not.toContain('PRIVATE_APPLICATION')
    expect(page.body).not.toContain('PRIVATE_BOOT_DATA')
  }
  expect(renderedPeers).toHaveLength(0)
})
