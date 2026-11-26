import { executeDefinitionFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import * as PtcToolRegistry from '@deepseek-ai/dsh-tool-registry-ptc'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolDefinition, type ToolRegistry } from '@deepseek-ai/dsh-tools'
import { ToolStep } from '@deepseek-ai/dsh-tools/pipeline'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import Llm, { LlmAdapter, type ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { type SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Projections from '@deepseek-ai/dsh-session-projection'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig } from '../src/mcp.ts'

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))
const roots: string[] = []
const contexts: Context[] = []
const activations: Promise<void>[] = []
const TOOL = 'mcp__browser-fixture__visit'

afterEach(async () => {
  const disposed = await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(activations.splice(0))
  const removed = await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  const failures: unknown[] = []
  for (const result of [...disposed, ...removed]) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'MCP fixture cleanup failed')
})

/** Observe pending creation or resume before a readiness assertion can fail; callers retain its original result. */
function observeActivation(activation: Promise<AgentHandle>): Promise<AgentHandle> {
  activations.push(activation.then(() => {}, () => {}))
  return activation
}

class FixtureModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.tools?.some(tool => tool.name === TOOL) && options.messages.at(-1)?.role === 'user') {
      const call = { type: 'tool-call' as const, id: brandString<ToolCallId>('visit'), name: TOOL, arguments: '{"label":"fixture"}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Visited.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Visited.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

class PresentationRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  resolve(): never { throw new Error('Unexpected PTC execution in a presentation test') }
  run(): Promise<never> { return Promise.reject(new Error('Unexpected PTC execution in a presentation test')) }
}

async function load(exclusive = false, mode?: string, toolCallTimeoutMs?: number, toolOrder?: string[], rootRegistry: 'native' | 'ptc' = 'native') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-mcp-'))
  roots.push(root)
  const model = new FixtureModel()
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
    ...rootRegistry === 'native' ? [['toolRegistry', NativeToolRegistry] as const] : [['ptcRuntime', PresentationRuntime] as const, ['toolRegistry', PtcToolRegistry] as const],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
    ['fs', LocalFileSystem], ['workingDirectory', WorkingDirectory],
    ['model', { inject: ['llm'], apply(ctx: Context) { ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model)) } }],
    ['browser', { inject: ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory'], apply(ctx: Context) {
      mountSessionMcp(ctx, { name: 'browser-fixture', exclusive, command: process.execPath, args: [fixture, root, ...mode === undefined ? [] : [mode]], ...toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs, env: {} } })
    } }],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ id: name, name, config: name === 'loop' ? { agents: [] } : name === 'prompt' && toolOrder !== undefined ? { toolOrder } : {} }))))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const browser = [...ctx.loader.entries()].find(entry => entry.options.id === 'browser')!.fiber!
  return { ctx, root, model, browser }
}

async function warm(ctx: Context, agent: Agent, signal = new AbortController().signal) {
  await agent.whenIdle()
  return ctx.systemPrompt.assemble({ agent, scope: agent, signal })
}

const FOREIGN = { name: 'BrowserSessionError', code: 'BROWSER_FOREIGN_SESSION' }

function execute(ctx: Context, agent: Agent, name = TOOL) {
  return executeToolFixture(ctx, { agent, name, arguments: name === TOOL ? { label: 'direct' } : {}, callId: brandString<ToolCallId>('direct'), signal: new AbortController().signal })
}

function resource(ctx: Context, agent: Agent | undefined, name = 'read_mcp_resource', server = 'browser-fixture', callId = name) {
  return executeToolFixture(ctx, {
    ...agent === undefined ? {} : { agent }, name,
    arguments: { server, ...name === 'read_mcp_resource' ? { uri: 'browser-fixture://state' } : {} },
    callId: brandString<ToolCallId>(callId), signal: new AbortController().signal,
  })
}

function browserState(result: Awaited<ReturnType<typeof resource>>): { counter: number; pid: number } {
  expect(result.isError).toBe(false)
  const value = result.value as { contents: { text: string }[] }
  return JSON.parse(value.contents[0]!.text) as { counter: number; pid: number }
}

