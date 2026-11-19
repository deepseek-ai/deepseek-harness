import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as McpClient from '../src/index.ts'
import { connectionStatusIn } from '../src/status.ts'
import { McpToolLoader } from '../src/tool-loading.ts'
import { McpToolRegistrationError, syncTools, type ToolBridgeOptions, type ToolDisposers } from '../src/tools.ts'
import { startHttpMcpFixture } from './http-fixture.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function host(): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

/** An agent with its own scope, announced as disposed after the scope unwinds. */
async function createAgent(ctx: Context): Promise<{ agent: Agent; scope: Scope; dispose: () => Promise<void> }> {
  const agent = {} as Agent
  let scope!: Scope
  await ctx.plugin({ inject: ['tools'], apply(inner: Context) { scope = createScope(inner, agent) } })
  return { agent, scope, dispose: async () => {
    await scope.dispose()
    ctx.emit('agent/disposed', { agent })
  } }
}

interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

function createMockClient(tools: MockTool[]) {
  return {
    listTools: vi.fn(async () => ({ tools, nextCursor: undefined })),
    callTool: vi.fn(async (params: { name: string }) => ({ content: [{ type: 'text', text: `called ${params.name}` }] })),
    getServerCapabilities: (): object => ({ tools: {} }),
  }
}

const object = { type: 'object' }

/** One on-demand server in its own plugin context: a loader plus the generation each sync publishes to it. */
async function onDemand(ctx: Context, maxLength = 160) {
  let owner!: Context
  await ctx.plugin({ inject: ['tools'], apply(inner: Context) { owner = inner } })
  const loader = new McpToolLoader(owner, 'srv', maxLength)
  const opts: ToolBridgeOptions = { signal: new AbortController().signal, serverName: 'srv', toolCallTimeoutMs: 60_000, loader }
  let disposers: ToolDisposers = new Map()
  return {
    owner,
    loader,
    async sync(tools: MockTool[]): Promise<ToolDisposers> {
      disposers = await syncTools(createMockClient(tools) as never, owner, opts, disposers)
      return disposers
    },
    clear(): void {
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
    },
  }
}

function load(ctx: Context, agent: Agent | undefined, tools: string[]) {
  return executeToolFixture(ctx, {
    name: 'mcp__srv__load_tools', arguments: { tools }, callId: ToolCallId('load'), signal: new AbortController().signal,
    ...agent === undefined ? {} : { agent },
  })
}

it('registers only the loader for an on-demand generation and lists its tools in the prompt catalog', async () => {
  const ctx = await host()
  const server = await onDemand(ctx, 24)
  const disposers = await server.sync([
    { name: 'search', description: '  Search   the workspace.\nLonger details stay out of the catalog.', inputSchema: object },
    { name: 'fetch', description: 'Fetch one page by its identifier from the workspace.', inputSchema: object },
    { name: 'ping', inputSchema: object },
  ])

  expect([...disposers.keys()]).toEqual(['mcp__srv__load_tools'])
  expect(server.loader.size).toBe(3)
  expect(ctx.tools.get('mcp__srv__search')).toBeUndefined()
  expect(ctx.tools.get('mcp__srv__load_tools')?.description)
    .toBe('Add tools from MCP server srv to your tool list. The system prompt lists them under "On-demand tools from MCP server srv".')
  expect(server.loader.catalog(undefined)).toBe([
    '### On-demand tools from MCP server srv',
    'These tools are not in your tool list. Before calling one, load it with mcp__srv__load_tools.',
    '- fetch: Fetch one page by its...\n- ping\n- search: Search the workspace.',
  ].join('\n\n'))
})

it('omits the catalog for an agent that cannot see the loader and while no generation is published', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  expect(server.loader.catalog(undefined)).toBe('')
  await server.sync([{ name: 'search', inputSchema: object }])
  const { agent, scope } = await createAgent(ctx)
  scope.ctx.tools.restrict({ deny: ['mcp__srv__load_tools'] })

  expect(server.loader.catalog(agent)).toBe('')
  expect(server.loader.catalog(undefined)).not.toBe('')
})

it('registers loaded tools in the calling agent\'s own scope', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }, { name: 'fetch', inputSchema: object }])
  const first = await createAgent(ctx)
  const second = await createAgent(ctx)

  expect(await load(ctx, first.agent, ['search', 'search'])).toMatchObject({ isError: false, value: 'Loaded: mcp__srv__search.' })
  expect(await load(ctx, first.agent, ['fetch', 'search']))
    .toMatchObject({ isError: false, value: 'Loaded: mcp__srv__fetch.\nAlready loaded: mcp__srv__search.' })
  expect(await load(ctx, first.agent, ['search'])).toMatchObject({ isError: false, value: 'Already loaded: mcp__srv__search.' })
  expect(ctx.tools.get('mcp__srv__search', first.agent)).toBeDefined()
  expect(ctx.tools.get('mcp__srv__search')).toBeUndefined()
  expect(ctx.tools.get('mcp__srv__search', second.agent)).toBeUndefined()
  expect(await executeToolFixture(ctx, {
    name: 'mcp__srv__search', arguments: {}, callId: ToolCallId('search'), signal: new AbortController().signal, agent: first.agent,
  })).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'called search' }] } })
})

it('rejects a load that names no agent, no tool, or a tool the server does not offer', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }])
  const { agent } = await createAgent(ctx)

  expect(await load(ctx, undefined, ['search'])).toMatchObject({ isError: true, error: { message: 'mcp__srv__load_tools requires an agent' } })
  expect(await load(ctx, agent, [])).toMatchObject({ isError: true, error: { message: 'mcp__srv__load_tools requires at least one tool name' } })
  expect(await load(ctx, agent, ['search', 'mcp__srv__search', 'gone'])).toMatchObject({
    isError: true,
    error: { message: 'MCP server srv does not offer "mcp__srv__search", "gone"; use names from its on-demand tool list' },
  })
  expect(ctx.tools.get('mcp__srv__search', agent)).toBeUndefined()
})

