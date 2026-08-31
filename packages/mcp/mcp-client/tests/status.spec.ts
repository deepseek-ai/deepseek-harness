/**
 * Tests for the connection-status surface: cell transitions across connect,
 * crash-driven reconnection, budget exhaustion, disabled reconnect, the
 * startup budget, and the per-scope lookup's registration lifecycle.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Config, McpConnectionStatus } from '@deepseek-ai/dsh-mcp-client'

const { mockConnect, mockClose, mockListTools, mockSetNotificationHandler, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, mockSetNotificationHandler, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

import * as McpClient from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { apply, connectionStatusOf } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { McpStatusCell } from '@deepseek-ai/dsh-mcp-client/src/status.ts'

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
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

function stdioConfig(overrides?: Partial<Config> & { reconnect?: Config['reconnect'] }): Config {
  return {
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
  } as Config
}

function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })), nextCursor: undefined }
}

describe('connection status surface', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
    ctx = await mountRegistry()
  })

  it('publishes connected with the registered tool count and answers the scope lookup', async () => {
    await apply(ctx, stdioConfig())
    const handle = connectionStatusOf(ctx, 'srv')
    expect(handle).toBeDefined()
    expect(handle!.current()).toEqual({
      state: 'connected',
      toolCount: 1,
      connectedAt: anyNumber,
    })
    expect(connectionStatusOf(ctx, 'absent')).toBeUndefined()
  })

  it('walks reconnecting -> connecting -> connected after a crash, and republishes tool counts on re-sync', async () => {
    captureWarns(ctx)
    await apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 } }))
    const handle = connectionStatusOf(ctx, 'srv')!
    const seen: McpConnectionStatus[] = []
    handle.onChange((status) => { seen.push(status) })

    mockListTools.mockResolvedValue(listing('revived', 'extra'))
    instances[0]!.onclose?.()
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
    const notification = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => Promise<void>
    mockListTools.mockResolvedValue(listing('only-one'))
    await notification()
    expect(handle.current()).toMatchObject({ state: 'connected', toolCount: 1 })
  })

  it('reports gave-up with the last connection error once the outage budget is exhausted', async () => {
    captureWarns(ctx)
    mockConnect.mockRejectedValue(new Error('spawn refused'))
    await apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 2 } }))
    const handle = connectionStatusOf(ctx, 'srv')!
    await vi.waitFor(() => {
      expect(handle.current()).toMatchObject({ state: 'failed', reason: 'gave-up' })
    })
    expect(handle.current()).toMatchObject({ lastError: containing('spawn refused') })
  })

  it('reports reconnect-disabled when the policy is off and the first attempt fails', async () => {
    captureWarns(ctx)
    mockConnect.mockRejectedValue(new Error('no route'))
    await apply(ctx, stdioConfig({ reconnect: { enabled: false } }))
    const handle = connectionStatusOf(ctx, 'srv')!
    await vi.waitFor(() => {
      expect(handle.current()).toEqual({
        state: 'failed',
        reason: 'reconnect-disabled',
        lastError: containing('no route'),
      })
    })
  })

  it('fails an attempt whose connect exceeds the startup budget', async () => {
    captureWarns(ctx)
    mockConnect.mockImplementation(() => new Promise(() => {}))
    await apply(ctx, stdioConfig({ startupTimeoutMs: 40, reconnect: { enabled: false } }))
    const handle = connectionStatusOf(ctx, 'srv')!
    await vi.waitFor(() => {
      expect(handle.current()).toMatchObject({
        state: 'failed',
        reason: 'reconnect-disabled',
        lastError: containing('startup timed out'),
      })
    })
  })

  it('fails an attempt whose initial tool sync exceeds the startup budget', async () => {
    captureWarns(ctx)
    mockListTools.mockImplementation(() => new Promise(() => {}))
    await apply(ctx, stdioConfig({ startupTimeoutMs: 40, reconnect: { enabled: false } }))
    const handle = connectionStatusOf(ctx, 'srv')!
    await vi.waitFor(() => {
      expect(handle.current()).toMatchObject({
        state: 'failed',
        lastError: containing('startup timed out'),
      })
    })
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
      const handle = connectionStatusOf(ctx, 'srv')!
      expect(handle.current()).toEqual({
        state: 'failed',
        reason: 'unclosed-generation',
        lastError: containing('half-open'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('contains a throwing observer, keeps later observers running, and honors disposal', async () => {
    const warns = captureWarns(ctx)
    await apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 3 } }))
    const handle = connectionStatusOf(ctx, 'srv')!
    const seen: string[] = []
    handle.onChange(() => { throw new Error('observer exploded') })
    const disposeSecond = handle.onChange((status) => { seen.push(status.state) })
    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(seen.length).toBeGreaterThan(0) })
    expect(warns.some(line => line.includes('onChange status observer failed'))).toBe(true)

    disposeSecond()
    const settled = seen.length
    await vi.waitFor(() => { expect(connectionStatusOf(ctx, 'srv')!.current().state).toBe('connected') })
    expect(seen.length).toBe(settled)
  })

  it('removes the status handle when the plugin instance is disposed', async () => {
    const fiber = ctx.plugin(McpClient, { transport: 'stdio', serverName: 'scoped', command: 'echo' })
    await fiber
    expect(connectionStatusOf(ctx, 'scoped')).toBeDefined()
    await fiber.dispose()
    expect(connectionStatusOf(ctx, 'scoped')).toBeUndefined()
  })

  it('keeps the default connecting status before any transition is published', () => {
    const cell = new McpStatusCell(() => {})
    expect(cell.current()).toEqual({ state: 'connecting', attempt: 0 })
  })

  it('tracks two instances independently under one registration scope', async () => {
    await apply(ctx, stdioConfig({ serverName: 'first' }))
    await apply(ctx, stdioConfig({ serverName: 'second' }))
    expect(connectionStatusOf(ctx, 'first')!.current().state).toBe('connected')
    expect(connectionStatusOf(ctx, 'second')!.current().state).toBe('connected')
  })

  it('normalizes a non-Error connect rejection into the failure diagnostics', async () => {
    captureWarns(ctx)
    mockConnect.mockRejectedValue('spawn refused as plain text')
    await apply(ctx, stdioConfig({ reconnect: { enabled: false } }))
    await vi.waitFor(() => {
      expect(connectionStatusOf(ctx, 'srv')!.current()).toMatchObject({
        state: 'failed',
        lastError: containing('spawn refused as plain text'),
      })
    })
  })

  it('reports an errorless outage when the transport closes during connect itself', async () => {
    captureWarns(ctx)
    // Connect resolves but the transport is already gone: no error is thrown,
    // so reconnecting falls back to the close signal as its diagnostic and a
    // budget exhausted this way carries no lastError at all.
    mockConnect.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    await apply(ctx, stdioConfig({ reconnect: { initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 2 } }))
    const handle = connectionStatusOf(ctx, 'srv')!
    const seen: McpConnectionStatus[] = []
    handle.onChange((status) => { seen.push(status) })
    await vi.waitFor(() => {
      expect(handle.current()).toEqual({ state: 'failed', reason: 'gave-up' })
    })
    const reconnecting = seen.find(status => status.state === 'reconnecting')
    expect(reconnecting).toMatchObject({ lastError: 'connection closed' })
  })

  it('reports an errorless reconnect-disabled stop when the transport closes during connect', async () => {
    captureWarns(ctx)
    mockConnect.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    await apply(ctx, stdioConfig({ reconnect: { enabled: false } }))
    await vi.waitFor(() => {
      expect(connectionStatusOf(ctx, 'srv')!.current()).toEqual({ state: 'failed', reason: 'reconnect-disabled' })
    })
  })
})