function registerIndependentTool(ctx: Context) {
  ctx.tools.register({
    name: 'unrelated', description: 'An independent capability.', parameters: { type: 'object' },
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Independent.' }] },
    execute: async () => true,
  })
}

async function events(root: string) {
  return (await readFile(join(root, 'events.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; pid: number; endpoint: string; name?: string; cwd?: string })
}

/** Whether the fixture process that recorded `endpoint` still runs; a later process that received its PID does not count. */
function listening(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false)
      else reject(error)
    })
  })
}

async function expectEnded(root: string) {
  for (const { pid, endpoint } of (await events(root)).filter(event => event.event === 'start')) {
    expect(await listening(endpoint), `fixture process ${pid} still listens at ${endpoint}`).toBe(false)
  }
}

it('requires a browser mode and validates launch and attachment settings', () => {
  expect(BrowserMcpConfig({ mode: 'launch' })).toEqual({ mode: 'launch', headless: true })
  expect(BrowserMcpConfig({ mode: 'launch', headless: false, executablePath: '/chromium', toolCallTimeoutMs: 12 })).toMatchObject({ headless: false, toolCallTimeoutMs: 12 })
  expect(BrowserMcpConfig({ mode: 'attach', endpoint: 'wss://browser.example/devtools/browser/id' })).toMatchObject({ mode: 'attach' })
  for (const invalid of [{}, { mode: 'attach' }, { mode: 'attach', endpoint: 'file:///tmp/browser' }, { mode: 'launch', toolCallTimeoutMs: 0 }, { mode: 'launch', executablePath: '' }]) {
    expect(() => BrowserMcpConfig(invalid as never)).toThrow()
  }
  for (const endpoint of ['http://localhost:bad/path', 'http://localhost trailing-junk', 'file:///tmp/browser', 'http://localhost/ ']) {
    expect(() => { validateBrowserMcpConfig({ mode: 'attach', endpoint }) }).toThrow('browser endpoint')
  }
})

it('waits for SystemPrompt and ToolRuntime before reserving the provider', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(BrowserUse)
  await ctx.plugin(Projections)
  await ctx.plugin(Agents)
  provideWorkingDirectoryFixture(ctx)
  const tools = ctx.plugin(Tools)
  const browser = ctx.plugin({
    inject: ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory'],
    apply(provider: Context) {
      mountSessionMcp(provider, { name: 'browser-fixture', exclusive: true, command: process.execPath, args: [fixture] })
    },
  })
  await Promise.all([tools, browser])
  expect(ctx.get('tools')).toBeUndefined()
  expect(ctx.browserUse.providerName).toBeUndefined()
  await ctx.plugin(SystemPrompt)
  await Promise.all([tools, browser])
  expect(ctx.browserUse.providerName).toBe('browser-fixture')
})

