import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'

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

/** The launch environment of a user who exported one proxy for both schemes. */
function proxyEnv(): { get(name: string): { value: string } | undefined } {
  return { get: name => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
}
async function observe(run: () => Promise<unknown>): Promise<string[]> {
  seen = []
  const dispose = await installProxyFromEnvironment(proxyEnv(), () => undefined)
  try { await run().catch(() => undefined) } finally { await dispose() }
  return seen
}
import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '../src/index.ts'
import { discoverModels } from '../src/discovery.ts'

/** Drive the shipping adapter's provider stream at an unresolvable endpoint. */
async function streamOnce(): Promise<void> {
  vi.stubEnv('PI_TEST_KEY', 'probe-key')
  try {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: 'http://pi-stream-probe.invalid' } },
    })
    for await (const _chunk of ctx.llm.stream({ provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })) {
      // The endpoint never answers; the proxy record is the assertion.
    }
  } finally {
    vi.unstubAllEnvs()
  }
}
describe('pi-ai discovery egress', () => {
  it('goes through the proxy', async () => {
    const observed = await observe(() => discoverModels({ baseURL: 'http://pi-probe.invalid/v1', api: 'openai-completions', apiKey: 'probe' }))
    expect(observed.join('|')).toContain('pi-probe.invalid')
  })
})

describe('pi-ai provider stream egress', () => {
  it('sends the inference request through the proxy', async () => {
    const observed = await observe(streamOnce)
    expect(observed.join('|')).toContain('pi-stream-probe.invalid')
  })
})