it('re-registers loaded tools from each new generation and drops the ones it no longer offers', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', description: 'Old.', inputSchema: object }, { name: 'fetch', inputSchema: object }])
  const { agent } = await createAgent(ctx)
  await load(ctx, agent, ['search', 'fetch'])

  await server.sync([{ name: 'search', description: 'New.', inputSchema: object }])
  expect(ctx.tools.get('mcp__srv__search', agent)?.description).toBe('New.')
  expect(ctx.tools.get('mcp__srv__fetch', agent)).toBeUndefined()

  await server.sync([{ name: 'search', inputSchema: object }, { name: 'fetch', inputSchema: object }])
  expect(ctx.tools.get('mcp__srv__fetch', agent)).toBeUndefined()
})

it('withdraws the loader and loaded tools with the generation and restores loaded tools from the next one', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }])
  const { agent } = await createAgent(ctx)
  await load(ctx, agent, ['search'])

  server.clear()
  expect(ctx.tools.get('mcp__srv__load_tools')).toBeUndefined()
  expect(ctx.tools.get('mcp__srv__search', agent)).toBeUndefined()
  expect(server.loader.size).toBe(0)

  await server.sync([{ name: 'search', inputSchema: object }])
  expect(ctx.tools.get('mcp__srv__search', agent)).toBeDefined()
})

it('releases an agent\'s loaded tools when the agent is disposed', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }])
  const subject = await createAgent(ctx)
  await load(ctx, subject.agent, ['search'])

  await subject.dispose()
  await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__search', subject.agent)).toBeUndefined() })
  await server.sync([{ name: 'search', inputSchema: object }])
  expect(ctx.tools.get('mcp__srv__search', subject.agent)).toBeUndefined()
})

it('keeps a failed restore to its own agent', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }])
  const blocked = await createAgent(ctx)
  const other = await createAgent(ctx)
  await load(ctx, blocked.agent, ['search'])
  await load(ctx, other.agent, ['search'])
  server.clear()
  const squatter = defineTool({
    name: 'mcp__srv__search', description: 'Squats.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'squat',
  })
  createScope(server.owner, blocked.agent).ctx.tools.register(squatter)
  const error = vi.spyOn(server.owner.logger, 'error')

  await server.sync([{ name: 'search', inputSchema: object }])
  expect(error).toHaveBeenCalledWith(expect.stringContaining('mcp-client(srv): could not restore loaded tool "search" for an agent'))
  expect(ctx.tools.get('mcp__srv__search', blocked.agent)).toBe(squatter)
  expect(ctx.tools.get('mcp__srv__search', other.agent)).toBeDefined()
  expect(ctx.tools.get('mcp__srv__load_tools')).toBeDefined()
})

it('leaves a server tool named like the loader out of the catalog', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  const warn = vi.spyOn(server.owner.logger, 'warn')

  await server.sync([{ name: 'load_tools', inputSchema: object }, { name: 'search', inputSchema: object }])
  expect(server.loader.size).toBe(1)
  expect(warn).toHaveBeenCalledWith('mcp-client(srv): server tool "load_tools" is not offered because its name is the on-demand loader\'s')
})

it('fails the generation when another registration holds the loader name', async () => {
  const ctx = await host()
  ctx.tools.register(defineTool({
    name: 'mcp__srv__load_tools', description: 'Foreign.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'foreign',
  }))
  const server = await onDemand(ctx)
  const error = vi.spyOn(server.owner.logger, 'error').mockImplementation(() => {})

  await expect(server.sync([{ name: 'search', inputSchema: object }])).rejects.toBeInstanceOf(McpToolRegistrationError)
  expect(error).toHaveBeenCalledWith(expect.stringContaining('mcp-client(srv): tool registration failed, no tools registered'))
})

it('loads and calls an on-demand server\'s tool through the plugin and withdraws it on unload', async () => {
  const ctx = await host()
  const { agent } = await createAgent(ctx)
  const fixture = await startHttpMcpFixture()
  onTestFinished(fixture.close)
  const fiber = await ctx.plugin(McpClient, McpClient.Config({
    transport: 'streamable-http', serverName: 'demo', url: fixture.url,
    toolLoading: 'on-demand', failOnStartupError: true, reconnect: { enabled: false },
  }))

  expect(connectionStatusIn(fiber)!.current()).toMatchObject({ state: 'connected', toolCount: 1 })
  expect(ctx.tools.get('mcp__demo__ping', agent)).toBeUndefined()
  const prompt = await ctx.systemPrompt.assemble({ scope: agent })
  expect(prompt.sections.map(section => section.text)).toContain([
    '### On-demand tools from MCP server demo',
    'These tools are not in your tool list. Before calling one, load it with mcp__demo__load_tools.',
    '- ping: Replies pong.',
  ].join('\n\n'))
  expect(await executeToolFixture(ctx, {
    name: 'mcp__demo__load_tools', arguments: { tools: ['ping'] }, callId: ToolCallId('load'), signal: new AbortController().signal, agent,
  })).toMatchObject({ isError: false, value: 'Loaded: mcp__demo__ping.' })
  expect(await executeToolFixture(ctx, {
    name: 'mcp__demo__ping', arguments: {}, callId: ToolCallId('ping'), signal: new AbortController().signal, agent,
  })).toMatchObject({ isError: false })

  await fiber.dispose()
  expect(ctx.tools.get('mcp__demo__load_tools')).toBeUndefined()
  expect(ctx.tools.get('mcp__demo__ping', agent)).toBeUndefined()
})
