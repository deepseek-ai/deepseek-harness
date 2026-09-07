import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { recordFeedback } from '@deepseek-ai/dsh-command-feedback'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import OpenTelemetrySessionBackend, { SessionTelemetryMode } from '../src/index.ts'

const seen: string[] = []
const captures: string[] = []
const servers: Server[] = []
let proxyUrl: string
let collectorUrl: string
let home: string
let previousHome: string | undefined

async function listen(server: Server): Promise<string> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  return `http://127.0.0.1:${address.port}`
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-otel-egress-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const proxy = createServer((request, response) => {
    seen.push(request.url ?? '')
    response.writeHead(502).end('fake-proxy')
  })
  proxy.on('connect', (request, socket) => {
    seen.push(request.url ?? '')
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  proxyUrl = await listen(proxy)
  const loopbackUrl = await listen(createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      captures.push(Buffer.concat(chunks).toString())
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  }))
  collectorUrl = loopbackUrl.replace('127.0.0.1', 'otel-direct.invalid')
})

afterAll(async () => {
  try {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
      server.closeAllConnections()
    })))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

/** The launch environment of a user who exported one proxy for both schemes. */
function proxyEnv(): { get(name: string): { value: string } | undefined } {
  return { get: name => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
}

describe('session-telemetry-otel egress', () => {
  it.each(['mock', 'deepseek-official', 'unknown-provider', undefined])(
    'exports only explicit feedback directly for provider %s, ignoring the configured proxy',
    async (provider) => {
      seen.length = 0
      captures.length = 0
      const disposeProxy = await installProxyFromEnvironment(proxyEnv(), () => undefined)
      const ctx = new Context()
      try {
        // The positive control proves a fetch-based exporter would reach the proxy.
        const response = await fetch(collectorUrl)
        await response.text()
        expect(response.status).toBe(502)
        expect(seen.length).toBeGreaterThan(0)
        seen.length = 0

        await ctx.plugin(SessionStore)
        const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
          mode: SessionTelemetryMode.FEEDBACK_ONLY,
          exporter: {
            url: `${collectorUrl}/v1/logs`,
            timeoutMillis: 1_000,
            // Resolve only the SDK's collector connection, not the global fetch dispatcher.
            httpAgentOptions: {
              lookup: (_host, options, callback) => {
                if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
                else callback(null, '127.0.0.1', 4)
              },
            },
          },
          processor: { scheduledDelayMillis: 60_000 },
        })
        const session = ctx.sessions.create(SessionId('egress'), { meta: { cwd: home } })
        if (provider !== undefined) {
          session.append('request/header', { header: { config: { provider, model: 'm' } }, reason: 'initial' })
        }
        session.append('turn/start', { turn: 1 })
        recordFeedback(session, 'explicit egress feedback')
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await fiber.dispose()

        expect(captures).toHaveLength(1)
        const wire = captures.join('')
        expect(wire).toContain('explicit egress feedback')
        expect(wire).toContain('turn/start')
        expect(wire).not.toContain('turn/end')
        expect(wire).not.toContain('telemetry.op')
        expect(seen).toEqual([])
      } finally {
        try {
          await ctx.fiber.dispose()
        } finally {
          await disposeProxy()
        }
      }
    },
  )
})
