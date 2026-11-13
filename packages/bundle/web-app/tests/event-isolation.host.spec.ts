/** Published Web entry URLs and source policy stay with their WebServer isolation. */
import { Context } from '@deepseek-ai/cordis'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as WebApp from '../src/index.ts'

it.each(['main', 'isolated'] as const)('publishes only %s entry URLs and explicit global contributions', async (selected) => {
  const ctx = new Context()
  const isolated = ctx.isolate('webServer')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { log.mockRestore() }
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await isolated.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  ctx.on('webserver/entry-url', function (this: unknown, baseUrl, entries) {
    expect(this).toBeInstanceOf(WebServer)
    entries.push({ label: 'global', url: `${baseUrl}/global`, open: false })
  }, { global: true })
  ctx.on('webserver/entry-url', (baseUrl, entries) => {
    entries.push({ label: 'main', url: `${baseUrl}/main`, open: false })
  })
  isolated.on('webserver/entry-url', (baseUrl, entries) => {
    entries.push({ label: 'isolated', url: `${baseUrl}/isolated`, open: false })
  })
  const target = selected === 'main' ? ctx : isolated
  const origin = target.webServer.getOrigin()
  await target.plugin(WebApp, { printUrl: true, openBrowser: false, surfaceContext: false }).await()
  expect(log.mock.calls).toEqual([[`global: ${origin}/global`], [`${selected}: ${origin}/${selected}`]])
})

it('keeps main Connection source checks away from an isolated anonymous webhook route', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const isolated = ctx.isolate('webServer')
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await isolated.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await ctx.plugin(Connection).await()
  const mainHandler = vi.fn<(req: IncomingMessage, res: ServerResponse) => void>((_req, res) => { res.end('main') })
  const webhookHandler = vi.fn<(req: IncomingMessage, res: ServerResponse) => void>((req, res) => { res.end(req.headers.host) })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/github', auth: 'anonymous', handler: mainHandler }))
  isolated.effect(() => isolated.webServer.register({ kind: 'exact', path: '/github', auth: 'anonymous', handler: webhookHandler }))

  const post = (server: WebServer) => new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const request = httpRequest(new URL('/github', server.getOrigin()), {
      method: 'POST', headers: { host: 'hooks.example.com', connection: 'close' },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8').on('data', (data: string) => { body += data })
      response.once('end', () => { resolve({ status: response.statusCode, body }) })
      response.once('error', reject)
    })
    const closed = new Promise<void>((resolve) => { request.once('close', resolve) })
    onTestFinished(async () => { request.destroy(); await closed })
    request.once('error', reject)
    request.end()
  })
  const main = await post(ctx.webServer)
  expect(main.status).toBe(403)
  expect(mainHandler).not.toHaveBeenCalled()
  const webhook = await post(isolated.webServer)
  expect(webhook).toEqual({ status: 200, body: 'hooks.example.com' })
  expect(webhookHandler).toHaveBeenCalledOnce()
})
