/** Real SDK cancellation and caller-owned connection budgets. */

import { z } from 'zod'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Client, InMemoryTransport, type Transport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'
import { probeServer } from '../src/probe.ts'
import { McpGeneration } from '../src/generation.ts'
import { McpStatusCell } from '../src/status.ts'
import type { Config } from '../src/index.ts'

const { mockTransport } = vi.hoisted(() => ({ mockTransport: vi.fn<() => Transport>() }))
vi.mock('../src/transport.ts', () => ({ createTransport: mockTransport }))

const config: Config = {
  transport: 'stdio', serverName: 'fixture', command: 'fixture', args: [], env: {}, cwd: '',
  toolCallTimeoutMs: 60_000, startupTimeoutMs: 30, closeTimeoutMs: 5_000,
  expandTemplates: false, failOnStartupError: true,
}

it('unregisters tools when disposal interrupts the registration result', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const server = new McpServer({ name: 'fixture', version: '1' })
  server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({ content: [] }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const serving = serveStdio(() => server, { transport: serverTransport })
  mockTransport.mockReturnValue(clientTransport)
  const disposed: PromiseWithResolvers<void> = Promise.withResolvers()
  const register = ctx.tools.register.bind(ctx.tools)
  const spy = vi.spyOn(ctx.tools, 'register').mockImplementation((definition) => {
    const unregister = register(definition)
    queueMicrotask(() => { void connection.dispose().then(disposed.resolve, disposed.reject) })
    return unregister
  })
  const status = new McpStatusCell(() => {})
  const connection = startConnection(ctx, { ...config, startupTimeoutMs: 30_000 },
    resolveReconnectPolicy({ enabled: false }, 'fixture'), status)
  onTestFinished(async () => {
    await connection.dispose()
    await serving.close()
    spy.mockRestore()
  })
  await disposed.promise
  expect(spy).toHaveBeenCalledOnce()
  expect(status.closure()).toEqual({ closeConfirmed: true })
  expect(ctx.tools.schemas()).toEqual([])
})

it.each([false, true])('uses the probe budget independently of startupTimeoutMs (expires: %s)', async (expires) => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
  const ctx = new Context()
  const server = new McpServer({ name: 'fixture', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const serving = serveStdio(() => server, { transport: serverTransport })
  mockTransport.mockReturnValue(clientTransport)
  const sending: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  const send = clientTransport.send.bind(clientTransport)
  clientTransport.send = async (...args) => {
    sending.resolve()
    await release.promise
    return send(...args)
  }
  const probe = probeServer(ctx, config, { timeoutMs: 2_000 })
  onTestFinished(async () => {
    release.resolve()
    await probe
    await serving.close()
    await ctx.fiber.dispose()
  })
  await sending.promise
  await vi.advanceTimersByTimeAsync(expires ? 2_001 : 31)
  release.resolve()
  const result = await probe
  expect(result.closeConfirmed).toBe(true)
  if (expires) {
    expect(result).toMatchObject({ ok: false, stage: 'connect' })
    if (!result.ok) expect(result.message).toMatch(/timed out/i)
  } else {
    expect(result).toMatchObject({ ok: true, serverInfo: { name: 'fixture', version: '1' }, toolNames: [] })
  }
})

it('reports confirmed transport closure when local work outlives cleanup', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
  const server = new McpServer({ name: 'fixture', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const serving = serveStdio(() => server, { transport: serverTransport })
  mockTransport.mockReturnValue(clientTransport)
  const client = new Client({ name: 'fixture', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  const generation = new McpGeneration(client, 100, String)
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(async () => {
    release.resolve()
    await pending
    await generation.close()
    await serving.close()
  })
  await generation.connect(config, 1_000)
  const observedClose: PromiseWithResolvers<void> = Promise.withResolvers()
  const onclose = clientTransport.onclose
  clientTransport.onclose = () => { onclose?.(); observedClose.resolve() }
  const pending = generation.run(async () => { entered.resolve(); await release.promise }).catch((error: unknown) => error)
  await entered.promise
  const closing = generation.close()
  await observedClose.promise
  await vi.advanceTimersByTimeAsync(101)
  expect(await closing).toEqual({
    closeConfirmed: true, cleanupError: 'Error: MCP cleanup did not settle',
  })
})

it.each([false, true])('distinguishes local work from unfinished negotiation (transport created: %s)', async (created) => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  const work = async (): Promise<void> => { entered.resolve(); await release.promise }
  const client = new Client({ name: 'fixture', version: '1' })
  // SDK stdio negotiation owns a sibling before starting or attaching the session transport.
  const connect = vi.spyOn(client, 'connect').mockImplementation(work)
  mockTransport.mockReturnValue({ start: async () => {}, close: async () => {}, send: async () => {} })
  const generation = new McpGeneration(client, 100, String)
  const pending = (created ? generation.connect(config, undefined) : generation.run(work)).catch((error: unknown) => error)
  onTestFinished(async () => {
    release.resolve()
    await pending
    await generation.close()
    connect.mockRestore()
  })
  await entered.promise
  const closing = generation.close()
  await vi.advanceTimersByTimeAsync(101)
  expect(await closing).toEqual({ closeConfirmed: !created, cleanupError: 'Error: MCP cleanup did not settle' })
})
