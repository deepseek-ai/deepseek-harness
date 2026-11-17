/** WebServer request and page events follow each instance's service isolation. */
import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished } from 'vitest'
import WebServer from '../src/index.ts'

it('filters HTTP, upgrade, and index listeners while retaining explicitly global listeners', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const isolated = ctx.isolate('webServer')
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await isolated.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  const servers = [ctx.webServer, isolated.webServer]
  const calls: string[] = []
  ctx.on('webserver/request', async function (this: unknown, _req: IncomingMessage, _res: ServerResponse, next: () => Promise<void>) {
    expect(this).toBeInstanceOf(WebServer)
    calls.push('global:request')
    await next()
  }, { global: true })
  ctx.on('webserver/authorize', () => { calls.push('global:authorize') }, { global: true })
  ctx.on('webserver/upgrade', async (_req, _socket, _head, _peer, next) => {
    calls.push('global:upgrade')
    await next()
  }, { global: true })
  ctx.on('webserver/index-inject', (rows) => {
    rows.push({ kind: 'global', name: 'globalEntry', value: true })
  }, { global: true })

  for (const [scope, label] of [[ctx, 'main'], [isolated, 'isolated']] as const) {
    scope.on('webserver/request', async (_req, _res, next) => {
      calls.push(`${label}:request`)
      await next()
    })
    scope.on('webserver/authorize', () => {
      calls.push(`${label}:authorize`)
      return { kind: 'allow' }
    })
    scope.on('webserver/upgrade', async (_req, _socket, _head, _peer, next) => {
      calls.push(`${label}:upgrade`)
      await next()
    })
    scope.on('webserver/index-inject', (rows) => {
      rows.push({ kind: 'global', name: label, value: true })
    })
    scope.effect(() => scope.webServer.register({
      kind: 'exact', path: '/probe', auth: 'anonymous',
      handler(_req, res) { res.end(label) },
    }))
    scope.effect(() => scope.webServer.registerUpgrade({
      path: '/socket', auth: 'anonymous',
      handler(_req, socket) {
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: probe\r\n\r\n')
      },
    }))
  }

  for (const [index, label] of ['main', 'isolated'].entries()) {
    const server = servers[index]!
    calls.length = 0
    const response = await fetch(`${server.getOrigin()}/probe`)
    expect(await response.text()).toBe(label)
    expect(calls).toEqual(['global:request', `${label}:request`, 'global:authorize', `${label}:authorize`])

    calls.length = 0
    const socket = connect(server.port!, '127.0.0.1')
    const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
    onTestFinished(async () => { socket.destroy(); await closed })
    await once(socket, 'connect')
    let output = ''
    socket.setEncoding('utf8').on('data', (data: string) => { output += data })
    socket.write('GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: probe\r\n\r\n')
    await closed
    expect(output).toContain('101 Switching Protocols')
    expect(calls).toEqual(['global:authorize', `${label}:authorize`, 'global:upgrade', `${label}:upgrade`])

    const peer: PeerScope = {
      id: label as PeerScope['id'], ctx, principal: { kind: 'owner' }, interactions: 'none',
      signal: new AbortController().signal, async dispose() {},
    }
    expect(server.collectIndexInjections(peer)).toEqual([
      { kind: 'global', name: 'globalEntry', value: true },
      { kind: 'global', name: label, value: true },
    ])
  }
})
