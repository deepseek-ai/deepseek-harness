/**
 * Tests for the manager's invariant companion: a status emission must name a
 * server the live manager lists, and must not happen without a manager at all.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as McpManagerInvariant from '@deepseek-ai/dsh-mcp-manager/invariant'

vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: vi.fn(function (this: Record<string, unknown>) {
    this.transport = {}
    this.connect = vi.fn(async () => {})
    this.close = vi.fn(async () => {})
    this.listTools = vi.fn(async () => ({ tools: [], nextCursor: undefined }))
    this.getServerCapabilities = () => ({ tools: {} })
    this.getInstructions = (): string | undefined => undefined
    this.listResources = async () => ({ resources: [] })
  }),
  StreamableHTTPClientTransport: vi.fn(function () { return { close: () => Promise.resolve() } }),
}))
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function () { return { close: () => Promise.resolve() } }),
}))

import McpServerManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'

async function setup(withManager: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(McpManagerInvariant)
  if (withManager) {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(McpServerManager, { servers: { listed: { transport: 'stdio', command: 'echo' } } })
  }
  return ctx
}

describe('mcp-manager invariants', () => {
  it('fails a status emission without a live manager service', async () => {
    const ctx = await setup(false)
    expect(() => {
      ctx.emit('mcp-manager/status', 'ghost', { state: 'disabled' })
    }).toThrow(/without a live manager service/)
  })

  it('fails a status emission for a server the manager does not list', async () => {
    const ctx = await setup(true)
    expect(() => {
      ctx.emit('mcp-manager/status', 'ghost', { state: 'disabled' })
    }).toThrow(/does not list/)
  })

  it('accepts a status emission for a listed server', async () => {
    const ctx = await setup(true)
    expect(() => {
      ctx.emit('mcp-manager/status', 'listed', { state: 'disabled' })
    }).not.toThrow()
  })
})
