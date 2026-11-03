/** Real profile persistence, inherited servers, and live Loader reconciliation. */
import type { Transport } from '@modelcontextprotocol/client'
import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Hmr from '@deepseek-ai/dsh-hmr'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { managerProfile } from './profile-fixture.ts'

const { MockClient, MockTransport } = vi.hoisted(() => {
  class MockTransport {
    onclose?: () => void
    start = async () => {}
    send = async () => {}
    close = async () => { this.onclose?.() }
  }
  class MockClient {
    transport: Transport | undefined
    onclose: (() => void) | undefined
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
  return { MockClient, MockTransport }
})

vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(function () { return new MockTransport() }),
}))
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function () { return new MockTransport() }),
}))

async function registry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

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
})
