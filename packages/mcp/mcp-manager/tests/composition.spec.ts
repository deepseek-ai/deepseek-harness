/**
 * Real profile composition: the `servers` dictionary through Settings, and server rows through the Loader, the
 * profile patch watcher, and ConfigEditor.
 */
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Transport } from '@modelcontextprotocol/client'
import { readFile, writeFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { auditStartupEntries } from '@deepseek-ai/dsh-app-boot'
import Hmr from '@deepseek-ai/dsh-hmr'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { NativeToolRegistry } from '@deepseek-ai/dsh-tools/pipeline'
import { managerProfile, profileRow, serverRow } from './profile-fixture.ts'

const { MockClient, MockTransport, clients, stdioConfigs } = vi.hoisted(() => {
  /** Every client a server mount constructed, in order. */
  const clients: unknown[] = []
  /** The stdio transport config of every server mount, in order. */
  const stdioConfigs: unknown[] = []
  class MockTransport {
    onclose?: () => void
    start = async () => {}
    send = async () => {}
    close = async () => { this.onclose?.() }
  }
  class MockClient {
    transport: Transport | undefined
    onclose: (() => void) | undefined
    constructor() { clients.push(this) }
    connect = vi.fn(async (transport: Transport) => {
      this.transport = transport
      const onclose = transport.onclose
      transport.onclose = () => { onclose?.(); this.onclose?.() }
      await transport.start()
    })
    getProtocolEra = () => 'legacy' as const
    ping = async () => {}
    close = vi.fn(async () => { await this.transport?.close() })
    listTools = vi.fn(async () => ({ tools: [{ name: 'remote', inputSchema: { type: 'object' } }], nextCursor: undefined }))
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
    listResources = async () => ({ resources: [] })
    getServerVersion = (): { name: string; version: string } => ({ name: 'fixture', version: '1.0.0' })
  }
  return { MockClient, MockTransport, clients, stdioConfigs }
})

vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(function () { return new MockTransport() }),
}))
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function (config: unknown) {
    stdioConfigs.push(config)
    return new MockTransport()
  }),
}))

const stdio = { transport: 'stdio', command: 'echo' }

async function registry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.setRoot(new NativeToolRegistry())
  return ctx
}

/** Start the profile patch watcher the product starts once the application is ready. */
async function watchProfile(ctx: Context): Promise<void> {
  ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await ctx.hmr.runExclusive(async () => {})
}

/** The warning the startup audit writes for rows that did not activate; `''` when every row runs. */
async function startupWarning(ctx: Context): Promise<string> {
  const warnings: string[] = []
  await auditStartupEntries(ctx, 'dsh', line => warnings.push(line))
  return warnings.join('')
}

const names = (ctx: Context): string[] => ctx.mcpManager.list().map(view => view.name).sort()

beforeEach(() => {
  clients.length = 0
  stdioConfigs.length = 0
})

