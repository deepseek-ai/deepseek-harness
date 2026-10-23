/** Real SDK negotiation, subscription, and cancellation through the connection supervisor. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { z } from 'zod'

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'
import type { Config } from '../src/index.ts'

const { mockTransport } = vi.hoisted(() => ({ mockTransport: vi.fn<() => Transport>() }))
vi.mock('../src/transport.ts', () => ({ createTransport: mockTransport }))

const config: Config = {
  transport: 'stdio', serverName: 'fixture', command: 'fixture', args: [], env: {}, cwd: '',
  toolCallTimeoutMs: 60_000, failOnStartupError: true,
}

async function connect(server: McpServer, options?: { resources: true }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const serving = serveStdio(() => server, { transport: serverTransport })
  mockTransport.mockReturnValue(clientTransport)
  const connection = startConnection(ctx, config, resolveReconnectPolicy({ enabled: false }, 'fixture'))
  onTestFinished(async () => {
    await connection.dispose()
    await serving.close()
    await ctx.fiber.dispose()
  })
  expect(await connection.ready).toEqual({})
  if (options?.resources) {
    await ctx.plugin(McpResources)
    ctx.mcpResources.register('fixture', connection.resources)
  }
  return ctx
}

describe('modern MCP connections', () => {
  it('keeps a resource-only server connected without requesting tools', async () => {
    const server = new McpServer({ name: 'resources', version: '1' })
    server.registerResource('memo', 'memo://readme', {}, async () => ({
      contents: [{ uri: 'memo://readme', text: 'memo' }],
    }))
    const ctx = await connect(server)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('keeps shared resource tools for a configured server without resource capability', async () => {
    const server = new McpServer({ name: 'tools-only', version: '1' })
    server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    const ctx = await connect(server, { resources: true })
    const names = ctx.tools.schemas().map(tool => tool.name)
    expect(names.toSorted()).toEqual([
      'list_mcp_resource_templates', 'list_mcp_resources', 'mcp__fixture__ping', 'read_mcp_resource',
    ])
    for (const [name, expected] of [
      ['list_mcp_resources', { resources: [] }],
      ['list_mcp_resource_templates', { resourceTemplates: [] }],
    ] as const) {
      const result = await executeToolFixture(ctx, {
        name, arguments: { server: 'fixture' },
        callId: ToolCallId(name), signal: new AbortController().signal,
      })
      expect(result).toMatchObject({ isError: false, value: expected })
    }
    const read = await executeToolFixture(ctx, {
      name: 'read_mcp_resource', arguments: { server: 'fixture', uri: 'memo://readme' },
      callId: ToolCallId('unsupported-resource-read'), signal: new AbortController().signal,
    })
    expect(read.isError).toBe(true)
    if (read.isError) expect(read.error.message).toContain('Method not found')
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(names)
    const ping = await executeToolFixture(ctx, {
      name: 'mcp__fixture__ping', arguments: {},
      callId: ToolCallId('ping-after-resource-errors'), signal: new AbortController().signal,
    })
    expect(ping).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'pong' }] } })
  })

  it('reads resources and preserves explicit list and template cursors through the SDK', async () => {
    const server = new McpServer({ name: 'resources', version: '1' })
    server.registerResource('memo', 'memo://readme', {}, async () => ({
      contents: [{ uri: 'memo://readme', text: 'memo' }],
    }))
    const seen: (string | undefined)[] = []
    server.server.setRequestHandler('resources/list', async (request) => {
      const cursor = request.params?.cursor
      seen.push(cursor)
      return { resources: [{ name: 'memo', uri: 'memo://readme' }] }
    })
    server.server.setRequestHandler('resources/templates/list', async (request) => {
      seen.push(request.params?.cursor)
      return { resourceTemplates: [] }
    })
    const ctx = await connect(server, { resources: true })
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates']) {
      for (const cursor of [undefined, 'opaque-page']) {
        const result = await executeToolFixture(ctx, {
          name, arguments: { server: 'fixture', ...cursor === undefined ? {} : { cursor } },
          callId: ToolCallId(name), signal: new AbortController().signal,
        })
        expect(result.isError).toBe(false)
      }
    }
    expect(seen).toEqual([undefined, 'opaque-page', undefined, 'opaque-page'])
    const read = await executeToolFixture(ctx, {
      name: 'read_mcp_resource', arguments: { server: 'fixture', uri: 'memo://readme' },
      callId: ToolCallId('read-resource'), signal: new AbortController().signal,
    })
    expect(read).toMatchObject({ isError: false, value: { contents: [{ uri: 'memo://readme', text: 'memo' }] } })
  })

  it('updates tools through the SDK modern list-change subscription', async () => {
    const server = new McpServer({ name: 'tools', version: '1' })
    server.registerTool('first', { inputSchema: z.object({}) }, async () => ({ content: [] }))
    const ctx = await connect(server)
    expect(ctx.tools.get('mcp__fixture__first')).toBeDefined()
    server.registerTool('second', { inputSchema: z.object({}) }, async () => ({ content: [] }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__fixture__second')).toBeDefined() })
  })

  it('delivers caller cancellation to an executing modern tool', async () => {
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const cancelled: PromiseWithResolvers<void> = Promise.withResolvers()
    const server = new McpServer({ name: 'cancel', version: '1' })
    server.registerTool('wait', { inputSchema: z.object({}) }, async (_args, context) => {
      const signal = context.mcpReq.signal
      signal.addEventListener('abort', () => { cancelled.resolve() }, { once: true })
      entered.resolve()
      await cancelled.promise
      return { content: [] }
    })
    const ctx = await connect(server)
    const controller = new AbortController()
    const result = executeToolFixture(ctx, {
      callId: ToolCallId('cancel'), name: 'mcp__fixture__wait', arguments: {}, signal: controller.signal,
    })
    await entered.promise
    controller.abort(new Error('caller stopped'))
    expect((await result).isError).toBe(true)
    await cancelled.promise
  })
})
