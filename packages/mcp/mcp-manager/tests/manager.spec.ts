/**
 * Tests for the MCP server manager: plugin registrations and their lifetime,
 * restart, status aggregation and the watch stream, cleanup failures that
 * block replacement, lifecycle races, and teardown unwinding every child
 * instance.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, FiberState, type Fiber } from '@deepseek-ai/cordis'
import type { Transport } from '@modelcontextprotocol/client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const { mockConnect, mockClose, mockListTools, MockClient, MockTransport, instances, transportUrls } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  class MockTransport {
    onclose?: () => void
    start = async () => {}
    send = async () => {}
    close = async () => { this.onclose?.() }
  }
  class MockClient {
    transport: Transport | undefined
    onclose: (() => void) | undefined
    async connect(transport: Transport): Promise<void> {
      this.transport = transport
      const onclose = transport.onclose
      transport.onclose = () => { onclose?.(); this.onclose?.() }
      await transport.start()
      await mockConnect.call(this)
    }
    close = mockClose
    listTools = mockListTools
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
    listResources = async () => ({ resources: [] })
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  const transportUrls: string[] = []
  return { mockConnect, mockClose, mockListTools, MockClient, MockTransport, instances, transportUrls }
})

// A static instance occupying a server name connects over stdio.
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  // Constructible mock: `new` on an arrow-implemented vi.fn throws.
  StdioClientTransport: vi.fn(function () { return new MockTransport() }),
}))
vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(function (url: URL) {
    transportUrls.push(url.href)
    return new MockTransport()
  }),
}))

import { apply as applyMcpClient, Config as ClientConfig, connectionStatusOf } from '@deepseek-ai/dsh-mcp-client'
import McpServerManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import type { Config, McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager/src/index.ts'

// Typed views of vitest's asymmetric matchers: their `any` return would
// otherwise trip no-unsafe-assignment inside expectation literals.
const anyNumber = expect.any(Number) as number
const containing = (text: string): string => expect.stringContaining(text) as string

const URL_A = 'http://mcp.test/a'
const URL_B = 'http://mcp.test/b'
const URL_C = 'http://mcp.test/c'

function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })), nextCursor: undefined }
}

async function mountWorld(config: Partial<Config> = {}): Promise<{ ctx: Context; manager: McpServerManager; managerFiber: Fiber }> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const managerFiber = ctx.plugin(McpServerManager, config)
  await managerFiber.await()
  return { ctx, manager: ctx.get('mcpServers')!, managerFiber }
}

/** Occupy a server name with an mcp-client instance outside the manager. */
async function occupyName(ctx: Context, serverName: string): Promise<void> {
  await applyMcpClient(ctx, ClientConfig({ transport: 'stdio', serverName, command: 'echo' }))
}

/** Count child mcp-client fibers that reach a lifecycle state. */
function countChildren(ctx: Context, state: FiberState): { readonly count: number; readonly configs: unknown[] } {
  const seen: { count: number; configs: unknown[] } = { count: 0, configs: [] }
  ctx.on('internal/status', (fiber) => {
    if (fiber.runtime?.callback !== applyMcpClient || fiber.state !== state) return
    seen.count++
    seen.configs.push(fiber.config)
  }, { global: true })
  return seen
}

async function waitForState(manager: McpServerManager, name: string, state: string): Promise<void> {
  await vi.waitFor(() => {
    const view = manager.list().find(entry => entry.name === name)
    expect(view?.status.state).toBe(state)
  })
}

function gatedClose(): { closing: PromiseWithResolvers<void>; gate: PromiseWithResolvers<void> } {
  const closing: PromiseWithResolvers<void> = Promise.withResolvers()
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
    closing.resolve()
    await gate.promise
    await this.transport?.close()
  })
  return { closing, gate }
}

