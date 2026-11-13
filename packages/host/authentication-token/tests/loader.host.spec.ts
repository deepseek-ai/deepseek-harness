/** Real Loader composition exercises Token as an independent authentication plugin. */
import { request as httpRequest } from 'node:http'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
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
import { expect, it, onTestFinished } from 'vitest'
import * as Token from '../src/index.ts'
import { BrowserAuth } from '../src/browser-auth.ts'

it('serves token exchanges through WebServer and keeps token-owned Peers outside Connection defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-token-plugin-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-token-plugin-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  })
  const path = join(root, 'cordis.yml')
  await writeFile(path, [
    { name: 'cordis:credentials', config: { path: join(root, '.credentials.yaml'), watch: false } },
    { name: 'cordis:webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: 'cordis:connection' },
    { id: 'token', name: 'cordis:token' },
  ].map(row => `- ${JSON.stringify(row)}`).join('\n') + '\n')
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, credentials: LocalCredentials, webserver: WebServer, connection: Connection, token: Token,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const auth = await BrowserAuth.create(ctx[Context.root], ctx.credentials, 30)
  const login = new URL(auth.authenticatedUrl(origin))
  expect(login.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const exchanged = await fetch(login, { redirect: 'manual' })
  expect(exchanged.status).toBe(303)
  expect(exchanged.headers.get('location')).toBe('./')
  const cookie = exchanged.headers.get('set-cookie')?.split(';', 1)[0]
  expect(cookie).toBeDefined()
  const headers = { host: new URL(origin).host, cookie }
  const admission = ctx.connection.authentication.authenticate({ headers })
  if ('rejection' in admission) throw new Error('token Cookie was rejected')
  expect(admission.peer).not.toBe(ctx.connection.browserPeer)
  expect(ctx.connection.authentication.authenticate({ headers })).toEqual(admission)

  const apiUrl = new URL(auth.authenticatedUrl(new URL('/connect', login).href))
  for (const source of [{ host: 'untrusted.example' }, { origin: 'http://untrusted.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const refused = await new Promise<{ status: number | undefined; cookie: string[] | undefined }>((resolve, reject) => {
      const request = httpRequest(apiUrl, { headers: source }, (response) => {
        response.resume()
        response.once('end', () => { resolve({ status: response.statusCode, cookie: response.headers['set-cookie'] }) })
      })
      request.once('error', reject)
      request.end()
    })
    expect(refused.status).toBe(403)
    expect(refused.cookie).toBeUndefined()
  }
  const connected = await fetch(apiUrl, { redirect: 'manual' })
  expect(connected.status).toBe(302)
  const apiCookie = connected.headers.get('set-cookie')?.split(';', 1)[0]
  const apiHeaders = { host: new URL(origin).host, cookie: apiCookie }
  const api = ctx.connection.admit({ headers: apiHeaders })
  if ('rejection' in api) throw new Error('API Cookie was rejected')
  expect(api.peer).not.toBe(admission.peer)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/page.html', auth: 'required',
    resource: async (_request, peer) => Response.json({ id: peer?.id }),
  }))
  const page = await fetch(new URL('/page.html', login), { headers: { cookie: apiCookie! } })
  expect(page.status).toBe(200)
  expect(await page.json()).toEqual({ id: api.peer.id })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/api/remote.mux',
    handler(_request, socket) {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n')
    },
  }))
  const socket = await new Promise<Duplex>((resolve, reject) => {
    const request = httpRequest(new URL('/api/remote.mux', origin), {
      headers: { cookie: apiCookie!, connection: 'Upgrade', upgrade: 'fixture' },
    })
    request.once('upgrade', (_response, socket) => { resolve(socket) })
    request.once('error', reject)
    request.end()
  })
  socket.resume()
  const closed = once(socket, 'close')
  onTestFinished(async () => { socket.destroy(); await closed })
  await api.peer.dispose()
  await closed
  expect((await fetch(new URL('/page.html', login), { headers: { cookie: apiCookie! } })).status).toBe(401)
  expect(ctx.connection.admit({ headers: apiHeaders })).toEqual({ rejection: 401 })

  const originalToken = login.searchParams.get('token')
  const token = [...ctx.loader.entries()].find(entry => entry.options.id === 'token')
  if (token?.fiber === undefined) throw new Error('token provider did not activate')
  await token.fiber.dispose()
  expect(admission.peer.signal.aborted).toBe(true)
  expect(ctx.connection.admit({ headers })).toEqual({ rejection: 401 })
  await ctx.plugin(Token, { cookieMaxAgeDays: 30 }).await()
  const reloaded = await BrowserAuth.create(ctx[Context.root], ctx.credentials, 30)
  const restarted = new URL(reloaded.authenticatedUrl(origin))
  expect(restarted.searchParams.get('token')).toBe(originalToken)
  const resumed = ctx.connection.authentication.authenticate({ headers })
  if ('rejection' in resumed) throw new Error('existing Cookie did not survive provider reload')
  expect(resumed.peer).not.toBe(admission.peer)
})