describe('Session MCP Loader composition', () => {
  it('discovers schemas before the first model request and retains distinct state across turns', async () => {
    const { ctx, root, model, browser } = await load(false, undefined, 5000, [TOOL, '<unlisted-tools>'])
    const first = await ctx.agents.create({ sessionId: brandString<SessionId>('first'), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    const second = await ctx.agents.create({ sessionId: brandString<SessionId>('second') })
    expect(ctx.tools.getAll()).toEqual([])
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(2)
    expect(model.requests[0]?.tools?.find(tool => tool.name === TOOL)).toMatchObject({ description: 'Visit the fixture page.', parameters: { required: ['label'], additionalProperties: false } })
    expect(JSON.stringify(first.agent.session.snapshotEvents())).toContain('Visit 1: fixture')
    expect((await execute(ctx, first.agent)).content).toEqual([{ type: 'text', text: 'Visit 2: direct' }])
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit once more.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(4)
    expect(JSON.stringify(first.agent.session.snapshotEvents())).toContain('Visit 3: fixture')
    await warm(ctx, second.agent)
    expect((await execute(ctx, second.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
    expect(ctx.tools.getAll()).toEqual([])
    expect(ctx.tools.getAll(first.agent)).toHaveLength(2)
    const initial = await events(root)
    expect(initial.filter(event => event.event === 'start')).toHaveLength(4)
    expect(initial.filter(event => event.event === 'probe')).toHaveLength(2)
    expect(initial.filter(event => event.event === 'initialize')).toHaveLength(2)
    await first.dispose()
    expect(ctx.tools.getAll(first.agent)).toEqual([])
    const resumed = await ctx.agents.create({ sessionId: brandString<SessionId>('first') })
    await warm(ctx, resumed.agent)
    expect((await execute(ctx, resumed.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
    await browser.dispose()
    expect(ctx.browserUse.providerName).toBeUndefined()
    await expectEnded(root)
  })

  it('keeps unrelated and child Sessions running without a busy attachment and admits a later owner', async () => {
    const { ctx, root, model } = await load(true)
    registerIndependentTool(ctx)
    const first = await ctx.agents.create({ sessionId: brandString<SessionId>('first') })
    const second = await ctx.agents.create({ sessionId: brandString<SessionId>('second'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    const child = await ctx.agents.create({
      sessionId: brandString<SessionId>('child'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (_inner, agent) => { bindScopeParent(agent, first.agent) },
    })
    await warm(ctx, first.agent)
    expect(ctx.tools.getAll(child.agent).some(tool => tool.name === TOOL)).toBe(false)
    for (const { agent } of [second, child]) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Answer without using the browser.' }], source: { kind: 'user' } }))
    }
    await Promise.all([second.agent.whenIdle(), child.agent.whenIdle()])
    expect(model.requests).toHaveLength(2)
    expect(model.requests.map(request => request.tools?.map(tool => tool.name))).toEqual([['unrelated'], ['unrelated']])
    for (const { agent } of [second, child]) {
      expect(ctx.tools.getAll(agent).map(tool => tool.name)).toEqual(['unrelated'])
      expect((await execute(ctx, agent)).error?.info).toEqual(FOREIGN)
      expect((await execute(ctx, agent, 'unrelated')).isError).toBe(false)
      expect((await warm(ctx, agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    }
    first.agent.ctx.tools.register({
      name: 'mcp__browser-fixture__late', description: 'A newly discovered browser operation.', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Late browser result.' }] },
      execute: async () => true,
    })
    expect(ctx.tools.getAll(child.agent).filter(tool => tool.name.startsWith('mcp__browser-fixture__'))).toEqual([])
    expect((await warm(ctx, child.agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    expect((await execute(ctx, child.agent, 'mcp__browser-fixture__late')).error?.info).toEqual(FOREIGN)
    expect((await events(root)).filter(event => event.event === 'initialize')).toHaveLength(1)
    expect((await events(root)).filter(event => event.event === 'call')).toEqual([])
    expect((await execute(ctx, first.agent)).isError).toBe(false)
    await first.dispose()
    expect((await warm(ctx, child.agent)).tools.some(tool => tool.name === TOOL)).toBe(false)
    expect((await execute(ctx, child.agent)).error?.info).toEqual(FOREIGN)
    expect((await warm(ctx, second.agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    const successor = await ctx.agents.create({ sessionId: brandString<SessionId>('successor') })
    expect((await warm(ctx, successor.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, successor.agent)).isError).toBe(false)
    await successor.dispose()
    await second.dispose()
    const resumed = await ctx.agents.create({ sessionId: brandString<SessionId>('second') })
    expect((await warm(ctx, resumed.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, resumed.agent)).isError).toBe(false)
  })

  it('allows another Session to answer while attached-browser discovery is pending', async () => {
    const { ctx, root, model, browser } = await load(true, 'hold')
    const first = observeActivation(ctx.agents.create({ sessionId: brandString<SessionId>('first') }))
    await expect.poll(async () => (await events(root)).some(event => event.event === 'probe')).toBe(true)
    const second = await ctx.agents.create({ sessionId: brandString<SessionId>('second'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    second.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Answer without using the browser.' }], source: { kind: 'user' } }))
    await second.agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools ?? []).toEqual([])
    expect((await events(root)).filter(event => event.event === 'start')).toHaveLength(1)
    await browser.dispose()
    await expect(first).rejects.toThrow()
    expect(ctx.agents.get(brandString<SessionId>('first'))).toBeUndefined()
    expect(ctx.sessions.get(brandString<SessionId>('first'))).toBeUndefined()
  })

  it('rolls back failed discovery and stops a child when unload interrupts discovery', async () => {
    const failed = await load(false, 'fail', undefined, [TOOL, '<unlisted-tools>'])
    let failedAgent!: Agent
    const laterListener = vi.fn()
    await expect(failed.ctx.agents.create({
      sessionId: brandString<SessionId>('failure'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        failedAgent = agent
        inner.on('agent/created', () => { agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } })) }, { prepend: true })
        inner.on('agent/created', laterListener)
      },
    })).rejects.toThrow('initial connection')
    expect(failed.model.requests).toEqual([])
    expect(laterListener).not.toHaveBeenCalled()
    expect(failed.ctx.agents.get(failedAgent.id)).toBeUndefined()
    expect(failed.ctx.sessions.get(failedAgent.id)).toBeUndefined()
    expect(failed.ctx.tools.getAll(failedAgent)).toEqual([])
    expect((await events(failed.root)).filter(event => event.event === 'initialize')).toHaveLength(1)
    await expectEnded(failed.root)
    const held = await load(false, 'hold')
    const pendingOwner = observeActivation(held.ctx.agents.create({ sessionId: brandString<SessionId>('pending') }))
    await expect.poll(async () => (await events(held.root)).some(event => event.event === 'probe')).toBe(true)
    await held.browser.dispose()
    await expect(pendingOwner).rejects.toThrow()
    expect(held.ctx.agents.get(brandString<SessionId>('pending'))).toBeUndefined()
    await expectEnded(held.root)
  })

  it('does not reconnect and silently replace browser state after a process exits', async () => {
    const { ctx, root } = await load()
    const owner = await ctx.agents.create({ sessionId: brandString<SessionId>('disconnect') })
    await warm(ctx, owner.agent)
    const serving = (await events(root)).find(event => event.event === 'initialize')!.endpoint
    await execute(ctx, owner.agent, 'mcp__browser-fixture__disconnect')
    await expect.poll(() => listening(serving)).toBe(false)
    await warm(ctx, owner.agent)
    expect((await events(root)).filter(event => event.event === 'initialize')).toHaveLength(1)
    expect((await execute(ctx, owner.agent)).isError).toBe(true)
  })

  it('keeps browser ownership exact when scopes inherit tools and leaves unrelated tools usable', async () => {
    const { ctx } = await load()
    await ctx.systemPrompt.assemble()
    const owner = await ctx.agents.create({ sessionId: brandString<SessionId>('parent') })
    const child = await ctx.agents.create({
      sessionId: brandString<SessionId>('child'),
      setup: (_inner, agent) => { bindScopeParent(agent, owner.agent) },
    })
    await warm(ctx, owner.agent)
    registerIndependentTool(ctx)
    expect((await execute(ctx, owner.agent, 'unrelated')).content).toEqual([{ type: 'text', text: 'Independent.' }])
    await warm(ctx, child.agent)
    expect((await execute(ctx, child.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
  })

  it('lets a child\'s call to an unknown browser tool name fail as an unknown tool', async () => {
    const { ctx } = await load()
    const owner = await ctx.agents.create({ sessionId: brandString<SessionId>('unknown-parent') })
    const child = await ctx.agents.create({
      sessionId: brandString<SessionId>('unknown-child'),
      setup: (_inner, agent) => { bindScopeParent(agent, owner.agent) },
    })
    await warm(ctx, owner.agent)
    await warm(ctx, child.agent)
    // No definition resolves, so no browser tool runs and the ownership check does not apply.
    expect((await execute(ctx, child.agent, 'mcp__browser-fixture__missing')).error?.info).toEqual({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })
  })

  it('denies inherited browser resources and instructions while keeping unrelated MCP servers usable', async () => {
    const { ctx, root } = await load(true)
    await ctx.plugin(McpResources)
    ctx.mcpResources.register('docs', { request: async () => ({ contents: [{ uri: 'docs://memo', text: 'Independent document.' }] }) })
    const parent = await ctx.agents.create({ sessionId: brandString<SessionId>('resource-parent') })
    const child = await ctx.agents.create({
      sessionId: brandString<SessionId>('resource-child'),
      setup: (_inner, agent) => { bindScopeParent(agent, parent.agent) },
    })
    expect(renderPrompt(await warm(ctx, parent.agent))).toContain('BROWSER_FIXTURE_INSTRUCTION')
    const blocked = await warm(ctx, child.agent)
    expect(blocked.tools.some(tool => tool.name === TOOL)).toBe(false)
    expect(renderPrompt(blocked)).not.toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect(renderPrompt(blocked)).toContain('browser-fixture')
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      expect((await resource(ctx, child.agent, name)).error?.info).toEqual(FOREIGN)
    }
    expect((await resource(ctx, undefined)).error?.info).toEqual({ name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' })
    expect((await events(root)).filter(event => event.event === 'resource')).toEqual([])
    expect((await resource(ctx, child.agent, 'read_mcp_resource', 'docs')).value)
      .toEqual({ contents: [{ uri: 'docs://memo', text: 'Independent document.' }] })
    for (const args of [null, 'invalid arguments']) {
      expect((await executeToolFixture(ctx, { agent: child.agent, name: 'read_mcp_resource', arguments: args, callId: brandString<ToolCallId>('invalid-resource'), signal: new AbortController().signal })).isError).toBe(true)
    }
    expect(browserState(await resource(ctx, parent.agent)).counter).toBe(0)
    await parent.dispose()
    expect(renderPrompt(await warm(ctx, child.agent))).not.toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect((await resource(ctx, child.agent)).error?.info).toEqual(FOREIGN)
    const successor = await ctx.agents.create({ sessionId: brandString<SessionId>('resource-successor') })
    expect(renderPrompt(await warm(ctx, successor.agent))).toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect(browserState(await resource(ctx, successor.agent)).counter).toBe(0)
  })

  it('keeps a blocked child\'s browser bindings under a PTC root and still refuses their calls', async () => {
    const { ctx } = await load(true)
    await ctx.plugin(PresentationRuntime)
    const parent = await ctx.agents.create({ sessionId: brandString<SessionId>('ptc-parent') })
    await warm(ctx, parent.agent)
    const definition = ctx.tools.get(TOOL, parent.agent)
    expect(definition).toBeDefined()
    const child = await ctx.agents.create({
      sessionId: brandString<SessionId>('ptc-child'),
      setup: (inner, agent) => {
        bindScopeParent(agent, parent.agent)
        inner.plugin(PtcToolRegistry)
      },
    })
    await child.agent.whenIdle()
    const toolStep = ToolStep.capture(ctx.tools, child.agent)
    const blocked = await ctx.systemPrompt.assemble({ agent: child.agent, scope: child.agent, toolStep })
    // The PTC root offers only run_code, so the blocked client's mask finds no inherited entry to deny.
    expect(blocked.tools.map(tool => tool.name)).toEqual(['run_code'])
    expect(blocked.sections.find(section => section.name === 'tools:sdk')?.text).toContain(TOOL)
    const refused = await executeDefinitionFixture(ctx, definition!, {
      agent: child.agent, name: TOOL, arguments: { label: 'program' }, callId: brandString<ToolCallId>('program'), signal: new AbortController().signal,
    })
    expect(refused.error?.info).toEqual(FOREIGN)
  })

  it('treats a missing root as no entries when tool changes refresh blocked masks', async () => {
    const { ctx } = await load(true)
    const parent = await ctx.agents.create({ sessionId: brandString<SessionId>('rootless-parent') })
    await warm(ctx, parent.agent)
    const root = [...ctx.loader.entries()].find(entry => entry.options.id === 'toolRegistry')!
    await root.fiber!.dispose()
    const child = await ctx.agents.create({
      sessionId: brandString<SessionId>('rootless-child'),
      setup: (_inner, agent) => { bindScopeParent(agent, parent.agent) },
    })
    expect(() => ctx.tools.getAll(child.agent)).toThrow('selected tool registry is unavailable')
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('fails Agent creation when the root reports another failure while blocked masks refresh', async () => {
    const { ctx } = await load(true)
    const parent = await ctx.agents.create({ sessionId: brandString<SessionId>('failing-parent') })
    await warm(ctx, parent.agent)
    let failing = false
    const root: ToolRegistry = {
      register: () => () => {},
      include: () => () => {},
      get: () => undefined,
      getAll: () => {
        if (failing) throw new Error('root view failed')
        return []
      },
    }
    await expect(ctx.agents.create({
      sessionId: brandString<SessionId>('failing-child'),
      setup: (inner, agent) => {
        bindScopeParent(agent, parent.agent)
        inner.tools.setRoot(root)
        failing = true
      },
    })).rejects.toThrow('root view failed')
  })

  it('refuses a parent-only browser tool to a child under a PTC deployment root', async () => {
    const { ctx } = await load(false, undefined, undefined, undefined, 'ptc')
    const parent = await ctx.agents.create({ sessionId: brandString<SessionId>('ptc-root-parent') })
    const child = await ctx.agents.create({
      sessionId: brandString<SessionId>('ptc-root-child'),
      setup: (_inner, agent) => { bindScopeParent(agent, parent.agent) },
    })
    await warm(ctx, parent.agent)
    await warm(ctx, child.agent)
    const parentOnly = vi.fn(async () => true)
    const definition: ToolDefinition = {
      name: 'mcp__browser-fixture__parent_only', description: 'A browser operation available only in the parent.', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [] }, execute: parentOnly,
    }
    parent.agent.ctx.tools.register(definition)
    // The PTC root offers only its program entry; programs bind the browser tools.
    expect(ctx.tools.getAll(child.agent).map(tool => tool.name)).toEqual(['run_code'])
    const refused = await executeDefinitionFixture(ctx, definition, {
      agent: child.agent, name: definition.name, arguments: {}, callId: brandString<ToolCallId>('parent-only'), signal: new AbortController().signal,
    })
    expect(refused.error?.info).toEqual(FOREIGN)
    expect(parentOnly).not.toHaveBeenCalled()
  })

  it('uses the child connection for resources and serializes them with browser tools exactly once', async () => {
    const { ctx } = await load()
    await ctx.plugin(McpResources)
    const parent = await ctx.agents.create({ sessionId: brandString<SessionId>('parent') })
    const child = await ctx.agents.create({
      sessionId: brandString<SessionId>('child'),
      setup: (_inner, agent) => { bindScopeParent(agent, parent.agent) },
    })
    await warm(ctx, parent.agent)
    await execute(ctx, parent.agent)
    await warm(ctx, child.agent)
    const parentOnly = vi.fn(async () => true)
    parent.agent.ctx.tools.register({
      name: 'mcp__browser-fixture__parent_only', description: 'A browser operation available only in the parent.', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [] }, execute: parentOnly,
    })
    expect((await execute(ctx, child.agent, 'mcp__browser-fixture__parent_only')).error?.info).toEqual(FOREIGN)
    expect(parentOnly).not.toHaveBeenCalled()
    const parentState = browserState(await resource(ctx, parent.agent))
    const childState = browserState(await resource(ctx, child.agent))
    expect(parentState.counter).toBe(1)
    expect(childState.counter).toBe(0)
    expect(childState.pid).not.toBe(parentState.pid)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const started: string[] = []
    const stop = ctx.on('tools/execute', async (exec, next) => {
      if (exec.agent === child.agent) {
        started.push(exec.name)
        if (exec.callId === brandString<ToolCallId>('held-resource')) {
          entered.resolve(undefined)
          await release.promise
        }
      }
      return next()
    })
    try {
      const reading = resource(ctx, child.agent, 'read_mcp_resource', 'browser-fixture', 'held-resource')
      await entered.promise
      const visiting = execute(ctx, child.agent)
      expect((await execute(ctx, parent.agent)).isError).toBe(false)
      expect(started).toEqual(['read_mcp_resource'])
      release.resolve(undefined)
      expect(browserState(await reading).counter).toBe(0)
      expect((await visiting).isError).toBe(false)
      expect(started).toEqual(['read_mcp_resource', TOOL])
      expect(browserState(await resource(ctx, child.agent)).counter).toBe(1)
    } finally {
      release.resolve(undefined)
      stop()
    }
  })

  it('holds an immediate PTC turn until the first SDK includes browser tools', async () => {
    const { ctx, root, model } = await load(false, 'gate', undefined, ['run_code', '<unlisted-tools>'])
    await ctx.plugin(PresentationRuntime)
    let created = false
    let initializing!: Agent
    const creation = observeActivation(ctx.agents.create({
      sessionId: brandString<SessionId>('ptc-first-request'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.plugin(PtcToolRegistry)
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Describe the available browser tools.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    }).then((handle) => {
      created = true
      return handle
    }))
    await expect.poll(async () => (await events(root)).some(event => event.event === 'probe')).toBe(true)
    expect(created).toBe(false)
    expect(model.requests).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    await writeFile(join(root, 'release'), '')
    const owner = await creation
    await owner.agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools?.map(tool => tool.name)).toEqual(['run_code'])
    expect(JSON.stringify(model.requests[0]?.messages)).toContain(TOOL)
  })

  it('cancels creation during discovery, closes its process, and releases the attachment', async () => {
    const { ctx, root, model } = await load(true, 'gate')
    const controller = new AbortController()
    let initializing!: Agent
    const creation = observeActivation(ctx.agents.create({
      sessionId: brandString<SessionId>('canceled-startup'), signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    }))
    await expect.poll(async () => (await events(root)).some(event => event.event === 'probe')).toBe(true)
    controller.abort(new Error('cancel browser startup'))
    await expect(creation).rejects.toThrow('cancel browser startup')
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(initializing.id)).toBeUndefined()
    expect(ctx.sessions.get(initializing.id)).toBeUndefined()
    expect(ctx.tools.getAll(initializing)).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    await expectEnded(root)
    await writeFile(join(root, 'release'), '')
    const successor = await ctx.agents.create({ sessionId: initializing.id })
    expect((await execute(ctx, successor.agent)).isError).toBe(false)
  })

  it('closes the discovered client when a later creation listener rejects', async () => {
    const { ctx, root, model } = await load(false, undefined, undefined, [TOOL, '<unlisted-tools>'])
    let initializing!: Agent
    await expect(ctx.agents.create({
      sessionId: brandString<SessionId>('later-listener-failure'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.on('agent/created', () => {
          expect(ctx.tools.getAll(agent).some(tool => tool.name === TOOL)).toBe(true)
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
          throw new Error('later initialization failed')
        })
      },
    })).rejects.toThrow('later initialization failed')
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(initializing.id)).toBeUndefined()
    expect(ctx.sessions.get(initializing.id)).toBeUndefined()
    expect(ctx.tools.getAll(initializing)).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    await expectEnded(root)
  })

  it('cancels before browser discovery without starting a process', async () => {
    const { ctx, root, model } = await load(false, 'gate')
    const controller = new AbortController()
    await expect(ctx.agents.create({
      sessionId: brandString<SessionId>('canceled-at-creation'), signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner) => {
        inner.on('agent/created', () => { controller.abort(new Error('cancel before discovery')) }, { prepend: true })
      },
    })).rejects.toThrow('cancel before discovery')
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(brandString<SessionId>('canceled-at-creation'))).toBeUndefined()
    await expect(readFile(join(root, 'events.ndjson'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a live server directory and starts the resumed server in the current Session directory', async () => {
    const { ctx, root } = await load()
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    await mkdir(join(root, 'original'))
    await mkdir(join(root, 'selected'))
    const original = await realpath(join(root, 'original'))
    const selected = await realpath(join(root, 'selected'))
    const sessionId = brandString<SessionId>('browser-directory')
    const first = await ctx.agents.create({ sessionId, meta: { cwd: original } })
    expect((await execute(ctx, first.agent)).isError).toBe(false)
    const initial = await events(root)
    const firstCall = initial.findLast(event => event.event === 'call')
    expect(firstCall).toMatchObject({ cwd: original })
    const starts = initial.filter(event => event.event === 'start').length

    await ctx.workingDirectory.set(first.agent, selected)
    expect(first.agent.session.header.cwd).toBe(original)
    expect((await execute(ctx, first.agent)).isError).toBe(false)
    const changed = await events(root)
    expect(changed.findLast(event => event.event === 'call')).toMatchObject({ cwd: original, pid: firstCall?.pid })
    expect(changed.filter(event => event.event === 'start')).toHaveLength(starts)
    await first.dispose()

    const resumed = await ctx.agents.resume({ resumeSessionId: sessionId })
    expect(resumed.agent.session.header.cwd).toBe(original)
    expect((await execute(ctx, resumed.agent)).isError).toBe(false)
    const reopened = await events(root)
    expect(reopened.findLast(event => event.event === 'call')).toMatchObject({ cwd: selected })
    expect(reopened.filter(event => event.event === 'start').length).toBeGreaterThan(starts)
    await resumed.dispose()
  })

  it('awaits discovery on persisted resume and releases a canceled resume before retry', async () => {
    const { ctx, root, model } = await load(true, 'gate')
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    await writeFile(join(root, 'release'), '')
    const sessionId = brandString<SessionId>('persisted-browser')
    const first = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(2)
    await first.dispose()
    await rm(join(root, 'release'))

    const controller = new AbortController()
    const canceledResume = observeActivation(ctx.agents.resume({
      resumeSessionId: sessionId, signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit again.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    }))
    await expect.poll(async () => (await events(root)).filter(event => event.event === 'probe')).toHaveLength(2)
    expect(model.requests).toHaveLength(2)
    controller.abort(new Error('cancel browser resume'))
    await expect(canceledResume).rejects.toThrow('cancel browser resume')
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    await expectEnded(root)

    let resumed = false
    const resuming = observeActivation(ctx.agents.resume({ resumeSessionId: sessionId }).then((handle) => {
      resumed = true
      return handle
    }))
    await expect.poll(async () => (await events(root)).filter(event => event.event === 'probe')).toHaveLength(3)
    expect(resumed).toBe(false)
    expect(model.requests).toHaveLength(2)
    await writeFile(join(root, 'release'), '')
    const owner = await resuming
    expect(ctx.tools.getAll(owner.agent).some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, owner.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
    await owner.dispose()
  })

  it('initializes only future activations after provider reload', async () => {
    const { ctx, root, browser } = await load()
    await browser.dispose()
    const existing = await ctx.agents.create({ sessionId: brandString<SessionId>('existing') })
    await ctx.plugin({
      inject: ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory'],
      apply(inner: Context) {
        mountSessionMcp(inner, { name: 'browser-fixture', exclusive: false, command: process.execPath, args: [fixture, root] })
      },
    })
    expect((await warm(ctx, existing.agent)).tools).toEqual([])
    const future = await ctx.agents.create({ sessionId: brandString<SessionId>('future') })
    expect((await warm(ctx, future.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, existing.agent)).isError).toBe(true)
    expect((await execute(ctx, future.agent)).isError).toBe(false)
  })
})