describe('mcp-manager', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    instances.length = 0
    transportUrls.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(async function (this: InstanceType<typeof MockClient>) {
      await this.transport?.close()
    })
    mockListTools.mockResolvedValue(listing('remote'))
  })

  it('mounts a registered server for its plugin lifetime and awaits its unmount on disposal', async () => {
    const { ctx, manager } = await mountWorld()
    const registrar = ctx.plugin({
      name: 'registrar',
      inject: ['mcpServers'],
      apply(child: Context) { child.mcpServers.register('app', { url: URL_A }) },
    })
    await registrar.await()
    await waitForState(manager, 'app', 'connected')
    expect(manager.list()).toEqual([{ name: 'app', status: { state: 'connected', toolCount: 1, connectedAt: anyNumber } }])
    expect(transportUrls).toEqual([URL_A])
    expect(ctx.tools.get('mcp__app__remote')).toBeDefined()
    await registrar.dispose()
    expect(ctx.tools.get('mcp__app__remote')).toBeUndefined()
    expect(manager.list()).toEqual([])
  })

  it('mounts each registration with the configured startup budget and non-strict startup', async () => {
    const { ctx, manager } = await mountWorld({ startupTimeoutMs: 1_234 })
    const active = countChildren(ctx, FiberState.ACTIVE)
    manager.register('app', { url: URL_A })
    await vi.waitFor(() => { expect(active.count).toBe(1) })
    expect(active.configs[0]).toMatchObject({
      transport: 'streamable-http', serverName: 'app', url: URL_A, startupTimeoutMs: 1_234, failOnStartupError: false,
    })
  })

  it('rejects a taken or invalid name and keeps its disposer idempotent', async () => {
    const { manager } = await mountWorld()
    const dispose = manager.register('app', { url: URL_A })
    // Listed before the first reconcile publishes a status.
    expect(manager.list()).toEqual([{ name: 'app', status: { state: 'connecting', attempt: 0 } }])
    expect(() => manager.register('app', { url: URL_B })).toThrow('server "app" is already registered')
    expect(() => manager.register('bad name', { url: URL_A })).toThrow('"serverName":"bad name"')
    dispose()
    dispose()
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
  })

  it('restarts a registered server and rejects an unknown name', async () => {
    const { manager } = await mountWorld()
    manager.register('app', { url: URL_A })
    await waitForState(manager, 'app', 'connected')
    const clients = instances.length
    await manager.restart('app')
    await waitForState(manager, 'app', 'connected')
    expect(instances.length).toBe(clients + 1)
    await expect(manager.restart('ghost')).rejects.toThrow('unknown server "ghost"')
  })

  it('reports a load failure when the name collides with a static instance, and restart retries the load', async () => {
    const { ctx, manager } = await mountWorld()
    await occupyName(ctx, 'dup')
    const failed = countChildren(ctx, FiberState.FAILED)
    manager.register('dup', { url: URL_A })
    await vi.waitFor(() => { expect(failed.count).toBe(1) })
    await waitForState(manager, 'dup', 'failed')
    expect(manager.list()).toEqual([{ name: 'dup', status: { state: 'failed', reason: 'load', lastError: containing('serverName "dup" is already in use') } }])
    await manager.restart('dup')
    await vi.waitFor(() => { expect(failed.count).toBe(2) })
    await waitForState(manager, 'dup', 'failed')
    // Only the static instance connected; neither managed attempt got past its name reservation.
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('ignores a status callback already captured when manager disposal detaches it', async () => {
    const { ctx, manager, managerFiber } = await mountWorld()
    let disposing: Promise<void> | undefined
    ctx.on('internal/status', (fiber) => {
      if (fiber.runtime?.callback !== applyMcpClient || fiber.state !== FiberState.ACTIVE) return
      connectionStatusOf(fiber)!.onChange(() => { disposing = managerFiber.dispose() })
    }, { global: true })
    manager.register('app', { url: URL_A })
    await waitForState(manager, 'app', 'connected')
    const before = manager.list()
    await instances[0]!.transport!.close()
    await vi.waitFor(() => { expect(disposing).toBeDefined() })
    await disposing
    expect(manager.list()).toEqual(before)
  })

  it('blocks replacement after a connection attempt reports incomplete cleanup and keeps a removed registration observable', async () => {
    mockConnect.mockRejectedValueOnce(new Error('connection refused'))
    mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
      await this.transport?.close()
      throw new Error('startup cleanup failure')
    })
    const { manager } = await mountWorld()
    const dispose = manager.register('srv', { url: URL_A })
    await waitForState(manager, 'srv', 'failed')
    expect(manager.list()[0]!.status).toMatchObject({ state: 'failed', reason: 'unclosed-generation' })
    await expect(manager.restart('srv')).rejects.toThrow('cleanup for "srv" is incomplete')
    expect(mockConnect).toHaveBeenCalledTimes(1)
    const cleanup: McpManagedServerStatus = {
      state: 'failed', reason: 'cleanup', result: { closeConfirmed: true, cleanupError: containing('startup cleanup failure') },
    }
    expect(manager.list()).toEqual([{ name: 'srv', status: cleanup }])
    dispose()
    // The removed registration's retained record still reports its cleanup failure.
    await vi.waitFor(() => { expect(manager.list()).toEqual([{ name: 'srv', status: cleanup }]) })
  })

  it('ignores a child startup rejection after manager disposal has retired it', async () => {
    const { ctx, manager, managerFiber } = await mountWorld()
    await occupyName(ctx, 'dup')
    const failed: PromiseWithResolvers<void> = Promise.withResolvers()
    let disposing: Promise<void> | undefined
    ctx.on('internal/status', (fiber) => {
      if (fiber.runtime?.callback !== applyMcpClient || fiber.state !== FiberState.FAILED) return
      disposing = managerFiber.dispose()
      failed.resolve()
    }, { global: true })
    manager.register('dup', { url: URL_A })
    await failed.promise
    await disposing
    expect(manager.list()).toEqual([{ name: 'dup', status: { state: 'connecting', attempt: 0 } }])
    await expect(manager.restart('dup')).rejects.toThrow('disposed')
  })

  it('drops queued startup-failure handling when registration removal retires the child', async () => {
    const { ctx, manager } = await mountWorld()
    await occupyName(ctx, 'dup')
    manager.register('live', { url: URL_A })
    await waitForState(manager, 'live', 'connected')
    const failed = countChildren(ctx, FiberState.FAILED)
    const { closing, gate } = gatedClose()
    // The reconcile mounting `dup` runs first; the restart then holds the queue,
    // so the failed child's handling waits behind it.
    const dispose = manager.register('dup', { url: URL_B })
    const restarting = manager.restart('live')
    try {
      await closing.promise
      await vi.waitFor(() => { expect(failed.count).toBe(1) })
      // Drain the rejection handlers that queue the failure handling.
      await new Promise(resolve => setTimeout(resolve, 0))
      dispose()
      gate.resolve()
      await restarting
      await vi.waitFor(() => { expect(manager.list().map(server => server.name)).toEqual(['live']) })
      await waitForState(manager, 'live', 'connected')
    } finally {
      gate.resolve()
      await restarting
    }
  })

  it.each(['newer registration', 'disposal'] as const)('does not mount a stale registration after %s overtakes cleanup', async (action) => {
    const { ctx, manager, managerFiber } = await mountWorld()
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    const first = manager.register('srv', { url: URL_A })
    await waitForState(manager, 'srv', 'connected')
    const { closing, gate } = gatedClose()
    try {
      first()
      const stale = manager.register('srv', { url: URL_B })
      await closing.promise
      if (action === 'newer registration') {
        stale()
        manager.register('srv', { url: URL_C })
        gate.resolve()
        await vi.waitFor(() => { expect(transportUrls).toEqual([URL_A, URL_C]) })
        await waitForState(manager, 'srv', 'connected')
      } else {
        const disposing = managerFiber.dispose()
        gate.resolve()
        await disposing
        expect(transportUrls).toEqual([URL_A])
        // The reconcile queued for the stale registration loses to disposal and is logged.
        await vi.waitFor(() => { expect(errors).toContain('mcp-manager: registration of "srv" failed') })
      }
    } finally {
      gate.resolve()
    }
  })

  it.each(['registration removal', 'disposal'] as const)('lets a restart stop after %s overtakes its unmount', async (action) => {
    const { manager, managerFiber } = await mountWorld()
    const dispose = manager.register('gated', { url: URL_A })
    await waitForState(manager, 'gated', 'connected')
    const clients = instances.length
    const { closing, gate } = gatedClose()
    const restarting = manager.restart('gated')
    try {
      await closing.promise
      if (action === 'registration removal') {
        dispose()
        gate.resolve()
        await restarting
        await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
      } else {
        const disposing = managerFiber.dispose()
        gate.resolve()
        await restarting
        await disposing
      }
      expect(instances.length).toBe(clients)
    } finally {
      gate.resolve()
      await restarting
    }
  })

  it('unwinds every instance and its tools when the manager is disposed, then refuses operations', async () => {
    const { ctx, manager, managerFiber } = await mountWorld()
    manager.register('one', { url: URL_A })
    manager.register('two', { url: URL_B })
    await waitForState(manager, 'one', 'connected')
    await waitForState(manager, 'two', 'connected')
    await managerFiber.dispose()
    expect(ctx.tools.get('mcp__one__remote')).toBeUndefined()
    expect(ctx.tools.get('mcp__two__remote')).toBeUndefined()
    await expect(manager.restart('one')).rejects.toThrow('disposed')
  })

  it('publishes nothing for a transport close that lands after the registration is removed', async () => {
    const { ctx, manager } = await mountWorld()
    const dispose = manager.register('racy', { url: URL_A })
    await waitForState(manager, 'racy', 'connected')
    const clients = instances.length
    // Removal retires the record synchronously, before the queued unmount runs.
    dispose()
    instances.at(-1)!.onclose?.()
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
    expect(ctx.tools.get('mcp__racy__remote')).toBeUndefined()
    expect(instances.length).toBe(clients)
  })

  it('discards a starting instance whose registration is removed before activation settles', async () => {
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => gate.promise)
    const { ctx, manager } = await mountWorld()
    const dispose = manager.register('starting', { url: URL_A })
    await vi.waitFor(() => { expect(instances.length).toBe(1) })
    dispose()
    gate.resolve()
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
    expect(ctx.tools.get('mcp__starting__remote')).toBeUndefined()
  })

  it('leaves unmounting to a stopped manager when a registration ends after disposal', async () => {
    const { ctx, manager, managerFiber } = await mountWorld()
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    const dispose = manager.register('app', { url: URL_A })
    await waitForState(manager, 'app', 'connected')
    await managerFiber.dispose()
    dispose()
    expect(() => manager.register('late', { url: URL_A })).toThrow('the manager is disposed')
    expect(errors).toEqual([])
  })

  it('streams the server list on subscription and after each change until the subscriber aborts', async () => {
    const { manager } = await mountWorld()
    const subscriber = new AbortController()
    const stream = manager.watch(subscriber.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toEqual([])
    manager.register('srv', { url: URL_A })
    let views: unknown
    await vi.waitFor(async () => {
      views = (await stream.next()).value
      expect(views).toEqual([{ name: 'srv', status: expect.objectContaining({ state: 'connected' }) as McpManagedServerStatus }])
    })
    subscriber.abort()
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(manager.watch(AbortSignal.abort())[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('ends a waiting stream when the manager is disposed', async () => {
    const { manager, managerFiber } = await mountWorld()
    const stream = manager.watch(new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    const waiting = stream.next()
    await managerFiber.dispose()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
  })
})

describe('manager configuration', () => {
  it('defaults the startup budget', () => {
    expect(McpServerManager.Config({})).toEqual({ startupTimeoutMs: 30_000 })
  })

  it.each([0, -5])('refuses startupTimeoutMs %d at load', (startupTimeoutMs) => {
    expect(() => McpServerManager.Config({ startupTimeoutMs })).toThrow()
  })
})
