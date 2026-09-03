import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import OpenTelemetrySessionBackend, { SessionTelemetryMode } from '../src/index.ts'

let seen: string[] = []
let proxy: Server
let proxyUrl: string

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`REQ ${request.url ?? ''}`)
    response.writeHead(502); response.end('fake-proxy')
  })
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.end()
  })
  const a = await new Promise<AddressInfo>((r) => { proxy.listen(0, '127.0.0.1', () => { r(proxy.address() as AddressInfo) }) })
  proxyUrl = `http://127.0.0.1:${String(a.port)}`
})
afterAll(async () => { await new Promise<void>((r) => { proxy.close(() => { r() }) }) })

let home: string
let previousHome: string | undefined
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-otel-egress-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})
afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** The launch environment of a user who exported one proxy for both schemes. */
function proxyEnv(): { get(name: string): { value: string } | undefined } {
  return { get: name => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
}

/** Mount the shipping backend against an unresolvable collector and let it try to export. */
async function exportThroughBackend(host: string): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
    mode: SessionTelemetryMode.FULL,
    exporter: { url: `http://${host}/v1/logs` },
  })
  const session = ctx.sessions.create(SessionId('egress'), { meta: { cwd: '/tmp/e' } })
  session.append('turn/start', { turn: 1 })
  ctx.sessionTelemetry.emit({ channel: 'ledger', time: Date.now(), severity: 'info', event: { type: 'probe' } } as never)
  await fiber.dispose()
}

describe('session-telemetry-otel egress', () => {
  it('exports directly, ignoring a configured proxy', async () => {
    seen = []
    const dispose = await installProxyFromEnvironment(proxyEnv(), () => undefined)
    try {
      await exportThroughBackend('otel-direct.invalid').catch(() => undefined)
    } finally {
      await dispose()
    }
    // Telemetry is the one outbound path this repository deliberately leaves direct. The SDK's OTLP
    // exporter posts through `node:http`, which no global dispatcher reaches, and routing it would
    // mean either an `http.Agent` whose `proxyEnv` option arrives after this project's lowest
    // supported Node, or replacing the transport and reimplementing the compression the shipped
    // profile enables. Neither is worth it for a channel whose loss costs the user nothing.
    //
    // This case exists so that stays a decision: an SDK upgrade that moved the exporter onto
    // `fetch` would start routing telemetry through a proxy silently, and this assertion is what
    // makes that visible instead.
    expect(seen).toEqual([])
  })
})
