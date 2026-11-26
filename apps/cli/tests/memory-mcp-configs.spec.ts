/**
 * The third-party memory examples stay config-only. This suite parses every
 * checked-in overlay, verifies its package pin, transport, and secret handling, then replaces
 * only the upstream endpoint with the package-owned keyless MCP fixture and
 * proves the real Cordis Loader discovers a tool through the generic bridge.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { NativeToolRegistry } from '@deepseek-ai/dsh-tools/pipeline'
import * as McpClient from '@deepseek-ai/dsh-mcp-client/src/index.ts'

interface ExampleContract {
  file: string
  id: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  pin: string
}

interface InsertedRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

const root = resolve(import.meta.dirname, '../../..')
const exampleDir = resolve(root, 'apps/cli/config/examples/mcp-memory')
const baseConfig = resolve(import.meta.dirname, 'fixtures/memory-mcp-base.cordis.yml')
const fixtureServer = resolve(root, 'packages/mcp/mcp-client/tests/fixture-server.ts')

const examples: ExampleContract[] = [
  {
    file: 'memorix.cordis.yml',
    id: 'memory-memorix',
    serverName: 'memorix',
    transport: 'stdio',
    pin: '1.3.0',
  },
  {
    file: 'mcp-reference-memory.cordis.yml',
    id: 'memory-mcp-reference',
    serverName: 'reference_memory',
    transport: 'stdio',
    pin: '2026.7.4',
  },
  {
    file: 'engram.cordis.yml',
    id: 'memory-engram',
    serverName: 'engram',
    transport: 'stdio',
    pin: '1.20.0',
  },
]

const liveContexts = new Set<Context>()

afterEach(async () => {
  await Promise.all([...liveContexts].map(async ctx => ctx.fiber.dispose()))
  liveContexts.clear()
})

function insertedRow(patches: PatchOptions[]): InsertedRow {
  expect(patches).toHaveLength(1)
  const insert = patches[0]?.insert
  expect(insert).toHaveLength(1)
  return insert?.[0] as InsertedRow
}

async function waitForTool(ctx: Context, name: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!ctx.tools.getAll().some(tool => tool.name === name)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${name}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
}

describe('third-party memory MCP example overlays', () => {
  it.each(examples)('parses $file with the documented generic plugin fields', (contract) => {
    const file = resolve(exampleDir, contract.file)
    const source = readFileSync(file, 'utf8')
    const row = insertedRow(loadOverlayPatches('memory-mcp-config-test', file))

    expect(row.id).toBe(contract.id)
    expect(row.name).toBe('@deepseek-ai/dsh-mcp-client')
    expect(row.config?.serverName).toBe(contract.serverName)
    expect(row.config?.transport).toBe(contract.transport)
    expect(source.split('\n', 1)[0]).toContain(contract.pin)
    expect(source).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}\b/)
    expect(source).not.toContain('DEEPSEEK_API_KEY')
  })

  it.each(examples)('loads $file and discovers a keyless fixture tool', async (contract) => {
    const patches = loadOverlayPatches(
      'memory-mcp-config-test',
      resolve(exampleDir, contract.file),
    )
    // The static config gate verifies the checked-in bare package specifier.
    // The unit test maps it to the source module so a clean checkout needs no
    // prebuilt `lib/` artifacts before proving the Loader/MCP behavior.
    insertedRow(patches).name = 'cordis:memory-test-mcp-client'
    const fixturePatch: PatchOptions = {
      id: contract.id,
      config: {
        serverName: contract.serverName,
        transport: 'stdio',
        command: process.execPath,
        args: [fixtureServer],
        env: {},
        cwd: root,
        toolCallTimeoutMs: 5_000,
      },
    }
    const ctx = await boot(
      'memory-mcp-config-test',
      baseConfig,
      [...patches, fixturePatch],
      (ctx) => {
        liveContexts.add(ctx)
        ctx.loader.builtins['memory-test-session-projection'] = SessionProjectionRegistry
        ctx.loader.builtins['memory-test-system-prompt'] = SystemPrompt
        ctx.loader.builtins['memory-test-tools'] = ToolRuntime
        ctx.loader.builtins['memory-test-tool-registry'] = {
          name: 'memory-test-tool-registry', inject: ['tools'],
          apply: (scope: Context) => { scope.tools.setRoot(new NativeToolRegistry()) },
        }
        ctx.loader.builtins['memory-test-mcp-client'] = McpClient
      },
    )
    await waitForTool(ctx, `mcp__${contract.serverName}__greet`)
  }, 15_000)
})
