import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import Llm, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig } from '../src/mcp.ts'

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))
const roots: string[] = []
const contexts: Context[] = []
const TOOL = 'mcp__browser-fixture__visit'

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FixtureModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.tools?.some(tool => tool.name === TOOL) && options.messages.at(-1)?.content[0]?.type === 'text') {
      const call = { type: 'tool-call' as const, id: ToolCallId('visit'), name: TOOL, arguments: '{"label":"fixture"}' }
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

async function load(exclusive = false, mode?: string, toolCallTimeoutMs?: number, toolOrder?: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-mcp-'))
  roots.push(root)
  const model = new FixtureModel()
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
    ['model', { inject: ['llm'], apply(ctx: Context) { ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model)) } }],
    ['browser', { inject: ['browserUse', 'agents', 'tools', 'systemPrompt'], apply(ctx: Context) {
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

function execute(ctx: Context, agent: Agent, name = TOOL) {
  return ctx.tools.execute({ agent, name, arguments: name === TOOL ? { label: 'direct' } : {}, callId: ToolCallId('direct'), signal: new AbortController().signal })
}

function resource(ctx: Context, agent: Agent | undefined, name = 'read_mcp_resource', server = 'browser-fixture', callId = name) {
  return ctx.tools.execute({
    ...agent === undefined ? {} : { agent }, name,
    arguments: { server, ...name === 'read_mcp_resource' ? { uri: 'browser-fixture://state' } : {} },
    callId: ToolCallId(callId), signal: new AbortController().signal,
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
  return (await readFile(join(root, 'events.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; pid: number; name?: string })
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
  await ctx.plugin(Agents)
  const tools = ctx.plugin(Tools)
  const browser = ctx.plugin({
    inject: ['browserUse', 'agents', 'tools', 'systemPrompt'],
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
    const first = await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    const second = await ctx.agents.create({ sessionId: SessionId('second') })
    expect(ctx.tools.schemas()).toEqual([])
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
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.tools.schemas(first.agent)).toHaveLength(2)
    const initial = await events(root)
    expect(initial.filter(event => event.event === 'start')).toHaveLength(4)
    expect(initial.filter(event => event.event === 'probe')).toHaveLength(2)
    expect(initial.filter(event => event.event === 'initialize')).toHaveLength(2)
    await first.dispose()
    expect(ctx.tools.schemas(first.agent)).toEqual([])
    const resumed = await ctx.agents.create({ sessionId: SessionId('first') })
    await warm(ctx, resumed.agent)
    expect((await execute(ctx, resumed.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
    await browser.dispose()
    expect(ctx.browserUse.providerName).toBeUndefined()
    const closed = await events(root)
    for (const { pid } of closed.filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  })

  it('keeps unrelated and child Sessions running without a busy attachment and admits a later owner', async () => {
    const { ctx, root, model } = await load(true)
    registerIndependentTool(ctx)
    const first = await ctx.agents.create({ sessionId: SessionId('first') })
    const second = await ctx.agents.create({ sessionId: SessionId('second'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    const child = await ctx.agents.create({
      sessionId: SessionId('child'), parentAgent: first.agent, agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (_inner, agent) => { bindScopeParent(agent, first.agent) },
    })
    await warm(ctx, first.agent)
    expect(ctx.tools.schemas(child.agent).some(tool => tool.name === TOOL)).toBe(false)
    for (const { agent } of [second, child]) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Answer without using the browser.' }], source: { kind: 'user' } }))
    }
    await Promise.all([second.agent.whenIdle(), child.agent.whenIdle()])
    expect(model.requests).toHaveLength(2)
    expect(model.requests.map(request => request.tools?.map(tool => tool.name))).toEqual([['unrelated'], ['unrelated']])
    for (const { agent } of [second, child]) {
      expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['unrelated'])
      expect((await execute(ctx, agent)).isError).toBe(true)
      expect((await execute(ctx, agent, 'unrelated')).isError).toBe(false)
      expect((await warm(ctx, agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    }
    first.agent.ctx.tools.register({
      name: 'mcp__browser-fixture__late', description: 'A newly discovered browser operation.', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Late browser result.' }] },
      execute: async () => true,
    })
    expect(ctx.tools.schemas(child.agent).filter(tool => tool.name.startsWith('mcp__browser-fixture__'))).toEqual([])
    expect((await warm(ctx, child.agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    expect((await execute(ctx, child.agent, 'mcp__browser-fixture__late')).isError).toBe(true)
    expect((await events(root)).filter(event => event.event === 'initialize')).toHaveLength(1)
    expect((await events(root)).filter(event => event.event === 'call')).toEqual([])
    expect((await execute(ctx, first.agent)).isError).toBe(false)
    await first.dispose()
    expect((await warm(ctx, child.agent)).tools.some(tool => tool.name === TOOL)).toBe(false)
    expect((await execute(ctx, child.agent)).isError).toBe(true)
    expect((await warm(ctx, second.agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    const successor = await ctx.agents.create({ sessionId: SessionId('successor') })
    expect((await warm(ctx, successor.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, successor.agent)).isError).toBe(false)
    await successor.dispose()
    await second.dispose()
    const resumed = await ctx.agents.create({ sessionId: SessionId('second') })
    expect((await warm(ctx, resumed.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, resumed.agent)).isError).toBe(false)
  })

  it('allows another Session to answer while attached-browser discovery is pending', async () => {
    const { ctx, root, model, browser } = await load(true, 'hold')
    const first = ctx.agents.create({ sessionId: SessionId('first') })
    const rejected = expect(first).rejects.toThrow()
    await vi.waitFor(async () => { expect((await events(root)).some(event => event.event === 'probe')).toBe(true) })
    const second = await ctx.agents.create({ sessionId: SessionId('second'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    second.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Answer without using the browser.' }], source: { kind: 'user' } }))
    await second.agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools ?? []).toEqual([])
    expect((await events(root)).filter(event => event.event === 'start')).toHaveLength(1)
    await browser.dispose()
    await rejected
    expect(ctx.agents.get(SessionId('first'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('first'))).toBeUndefined()
  })

  it('rolls back failed discovery and stops a child when unload interrupts discovery', async () => {
    const failed = await load(false, 'fail', undefined, [TOOL, '<unlisted-tools>'])
    let failedAgent!: Agent
    const laterListener = vi.fn()
    await expect(failed.ctx.agents.create({
      sessionId: SessionId('failure'), agentOptions: { provider: 'fixture', model: 'fixture' },
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
    expect(failed.ctx.tools.schemas(failedAgent)).toEqual([])
    const failedEvents = await events(failed.root)
    expect(failedEvents.filter(event => event.event === 'initialize')).toHaveLength(1)
    for (const { pid } of failedEvents.filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
    const held = await load(false, 'hold')
    const pendingOwner = held.ctx.agents.create({ sessionId: SessionId('pending') })
    const interrupted = expect(pendingOwner).rejects.toThrow()
    await vi.waitFor(async () => { expect((await events(held.root)).some(event => event.event === 'probe')).toBe(true) })
    await held.browser.dispose()
    await interrupted
    expect(held.ctx.agents.get(SessionId('pending'))).toBeUndefined()
    for (const { pid } of (await events(held.root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  })

  it('does not reconnect and silently replace browser state after a process exits', async () => {
    const { ctx, root } = await load()
    const owner = await ctx.agents.create({ sessionId: SessionId('disconnect') })
    await warm(ctx, owner.agent)
    const servingPid = (await events(root)).find(event => event.event === 'initialize')!.pid
    await execute(ctx, owner.agent, 'mcp__browser-fixture__disconnect')
    await vi.waitFor(() => { expect(() => process.kill(servingPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })) })
    await warm(ctx, owner.agent)
    expect((await events(root)).filter(event => event.event === 'initialize')).toHaveLength(1)
    expect((await execute(ctx, owner.agent)).isError).toBe(true)
  })

  it('keeps browser ownership exact when scopes inherit tools and leaves unrelated tools usable', async () => {
    const { ctx } = await load()
    await ctx.systemPrompt.assemble()
    const owner = await ctx.agents.create({ sessionId: SessionId('parent') })
    const child = await ctx.agents.create({
      sessionId: SessionId('child'), parentAgent: owner.agent,
      setup: (_inner, agent) => { bindScopeParent(agent, owner.agent) },
    })
    await warm(ctx, owner.agent)
    registerIndependentTool(ctx)
    expect((await execute(ctx, owner.agent, 'unrelated')).content).toEqual([{ type: 'text', text: 'Independent.' }])
    await warm(ctx, child.agent)
    expect((await execute(ctx, child.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
  })

  it('denies inherited browser resources and instructions while keeping unrelated MCP servers usable', async () => {
    const { ctx, root } = await load(true)
    await ctx.plugin(McpResources)
    ctx.mcpResources.register('docs', { request: async () => ({ contents: [{ uri: 'docs://memo', text: 'Independent document.' }] }) })
    const parent = await ctx.agents.create({ sessionId: SessionId('resource-parent') })
    const child = await ctx.agents.create({
      sessionId: SessionId('resource-child'), parentAgent: parent.agent,
      setup: (_inner, agent) => { bindScopeParent(agent, parent.agent) },
    })
    expect(renderPrompt(await warm(ctx, parent.agent))).toContain('BROWSER_FIXTURE_INSTRUCTION')
    const blocked = await warm(ctx, child.agent)
    expect(blocked.tools.some(tool => tool.name === TOOL)).toBe(false)
    expect(renderPrompt(blocked)).not.toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect(renderPrompt(blocked)).toContain('browser-fixture')
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      expect((await resource(ctx, child.agent, name)).isError).toBe(true)
    }
    expect((await resource(ctx, undefined)).isError).toBe(true)
    expect((await events(root)).filter(event => event.event === 'resource')).toEqual([])
    expect((await resource(ctx, child.agent, 'read_mcp_resource', 'docs')).value)
      .toEqual({ contents: [{ uri: 'docs://memo', text: 'Independent document.' }] })
    for (const args of [null, 'invalid arguments']) {
      expect((await ctx.tools.execute({ agent: child.agent, name: 'read_mcp_resource', arguments: args, callId: ToolCallId('invalid-resource'), signal: new AbortController().signal })).isError).toBe(true)
    }
    expect(browserState(await resource(ctx, parent.agent)).counter).toBe(0)
    await parent.dispose()
    expect(renderPrompt(await warm(ctx, child.agent))).not.toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect((await resource(ctx, child.agent)).isError).toBe(true)
    const successor = await ctx.agents.create({ sessionId: SessionId('resource-successor') })
    expect(renderPrompt(await warm(ctx, successor.agent))).toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect(browserState(await resource(ctx, successor.agent)).counter).toBe(0)
  })

  it('uses the child connection for resources and serializes them with browser tools exactly once', async () => {
    const { ctx } = await load()
    await ctx.plugin(McpResources)
    const parent = await ctx.agents.create({ sessionId: SessionId('parent') })
    const child = await ctx.agents.create({
      sessionId: SessionId('child'), parentAgent: parent.agent,
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
    expect((await execute(ctx, child.agent, 'mcp__browser-fixture__parent_only')).isError).toBe(true)
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
        if (exec.callId === ToolCallId('held-resource')) {
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
    const creation = ctx.agents.create({
      sessionId: SessionId('ptc-first-request'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.tools.presentAs('ptc')
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Describe the available browser tools.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    }).then((handle) => {
      created = true
      return handle
    })
    await vi.waitFor(async () => { expect((await events(root)).some(event => event.event === 'probe')).toBe(true) })
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
    const creation = ctx.agents.create({
      sessionId: SessionId('canceled-startup'), signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    })
    const rejected = expect(creation).rejects.toThrow('cancel browser startup')
    await vi.waitFor(async () => { expect((await events(root)).some(event => event.event === 'probe')).toBe(true) })
    controller.abort(new Error('cancel browser startup'))
    await rejected
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(initializing.id)).toBeUndefined()
    expect(ctx.sessions.get(initializing.id)).toBeUndefined()
    expect(ctx.tools.schemas(initializing)).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    for (const { pid } of (await events(root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
    await writeFile(join(root, 'release'), '')
    const successor = await ctx.agents.create({ sessionId: initializing.id })
    expect((await execute(ctx, successor.agent)).isError).toBe(false)
  })

  it('closes the discovered client when a later creation listener rejects', async () => {
    const { ctx, root, model } = await load(false, undefined, undefined, [TOOL, '<unlisted-tools>'])
    let initializing!: Agent
    await expect(ctx.agents.create({
      sessionId: SessionId('later-listener-failure'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.on('agent/created', () => {
          expect(ctx.tools.schemas(agent).some(tool => tool.name === TOOL)).toBe(true)
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
          throw new Error('later initialization failed')
        })
      },
    })).rejects.toThrow('later initialization failed')
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(initializing.id)).toBeUndefined()
    expect(ctx.sessions.get(initializing.id)).toBeUndefined()
    expect(ctx.tools.schemas(initializing)).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    for (const { pid } of (await events(root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  })

  it('cancels before browser discovery without starting a process', async () => {
    const { ctx, root, model } = await load(false, 'gate')
    const controller = new AbortController()
    await expect(ctx.agents.create({
      sessionId: SessionId('canceled-at-creation'), signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner) => {
        inner.on('agent/created', () => { controller.abort(new Error('cancel before discovery')) }, { prepend: true })
      },
    })).rejects.toThrow('cancel before discovery')
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(SessionId('canceled-at-creation'))).toBeUndefined()
    await expect(readFile(join(root, 'events.ndjson'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('awaits discovery on persisted resume and releases a canceled resume before retry', async () => {
    const { ctx, root, model } = await load(true, 'gate')
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    await writeFile(join(root, 'release'), '')
    const sessionId = SessionId('persisted-browser')
    const first = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(2)
    await first.dispose()
    await rm(join(root, 'release'))

    const controller = new AbortController()
    const canceledResume = ctx.agents.resume({
      resumeSessionId: sessionId, signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit again.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    })
    const rejected = expect(canceledResume).rejects.toThrow('cancel browser resume')
    await vi.waitFor(async () => { expect((await events(root)).filter(event => event.event === 'probe')).toHaveLength(2) })
    expect(model.requests).toHaveLength(2)
    controller.abort(new Error('cancel browser resume'))
    await rejected
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    for (const { pid } of (await events(root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }

    let resumed = false
    const resuming = ctx.agents.resume({ resumeSessionId: sessionId }).then((handle) => {
      resumed = true
      return handle
    })
    await vi.waitFor(async () => { expect((await events(root)).filter(event => event.event === 'probe')).toHaveLength(3) })
    expect(resumed).toBe(false)
    expect(model.requests).toHaveLength(2)
    await writeFile(join(root, 'release'), '')
    const owner = await resuming
    expect(ctx.tools.schemas(owner.agent).some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, owner.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
    await owner.dispose()
  })

  it('initializes only future activations after provider reload', async () => {
    const { ctx, root, browser } = await load()
    await browser.dispose()
    const existing = await ctx.agents.create({ sessionId: SessionId('existing') })
    await ctx.plugin({
      inject: ['browserUse', 'agents', 'tools', 'systemPrompt'],
      apply(inner: Context) {
        mountSessionMcp(inner, { name: 'browser-fixture', exclusive: false, command: process.execPath, args: [fixture, root] })
      },
    })
    expect((await warm(ctx, existing.agent)).tools).toEqual([])
    const future = await ctx.agents.create({ sessionId: SessionId('future') })
    expect((await warm(ctx, future.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, existing.agent)).isError).toBe(true)
    expect((await execute(ctx, future.agent)).isError).toBe(false)
  })
})