describe('mcp-manager real composition', () => {
  it('boots inherited servers, hot-adds a server from the profile patch, and restores saved edits', async () => {
    const ctx = await registry()
    const id = 'managed-mcp'
    const { profile, entry, start } = await managerProfile(ctx, {
      id, base: { servers: { base: { transport: 'stdio', command: 'echo' } } },
    })
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__base__remote')).toBeDefined() })
    const manager = ctx.mcpManager
    const fiber = entry.fiber
    expect(manager.list()).toHaveLength(1)

    await writeFile(profile.patchPath, JSON.stringify([{ id, config: {
      servers: { base: { transport: 'stdio', command: 'echo' }, added: { transport: 'stdio', command: 'echo' } },
    } }]))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__added__remote')).toBeDefined() }, { timeout: 5_000 })
    expect(entry.fiber).toBe(fiber)
    expect(manager.list().map(view => view.name).sort()).toEqual(['added', 'base'])
    expect(manager.list().find(view => view.name === 'added')).toMatchObject({ configured: true })
    expect(manager.list().find(view => view.name === 'base')).toMatchObject({ configured: true })

    const revision = ctx.settings.describe().find(row => row.ns === id)!.revision
    await ctx.settings.update(id, { servers: { base: { enabled: false } } }, revision)
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__base__remote')).toBeUndefined() })
    await expect(ctx.settings.update(id, { servers: { base: { enabled: true } } }, revision)).rejects.toThrow('changed since it was read')
    await ctx.fiber.dispose()
    const restored = await registry()
    await start(restored)
    await vi.waitFor(() => { expect(restored.tools.get('mcp__added__remote')).toBeDefined() })
    expect(restored.mcpManager.list().find(view => view.name === 'base')).toMatchObject({ configured: true, status: { state: 'disabled' } })
    await restored.settings.mutate(id, [{ op: 'unset', path: ['servers', 'base'] }])
    await vi.waitFor(() => { expect(restored.tools.get('mcp__base__remote')).toBeDefined() })
    await restored.settings.mutate(id, [{ op: 'unset', path: ['servers', 'added'] }])
    await vi.waitFor(() => { expect(restored.mcpManager.list().map(view => view.name)).toEqual(['base']) })
  })

  it('rejects invalid server edits before persistence', async () => {
    const ctx = await registry()
    const { profile, entry } = await managerProfile(ctx, {
      base: { servers: { base: { transport: 'stdio', command: 'echo' } } },
    })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__base__remote')).toBeDefined() })
    const saved = await readFile(profile.patchPath, 'utf8')
    const fiber = entry.fiber!
    for (const patch of [{ command: '' }, { headers: { invalid: 'stdio' } }, { command: '${vault:INVALID}' }]) {
      await expect(ctx.settings.update('mcp', { servers: { base: patch } })).rejects.toThrow()
      expect(await readFile(profile.patchPath, 'utf8')).toBe(saved)
    }
    expect(entry.fiber).toBe(fiber)
    expect(ctx.tools.get('mcp__base__remote')).toBeDefined()
  })

  it('rejects OAuth on stdio, mixed Authorization headers, invalid keys, and keys shared with disabled entries before persistence', async () => {
    const ctx = await registry()
    const { profile } = await managerProfile(ctx, { base: { servers: {} } })
    const saved = await readFile(profile.patchPath, 'utf8')
    const oauth = { credentialKey: 'mcp-client/shared' }
    const http = { transport: 'streamable-http', url: 'https://example.invalid/mcp', oauth, enabled: false }
    for (const servers of [
      { one: { transport: 'stdio', command: 'echo', oauth } },
      { one: { ...http, headers: { AUTHORIZATION: 'private' } } },
      { one: { ...http, oauth: { credentialKey: 'invalid' } } },
      { one: { ...http, oauth: { credentialKey: 'deepseek-account-platform/default' } } },
      { one: http, two: http },
    ]) {
      await expect(ctx.settings.update('mcp', { servers })).rejects.toThrow()
      expect(await readFile(profile.patchPath, 'utf8')).toBe(saved)
      expect(ctx.mcpManager.list()).toEqual([])
    }
  })

  it('names the OAuth credentialKey field when a settings write supplies an invalid mcp-client key', async () => {
    const ctx = await registry()
    const { profile } = await managerProfile(ctx, { base: { servers: {} } })
    const saved = await readFile(profile.patchPath, 'utf8')
    await expect(ctx.settings.update('mcp', { servers: { one: {
      transport: 'streamable-http', url: 'https://example.invalid/mcp', oauth: { credentialKey: 'mcp-client/Foo' }, enabled: false,
    } } })).rejects.toThrow('servers.one.oauth.credentialKey: credential key segment "Foo" must match')
    expect(await readFile(profile.patchPath, 'utf8')).toBe(saved)
    expect(ctx.mcpManager.list()).toEqual([])
  })

  it('names the oauth field when a settings write supplies an OAuth configuration without a credential key', async () => {
    const ctx = await registry()
    const { profile } = await managerProfile(ctx, { base: { servers: {} } })
    const saved = await readFile(profile.patchPath, 'utf8')
    await expect(ctx.settings.update('mcp', { servers: { one: {
      transport: 'streamable-http', url: 'https://example.invalid/mcp', oauth: {}, enabled: false,
    } } })).rejects.toThrow('servers.one.oauth expected')
    expect(await readFile(profile.patchPath, 'utf8')).toBe(saved)
  })
})

