/**
 * Tests for the MCP server manager: entry-config fallback, settings-driven
 * reconciliation (add / change / disable / delete), restart, template
 * resolution over env and credentials, rotation-driven rebuilds, status
 * aggregation and events, and teardown unwinding every child instance.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

const { mockConnect, mockClose, mockListTools, MockClient, instances, transportConfigs } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    ping = (): Promise<void> => Promise.resolve()
    close = mockClose
    request = mockRequest
    getServerVersion = (): { name: string; version: string } => ({ name: 'fixture', version: '1.0.0' })
    setNotificationHandler = vi.fn()
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  const transportConfigs: Array<Record<string, unknown>> = []
  return { mockConnect, mockClose, mockListTools, MockClient, instances, transportConfigs }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  // Constructible mock: `new` on an arrow-implemented vi.fn throws.
  StdioClientTransport: vi.fn(function (config: Record<string, unknown>) { transportConfigs.push(config); return {} }),
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(function (url: URL, options: Record<string, unknown>) {
    transportConfigs.push({ url: url.href, ...options })
    return {}
  }),
}))

import { apply as applyMcpClient } from '@deepseek-ai/dsh-mcp-client'
import McpServerManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import type { Config, McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import { MemorySettings } from './memory-settings.ts'

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
  settings: MemorySettings | undefined
  credentials: MemoryCredentials | undefined
  events: Array<{ name: string; status: McpManagedServerStatus }>
  managerFiber: { dispose(): Promise<void> }
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let settings: MemorySettings | undefined
  if (options?.withSettings !== false) {
    await ctx.plugin(MemorySettings, { doc: options?.settingsDoc ?? {} })
    settings = ctx.get('settings') as MemorySettings
  }
  let credentials: MemoryCredentials | undefined
  if (options?.withCredentials === true) {
    await ctx.plugin(MemoryCredentials)
    credentials = ctx.get('credentials') as MemoryCredentials
  }
  const events: Array<{ name: string; status: McpManagedServerStatus }> = []
  ctx.on('mcp-manager/status', (name, status) => { events.push({ name, status }) })
  const managerFiber = ctx.plugin(McpServerManager, options?.managerConfig ?? {})
  await managerFiber
  const manager = ctx.get('mcpServers')!
  return { ctx, manager, settings, credentials, events, managerFiber: managerFiber as unknown as { dispose(): Promise<void> } }
}

async function waitForState(manager: McpServerManager, name: string, state: string): Promise<void> {
  await vi.waitFor(() => {
    const view = manager.list().find(entry => entry.name === name)
    expect(view?.status.state).toBe(state)
  })
}

describe('mcp-manager', () => {
  let restoreEnv: Array<() => void> = []

  beforeEach(() => {
    vi.clearAllMocks()
    instances.length = 0
    transportConfigs.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
  })

  afterEach(() => {
    for (const restore of restoreEnv) restore()
    restoreEnv = []
  })

  function setEnv(name: string, value: string): void {
    const previous = process.env[name]
    process.env[name] = value
    restoreEnv.push(() => {
      if (previous === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = previous
    })
  }

  it('mounts composition-base servers without any settings provider', async () => {
    const { ctx, manager } = await mountWorld({
      withSettings: false,
      managerConfig: { servers: { base: stdioEntry() } },
    })
    await waitForState(manager, 'base', 'connected')
    expect(ctx.tools.get('mcp__base__remote')).toBeDefined()
    expect(manager.list()).toEqual([{
      name: 'base',
      transport: 'stdio',
      enabled: true,
      deletable: false,
      status: { state: 'connected', toolCount: 1, connectedAt: anyNumber },
    }])
  })

  it('mounts servers from the settings user layer and reports them deletable', async () => {
    const { ctx, manager } = await mountWorld({
      settingsDoc: { mcp: { servers: { added: stdioEntry() } } },
    })
    await waitForState(manager, 'added', 'connected')
    expect(ctx.tools.get('mcp__added__remote')).toBeDefined()
    expect(manager.list()[0]).toMatchObject({ name: 'added', deletable: true })
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
        alpha: { args: ['--fast'], toolCallTimeoutMs: 5_000, startupTimeoutMs: 4_000, healthCheckIntervalMs: 60_000, reconnect: { maxAttempts: 3 } },
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
    expect(manager.list()[0]).toMatchObject({ name: 'toggled', enabled: false, status: { state: 'disabled' } })

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

    settings!.pushExternal({ mcp: { servers: {} } })
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

  it('resolves env templates into the child environment and fails loud on a missing variable', async () => {
    setEnv('MCP_MANAGER_SPEC_VALUE', 'resolved-secret')
    const { manager, settings } = await mountWorld({
      settingsDoc: {
        mcp: {
          servers: {
            templated: stdioEntry({ env: { PASSTHROUGH: 'literal', SECRET: '${env:MCP_MANAGER_SPEC_VALUE}' } }),
          },
        },
      },
    })
    await waitForState(manager, 'templated', 'connected')
    expect(transportConfigs.at(-1)!['env']).toMatchObject({ PASSTHROUGH: 'literal', SECRET: 'resolved-secret' })

    await settings!.update('mcp', { servers: { templated: { env: { SECRET: '${env:MCP_MANAGER_SPEC_ABSENT}' } } } })
    await waitForState(manager, 'templated', 'failed')
    const view = manager.list()[0]!
    expect(view.status).toMatchObject({
      state: 'failed',
      reason: 'resolve',
      lastError: containing('MCP_MANAGER_SPEC_ABSENT'),
    })
  })

  it('resolves credential templates and rebuilds the instance when the credential rotates', async () => {
    const { manager, credentials } = await mountWorld({
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
    const clientsBefore = instances.length

    await credentials!.set(credentialRef('MCP_SPEC_TOKEN'), 'second-token')
    await vi.waitFor(() => {
      expect(transportConfigs.at(-1)).toMatchObject({ requestInit: { headers: { Authorization: 'Bearer second-token' } } })
    })
    expect(instances.length).toBe(clientsBefore + 1)
    // An unrelated credential rotation rebuilds nothing, and the disabled
    // sibling referencing the same credential never mounted.
    await credentials!.set(credentialRef('MCP_SPEC_UNRELATED'), 'noise')
    await manager.restart('remote')
    expect(instances.length).toBe(clientsBefore + 2)
    expect(manager.list().find(view => view.name === 'dormant')!.status).toEqual({ state: 'disabled' })
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
      reason: 'resolve',
      lastError: containing('credential seam'),
    })
  })

  it('reports a load failure when the serverName collides with a static instance', async () => {
    const { ctx, manager } = await mountWorld({ withSettings: false, managerConfig: {} })
    await applyMcpClient(ctx, {
      transport: 'stdio',
      serverName: 'dup',
      command: 'echo',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 60_000,
      startupTimeoutMs: 30_000,
      healthCheckIntervalMs: 30_000,
      failOnStartupError: false,
    })
    // The manager learns about "dup" only now, through a live settings attach.
    await ctx.plugin(MemorySettings, { doc: { mcp: { servers: { dup: stdioEntry() } } } })
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

  it('contains a throwing status listener so the lifecycle operation completes', async () => {
    const { ctx, manager, settings } = await mountWorld({
      settingsDoc: { mcp: { servers: { srv: stdioEntry() } } },
    })
    await waitForState(manager, 'srv', 'connected')
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    ctx.on('mcp-manager/status', () => {
      throw new Error('listener bomb')
    })
    await settings!.update('mcp', { servers: { srv: { enabled: false } } })
    await waitForState(manager, 'srv', 'disabled')
    expect(errors.some(line => line.includes('mcp-manager/status listener failed'))).toBe(true)
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
    settings!.pushExternal({ mcp: { servers: {} } })
    gate.resolve()
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
    // Nothing mounted for the removed entry: no instance, no tools.
    expect(instances.length).toBe(0)
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
    settings!.pushExternal({ mcp: { servers: {} } })
    instances.at(-1)!.onclose?.()
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
    settings!.pushExternal({ mcp: { servers: {} } })
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
    gate.resolve()
    // The activation continuation finds its record gone and publishes nothing.
    await new Promise(resolve => setTimeout(resolve, 20))
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
    await waitForState(manager, 'vanishing', 'failed')
    await credentials!.set(credentialRef('MCP_SPEC_VANISH'), 'value')
    await waitForState(manager, 'vanishing', 'connected')
    const clientsBefore = instances.length

    // Rotation queues a rebuild whose unmount blocks on the slow close…
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return closeGate.promise
    })
    await credentials!.set(credentialRef('MCP_SPEC_VANISH'), 'rotated')
    // …and the entry is deleted while that unmount is still in flight.
    settings!.pushExternal({ mcp: { servers: {} } })
    closeGate.resolve()
    await vi.waitFor(() => { expect(manager.list()).toEqual([]) })
    // The rebuild found its entry gone: no client was minted after the delete.
    expect(instances.length).toBe(clientsBefore)
  })

  it('contains a queued reconcile that loses to disposal, logging the operation', async () => {
    const { ctx, manager, settings, credentials, managerFiber } = await mountWorld({
      withCredentials: true,
      settingsDoc: {
        mcp: { servers: { gated: { transport: 'streamable-http', url: 'http://localhost:1', headers: { Authorization: '${credential:MCP_SPEC_GATE}' } } } },
      },
    })
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    await credentials!.set(credentialRef('MCP_SPEC_GATE'), 'value')
    await waitForState(manager, 'gated', 'connected')

    // Hold the tail open inside a restart's template resolution…
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    credentials!.resolveGate = gate.promise
    const restarting = manager.restart('gated')
    // …queue a settings reconcile behind it, then dispose the manager.
    await settings!.update('mcp', { servers: { gated: { toolCallTimeoutMs: 5_000 } } })
    const disposing = managerFiber.dispose()
    gate.resolve()
    await restarting
    await disposing
    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('settings reconcile failed'))).toBe(true)
    })
  })
})

describe('entry schema bounds', () => {
  it.each([
    [{ startupTimeoutMs: 0 }],
    [{ startupTimeoutMs: -5 }],
    [{ healthCheckIntervalMs: 500 }],
  ])('refuses %j at the write instead of at mount', (patch) => {
    expect(() => {
      McpServerManager.Config({ servers: { a: { transport: 'stdio', command: 'echo', ...patch } } })
    }).toThrow()
  })

  it('accepts in-bounds overrides', () => {
    expect(() => {
      McpServerManager.Config({ servers: { a: { transport: 'stdio', command: 'echo', startupTimeoutMs: 5_000, healthCheckIntervalMs: 15_000 } } })
    }).not.toThrow()
  })
})

describe('entry validation at construction', () => {
  const base = (servers: Record<string, unknown>): Config => ({ servers }) as Config

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
    [{ a: { transport: 'stdio', command: '${x${env:A}', url: '', args: [], env: {}, cwd: '', headers: {}, enabled: true } }, /not a template token/],
    [{ a: { transport: 'stdio', command: 'x', url: '', args: [], env: {}, cwd: '', headers: {}, enabled: true, reconnect: { enabled: true, initialDelayMs: 5_000, maxDelayMs: 100, maxAttempts: 3 } } }, /initialDelayMs must be less than or equal to maxDelayMs/],
  ])('rejects %j', (servers, expected) => {
    expect(() => {
      new McpServerManager(new Context(), base(servers))
    }).toThrow(expected)
  })
})
