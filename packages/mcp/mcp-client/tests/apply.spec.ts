/**
 * Tests for the mcp-client plugin's `apply` lifecycle entry point.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import assert from 'node:assert/strict'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
const { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, MockClient } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _options?: unknown,
  ) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  class MockClient {
    transport = {}
    connect = mockConnect
    close = mockClose
    listTools = mockListTools
    callTool = mockCallTool
    constructor(_info: unknown, options: { listChanged: { tools: { onChanged: () => void } } }) {
      mockSetNotificationHandler('notifications/tools/list_changed', options.listChanged.tools.onChanged)
    }
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
  }
  return { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, MockClient }
})

vi.mock('@modelcontextprotocol/client', () => ({
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(),
}))

// vi.mock is hoisted above static imports, so the module under test sees the
// mocked SDK even through a static import.
import { apply, name, inject, Config as ConfigSchema } from '@deepseek-ai/dsh-mcp-client/src/index.ts'

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

function sleep(ms: number): Promise<void> {
  // Annotated binding (not withResolvers<void>()): the tests lint layer runs
  // no-invalid-void-type with default options, which rejects the explicit
  // type argument in call position but accepts the inferred form.
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(gate.resolve, ms)
  return gate.promise
}

const stdioConfig: Config = {
  transport: 'stdio',
  serverName: 'srv',
  command: 'echo',
  args: [],
  env: {},
  cwd: '',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
}

// ---- Tests ----

describe('mcp-client plugin module exports', () => {
  it('exports name, inject, and Config', () => {
    expect(name).toBe('mcp-client')
    expect(inject).toEqual(['tools'])
    expect(ConfigSchema).toBeDefined()
  })

  it('Config schema rejects a missing serverName', () => {
    expect(() => ConfigSchema({
      transport: 'stdio',
      command: 'echo',
    } as never)).toThrow()
  })

  it('Config schema rejects an invalid serverName', () => {
    // schemastery unions wrap branch errors in a generic "expected ... but got"
    // message, so assert the throw, not the inner pattern text.
    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'bad name!',
      command: 'echo',
    } as never)).toThrow()
    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'x'.repeat(33),
      command: 'echo',
    } as never)).toThrow()
  })

  it('Config schema accepts a valid serverName', () => {
    const resolved = ConfigSchema({
      transport: 'stdio',
      serverName: 'github-prod_1',
      command: 'echo',
    } as never)
    expect(resolved.serverName).toBe('github-prod_1')
  })

  it('Config schema materializes reconnect defaults and merges partial overrides', () => {
    const omitted = ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
    } as never)
    expect(omitted.reconnect).toEqual({ enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 })

    const partial = ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      reconnect: { initialDelayMs: 100 },
    } as never)
    expect(partial.reconnect).toEqual({ enabled: true, initialDelayMs: 100, maxDelayMs: 30_000, maxAttempts: 10 })
  })

  it('Config schema rejects an invalid reconnect block', () => {
    // schemastery unions wrap branch errors, so assert the throw only.
    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      reconnect: { maxAttempts: 0 },
    } as never)).toThrow()
  })
})

describe('apply (plugin lifecycle)', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue({
      tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it.each([undefined, '', ' \n\t'])(
    'connects without attributed prompt text when server instructions are absent or blank (%j)', async (instructions) => {
      const spy = vi.spyOn(MockClient.prototype, 'getInstructions').mockReturnValue(instructions)
      try {
        await apply(ctx, {
          ...stdioConfig, failOnStartupError: true, reconnect: { enabled: false }, maxInstructionBytes: 1,
        })
        expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
        expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('### MCP server:')
      } finally {
        spy.mockRestore()
        await ctx.fiber.dispose()
      }
    },
  )

  it('connects, syncs tools under the namespace, and registers a notification handler', async () => {
    await apply(ctx, stdioConfig)

    expect(mockConnect).toHaveBeenCalled()
    expect(mockListTools).toHaveBeenCalled()
    expect(mockSetNotificationHandler).toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    expect(ctx.tools.get('remote')).toBeUndefined()
  })

  it('keeps the Cordis plugin loading until initial discovery publishes its tools', async () => {
    const connection: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(async () => {
      await connection.promise
    })
    const fiber = ctx.plugin({ name: 'mcp-client-lifecycle', inject, apply }, stdioConfig)
    let activated = false
    const activation = Promise.resolve(fiber).then(() => { activated = true })

    await vi.waitFor(() => { expect(mockConnect).toHaveBeenCalled() })
    expect(activated).toBe(false)
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()

    connection.resolve()
    await activation
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await fiber.dispose()
  })

  it('rejects a duplicate serverName at load and leaves the first instance intact', async () => {
    await apply(ctx, stdioConfig)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    await expect(apply(ctx, stdioConfig)).rejects.toThrow(/serverName "srv" is already in use/)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('closes the transport when its owner unloads during initial connection', async () => {
    const connecting: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => connecting.promise)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      connecting.resolve()
      return Promise.resolve()
    })
    const fiber = ctx.plugin({ name: 'mcp-pending-startup', inject, apply }, { ...stdioConfig, reconnect: { enabled: false } })
    const activation = Promise.resolve(fiber).catch((error: unknown) => error)
    try {
      await vi.waitFor(() => { expect(mockConnect).toHaveBeenCalledTimes(1) })
      await fiber.dispose()
      await activation
      expect(mockClose).toHaveBeenCalledTimes(1)
      expect(mockListTools).not.toHaveBeenCalled()
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      connecting.resolve()
      await ctx.fiber.dispose()
    }
  })

  it('allows one serverName in each independent registration scope', async () => {
    const first = createScope(ctx, {})
    const second = createScope(ctx, {})

    await Promise.all([apply(first.ctx, stdioConfig), apply(second.ctx, stdioConfig)])

    expect(mockConnect).toHaveBeenCalledTimes(2)
    await Promise.all([first.dispose(), second.dispose()])
  })

  it('releases the serverName reservation on dispose', async () => {
    const first = new Context()
    await first.plugin(SystemPrompt)
    await first.plugin(ToolRuntime)
    await first.plugin(NativeToolExecutor)
    await apply(first, stdioConfig)

    await first.fiber.dispose()
    await sleep(50)

    // Same root would conflict; a fresh app root reuses the name freely,
    // and the disposed instance no longer holds the reservation on its root.
    const second = new Context()
    await second.plugin(SystemPrompt)
    await second.plugin(ToolRuntime)
    await second.plugin(NativeToolExecutor)
    await expect(apply(second, stdioConfig)).resolves.toBeUndefined()
    await second.fiber.dispose()
  })

  it('scopes serverName reservations per app root', async () => {
    const other = await mountRegistry()

    const first = apply(ctx, stdioConfig)
    // Same serverName on a DIFFERENT root is fine.
    const second = apply(other, stdioConfig)
    await Promise.all([first, second])

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    expect(other.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('logs error and registers no tools when connect fails; dispose closes the client', async () => {
    mockConnect.mockRejectedValue(new Error('connection refused'))

    await apply(ctx, stdioConfig)

    expect(mockListTools).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()

    // Disposal cancels the scheduled reconnect attempt: nothing to
    // unregister, close already attempted by the failed attempt, no throw.
    await ctx.fiber.dispose()
    await sleep(50)
    expect(mockClose).toHaveBeenCalled()
  })

  it('rejects activation and still closes the client when startup failure is configured as fatal', async () => {
    const cause = new Error('connection refused')
    mockConnect.mockRejectedValue(cause)
    await expect(apply(ctx, {
      ...stdioConfig,
      failOnStartupError: true,
    })).rejects.toMatchObject({
      message: 'mcp-client(srv): initial connection or tool synchronization failed',
      cause,
    })

    expect(mockListTools).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    await ctx.fiber.dispose()
    expect(mockClose).toHaveBeenCalled()
  })

  it('rejects strict startup when the initial tool generation cannot be registered', async () => {
    ctx.tools.register({
      name: 'mcp__srv__remote',
      description: 'Foreign squatter',
      parameters: { type: 'object' },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      execute: async () => 'foreign',
    })

    await expect(apply(ctx, {
      ...stdioConfig,
      failOnStartupError: true,
    })).rejects.toThrow('initial connection or tool synchronization failed')

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await ctx.fiber.dispose()
    expect(mockClose).toHaveBeenCalled()
  })

  it('preserves strict startup registration when list_changed arrives before connect resolves', async () => {
    ctx.tools.register({
      name: 'mcp__srv__remote',
      description: 'Foreign squatter',
      parameters: { type: 'object' },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      execute: async () => 'foreign',
    })
    mockConnect.mockImplementation(async () => {
      const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => void
      handler()
    })

    await expect(apply(ctx, {
      ...stdioConfig,
      failOnStartupError: true,
    })).rejects.toThrow('initial connection or tool synchronization failed')

    expect(mockListTools).toHaveBeenCalledTimes(2)
    expect(ctx.tools.get('mcp__srv__remote')?.description).toBe('Foreign squatter')
    await ctx.fiber.dispose()
  })

  it('re-syncs tools on ToolListChanged notification', async () => {
    await apply(ctx, stdioConfig)

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    mockListTools.mockResolvedValue({
      tools: [{ name: 'updated', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })

    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => void
    handler()

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__updated')).toBeDefined() })
  })

  it('keeps the previous generation when a re-sync fails', async () => {
    await apply(ctx, stdioConfig)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    const reported = vi.spyOn(ctx.logger, 'error')
    mockListTools.mockRejectedValue(new Error('flaky server'))
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => void
    handler()
    await vi.waitFor(() => { expect(reported).toHaveBeenCalledWith(expect.stringContaining('flaky server')) })

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('effect disposer unregisters the CURRENT generation and closes client', async () => {
    // Load through ctx.plugin so ONLY the plugin's fiber is disposed — the
    // registry must survive to observe the unregistration.
    const fiber = ctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, stdioConfig)
    await fiber

    // Advance to a second generation first.
    mockListTools.mockResolvedValue({
      tools: [{ name: 'updated', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => void
    handler()
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__updated')).toBeDefined() })

    await fiber.dispose()
    await sleep(50)

    expect(mockClose).toHaveBeenCalled()
    // The live (second) generation was unregistered, not just the first.
    expect(ctx.tools.get('mcp__srv__updated')).toBeUndefined()
  })

  it('effect disposer handles client.close failure gracefully', async () => {
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.reject(new Error('already closed'))
    })

    await apply(ctx, stdioConfig)

    // Should not throw when dispose is triggered.
    await ctx.fiber.dispose()
    await sleep(50)

    expect(mockClose).toHaveBeenCalled()
  })

  it('uses streamable-http config path', async () => {
    const httpConfig: Config = {
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer x' },
      toolCallTimeoutMs: 30_000,
      failOnStartupError: false,
    }

    await apply(ctx, httpConfig)

    expect(mockConnect).toHaveBeenCalled()
    expect(ctx.tools.get('mcp__web__remote')).toBeDefined()
  })
})


describe('server instruction limits', () => {
  it('counts the complete attributed UTF-8 text before publishing tools', async () => {
    const ctx = await mountRegistry()
    const text = '服务器指南'
    const spy = vi.spyOn(MockClient.prototype, 'getInstructions').mockReturnValue(text)
    const exactBytes = Buffer.byteLength(`### MCP server: srv\n\n${text}`)
    try {
      const failure: unknown = await apply(ctx, {
        ...stdioConfig, failOnStartupError: true, reconnect: { enabled: false },
        maxInstructionBytes: exactBytes - 1,
      }).catch((error: unknown) => error)
      assert(failure instanceof Error)
      assert(failure.cause instanceof Error)
      expect(failure.cause.message).toContain('server instructions exceed maxInstructionBytes')
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      spy.mockRestore()
      await ctx.fiber.dispose()
    }
    const valid = await mountRegistry()
    const validSpy = vi.spyOn(MockClient.prototype, 'getInstructions').mockReturnValue(text)
    try {
      await apply(valid, {
        ...stdioConfig, failOnStartupError: true, reconnect: { enabled: false },
        maxInstructionBytes: exactBytes,
      })
    } finally {
      validSpy.mockRestore()
      await valid.fiber.dispose()
    }
  })
})
