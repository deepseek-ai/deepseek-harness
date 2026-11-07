/**
 * Tests for the MCP server manager: entry-config fallback, settings-driven
 * reconciliation (add / change / disable / delete), plugin registrations,
 * restart, credential templates and rotation-driven rebuilds, status
 * aggregation, events and the watch stream, and teardown unwinding every
 * child instance.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, FiberState, type Fiber } from '@deepseek-ai/cordis'
import type { Transport } from '@modelcontextprotocol/client'
import type Settings from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

const { mockConnect, mockClose, mockListTools, MockClient, MockTransport, instances, transportConfigs } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
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
    // The probe pages through request(); the supervised connection lists through listTools().
    request = mockRequest
    listTools = mockListTools
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
    listResources = async () => ({ resources: [] })
    getServerVersion = (): { name: string; version: string } => ({ name: 'fixture', version: '1.0.0' })
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  const transportConfigs: Array<Record<string, unknown>> = []
  return { mockConnect, mockClose, mockListTools, MockClient, MockTransport, instances, transportConfigs }
})

vi.mock('@modelcontextprotocol/client/stdio', () => ({
  // Constructible mock: `new` on an arrow-implemented vi.fn throws.
  StdioClientTransport: vi.fn(function (config: Record<string, unknown>) {
    transportConfigs.push(config)
    return new MockTransport()
  }),
}))
vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(function (url: URL, options: Record<string, unknown>) {
    transportConfigs.push({ url: url.href, ...options })
    return new MockTransport()
  }),
}))

import { apply as applyMcpClient, Config as ClientConfig, connectionStatusOf } from '@deepseek-ai/dsh-mcp-client'
import McpServerManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import type { Config, McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import { managerProfile } from './profile-fixture.ts'

/** Minimal real credential provider: reference half backed by a map. */
class MemoryCredentials extends CredentialProvider {
  values = new Map<string, string>()
  /** Gate awaited by resolve() when set, to hold a lifecycle operation open. */
  resolveGate: Promise<void> | undefined

  get writable(): boolean { return true }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (this.resolveGate !== undefined) await this.resolveGate
    const value = this.values.get(String(ref))
    return value === undefined ? undefined : { value, source: 'memory' }
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.values.has(String(ref)), writable: true } as CredentialInfo)
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(String(ref), value)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(String(ref))
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  readRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  describeRecord(): Promise<CredentialRecordInfo> { return Promise.resolve({ configured: false, writable: false } as CredentialRecordInfo) }
  listRecords(): Promise<readonly CredentialRecordEntry[]> { return Promise.resolve([]) }
  modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }
  deleteRecord(_key: CredentialKey): Promise<void> { return Promise.resolve() }
}

// Typed views of vitest's asymmetric matchers: their `any` return would
// otherwise trip no-unsafe-assignment inside expectation literals.
const anyNumber = expect.any(Number) as number
const containing = (text: string): string => expect.stringContaining(text) as string

function stdioEntry(overrides?: Record<string, unknown>): Record<string, unknown> {
  return { transport: 'stdio', command: 'echo', ...overrides }
}

function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })), nextCursor: undefined }
}

async function mountWorld(options?: {
  managerConfig?: unknown
  settingsDoc?: Record<string, unknown>
  withSettings?: boolean
  withCredentials?: boolean
}): Promise<{
  ctx: Context
  manager: McpServerManager
  settings: Settings | undefined
  credentials: MemoryCredentials | undefined
  events: Array<{ name: string; status: McpManagedServerStatus }>
  managerFiber: Fiber
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let credentials: MemoryCredentials | undefined
  if (options?.withCredentials === true) {
    await ctx.plugin(MemoryCredentials)
    credentials = ctx.get('credentials') as MemoryCredentials
  }
  const events: Array<{ name: string; status: McpManagedServerStatus }> = []
  ctx.on('mcp-manager/status', (name, status) => { events.push({ name, status }) })
  let managerFiber: Fiber
  if (options?.withSettings === false) {
    onTestFinished(async () => { await ctx.fiber.dispose() })
    managerFiber = ctx.plugin(McpServerManager, options.managerConfig ?? {})
    await managerFiber.await()
  } else {
    const { entry } = await managerProfile(ctx, { base: options?.managerConfig, user: options?.settingsDoc?.mcp })
    managerFiber = entry.fiber!
  }
  const settings = ctx.get('settings')
  const manager = ctx.get('mcpManager')!
  return { ctx, manager, settings, credentials, events, managerFiber }
}

async function waitForState(manager: McpServerManager, name: string, state: string): Promise<void> {
  await vi.waitFor(() => {
    const view = manager.list().find(entry => entry.name === name)
    expect(view?.status.state).toBe(state)
  })
}

