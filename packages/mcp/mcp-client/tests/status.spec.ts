/**
 * Tests for the connection-status surface: cell transitions across connect,
 * crash-driven reconnection, budget exhaustion, disabled reconnect, the
 * startup budget, and the per-Fiber lookup's registration lifecycle.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Transport } from '@modelcontextprotocol/client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Config, McpConnectionStatus } from '@deepseek-ai/dsh-mcp-client'

const { mockConnect, mockClose, mockListTools, mockSetNotificationHandler, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<(_options?: { signal?: AbortSignal }) => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>, _options?: { signal?: AbortSignal }) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  class MockClient {
    transport: Transport | undefined
    onclose: (() => void) | undefined
    async connect(transport: Transport, options?: { signal?: AbortSignal }): Promise<void> {
      this.transport = transport
      const onclose = transport.onclose
      transport.onclose = () => { onclose?.(); this.onclose?.() }
      await transport.start()
      await mockConnect.call(this, options)
    }
    ping = (): Promise<void> => Promise.resolve()
    close = mockClose
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
    listResources = async () => ({ resources: [] })
    listTools = mockListTools
    constructor(_info: unknown, options: { listChanged: { tools: { onChanged: () => void } } }) {
      instances.push(this)
      mockSetNotificationHandler('notifications/tools/list_changed', options.listChanged.tools.onChanged)
    }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, mockSetNotificationHandler, MockClient, instances }
})

vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(function () {
    return {
      onclose: undefined as (() => void) | undefined,
      start: () => Promise.resolve(),
      send: () => Promise.resolve(),
      close() { this.onclose?.(); return Promise.resolve() },
    }
  }),
}))
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function () {
    return {
      onclose: undefined as (() => void) | undefined,
      start: () => Promise.resolve(),
      send: () => Promise.resolve(),
      close() { this.onclose?.(); return Promise.resolve() },
    }
  }),
}))

import * as McpClient from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { Config as ConfigSchema, apply, connectionStatusOf } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { McpStatusCell } from '@deepseek-ai/dsh-mcp-client/src/status.ts'

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function captureWarns(ctx: Context): string[] {
  const warns: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = (() => {}) as typeof ctx.logger.error
  return warns
}

// Typed views of vitest's asymmetric matchers: their `any` return would
// otherwise trip no-unsafe-assignment inside expectation literals.
const anyNumber = expect.any(Number) as number
const containing = (text: string): string => expect.stringContaining(text) as string

function stdioConfig(overrides?: Partial<Extract<Config, { transport: 'stdio' }>>): Config {
  return ConfigSchema({
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    startupTimeoutMs: 30_000,
    failOnStartupError: false,
    ...overrides,
  })
}

function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })), nextCursor: undefined }
}

describe('async status observers', () => {
  it('contains an async observer rejection through the cell warn callback', async () => {
    const warned: string[] = []
    const cell = new McpStatusCell((message) => { warned.push(message) })
    cell.onChange(async () => {
      await Promise.resolve()
      throw new Error('late observer failure')
    })
    cell.update({ state: 'connecting', attempt: 0 })
    await vi.waitFor(() => {
      expect(warned.some(line => line.includes('an onChange status observer failed'))).toBe(true)
    })
  })
})

describe('connection status surface', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { transport?: Transport }) {
      this.transport?.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
    ctx = await mountRegistry()
  })

  it('publishes connected with the registered tool count and answers the Fiber lookup', async () => {
    await apply(ctx, stdioConfig())
    const handle = connectionStatusOf(ctx.fiber)
    expect(handle).toBeDefined()
    expect(handle!.current()).toEqual({
      state: 'connected',
      toolCount: 1,
      connectedAt: anyNumber,
    })
    expect(connectionStatusOf(new Context().fiber)).toBeUndefined()
  })

  it('walks reconnecting -> connecting -> connected after a crash, and republishes tool counts on re-sync', async () => {
    captureWarns(ctx)
    await apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 } }))
    const handle = connectionStatusOf(ctx.fiber)!
    const seen: McpConnectionStatus[] = []
    handle.onChange((status) => { seen.push(status) })

    mockListTools.mockResolvedValue(listing('revived', 'extra'))
    instances[0]!.transport?.onclose?.()
    await vi.waitFor(() => {
      expect(handle.current()).toMatchObject({ state: 'connected', toolCount: 2 })
    })

    const states = seen.map(status => status.state)
    expect(states).toContain('reconnecting')
    expect(states).toContain('connecting')
    const reconnecting = seen.find(status => status.state === 'reconnecting')!
    expect(reconnecting).toMatchObject({ attempt: 1, maxAttempts: 5, lastError: 'connection closed' })
    expect(reconnecting.nextRetryAtMs).toBeGreaterThan(0)

    // A tools/list_changed re-sync republishes the connected count.
    const notification = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => void
    mockListTools.mockResolvedValue(listing('only-one'))
    notification()
    await vi.waitFor(() => {
      expect(handle.current()).toMatchObject({ state: 'connected', toolCount: 1 })
    })
  })

  it('reports gave-up with the last connection error once the outage budget is exhausted', async () => {
    captureWarns(ctx)
    mockConnect.mockRejectedValue(new Error('spawn refused'))
    await apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 2 } }))
    const handle = connectionStatusOf(ctx.fiber)!
    await vi.waitFor(() => {
      expect(handle.current()).toMatchObject({ state: 'failed', reason: 'gave-up' })
    })
    expect(handle.current()).toMatchObject({ lastError: containing('spawn refused') })
  })

  it('reports reconnect-disabled when the policy is off and the first attempt fails', async () => {
    captureWarns(ctx)
    mockConnect.mockRejectedValue(new Error('no route'))
    await apply(ctx, stdioConfig({ reconnect: { enabled: false } }))
    const handle = connectionStatusOf(ctx.fiber)!
    await vi.waitFor(() => {
      expect(handle.current()).toEqual({
        state: 'failed',
        reason: 'reconnect-disabled',
        lastError: containing('no route'),
      })
    })
  })

  it.each(['connect', 'initial tool sync'] as const)('fails an attempt whose %s exceeds the startup budget', async (phase) => {
    vi.useFakeTimers()
    try {
      captureWarns(ctx)
      const pendingRequest = (options?: { signal?: AbortSignal }): Promise<never> => new Promise((_, reject) => {
        options!.signal!.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
      })
      if (phase === 'connect') mockConnect.mockImplementation(pendingRequest)
      else mockListTools.mockImplementation((_params, options) => pendingRequest(options))
      const pending = apply(ctx, stdioConfig({ startupTimeoutMs: 40, reconnect: { enabled: false } }))
      await vi.advanceTimersByTimeAsync(40)
      await pending
      const handle = connectionStatusOf(ctx.fiber)!
      expect(handle.current()).toMatchObject({
        state: 'failed',
        reason: 'reconnect-disabled',
        lastError: containing(phase === 'connect' ? 'MCP operation timed out' : 'startup timed out'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports unclosed-generation when a failed generation never signals close', async () => {
    vi.useFakeTimers()
    try {
      captureWarns(ctx)
      mockConnect.mockRejectedValue(new Error('half-open'))
      // close resolves but never fires onclose: the close barrier must time out.
      mockClose.mockResolvedValue(undefined)
      const pending = apply(ctx, stdioConfig())
      await vi.advanceTimersByTimeAsync(5_100)
      await pending
      const handle = connectionStatusOf(ctx.fiber)!
      expect(handle.current()).toEqual({
        state: 'failed',
        reason: 'unclosed-generation',
        lastError: containing('MCP cleanup did not settle'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([false, true])('contains observer failures with template expansion %s and honors disposal', async (expandTemplates) => {
    const warns = captureWarns(ctx)
    await apply(ctx, stdioConfig({ expandTemplates, reconnect: { initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 3 } }))
    const handle = connectionStatusOf(ctx.fiber)!
    const seen: string[] = []
    handle.onChange(() => { throw new Error('observer exploded') })
    const disposeSecond = handle.onChange((status) => { seen.push(status.state) })
    instances[0]!.transport?.onclose?.()
    await vi.waitFor(() => { expect(seen.length).toBeGreaterThan(0) })
    expect(warns.some(line => line.includes('onChange status observer failed'))).toBe(true)
    expect(warns.some(line => line.includes('observer exploded'))).toBe(!expandTemplates)

    disposeSecond()
    const settled = seen.length
    await vi.waitFor(() => { expect(connectionStatusOf(ctx.fiber)!.current().state).toBe('connected') })
    expect(seen.length).toBe(settled)
  })

  it('keeps the final status readable when the plugin instance is disposed', async () => {
    const fiber = ctx.plugin(McpClient, { transport: 'stdio', serverName: 'scoped', command: 'echo' })
    const actualFiber = await fiber
    const handle = connectionStatusOf(fiber)!
    expect(connectionStatusOf(actualFiber)).toBe(handle)
    expect(handle.current().state).toBe('connected')
    await fiber.dispose()
    expect(connectionStatusOf(fiber)).toBe(handle)
    expect(handle.current()).toEqual({ state: 'closed', result: { closeConfirmed: true } })
  })

  it('preserves the status handle and observers across a reload, then detaches observers on disposal', async () => {
    const config = stdioConfig()
    const wrapper = ctx.plugin(McpClient, config)
    const fiber = await wrapper
    const handle = connectionStatusOf(wrapper)!
    const observed = vi.fn()
    handle.onChange(observed)
    await fiber.update({ ...config, args: ['updated'] })
    await fiber.await()
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(connectionStatusOf(fiber)).toBe(handle)
    expect(handle.current().state).toBe('connected')
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ state: 'closed' }))
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected' }))
    observed.mockClear()
    await fiber.dispose()
    expect(handle.current()).toEqual({ state: 'closed', result: { closeConfirmed: true } })
    expect(observed).not.toHaveBeenCalled()
  })

  it.each(['unconfirmed', 'cleanup-error'] as const)('blocks a reload after %s cleanup', async (mode) => {
    vi.useFakeTimers()
    try {
      captureWarns(ctx)
      const config = stdioConfig({ closeTimeoutMs: 100 })
      const fiber = await ctx.plugin(McpClient, config)
      const handle = connectionStatusOf(fiber)!
      mockClose.mockImplementation(function (this: { transport?: Transport }) {
        if (mode === 'unconfirmed') return Promise.resolve()
        this.transport?.onclose?.()
        return Promise.reject(new Error('transport cleanup failed'))
      })
      const reloading = expect(fiber.restart()).rejects.toThrow('previous connection cleanup is incomplete')
      await vi.advanceTimersByTimeAsync(100)
      await reloading
      expect(mockConnect).toHaveBeenCalledTimes(1)
      expect(connectionStatusOf(fiber)).toBe(handle)
      expect(handle.closure()).toEqual({
        closeConfirmed: mode === 'cleanup-error',
        cleanupError: mode === 'cleanup-error' ? 'Error: transport cleanup failed' : 'McpLocalError: MCP cleanup did not settle',
      })
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a reload when its retained status observer disposes the Fiber', async () => {
    captureWarns(ctx)
    const fiber = await ctx.plugin(McpClient, stdioConfig({ reconnect: { enabled: false } }))
    const handle = connectionStatusOf(fiber)!
    const connect: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => connect.promise)
    let disposing: Promise<void> | undefined
    handle.onChange((status) => {
      if (status.state === 'connecting') disposing = fiber.dispose()
    })
    try {
      await fiber.restart()
      await disposing
      expect(fiber.uid).toBeNull()
      expect(handle.current()).toEqual({ state: 'closed', result: { closeConfirmed: true } })
      expect(mockConnect).toHaveBeenCalledTimes(1)
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      connect.resolve()
      await vi.waitFor(() => { expect(handle.closure().closeConfirmed).toBe(true) })
    }
  })

  it('keeps the default connecting status before any transition is published', () => {
    const cell = new McpStatusCell(() => {})
    expect(cell.current()).toEqual({ state: 'connecting', attempt: 0 })
  })

  it('tracks two instances independently under one registration scope', async () => {
    const first = ctx.plugin(McpClient, stdioConfig({ serverName: 'first' }))
    const second = ctx.plugin(McpClient, stdioConfig({ serverName: 'second' }))
    await Promise.all([first, second])
    expect(connectionStatusOf(first)!.current().state).toBe('connected')
    expect(connectionStatusOf(second)!.current().state).toBe('connected')
    expect(connectionStatusOf(first)).not.toBe(connectionStatusOf(second))
  })

  it('normalizes a non-Error connect rejection into the failure diagnostics', async () => {
    captureWarns(ctx)
    mockConnect.mockRejectedValue('spawn refused as plain text')
    await apply(ctx, stdioConfig({ reconnect: { enabled: false } }))
    await vi.waitFor(() => {
      expect(connectionStatusOf(ctx.fiber)!.current()).toMatchObject({
        state: 'failed',
        lastError: containing('spawn refused as plain text'),
      })
    })
  })

  it('reports transport closure when the transport closes during connect itself', async () => {
    captureWarns(ctx)
    mockConnect.mockImplementation(function (this: { transport?: Transport }) {
      this.transport?.onclose?.()
      return Promise.resolve()
    })
    await apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 2 } }))
    const handle = connectionStatusOf(ctx.fiber)!
    const seen: McpConnectionStatus[] = []
    handle.onChange((status) => { seen.push(status) })
    await vi.waitFor(() => {
      expect(handle.current()).toEqual({ state: 'failed', reason: 'gave-up', lastError: 'McpLocalError: MCP transport closed' })
    })
    const reconnecting = seen.find(status => status.state === 'reconnecting')
    expect(reconnecting).toMatchObject({ lastError: 'McpLocalError: MCP transport closed' })
  })

  it('reports a reconnect-disabled stop when the transport closes during connect', async () => {
    captureWarns(ctx)
    mockConnect.mockImplementation(function (this: { transport?: Transport }) {
      this.transport?.onclose?.()
      return Promise.resolve()
    })
    await apply(ctx, stdioConfig({ reconnect: { enabled: false } }))
    await vi.waitFor(() => {
      expect(connectionStatusOf(ctx.fiber)!.current()).toEqual({ state: 'failed', reason: 'reconnect-disabled', lastError: 'McpLocalError: MCP transport closed' })
    })
  })
})