describe('mcp-manager server rows in a real profile', () => {
  it('boots inherited rows, hot-adds a row from the profile patch, and removes it when the patch stops listing it', async () => {
    const ctx = await registry()
    const { profile } = await managerProfile(ctx, { rows: { base: stdio } })
    await watchProfile(ctx)
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__base__remote')).toBeDefined() })
    expect(await startupWarning(ctx)).toBe('')
    expect(ctx.mcpManager.list()).toMatchObject([{ name: 'base', configured: true, status: { state: 'connected' } }])

    await writeFile(profile.patchPath, JSON.stringify([{ insert: [serverRow('added', stdio)] }]))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__added__remote')).toBeDefined() }, { timeout: 5_000 })
    expect(names(ctx)).toEqual(['added', 'base'])
    expect(ctx.mcpManager.list().find(view => view.name === 'added')).toMatchObject({ configured: true })
    // The manager and the inherited row kept running: only the added server connected.
    expect(clients).toHaveLength(2)

    await writeFile(profile.patchPath, '[]\n')
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__added__remote')).toBeUndefined() }, { timeout: 5_000 })
    expect(names(ctx)).toEqual(['base'])
    expect(ctx.tools.get('mcp__base__remote')).toBeDefined()
    expect(clients).toHaveLength(2)
  })

  it('switches a server off and on through the row\'s disabled field and keeps it off across a restart', async () => {
    const ctx = await registry()
    const { profile, start } = await managerProfile(ctx, { rows: { base: stdio, other: stdio } })
    await watchProfile(ctx)
    await vi.waitFor(() => { expect(names(ctx)).toEqual(['base', 'other']) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__base__remote')).toBeDefined() })

    await writeFile(profile.patchPath, JSON.stringify([{ id: 'mcp-server-base', disabled: true }]))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__base__remote')).toBeUndefined() }, { timeout: 5_000 })
    // A switched-off row is unloaded, so the manager no longer lists its server.
    expect(names(ctx)).toEqual(['other'])
    expect(clients).toHaveLength(2)
    await ctx.fiber.dispose()

    const restored = await registry()
    await start(restored)
    await watchProfile(restored)
    await vi.waitFor(() => { expect(restored.tools.get('mcp__other__remote')).toBeDefined() })
    expect(names(restored)).toEqual(['other'])
    expect(await startupWarning(restored)).toBe('')

    await writeFile(profile.patchPath, '[]\n')
    await vi.waitFor(() => { expect(restored.tools.get('mcp__base__remote')).toBeDefined() }, { timeout: 5_000 })
    expect(names(restored)).toEqual(['base', 'other'])
  })

  it('restarts only the edited row and persists the edit in the profile patch', async () => {
    const ctx = await registry()
    const { profile } = await managerProfile(ctx, { rows: { one: stdio, two: stdio } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__one__remote')).toBeDefined() })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__two__remote')).toBeDefined() })
    const manager = profileRow(ctx, 'mcp').fiber
    expect(clients).toHaveLength(2)

    await ctx.configEditor.edit(profileRow(ctx, 'mcp-server-one'), current => ({ ...current, args: ['--fast'] }))
    await vi.waitFor(() => { expect(stdioConfigs.at(-1)).toMatchObject({ command: 'echo', args: ['--fast'] }) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__one__remote')).toBeDefined() })
    // One new connection: the manager and the sibling row were not restarted.
    expect(clients).toHaveLength(3)
    expect(profileRow(ctx, 'mcp').fiber).toBe(manager)
    expect(ctx.tools.get('mcp__two__remote')).toBeDefined()
    const saved = await readFile(profile.patchPath, 'utf8')
    expect(saved).toContain('mcp-server-one')
    expect(saved).toContain('--fast')
  })

  it('refuses a schema-invalid edit before the write and rolls back an edit the manager refuses', async () => {
    const ctx = await registry()
    const { profile } = await managerProfile(ctx, { rows: { one: stdio } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__one__remote')).toBeDefined() })
    const saved = await readFile(profile.patchPath, 'utf8')
    const row = profileRow(ctx, 'mcp-server-one')

    for (const patch of [{ startupTimeoutMs: 0 }, { enabled: false }]) {
      await expect(ctx.configEditor.edit(row, current => ({ ...current, ...patch }))).rejects.toThrow('invalid config')
      expect(await readFile(profile.patchPath, 'utf8')).toBe(saved)
    }
    // The schema refused the candidates, so the running server was not touched.
    expect(clients).toHaveLength(1)
    expect(ctx.tools.get('mcp__one__remote')).toBeDefined()

    const refused: Array<[Record<string, unknown>, string]> = [
      [{ command: '' }, 'servers.one: a stdio server requires "command"'],
      [{ headers: { invalid: 'stdio' } }, 'servers.one: "headers" is not a stdio field'],
      [{ command: '${vault:INVALID}' }, 'not a template token'],
    ]
    for (const [index, [patch, message]] of refused.entries()) {
      await expect(ctx.configEditor.edit(row, current => ({ ...current, ...patch }))).rejects.toThrow(message)
      expect(await readFile(profile.patchPath, 'utf8')).toBe(saved)
      // The row failed to restart on the refused config; the rollback reconnects the server on the previous one.
      await vi.waitFor(() => { expect(ctx.tools.get('mcp__one__remote')).toBeDefined() })
      expect(clients).toHaveLength(index + 2)
      expect(stdioConfigs.at(-1)).toMatchObject({ command: 'echo' })
    }
    expect(await startupWarning(ctx)).toBe('')
  })

  it('gives Settings the manager\'s dictionary and no form for a server row', async () => {
    const ctx = await registry()
    const { profile } = await managerProfile(ctx, { rows: { one: stdio } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__one__remote')).toBeDefined() })
    const saved = await readFile(profile.patchPath, 'utf8')

    expect(ctx.settings.describe().map(row => row.ns)).toEqual(['mcp'])
    await expect(ctx.settings.update('mcp-server-one', { args: ['--fast'] })).rejects.toThrow('Plugin entry "mcp-server-one" has no volatile fields')
    expect(await readFile(profile.patchPath, 'utf8')).toBe(saved)
    expect(clients).toHaveLength(1)
  })

  it('fails an invalid row alone and starts it once the profile patch corrects it', async () => {
    const ctx = await registry()
    const { profile } = await managerProfile(ctx, { rows: { good: stdio, broken: { transport: 'stdio' } } })
    await watchProfile(ctx)
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__good__remote')).toBeDefined() })
    const warning = await startupWarning(ctx)
    expect(warning).toContain('dsh: warning: 1 entry did not activate\nmcp-server-broken (cordis:mcp-manager-server): ')
    expect(warning).toContain('servers.broken: a stdio server requires "command"')
    expect(names(ctx)).toEqual(['good'])

    await writeFile(profile.patchPath, JSON.stringify([{ id: 'mcp-server-broken', config: { ...stdio, serverName: 'broken' } }]))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__broken__remote')).toBeDefined() }, { timeout: 5_000 })
    expect(names(ctx)).toEqual(['broken', 'good'])
    expect(clients).toHaveLength(2)
    expect(await startupWarning(ctx)).toBe('')
  })

  it('fails the second row that declares a server name already registered', async () => {
    const ctx = await registry()
    await managerProfile(ctx, {
      rows: { dup: stdio },
      patch: [{ insert: [{ ...serverRow('dup', stdio), id: 'mcp-server-dup-again' }] }],
    })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__dup__remote')).toBeDefined() })
    const warning = await startupWarning(ctx)
    expect(warning).toContain('dsh: warning: 1 entry did not activate\nmcp-server-dup-again (cordis:mcp-manager-server): ')
    expect(warning).toContain('mcp-manager: server "dup" is already configured or registered')
    expect(names(ctx)).toEqual(['dup'])
    expect(clients).toHaveLength(1)
  })

  it('lets another row declare the server name of a switched-off row', async () => {
    const ctx = await registry()
    await managerProfile(ctx, {
      rows: { one: stdio },
      patch: [
        { id: 'mcp-server-one', disabled: true },
        { insert: [{ ...serverRow('one', { ...stdio, args: ['--replacement'] }), id: 'mcp-server-one-replacement' }] },
      ],
    })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__one__remote')).toBeDefined() })
    expect(await startupWarning(ctx)).toBe('')
    expect(names(ctx)).toEqual(['one'])
    // The switched-off row never registered: the only connection belongs to the replacement row.
    expect(clients).toHaveLength(1)
    expect(stdioConfigs).toMatchObject([{ command: 'echo', args: ['--replacement'] }])
  })

  it('fails a row that carries the enabled field of a dictionary entry', async () => {
    const ctx = await registry()
    await managerProfile(ctx, { rows: { good: stdio, copied: { ...stdio, enabled: false } } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__good__remote')).toBeDefined() })
    const warning = await startupWarning(ctx)
    expect(warning).toContain('dsh: warning: 1 entry did not activate\nmcp-server-copied (cordis:mcp-manager-server): ')
    expect(warning).toContain('$.enabled expected nullable but got false')
    expect(names(ctx)).toEqual(['good'])
  })
})

describe('mcp-manager server rows beside the servers dictionary', () => {
  it('runs a dictionary entry and a server row together, listing the dictionary entry first', async () => {
    const ctx = await registry()
    await managerProfile(ctx, { base: { servers: { listed: stdio } }, rows: { row: stdio } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__listed__remote')).toBeDefined() })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__row__remote')).toBeDefined() })
    expect(await startupWarning(ctx)).toBe('')
    expect(ctx.mcpManager.list()).toMatchObject([
      { name: 'listed', configured: true, status: { state: 'connected' } },
      { name: 'row', configured: true, status: { state: 'connected' } },
    ])
    expect(clients).toHaveLength(2)
  })

  it('fails a row whose server name a dictionary entry holds, even a disabled one, and keeps the dictionary\'s servers', async () => {
    const ctx = await registry()
    await managerProfile(ctx, {
      base: { servers: { taken: { ...stdio, args: ['--dictionary'] }, parked: { ...stdio, enabled: false } } },
      rows: { taken: { ...stdio, args: ['--row'] }, parked: stdio },
    })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__taken__remote')).toBeDefined() })
    const warning = await startupWarning(ctx)
    expect(warning).toContain('dsh: warning: 2 entries did not activate')
    expect(warning).toContain('mcp-server-taken (cordis:mcp-manager-server): ')
    expect(warning).toContain('mcp-manager: server "taken" is already configured or registered')
    expect(warning).toContain('mcp-server-parked (cordis:mcp-manager-server): ')
    expect(warning).toContain('mcp-manager: server "parked" is already configured or registered')
    expect(ctx.mcpManager.list()).toMatchObject([
      { name: 'taken', configured: true, status: { state: 'connected' } },
      { name: 'parked', configured: true, status: { state: 'disabled' } },
    ])
    // The dictionary's entry serves the name: the only connection carries its arguments.
    expect(clients).toHaveLength(1)
    expect(stdioConfigs).toMatchObject([{ command: 'echo', args: ['--dictionary'] }])
  })

  it('refuses a dictionary write that takes the server name of a running row', async () => {
    const ctx = await registry()
    const { profile } = await managerProfile(ctx, { rows: { row: stdio } })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__row__remote')).toBeDefined() })
    const saved = await readFile(profile.patchPath, 'utf8')

    await expect(ctx.settings.update('mcp', { servers: { row: stdio } }))
      .rejects.toThrow('servers.row: a plugin already registers this server name')
    expect(await readFile(profile.patchPath, 'utf8')).toBe(saved)
    expect(names(ctx)).toEqual(['row'])
    expect(clients).toHaveLength(1)
  })

  it('leaves every server row waiting when an invalid dictionary entry fails the manager row', async () => {
    const ctx = await registry()
    await managerProfile(ctx, { base: { servers: { broken: { transport: 'stdio' } } }, rows: { row: stdio } })
    const warning = await startupWarning(ctx)
    expect(warning).toContain('dsh: warning: 2 entries did not activate\nmcp (cordis:mcp-manager): ')
    expect(warning).toContain('servers.broken: a stdio server requires "command"')
    expect(warning).toContain('mcp-server-row (cordis:mcp-manager-server): pending (waiting for service: mcpManager)')
    expect(ctx.get('mcpManager')).toBeUndefined()
    expect(clients).toHaveLength(0)
  })

  it('moves a server from the dictionary to a row in one profile patch edit', async () => {
    const ctx = await registry()
    const { profile } = await managerProfile(ctx, { user: { servers: { moved: stdio } } })
    await watchProfile(ctx)
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__moved__remote')).toBeDefined() })
    expect(clients).toHaveLength(1)

    await writeFile(profile.patchPath, JSON.stringify([{ insert: [serverRow('moved', { ...stdio, args: ['--row'] })] }]))
    await vi.waitFor(() => { expect(stdioConfigs.at(-1)).toMatchObject({ command: 'echo', args: ['--row'] }) }, { timeout: 5_000 })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__moved__remote')).toBeDefined() })
    expect(await startupWarning(ctx)).toBe('')
    expect(ctx.mcpManager.list()).toMatchObject([{ name: 'moved', configured: true, status: { state: 'connected' } }])
    expect(profileRow(ctx, 'mcp-server-moved').fiber).toBeDefined()
  })
})
