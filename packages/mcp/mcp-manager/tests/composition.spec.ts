/**
 * Real-composition guard: the manager boots from a test-only cordis.yml
 * through the actual Loader + Include path beside the file settings provider,
 * mounts its composition-base server, and an external edit of settings.yaml
 * hot-adds a second server whose tools appear — the product path a Web
 * management surface drives. The MCP SDK is mocked at the module level; the
 * Loader, settings file watcher, manager, and mcp-client instances are real.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'

const { MockClient } = vi.hoisted(() => {
  class MockClient {
    transport: object | undefined = {}
    onclose: (() => void) | undefined
    connect = vi.fn(async () => {})
    close = vi.fn(async function (this: { onclose?: () => void }) { this.onclose?.() })
    listTools = vi.fn(async () => ({ tools: [{ name: 'remote', inputSchema: { type: 'object' } }], nextCursor: undefined }))
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
    listResources = async () => ({ resources: [] })
    getServerVersion = (): { name: string; version: string } => ({ name: 'fixture', version: '1.0.0' })
  }
  return { MockClient }
})

vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(function () { return { close: () => Promise.resolve() } }),
}))
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function () { return { close: () => Promise.resolve() } }),
}))

import McpServerManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('mcp-manager real composition', () => {
  it('boots from cordis.yml, mounts the base server, and hot-adds one from a settings edit', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-composition-'))
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, '\n')

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: system-prompt',
      '  name: test-system-prompt',
      '- id: tools',
      '  name: test-tools',
      '- id: settings',
      "  name: '@deepseek-ai/dsh-settings-file'",
      '  config:',
      `    path: ${JSON.stringify(settingsPath)}`,
      '    debounceMs: 10',
      '- id: mcp',
      "  name: '@deepseek-ai/dsh-mcp-manager'",
      '  config:',
      '    servers:',
      '      base:',
      '        transport: stdio',
      '        command: echo',
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-system-prompt', SystemPrompt],
      ['test-tools', ToolRuntime],
      ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
      ['@deepseek-ai/dsh-mcp-manager', McpServerManager],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    // Composition-base server mounts without any user layer.
    await vi.waitFor(() => { expect(ctx.get('tools')!.get('mcp__base__remote')).toBeDefined() })
    const manager = ctx.get('mcpServers')!
    expect(manager.list()).toHaveLength(1)

    // An external settings.yaml edit is the same write path the Web surface
    // uses; the watcher publishes it and the manager mounts the new server.
    await writeFile(settingsPath, [
      'mcp:',
      '  servers:',
      '    added:',
      '      transport: stdio',
      '      command: echo',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.get('tools')!.get('mcp__added__remote')).toBeDefined()
    }, { timeout: 5_000 })
    expect(manager.list().map(view => view.name).sort()).toEqual(['added', 'base'])
    expect(manager.list().find(view => view.name === 'added')).toMatchObject({ deletable: true })
    expect(manager.list().find(view => view.name === 'base')).toMatchObject({ deletable: false })
  })
})
