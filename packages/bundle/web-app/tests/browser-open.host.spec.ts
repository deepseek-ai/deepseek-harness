/** WebApp browser startup reaches the authenticated page through a real Loader composition. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { auditStartupEntries } from '@deepseek-ai/dsh-app-boot'
import WebServer, { type WebEntryUrl } from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Token from '@deepseek-ai/dsh-host-authentication-token'
import * as WebApp from '../src/index.ts'

it('opens its tokenized URL only after the complete authenticated page is reachable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-token-browser-open-'))
  const ctx = new Context()
  const originalOpen = WebApp.internals.openBrowser
  const originalResolve = WebApp.internals.resolveDistIndex
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    WebApp.internals.openBrowser = originalOpen
    WebApp.internals.resolveDistIndex = originalResolve
    vi.unstubAllEnvs()
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-token-browser-open-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  })
  vi.stubEnv('SSH_CONNECTION', '')
  vi.stubEnv('SSH_TTY', '')
  const dist = join(root, 'dist')
  await mkdir(dist)
  const index = join(dist, 'index.html')
  await writeFile(index, '<!doctype html><head></head><body>token-startup-ready</body>')
  const opened = Promise.withResolvers<{ url: string; html: string; peerAccepted: boolean }>()
  WebApp.internals.openBrowser = async (url) => {
    try {
      const login = await fetch(url, { redirect: 'manual' })
      expect(login.status).toBe(303)
      expect(login.headers.get('location')).toBe('./')
      const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
      if (cookie === undefined) throw new Error('Token startup did not issue a browser Cookie')
      const page = await fetch(new URL('./', url), { headers: { cookie } })
      expect(page.status).toBe(200)
      const html = await page.text()
      const result = ctx.connection.authentication.authenticate({
        headers: { host: new URL(url).host, cookie },
      })
      opened.resolve({ url, html, peerAccepted: 'peer' in result })
    } catch (error) { opened.reject(error) }
  }
  WebApp.internals.resolveDistIndex = () => index
  const rows = [
    { name: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: 'credentials', config: { path: join(root, 'credentials.yaml'), watch: false } },
    { name: 'connection' },
    { name: 'token', config: { cookieMaxAgeDays: 30 } },
    { name: 'web-app', config: { printUrl: false } },
  ]
  const config = join(root, 'cordis.yml')
  await writeFile(config, rows.map(row => `- ${JSON.stringify({ ...row, name: `cordis:${row.name}` })}`).join('\n') + '\n')
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, webserver: WebServer, credentials: LocalCredentials,
    connection: Connection, token: Token, frontend: FrontendStatic,
    'web-app': WebApp,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  await auditStartupEntries(ctx[Context.root], 'browser-open fixture', () => {})
  const entries: WebEntryUrl[] = []
  ctx.emit(ctx.webServer, 'webserver/entry-url', ctx.webServer.getOrigin(), entries)
  expect(entries).toHaveLength(1)
  const result = await opened.promise
  const url = new URL(result.url)
  expect(url.origin).toBe(ctx.webServer.getOrigin())
  expect(url.pathname).toBe('/')
  expect(url.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  expect(result.html).toContain('token-startup-ready')
  expect(result.peerAccepted).toBe(true)
})