describe('mcp-manager', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    instances.length = 0
    transportConfigs.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(async function (this: InstanceType<typeof MockClient>) {
      await this.transport?.close()
    })
    mockListTools.mockResolvedValue(listing('remote'))
  })

  it('mounts composition-base servers without any settings provider', async () => {
    const { ctx, manager } = await mountWorld({
      withSettings: false,
      managerConfig: { servers: { base: stdioEntry() } },
    })
    await waitForState(manager, 'base', 'connected')
    expect(ctx.tools.get('mcp__base__remote')).toBeDefined()
    expect(manager.list()).toEqual([{
      name: 'base',
      configured: true,
      status: { state: 'connected', toolCount: 1, connectedAt: anyNumber },
    }])
  })

  it('mounts servers from the settings user layer and reports them configured', async () => {
    const { ctx, manager } = await mountWorld({
      settingsDoc: { mcp: { servers: { added: stdioEntry() } } },
    })
    await waitForState(manager, 'added', 'connected')
    expect(ctx.tools.get('mcp__added__remote')).toBeDefined()
    expect(manager.list()[0]).toMatchObject({ name: 'added', configured: true })
  })

  it('rebuilds an instance when its entry changes and leaves an unchanged sibling alone', async () => {
    const { ctx, manager, settings } = await mountWorld({
      settingsDoc: { mcp: { servers: { alpha: stdioEntry(), beta: stdioEntry({ command: 'beta' }) } } },
    })
    await waitForState(manager, 'alpha', 'connected')
    await waitForState(manager, 'beta', 'connected')
    const clientsBefore = instances.length

    mockListTools.mockResolvedValue(listing('changed'))
    await settings!.update('mcp', {
      servers: {
        alpha: { args: ['--fast'], toolCallTimeoutMs: 5_000, startupTimeoutMs: 4_000, reconnect: { maxAttempts: 3 } },
      },
    })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__alpha__changed')).toBeDefined() })
    // Exactly one new client generation: beta was not rebuilt.
    expect(instances.length).toBe(clientsBefore + 1)
    expect(transportConfigs.at(-1)).toMatchObject({ command: 'echo', args: ['--fast'] })
  })

  it('disable unmounts the instance and keeps the entry listed; re-enable remounts it', async () => {
    const { ctx, manager, settings, events } = await mountWorld({
      settingsDoc: { mcp: { servers: { toggled: stdioEntry() } } },
    })
    await waitForState(manager, 'toggled', 'connected')

    await settings!.update('mcp', { servers: { toggled: { enabled: false } } })
    await waitForState(manager, 'toggled', 'disabled')
    expect(ctx.tools.get('mcp__toggled__remote')).toBeUndefined()
    expect(manager.list()[0]).toMatchObject({ name: 'toggled', configured: true, status: { state: 'disabled' } })

    await settings!.update('mcp', { servers: { toggled: { enabled: true } } })
    await waitForState(manager, 'toggled', 'connected')
    expect(ctx.tools.get('mcp__toggled__remote')).toBeDefined()
    // The disabled status was published exactly once despite two reconciles.
    expect(events.filter(event => event.status.state === 'disabled')).toHaveLength(1)
  })

  it('deleting the entry unmounts the instance and drops it from the list', async () => {
    const { ctx, manager, settings } = await mountWorld({
      settingsDoc: { mcp: { servers: { doomed: stdioEntry() } } },
    })
    await waitForState(manager, 'doomed', 'connected')

    await settings!.replace('mcp', {})
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__doomed__remote')).toBeUndefined() })
  })

  it('restart rebuilds the instance and rejects an unknown name', async () => {
    const { manager } = await mountWorld({
      settingsDoc: { mcp: { servers: { srv: stdioEntry() } } },
    })
    await waitForState(manager, 'srv', 'connected')
    const clientsBefore = instances.length
    await manager.restart('srv')
    await waitForState(manager, 'srv', 'connected')
    expect(instances.length).toBe(clientsBefore + 1)
    await expect(manager.restart('ghost')).rejects.toThrow(/unknown server "ghost"/)
  })

  it('resolves credentials without expanding Fiber config and replaces the connection on rotation', async () => {
    const { ctx, manager, credentials } = await mountWorld({
      withCredentials: true,
      settingsDoc: {
        mcp: {
          servers: {
            remote: { transport: 'streamable-http', url: 'http://localhost:1', headers: { Authorization: 'Bearer ${credential:MCP_SPEC_TOKEN}' } },
            dormant: { transport: 'streamable-http', url: 'http://localhost:2', headers: { Authorization: '${credential:MCP_SPEC_TOKEN}' }, enabled: false },
          },
        },
      },
    })
    await credentials!.set(credentialRef('MCP_SPEC_TOKEN'), 'first-token')
    await vi.waitFor(() => {
      expect(transportConfigs.at(-1)).toMatchObject({ requestInit: { headers: { Authorization: 'Bearer first-token' } } })
    })
    await waitForState(manager, 'remote', 'connected')
    const fiber = [...ctx.registry.get(applyMcpClient)!.fibers][0]!
    expect(fiber.config).toMatchObject({ headers: { Authorization: 'Bearer ${credential:MCP_SPEC_TOKEN}' } })
    const clientsBefore = instances.length

    await credentials!.set(credentialRef('MCP_SPEC_TOKEN'), 'second-token')
    await vi.waitFor(() => {
      expect(transportConfigs.at(-1)).toMatchObject({ requestInit: { headers: { Authorization: 'Bearer second-token' } } })
    })
    expect(instances.length).toBe(clientsBefore + 1)
    expect([...ctx.registry.get(applyMcpClient)!.fibers][0]).toBe(fiber)
    // An unrelated credential rotation rebuilds nothing, and the disabled
    // sibling referencing the same credential never mounted.
    await credentials!.set(credentialRef('MCP_SPEC_UNRELATED'), 'noise')
    await manager.restart('remote')
    expect(instances.length).toBe(clientsBefore + 2)
    expect(manager.list().find(view => view.name === 'dormant')!.status).toEqual({ state: 'disabled' })
  })

  it('preserves an exhausted retry budget for same-value credential notifications', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, manager, credentials } = await mountWorld({
        withSettings: false, withCredentials: true,
        managerConfig: { servers: { remote: {
          transport: 'streamable-http', url: 'http://localhost:1',
          headers: { Authorization: '${credential:MCP_SPEC_RETRY}' },
          reconnect: { initialDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 1 },
        } } },
      })
      await vi.waitFor(() => { expect(manager.list()[0]?.status.state).toBe('waiting-credentials') })
      mockConnect.mockRejectedValue(new Error('unavailable'))
      await credentials!.set(credentialRef('MCP_SPEC_RETRY'), 'first-token')
      await vi.runAllTimersAsync()
      expect(manager.list()[0]?.status).toMatchObject({ state: 'failed', reason: 'gave-up' })
      const attempts = mockConnect.mock.calls.length
      await credentials!.set(credentialRef('MCP_SPEC_RETRY'), 'first-token')
      await vi.runAllTimersAsync()
      expect(mockConnect).toHaveBeenCalledTimes(attempts)
      expect(manager.list()[0]?.status).toMatchObject({ state: 'failed', reason: 'gave-up' })
      mockConnect.mockResolvedValue(undefined)
      await credentials!.set(credentialRef('MCP_SPEC_RETRY'), 'second-token')
      await vi.runAllTimersAsync()
      expect(mockConnect).toHaveBeenCalledTimes(attempts + 1)
      expect(manager.list()[0]?.status.state).toBe('connected')
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnects an HTTP server with a rotated header value', async () => {
    const { manager, credentials } = await mountWorld({
      withCredentials: true,
      settingsDoc: { mcp: { servers: { remote: {
        transport: 'streamable-http', url: 'http://localhost:1',
        headers: { Authorization: 'Bearer ${credential:MCP_SPEC_HTTP}' },
      } } } },
    })
    await waitForState(manager, 'remote', 'waiting-credentials')
    await credentials!.set(credentialRef('MCP_SPEC_HTTP'), 'first-token')
    await waitForState(manager, 'remote', 'connected')
    expect(transportConfigs.at(-1)).toMatchObject({ requestInit: { headers: { Authorization: 'Bearer first-token' } } })
    await credentials!.set(credentialRef('MCP_SPEC_HTTP'), 'second-token')
    await vi.waitFor(() => {
      expect(transportConfigs.at(-1)).toMatchObject({ requestInit: { headers: { Authorization: 'Bearer second-token' } } })
    })
    await waitForState(manager, 'remote', 'connected')
  })

  it('removes tools while an active credential is missing and recovers when it is stored again', async () => {
    const { ctx, manager, credentials } = await mountWorld({
      withCredentials: true,
      settingsDoc: { mcp: { servers: { srv: stdioEntry({ env: { TOKEN: '${credential:MCP_SPEC_UNSET}' } }) } } },
    })
    await waitForState(manager, 'srv', 'waiting-credentials')
    await credentials!.set(credentialRef('MCP_SPEC_UNSET'), 'first')
    await waitForState(manager, 'srv', 'connected')
    await credentials!.unset(credentialRef('MCP_SPEC_UNSET'))
    await waitForState(manager, 'srv', 'waiting-credentials')
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(mockConnect).toHaveBeenCalledTimes(1)
    await credentials!.set(credentialRef('MCP_SPEC_UNSET'), 'restored')
    await waitForState(manager, 'srv', 'connected')
    expect(transportConfigs.at(-1)?.env).toMatchObject({ TOKEN: 'restored' })
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('rechecks a queued credential update after provider failure without logging a resolved secret', async () => {
    const { ctx, manager, credentials } = await mountWorld({
      withCredentials: true,
      settingsDoc: { mcp: { servers: { srv: stdioEntry({ env: { TOKEN: '${credential:MCP_SPEC_RECHECK}' } }) } } },
    })
    await waitForState(manager, 'srv', 'waiting-credentials')
    await credentials!.set(credentialRef('MCP_SPEC_RECHECK'), 'first-secret')
    await waitForState(manager, 'srv', 'connected')
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const resolve = vi.spyOn(credentials!, 'resolve').mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      throw new Error('provider response included first-secret')
    })
    try {
      await credentials!.set(credentialRef('MCP_SPEC_RECHECK'), 'second')
      await entered.promise
      await credentials!.set(credentialRef('MCP_SPEC_RECHECK'), 'latest')
      gate.resolve()
      await vi.waitFor(() => { expect(transportConfigs.at(-1)?.env).toMatchObject({ TOKEN: 'latest' }) })
      await waitForState(manager, 'srv', 'connected')
      expect(resolve.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(errors.some(line => line.includes('credential refresh failed'))).toBe(true)
      expect(errors.join('\n')).toContain('[redacted]')
      expect(errors.join('\n')).not.toContain('first-secret')
      expect(mockConnect).toHaveBeenCalledTimes(2)
    } finally {
      gate.resolve()
      resolve.mockRestore()
    }
  })

  it('reports cleanup timeout when disposal overtakes credential resolution and contains its late rejection', async () => {
    vi.useFakeTimers()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    let disposing: Promise<void> | undefined
    try {
      const { ctx, manager, credentials, managerFiber } = await mountWorld({
        withSettings: false, withCredentials: true,
        managerConfig: { servers: { srv: stdioEntry({ env: { TOKEN: '${credential:MCP_SPEC_DISPOSE}' }, closeTimeoutMs: 50 }) } },
      })
      await waitForState(manager, 'srv', 'waiting-credentials')
      await credentials!.set(credentialRef('MCP_SPEC_DISPOSE'), 'first')
      await waitForState(manager, 'srv', 'connected')
      const fiber = [...ctx.registry.get(applyMcpClient)!.fibers][0]!
      const errors: string[] = []
      ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
      vi.spyOn(credentials!, 'resolve').mockImplementationOnce(async () => {
        entered.resolve()
        await gate.promise
        throw new Error('late provider secret-value')
      })
      await credentials!.set(credentialRef('MCP_SPEC_DISPOSE'), 'second')
      await entered.promise
      disposing = managerFiber.dispose()
      await vi.advanceTimersByTimeAsync(51)
      await disposing
      expect(connectionStatusOf(fiber)!.closure()).toMatchObject({ closeConfirmed: true, cleanupError: containing('MCP cleanup did not settle') })
      expect(manager.list()[0]!.status).toMatchObject({ state: 'failed', reason: 'cleanup' })
      gate.resolve()
      await vi.runAllTimersAsync()
      expect(errors.some(line => line.includes('credential refresh failed'))).toBe(false)
      expect(errors.join('\n')).not.toContain('secret-value')
      expect(mockConnect).toHaveBeenCalledTimes(1)
      await ctx.fiber.dispose()
    } finally {
      gate.resolve()
      await disposing
      vi.useRealTimers()
    }
  })

  it('fails a credential template without the credential seam, naming the alternative', async () => {
    const { manager } = await mountWorld({
      settingsDoc: {
        mcp: {
          servers: {
            remote: { transport: 'streamable-http', url: 'http://localhost:1', headers: { Authorization: '${credential:MCP_SPEC_TOKEN}' } },
          },
        },
      },
    })
    await waitForState(manager, 'remote', 'failed')
    expect(manager.list()[0]!.status).toMatchObject({
      reason: 'load',
      lastError: containing('credentials provider'),
    })
  })

  it('reports a load failure when the serverName collides with a static instance', async () => {
    const { ctx, manager, settings } = await mountWorld()
    await applyMcpClient(ctx, ClientConfig({
      transport: 'stdio',
      serverName: 'dup',
      command: 'echo',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 60_000,
      startupTimeoutMs: 30_000,
      failOnStartupError: false,
    }))
    await settings!.update('mcp', { servers: { dup: stdioEntry() } })
    await waitForState(manager, 'dup', 'failed')
    expect(manager.list()[0]!.status).toMatchObject({
      state: 'failed',
      reason: 'load',
      lastError: containing('serverName "dup" is already in use'),
    })
  })

  it('probes a configured server without touching its instance and rejects an unknown name', async () => {
    const { manager } = await mountWorld({
      settingsDoc: { mcp: { servers: { srv: stdioEntry(), off: stdioEntry({ enabled: false }) } } },
    })
    await waitForState(manager, 'srv', 'connected')
    const clientsBefore = instances.length
    const result = await manager.probe('off')
    expect(result).toMatchObject({ ok: true, toolNames: ['remote'] })
    // The probe used its own client and left the instance set alone.
    expect(instances.length).toBe(clientsBefore + 1)
    expect(manager.list().find(view => view.name === 'off')!.status).toEqual({ state: 'disabled' })
    // Restarting a disabled entry is a no-op that reaffirms its disabled state.
    await manager.restart('off')
    expect(manager.list().find(view => view.name === 'off')!.status).toEqual({ state: 'disabled' })
    await expect(manager.probe('ghost')).rejects.toThrow(/unknown server "ghost"/)
  })

  it('cancels a probe when its configuration is deleted and retains failed cleanup', async () => {
    const { manager, settings, events } = await mountWorld({
      settingsDoc: { mcp: { servers: { probed: stdioEntry({ enabled: false }) } } },
    })
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const connect: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => { entered.resolve(); return connect.promise })
    mockClose.mockImplementation(async function (this: InstanceType<typeof MockClient>) {
      connect.reject(new Error('closed by removal'))
      await this.transport?.close()
      throw new Error('cleanup failed')
    })
    const probing = manager.probe('probed')
    await entered.promise
    await settings!.replace('mcp', {})
    expect(await probing).toMatchObject({ ok: false, closeConfirmed: true, cleanupError: expect.any(String) as string })
    await vi.waitFor(() => {
      expect(manager.list()).toMatchObject([{ name: 'probed', configured: false, status: { state: 'failed', reason: 'cleanup' } }])
    })
    expect(events.at(-1)).toMatchObject({ name: 'probed', status: { state: 'failed', reason: 'cleanup' } })
    await settings!.update('mcp', { servers: { probed: stdioEntry() } })
    await expect(manager.restart('probed')).rejects.toThrow('cleanup')
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('cancels a caller-owned probe without closing the managed connection', async () => {
    const { ctx, manager } = await mountWorld({
      settingsDoc: { mcp: { servers: { srv: stdioEntry() } } },
    })
    await waitForState(manager, 'srv', 'connected')
    const live = instances[0]!
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const listed: PromiseWithResolvers<ReturnType<typeof listing>> = Promise.withResolvers()
    mockListTools.mockImplementationOnce(() => { entered.resolve(); return listed.promise })
    const controller = new AbortController()
    const probing = manager.probe('srv', { signal: controller.signal })
    try {
      await entered.promise
      controller.abort()
      listed.resolve(listing('probe-only'))
      expect(await probing).toMatchObject({ ok: false, stage: 'list', message: 'probe aborted', closeConfirmed: true })
      expect(manager.list()[0]!.status.state).toBe('connected')
      expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
      expect(mockClose.mock.contexts).not.toContain(live)
    } finally {
      listed.resolve(listing())
      await probing
    }
  })

  it('preserves probe cleanup failures against later connection status changes', async () => {
    const { ctx, manager } = await mountWorld({
      settingsDoc: { mcp: { servers: { srv: stdioEntry({ reconnect: { enabled: false } }) } } },
    })
    await waitForState(manager, 'srv', 'connected')
    const live = instances[0]!
    const fiber = [...ctx.registry.get(applyMcpClient)!.fibers][0]!
    mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
      await this.transport?.close()
      throw new Error('probe cleanup failure')
    })
    expect(await manager.probe('srv')).toMatchObject({ ok: true, closeConfirmed: true, cleanupError: expect.any(String) as string })
    await expect(manager.probe('srv')).rejects.toThrow('cleanup')
    await live.transport!.close()
    await vi.waitFor(() => { expect(connectionStatusOf(fiber)!.current()).toMatchObject({ state: 'failed', reason: 'reconnect-disabled' }) })
    expect(manager.list()[0]!.status).toMatchObject({ state: 'failed', reason: 'cleanup' })
    await expect(manager.restart('srv')).rejects.toThrow('cleanup')
  })

  it.each([false, true])('retains unconfirmed closure across concurrent probes when the first confirms %s', async (firstConfirmed) => {
    const { manager, managerFiber } = await mountWorld({
      settingsDoc: { mcp: { servers: { off: stdioEntry({ enabled: false, closeTimeoutMs: 50 }) } } },
    })
    await waitForState(manager, 'off', 'disabled')
    const firstClosing: PromiseWithResolvers<void> = Promise.withResolvers()
    const finishFirst: PromiseWithResolvers<void> = Promise.withResolvers()
    const secondListing: PromiseWithResolvers<void> = Promise.withResolvers()
    const listed = Promise.withResolvers<ReturnType<typeof listing>>()
    const secondClosing: PromiseWithResolvers<void> = Promise.withResolvers()
    mockListTools.mockResolvedValueOnce(listing('remote')).mockImplementationOnce(() => {
      secondListing.resolve()
      return listed.promise
    })
    mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
      firstClosing.resolve()
      await finishFirst.promise
      if (!firstConfirmed) return
      await this.transport?.close()
      throw new Error('first cleanup failure')
    }).mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
      secondClosing.resolve()
      if (firstConfirmed) return
      await this.transport?.close()
      throw new Error('second cleanup failure')
    })
    vi.useFakeTimers()
    const first = manager.probe('off')
    let second: ReturnType<McpServerManager['probe']> | undefined
    try {
      await firstClosing.promise
      second = manager.probe('off')
      await secondListing.promise
      finishFirst.resolve()
      await vi.advanceTimersByTimeAsync(50)
      const firstResult = await first
      expect(firstResult).toMatchObject({ ok: true, closeConfirmed: firstConfirmed })
      listed.resolve(listing('remote'))
      await secondClosing.promise
      await vi.advanceTimersByTimeAsync(50)
      expect(await second).toMatchObject({ ok: true, closeConfirmed: !firstConfirmed })
      expect(manager.list()[0]!.status).toEqual({ state: 'failed', reason: 'cleanup',
        result: { closeConfirmed: false, cleanupError: firstResult.cleanupError } })
      await expect(manager.restart('off')).rejects.toThrow('cleanup')
    } finally {
      finishFirst.resolve()
      listed.resolve(listing())
      for (const instance of instances) await instance.transport?.close()
      await Promise.allSettled([first, second])
      await managerFiber.dispose()
      vi.useRealTimers()
    }
  })

  it('retains an unconfirmed managed connection after a probe cleanup error and configuration removal', async () => {
    const { manager, settings, managerFiber } = await mountWorld({
      settingsDoc: { mcp: { servers: { srv: stdioEntry({ closeTimeoutMs: 50 }) } } },
    })
    await waitForState(manager, 'srv', 'connected')
    const live = instances[0]!
    mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
      await this.transport?.close()
      throw new Error('probe cleanup failure')
    })
    const probe = await manager.probe('srv')
    expect(probe).toMatchObject({ ok: true, closeConfirmed: true, cleanupError: expect.any(String) as string })
    const closing: PromiseWithResolvers<void> = Promise.withResolvers()
    mockClose.mockImplementationOnce(() => { closing.resolve(); return Promise.resolve() })
    vi.useFakeTimers()
    try {
      await settings!.replace('mcp', {})
      await closing.promise
      await vi.advanceTimersByTimeAsync(50)
      await vi.waitFor(() => {
        expect(manager.list()).toEqual([{ name: 'srv', configured: false, status: {
          state: 'failed', reason: 'cleanup', result: { closeConfirmed: false, cleanupError: probe.cleanupError },
        } }])
      })
    } finally {
      await live.transport?.close()
      await managerFiber.dispose()
      vi.useRealTimers()
    }
  })

  it('combines probe cleanup errors with a later live connection closure failure', async () => {
    vi.useFakeTimers()
    try {
      const { manager, managerFiber } = await mountWorld({
        withSettings: false,
        managerConfig: { servers: { srv: stdioEntry({ closeTimeoutMs: 50 }) } },
      })
      await waitForState(manager, 'srv', 'connected')
      const live = instances[0]!
      try {
        mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
          await this.transport?.close()
          throw new Error('probe cleanup failure')
        })
        const probe = await manager.probe('srv')
        expect(probe.closeConfirmed).toBe(true)
        mockClose.mockResolvedValueOnce(undefined)
        live.onclose?.()
        await vi.advanceTimersByTimeAsync(50)
        expect(manager.list()[0]!.status).toEqual({ state: 'failed', reason: 'cleanup',
          result: { closeConfirmed: false, cleanupError: probe.cleanupError } })
      } finally {
        await live.transport?.close()
        await managerFiber.dispose()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a status callback already captured when manager disposal detaches it', async () => {
    const { ctx, manager, settings, managerFiber, events } = await mountWorld()
    let disposing: Promise<void> | undefined
    ctx.on('internal/status', (fiber) => {
      if (fiber.runtime?.callback !== applyMcpClient || fiber.state !== FiberState.ACTIVE) return
      connectionStatusOf(fiber)!.onChange(() => { disposing = managerFiber.dispose() })
    }, { global: true })
    await settings!.update('mcp', { servers: { srv: stdioEntry() } })
    await waitForState(manager, 'srv', 'connected')
    const before = manager.list()
    const published = events.length
    await instances[0]!.transport!.close()
    await vi.waitFor(() => { expect(disposing).toBeDefined() })
    await disposing
    expect(manager.list()).toEqual(before)
    expect(events).toHaveLength(published)
  })

  it('blocks replacements after a connection attempt reports incomplete cleanup', async () => {
    mockConnect.mockRejectedValueOnce(new Error('connection refused'))
    mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
      await this.transport?.close()
      throw new Error('startup cleanup failure')
    })
    const { manager, credentials } = await mountWorld({
      withCredentials: true,
      settingsDoc: { mcp: { servers: { srv: stdioEntry({ env: { TOKEN: '${credential:MCP_SPEC_CLEANUP}' } }) } } },
    })
    await waitForState(manager, 'srv', 'waiting-credentials')
    await credentials!.set(credentialRef('MCP_SPEC_CLEANUP'), 'first')
    await waitForState(manager, 'srv', 'failed')
    expect(manager.list()[0]!.status).toMatchObject({ state: 'failed', reason: 'unclosed-generation' })
    const resolve = vi.spyOn(credentials!, 'resolve')
    await credentials!.set(credentialRef('MCP_SPEC_CLEANUP'), 'second')
    expect(resolve).not.toHaveBeenCalled()
    await expect(manager.probe('srv')).rejects.toThrow('cleanup')
    await expect(manager.restart('srv')).rejects.toThrow('cleanup')
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('ignores a child startup rejection after manager disposal has retired it', async () => {
    const { ctx, manager, settings, managerFiber, events } = await mountWorld()
    const failed: PromiseWithResolvers<void> = Promise.withResolvers()
    let disposing: Promise<void> | undefined
    ctx.on('internal/status', (fiber) => {
      if (fiber.runtime?.callback !== applyMcpClient || fiber.state !== FiberState.FAILED) return
      disposing = managerFiber.dispose()
      failed.resolve()
    }, { global: true })
    await settings!.update('mcp', { servers: { missing: stdioEntry({ env: { TOKEN: '${credential:MCP_SPEC_ABSENT_PROVIDER}' } }) } })
    await failed.promise
    await disposing
    expect(events.some(event => event.status.state === 'failed')).toBe(false)
    await expect(manager.restart('missing')).rejects.toThrow('disposed')
  })

  it('drops queued startup-failure handling when configuration removal retires the child', async () => {
    const { ctx, manager, settings, events } = await mountWorld({
      settingsDoc: { mcp: { servers: { live: stdioEntry() } } },
    })
    await waitForState(manager, 'live', 'connected')
    const closing: PromiseWithResolvers<void> = Promise.withResolvers()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    let restarting: Promise<void> | undefined
    mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
      closing.resolve()
      await gate.promise
      await this.transport?.close()
    })
    ctx.on('internal/status', (fiber) => {
      if (fiber.runtime?.callback !== applyMcpClient || fiber.state !== FiberState.FAILED) return
      restarting = manager.restart('live')
    }, { global: true })
    try {
      await settings!.update('mcp', { servers: { missing: stdioEntry({ env: { TOKEN: '${credential:MCP_SPEC_ABSENT_PROVIDER}' } }) } })
      await closing.promise
      await settings!.replace('mcp', { servers: { live: stdioEntry() } })
      gate.resolve()
      await restarting
      await vi.waitFor(() => { expect(manager.list().map(server => server.name)).toEqual(['live']) })
      expect(events.some(event => event.name === 'missing' && event.status.state === 'failed')).toBe(false)
    } finally {
      gate.resolve()
      await restarting
    }
  })

  it('cancels an active probe before manager disposal waits for it', async () => {
    const { manager, managerFiber } = await mountWorld({
      settingsDoc: { mcp: { servers: { off: stdioEntry({ enabled: false }) } } },
    })
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementationOnce(() => { entered.resolve(); return gate.promise })
    mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
      gate.reject(new Error('probe closed'))
      await this.transport?.close()
    })
    const probing = manager.probe('off')
    try {
      await entered.promise
      await managerFiber.dispose()
      expect(await probing).toMatchObject({ ok: false, message: 'probe aborted', closeConfirmed: true })
      await expect(manager.probe('off')).rejects.toThrow('disposed')
    } finally {
      gate.resolve()
      await probing
    }
  })

  it.each(['removed configuration', 'failed probe cleanup'] as const)('settles failed startup alongside %s during credential resolution', async (action) => {
    const { ctx, manager, settings, credentials, events } = await mountWorld({ withCredentials: true })
    await applyMcpClient(ctx, ClientConfig({ transport: 'stdio', serverName: 'dup', command: 'static' }))
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const resolution = gate.promise.then(() => ({ value: 'token', source: 'memory' }))
    vi.spyOn(credentials!, 'resolve').mockImplementationOnce(() => {
      entered.resolve()
      return resolution
    })
    let probing: ReturnType<McpServerManager['probe']> | undefined
    const detach = ctx.on('mcp-manager/status', (name, status) => {
      if (name === 'dup' && status.state === 'connecting') probing = manager.probe(name)
    })
    vi.useFakeTimers()
    try {
      await settings!.update('mcp', { servers: { dup: stdioEntry({ env: { TOKEN: '${credential:MCP_SPEC_COLLISION}' }, closeTimeoutMs: 50 }) } })
      await entered.promise
      if (action === 'removed configuration') {
        await settings!.replace('mcp', {})
        gate.resolve()
        expect(await probing).toMatchObject({ ok: false, closeConfirmed: true })
        await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
        expect(events.some(event => event.name === 'dup' && event.status.state === 'failed')).toBe(false)
      } else {
        await vi.advanceTimersByTimeAsync(51)
        expect(await probing).toMatchObject({ ok: false, closeConfirmed: true, cleanupError: containing('MCP cleanup did not settle') })
        await waitForState(manager, 'dup', 'failed')
        expect(manager.list()[0]!.status).toMatchObject({ state: 'failed', reason: 'cleanup' })
      }
      expect(ctx.tools.get('mcp__dup__remote')).toBeDefined()
    } finally {
      detach()
      gate.resolve()
      await resolution
      await probing
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it.each(['newer configuration', 'disposal'] as const)('does not mount a stale configuration after %s overtakes cleanup', async (action) => {
    const { manager, settings, managerFiber } = await mountWorld({
      settingsDoc: { mcp: { servers: { srv: stdioEntry() } } },
    })
    await waitForState(manager, 'srv', 'connected')
    const closing: PromiseWithResolvers<void> = Promise.withResolvers()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
      closing.resolve()
      await gate.promise
      await this.transport?.close()
    })
    try {
      await settings!.update('mcp', { servers: { srv: { command: 'stale' } } })
      await closing.promise
      await expect(manager.probe('srv')).rejects.toThrow('changing')
      if (action === 'newer configuration') {
        await settings!.update('mcp', { servers: { srv: { command: 'latest', closeTimeoutMs: 900 } } })
        gate.resolve()
        await vi.waitFor(() => { expect(transportConfigs.map(config => config.command)).toEqual(['echo', 'latest']) })
        await waitForState(manager, 'srv', 'connected')
      } else {
        const disposing = managerFiber.dispose()
        gate.resolve()
        await disposing
        expect(transportConfigs.map(config => config.command)).toEqual(['echo'])
      }
    } finally {
      gate.resolve()
    }
  })

  it.each(['throws', 'rejects'] as const)('notifies later status listeners and completes the lifecycle when a listener %s', async (failureMode) => {
    const { ctx, manager, settings } = await mountWorld({
      settingsDoc: { mcp: { servers: { srv: stdioEntry() } } },
    })
    await waitForState(manager, 'srv', 'connected')
    const failure = new Error('listener bomb')
    const logError = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { logError.mockRestore() })
    ctx.on('mcp-manager/status', () => {
      if (failureMode === 'throws') throw failure
      return Promise.reject(failure)
    })
    const laterEvents: Array<{ name: string; status: McpManagedServerStatus }> = []
    ctx.on('mcp-manager/status', (name, status) => { laterEvents.push({ name, status }) })
    await settings!.update('mcp', { servers: { srv: { enabled: false } } })
    await waitForState(manager, 'srv', 'disabled')
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(laterEvents).toContainEqual({ name: 'srv', status: { state: 'disabled' } })
    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith('mcp-manager: a mcp-manager/status listener failed for "srv"')
      expect(logError).toHaveBeenCalledWith(expect.objectContaining({ errors: [failure] }))
    })
  })

  it('unwinds every instance and its tools when the manager is disposed, then refuses operations', async () => {
    const { ctx, manager, managerFiber } = await mountWorld({
      settingsDoc: { mcp: { servers: { one: stdioEntry(), two: stdioEntry({ command: 'two' }) } } },
    })
    await waitForState(manager, 'one', 'connected')
    await waitForState(manager, 'two', 'connected')
    await managerFiber.dispose()
    expect(ctx.tools.get('mcp__one__remote')).toBeUndefined()
    expect(ctx.tools.get('mcp__two__remote')).toBeUndefined()
    await expect(manager.restart('one')).rejects.toThrow(/disposed/)
  })

  it('aborts a mount whose entry was removed while its templates resolved', async () => {
    const { ctx, manager, settings, credentials, events } = await mountWorld({
      withCredentials: true,
      settingsDoc: {},
    })
    // Credential value present but stored directly, so no rotation event fires;
    // the gate holds the mount inside its template resolution.
    credentials!.values.set('MCP_SPEC_FLEETING', 'value')
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    credentials!.resolveGate = gate.promise
    await settings!.update('mcp', {
      servers: { fleeting: { transport: 'streamable-http', url: 'http://localhost:1', headers: { Authorization: '${credential:MCP_SPEC_FLEETING}' } } },
    })
    await vi.waitFor(() => {
      expect(events.some(event => event.name === 'fleeting' && event.status.state === 'connecting')).toBe(true)
    })
    await settings!.replace('mcp', {})
    gate.resolve()
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
    expect(mockConnect).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__fleeting__remote')).toBeUndefined()
  })

  it('skips stale activation callbacks and late connection events for a removed server', async () => {
    const { ctx, manager, settings, events } = await mountWorld({
      settingsDoc: { mcp: { servers: { racy: stdioEntry() } } },
    })
    await waitForState(manager, 'racy', 'connected')

    // Remove the entry, then fire a transport close BEFORE the reconcile
    // unmounts: the cell publishes, and the manager must swallow it — the
    // event contract only covers configured entries.
    const detach = ctx.on('loader/volatile-update', () => { instances.at(-1)!.onclose?.() }, { global: true })
    await settings!.replace('mcp', {})
    detach()
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__racy__remote')).toBeUndefined() })
    expect(events.filter(event => event.name === 'racy' && event.status.state === 'reconnecting')).toEqual([])
  })

  it('discards a starting instance whose entry is removed before activation settles', async () => {
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => gate.promise)
    const { ctx, manager, settings, events } = await mountWorld({
      settingsDoc: { mcp: { servers: { starting: stdioEntry() } } },
    })
    await vi.waitFor(() => { expect(instances.length).toBe(1) })
    await settings!.replace('mcp', {})
    gate.resolve()
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
    expect(ctx.tools.get('mcp__starting__remote')).toBeUndefined()
    expect(events.filter(event => event.name === 'starting' && event.status.state === 'connected')).toEqual([])
  })

  it('lets a credential rebuild find its entry gone once the unmount completes', async () => {
    const closeGate: PromiseWithResolvers<void> = Promise.withResolvers()
    const { manager, settings, credentials } = await mountWorld({
      withCredentials: true,
      settingsDoc: {
        mcp: { servers: { vanishing: { transport: 'streamable-http', url: 'http://localhost:1', headers: { Authorization: '${credential:MCP_SPEC_VANISH}' } } } },
      },
    })
    // Let the boot mount settle as a resolve failure before the credential
    // exists, so the healing rebuild below is the only mount in flight.
    await waitForState(manager, 'vanishing', 'waiting-credentials')
    await credentials!.set(credentialRef('MCP_SPEC_VANISH'), 'value')
    await waitForState(manager, 'vanishing', 'connected')
    const clientsBefore = instances.length

    // Rotation queues a rebuild whose unmount blocks on the slow close…
    mockClose.mockImplementation(async function (this: InstanceType<typeof MockClient>) {
      await this.transport?.close()
      await closeGate.promise
    })
    await credentials!.set(credentialRef('MCP_SPEC_VANISH'), 'rotated')
    // …and the entry is deleted while that unmount is still in flight.
    await settings!.replace('mcp', {})
    closeGate.resolve()
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
    // The rebuild found its entry gone: no client was minted after the delete.
    expect(instances.length).toBe(clientsBefore)
  })

  it('contains a queued reconcile that loses to disposal, logging the operation', async () => {
    const { ctx, manager, settings, credentials, managerFiber, events } = await mountWorld({
      withCredentials: true,
      settingsDoc: {
        mcp: { servers: { gated: { transport: 'streamable-http', url: 'http://localhost:1', headers: { Authorization: '${credential:MCP_SPEC_GATE}' } } } },
      },
    })
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    await credentials!.set(credentialRef('MCP_SPEC_GATE'), 'value')
    await waitForState(manager, 'gated', 'connected')
    const failures = events.filter(event => event.status.state === 'failed').length

    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const closing: PromiseWithResolvers<void> = Promise.withResolvers()
    mockClose.mockImplementationOnce(async function (this: InstanceType<typeof MockClient>) {
      closing.resolve()
      await gate.promise
      await this.transport?.close()
    })
    const restarting = manager.restart('gated')
    await closing.promise
    await settings!.update('mcp', { servers: { gated: { toolCallTimeoutMs: 5_000 } } })
    const disposing = managerFiber.dispose()
    gate.resolve()
    await restarting
    await disposing
    expect(events.filter(event => event.status.state === 'failed')).toHaveLength(failures)
    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('config reconcile failed'))).toBe(true)
    })
  })

  it('mounts a registered server for its plugin lifetime and awaits its unmount on disposal', async () => {
    const { ctx, manager } = await mountWorld({ managerConfig: { servers: { base: stdioEntry() } }, withSettings: false })
    const registrar = ctx.plugin({
      name: 'registrar',
      inject: ['mcpManager'],
      apply(child: Context) { child.mcpManager.register('app', { transport: 'stdio', command: 'echo' }) },
    })
    await registrar.await()
    await waitForState(manager, 'app', 'connected')
    expect(manager.list().map(view => [view.name, view.configured])).toEqual([['base', true], ['app', true]])
    expect(ctx.tools.get('mcp__app__remote')).toBeDefined()
    await registrar.dispose()
    expect(ctx.tools.get('mcp__app__remote')).toBeUndefined()
    expect(manager.list().map(view => view.name)).toEqual(['base'])
  })

  it('rejects a registration that takes a configured or registered name or carries an invalid entry', async () => {
    const { manager } = await mountWorld({ managerConfig: { servers: { base: stdioEntry() } }, withSettings: false })
    expect(() => manager.register('base', { transport: 'stdio', command: 'echo' })).toThrow('already configured or registered')
    const dispose = manager.register('app', { transport: 'stdio', command: 'echo' })
    expect(() => manager.register('app', { transport: 'stdio', command: 'echo' })).toThrow('already configured or registered')
    expect(() => manager.register('bare', { transport: 'stdio' })).toThrow('requires "command"')
    expect(() => manager.register('bad name', { transport: 'stdio', command: 'echo' })).toThrow('server name must match')
    dispose()
    dispose()
    await vi.waitFor(() => { expect(manager.list().map(view => view.name)).toEqual(['base']) })
  })

  it('refuses a settings entry that takes a registered name', async () => {
    const { manager, settings } = await mountWorld()
    manager.register('app', { transport: 'stdio', command: 'echo' })
    await expect(settings!.update('mcp', { servers: { app: stdioEntry() } })).rejects.toThrow('a plugin already registers this server name')
  })

  it('restarts and probes a registered server through its Remote operations', async () => {
    const { manager } = await mountWorld({ withSettings: false })
    manager.register('app', { transport: 'stdio', command: 'echo' })
    await waitForState(manager, 'app', 'connected')
    const clients = instances.length
    await manager.restart('app')
    await waitForState(manager, 'app', 'connected')
    expect(instances.length).toBe(clients + 1)
    await expect(manager.probeFromClient('app', new AbortController().signal)).resolves.toMatchObject({ ok: true, toolNames: ['remote'] })
  })

  it('leaves unmounting to a stopped manager when a registration ends after disposal', async () => {
    const { ctx, manager, managerFiber } = await mountWorld({ withSettings: false })
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    const dispose = manager.register('app', { transport: 'stdio', command: 'echo' })
    await waitForState(manager, 'app', 'connected')
    await managerFiber.dispose()
    dispose()
    expect(() => manager.register('late', { transport: 'stdio', command: 'echo' })).toThrow('the manager is disposed')
    expect(errors).toEqual([])
  })

  it('streams the server list on subscription and after each change until the subscriber aborts', async () => {
    const { manager, settings } = await mountWorld()
    const subscriber = new AbortController()
    const stream = manager.watch(subscriber.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toEqual([])
    await settings!.update('mcp', { servers: { srv: stdioEntry() } })
    let views: unknown
    await vi.waitFor(async () => {
      views = (await stream.next()).value
      expect(views).toEqual([{ name: 'srv', configured: true, status: expect.objectContaining({ state: 'connected' }) as McpManagedServerStatus }])
    })
    subscriber.abort()
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(manager.watch(AbortSignal.abort())[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('ends a waiting stream when the manager is disposed', async () => {
    const { manager, managerFiber } = await mountWorld({ withSettings: false })
    const stream = manager.watch(new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    const waiting = stream.next()
    await managerFiber.dispose()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
  })
})

describe('entry schema bounds', () => {
  it.each([
    [{ startupTimeoutMs: 0 }],
    [{ startupTimeoutMs: -5 }],
  ])('refuses %j at the write instead of at mount', (patch) => {
    expect(() => {
      McpServerManager.Config({ servers: { a: { transport: 'stdio', command: 'echo', ...patch } } })
    }).toThrow()
  })

  it('accepts in-bounds overrides', () => {
    expect(() => {
      McpServerManager.Config({ servers: { a: { transport: 'stdio', command: 'echo', startupTimeoutMs: 5_000 } } })
    }).not.toThrow()
  })
})

describe('entry validation at construction', () => {
  const base = (servers: Record<string, unknown>): Config =>
    McpServerManager.Config({ servers } as Parameters<typeof McpServerManager.Config>[0])

  it('lists configured entries by their enablement before the first reconcile publishes status', () => {
    const manager = new McpServerManager(new Context(), base({
      on: { transport: 'stdio', command: 'echo', enabled: true },
      off: { transport: 'stdio', command: 'echo', enabled: false },
    }))
    expect(manager.list().map(view => view.status)).toEqual([{ state: 'connecting', attempt: 0 }, { state: 'disabled' }])
  })

  it('rejects ${env:…} templates and names the credential syntax', () => {
    expect(() => {
      new McpServerManager(new Context(), base({ a: { transport: 'stdio', command: 'echo', env: { K: '${env:K}' } } }))
    }).toThrow('use ${credential:REF}')
  })

  it('accepts a well-formed stdio and streamable-http pair', () => {
    expect(() => {
      new McpServerManager(new Context(), base({
        local: { transport: 'stdio', command: 'echo', url: '', args: [], env: {}, cwd: '', headers: {}, enabled: true },
        remote: { transport: 'streamable-http', url: 'http://localhost:1', command: '', args: [], env: {}, cwd: '', headers: {}, enabled: true },
      }))
    }).not.toThrow()
  })

  it.each([
    [{ 'bad name!': { transport: 'stdio', command: 'x', url: '', args: [], env: {}, cwd: '', headers: {}, enabled: true } }, /server name must match/],
    [{ a: { transport: 'stdio', command: '', url: '', args: [], env: {}, cwd: '', headers: {}, enabled: true } }, /requires "command"/],
    [{ a: { transport: 'stdio', command: 'x', url: 'http://x', args: [], env: {}, cwd: '', headers: {}, enabled: true } }, /"url" is not a stdio field/],
    [{ a: { transport: 'stdio', command: 'x', url: '', args: [], env: {}, cwd: '', headers: { h: 'v' }, enabled: true } }, /"headers" is not a stdio field/],
    [{ a: { transport: 'streamable-http', url: '', command: '', args: [], env: {}, cwd: '', headers: {}, enabled: true } }, /requires "url"/],
    [{ a: { transport: 'streamable-http', url: 'http://x', command: 'x', args: [], env: {}, cwd: '', headers: {}, enabled: true } }, /"command" is not a streamable-http field/],
    [{ a: { transport: 'streamable-http', url: 'http://x', command: '', args: ['x'], env: {}, cwd: '', headers: {}, enabled: true } }, /"args" is not a streamable-http field/],
    [{ a: { transport: 'streamable-http', url: 'http://x', command: '', args: [], env: { k: 'v' }, cwd: '', headers: {}, enabled: true } }, /"env" is not a streamable-http field/],
    [{ a: { transport: 'streamable-http', url: 'http://x', command: '', args: [], env: {}, cwd: '/tmp', headers: {}, enabled: true } }, /"cwd" is not a streamable-http field/],
    [{ a: { transport: 'stdio', command: 'x', url: '', args: [], env: { k: '${vault:nope}' }, cwd: '', headers: {}, enabled: true } }, /not a template token/],
    // A nested `${` merely CONTAINS a valid token; the resolver would leave
    // its prefix behind as a literal, so the write must refuse it.
    [{ a: { transport: 'stdio', command: '${x${credential:A}', url: '', args: [], env: {}, cwd: '', headers: {}, enabled: true } }, /not a template token/],
    [{ a: { transport: 'stdio', command: 'x', url: '', args: [], env: {}, cwd: '', headers: {}, enabled: true, reconnect: { enabled: true, initialDelayMs: 5_000, maxDelayMs: 100, maxAttempts: 3 } } }, /initialDelayMs must be less than or equal to maxDelayMs/],
  ])('rejects %j', (servers, expected) => {
    expect(() => {
      new McpServerManager(new Context(), base(servers))
    }).toThrow(expected)
  })
})
