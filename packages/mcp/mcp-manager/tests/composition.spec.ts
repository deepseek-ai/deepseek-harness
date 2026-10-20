/** Plugin registration through a real Loader composition. */
import type { Transport } from '@modelcontextprotocol/client'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpServerManager from '../src/index.ts'
import type { McpManagedServerStatus } from '../src/index.ts'

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
    close = vi.fn(async () => { await this.transport?.close() })
    listTools = vi.fn(async () => ({ tools: [{ name: 'remote', inputSchema: { type: 'object' } }], nextCursor: undefined }))
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
    listResources = async () => ({ resources: [] })
  }
  return { MockClient, MockTransport }
})

vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(function () { return new MockTransport() }),
}))

/** A plugin that contributes one server for its own lifetime, as connector plugins do. */
const Registrar = {
  name: 'registrar',
  inject: ['mcpServers'],
  apply(ctx: Context, config: { url: string }) { ctx.mcpServers.register('app', { url: config.url }) },
}

describe('mcp-manager real composition', () => {
  it('mounts a server a composed plugin registers and withdraws it with that entry', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-')))
    const ctx = new Context()
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const configPath = join(home, 'cordis.yml')
    await writeFile(configPath, [
      '- id: mcp',
      "  name: 'cordis:mcp-manager'",
      '  config:',
      '    startupTimeoutMs: 5000',
      '- id: app',
      "  name: 'cordis:registrar'",
      '  config:',
      "    url: 'http://mcp.test/app'",
    ].join('\n') + '\n')
    ctx.baseUrl = pathToFileURL(home).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins['mcp-manager'] = McpServerManager
    ctx.loader.builtins.registrar = Registrar
    await mountRootInclude(ctx, configPath)
    await ctx.loader.await()

    await vi.waitFor(() => { expect(ctx.mcpServers.list()).toEqual([{ name: 'app', status: expect.objectContaining({ state: 'connected', toolCount: 1 }) as McpManagedServerStatus }]) })
    expect(ctx.tools.get('mcp__app__remote')).toBeDefined()

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'app')
    await entry!.fiber!.dispose()
    expect(ctx.tools.get('mcp__app__remote')).toBeUndefined()
    expect(ctx.mcpServers.list()).toEqual([])
  })
})
