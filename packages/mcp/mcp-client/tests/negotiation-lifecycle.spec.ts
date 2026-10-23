/** Real SDK probe ownership, failed negotiation recovery, and subprocess quiescence. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'
import type { Config } from '../src/index.ts'

const { mockTransport } = vi.hoisted(() => ({ mockTransport: vi.fn<() => Transport>() }))
vi.mock('../src/transport.ts', () => ({ createTransport: mockTransport }))

const config: Config = {
  transport: 'stdio', serverName: 'fixture', command: 'fixture', args: [], env: {}, cwd: '',
  toolCallTimeoutMs: 60_000, failOnStartupError: false,
}
const fixture = fileURLToPath(new URL('./fixtures/negotiation-lifecycle.mjs', import.meta.url))

async function connection(factory: () => Transport, retry: boolean) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const errors: string[] = []
  const warns: string[] = []
  ctx.logger.error = (message: unknown) => { errors.push(String(message)) }
  ctx.logger.warn = (message: unknown) => { warns.push(String(message)) }
  const transports: Transport[] = []
  mockTransport.mockImplementation(() => {
    const transport = factory()
    transports.push(transport)
    return transport
  })
  const handle = startConnection(ctx, config, resolveReconnectPolicy({
    enabled: retry, initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 3,
  }, 'fixture'))
  onTestFinished(async () => {
    for (const transport of transports) await transport.close()
    await handle.dispose()
  })
  return { ...handle, errors, warns, transports }
}

async function stdioFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-negotiation-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const eventsPath = join(root, 'events.jsonl')
  const releasePath = join(root, 'release')
  await writeFile(eventsPath, '')
  const events = async (): Promise<{ event: string; pid: number; previousAlive?: boolean }[]> => (await readFile(eventsPath, 'utf8'))
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as { event: string; pid: number; previousAlive?: boolean })
  const handle = await connection(() => new StdioClientTransport({
    command: process.execPath, args: [fixture, eventsPath, releasePath], env: {},
  }), false)
  return { handle, events, release: () => writeFile(releasePath, '') }
}

describe('SDK negotiation lifecycle', () => {
  it('reaps the probe before starting the serving process', async () => {
    const { handle, events, release } = await stdioFixture()
    await release()
    expect(await handle.ready).toEqual({})
    const observed = await events()
    const starts = observed.filter(item => item.event === 'start')
    expect(starts).toHaveLength(2)
    expect(starts[1]!.previousAlive).toBe(false)
    await handle.dispose()
    for (const item of starts) expect(() => process.kill(item.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  })

  it('disposes during a probe without starting or retaining a serving process', async () => {
    const { handle, events, release } = await stdioFixture()
    await vi.waitFor(async () => {
      expect((await events()).some(item => item.event === 'server/discover')).toBe(true)
    }, { timeout: 15_000 })
    const disposing = handle.dispose()
    await release()
    await disposing
    const starts = (await events()).filter(item => item.event === 'start')
    expect(starts).toHaveLength(1)
    for (const item of starts) expect(() => process.kill(item.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect(handle.errors).toEqual([])
  })

  it('retries failed HTTP probes without waiting for a Client close event', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(503)
      response.end('temporary failure')
    })
    onTestFinished(async () => {
      server.closeAllConnections()
      const closed: PromiseWithResolvers<void> = Promise.withResolvers()
      server.close((error) => {
        if (error) closed.reject(error)
        else closed.resolve()
      })
      await closed.promise
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind a TCP address')
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`)
    const handle = await connection(() => new StreamableHTTPClientTransport(url), true)
    expect((await handle.ready).error).toBeDefined()
    expect(handle.errors).toEqual([])
    await vi.waitFor(() => { expect(handle.errors.some(line => line.includes('giving up after 3'))).toBe(true) })
    expect(requests).toBe(4)
    expect(handle.warns.filter(line => line.includes('connection failed; retrying'))).toHaveLength(3)
  })

  it('retries failed stdio probes when no child could be spawned', async () => {
    const handle = await connection(() => new StdioClientTransport({
      command: join(fixture, 'missing-command'), env: {},
    }), true)
    expect((await handle.ready).error).toBeDefined()
    expect(handle.errors).toEqual([])
    await vi.waitFor(() => { expect(handle.errors.some(line => line.includes('giving up after 3'))).toBe(true) })
    expect(handle.transports).toHaveLength(4)
    expect(handle.warns.filter(line => line.includes('connection failed; retrying'))).toHaveLength(3)
  })

  it('stops retries when a failed probe cannot confirm transport cleanup', async () => {
    const close = vi.fn()
      .mockRejectedValueOnce(new Error('SDK shutdown failed'))
      .mockRejectedValueOnce(new Error('supervisor shutdown failed'))
      .mockResolvedValue(undefined)
    const handle = await connection(() => ({
      start: () => Promise.reject(new Error('probe failed')),
      send: () => Promise.resolve(),
      close,
    }), true)
    expect((await handle.ready).error).toBeDefined()
    expect(handle.errors).toEqual([
      'mcp-client(fixture): failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry',
    ])
    expect(handle.warns.some(line => line.includes('connection failed; retrying'))).toBe(false)
    expect(handle.transports).toHaveLength(1)
  })
})
