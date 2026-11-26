/** Scoped root registry selection and lifetime through the real Agent loop. */
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { createUserMessage, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, ToolsService } from '@deepseek-ai/dsh-tools'
import { ToolStep } from '@deepseek-ai/dsh-tools/pipeline'
import type { ToolRegistry, ToolBatchInput } from '@deepseek-ai/dsh-tools'
import AgentLoop from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/**
 * A root with one transport entry of its own and no native or PTC registry behind it.
 * The entry runs `echo` from the registrations the root received.
 */
function independent(name: string, trace: string[], before?: () => Promise<void>): ToolRegistry {
  const sources: Pick<ToolRegistry, 'get'>[] = []
  const transport = defineTool({
    name, description: `Execute through ${name}.`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      trace.push(`${name}:execute`)
      await before?.()
      const tool = sources.map(source => source.get('echo', exec.agent)).find(found => found !== undefined)
      if (tool === undefined) throw new Error('echo is not visible')
      return `${name}:${String(await tool.execute({}, exec))}`
    },
  })
  return {
    register: () => { throw new Error(`${name} has no registrations`) },
    include: (source) => {
      sources.push(source)
      return () => { sources.splice(sources.indexOf(source), 1) }
    },
    get: entry => entry === name ? transport : undefined,
    getAll: () => [transport],
  }
}

async function setup(adapter = new MockAdapter([]), maxParallelToolCalls?: number) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [], ...maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls } })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineTool({
    name: 'echo', description: 'Shared capability.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'shared',
  }))
  return ctx
}

async function scoped(ctx: Context, key: ScopeKey): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
    { inject: ['tools', 'systemPrompt'] }))
  return scope
}

async function run(ctx: Context, agent: Agent): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', (event) => {
      if (event.agent === agent && event.status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await idle
}

/** One assistant response calling every named tool without arguments. */
function toolCalls(...names: string[]): StreamChunk[] {
  return [
    ...names.flatMap((name, index): StreamChunk[] => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: brandString<ToolCallId>(`call-${name}`), name, arguments: '{}' } },
    ]),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

it('shares the registry and selects an independent root through the preset scope chain', async () => {
  const trace: string[] = []
  const adapter = new MockAdapter([
    toolCallResponse('sdk-call', 'sdk_eval', {}), textResponse('sdk done'),
    toolCallResponse('native-call', 'echo', {}), textResponse('native done'),
  ])
  const ctx = await setup(adapter)
  const presetKey = { preset: 'sdk' }
  const preset = await scoped(ctx, presetKey)
  preset.ctx.tools.setRoot(independent('sdk_eval', trace))
  const sdk = await ctx.agentLoop.create(brandString<SessionId>('sdk'), { provider: 'mock', model: 'mock' })
  bindScopeParent(sdk, presetKey)
  const native = await ctx.agentLoop.create(brandString<SessionId>('native'), { provider: 'mock', model: 'mock' })
  expect(ctx.tools).toBeInstanceOf(ToolsService)
  expect('registerExecutor' in ctx.tools).toBe(false)
  expect('setExecutor' in ctx.tools).toBe(false)
  // ctx.tools answers from each Agent's selected root.
  expect(sdk.ctx.tools.get('echo', sdk)).toBeUndefined()
  expect(sdk.ctx.tools.getAll(sdk).map(tool => tool.name)).toEqual(['sdk_eval'])
  expect(native.ctx.tools.get('echo', native)).toBe(ctx.tools.get('echo'))
  await run(ctx, sdk)
  await run(ctx, native)
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['sdk_eval'])
  expect(adapter.requests[2]?.tools?.map(tool => tool.name)).toEqual(['echo'])
  expect(trace).toEqual(['sdk_eval:execute'])
  expect(sdk.session.snapshotEvents().find(event => event.type === 'tool/result')).toMatchObject({
    data: { message: { content: [{ type: 'text', text: 'sdk_eval:shared' }], isError: false } },
  })
})

it('dispatches through the root selected at dispatch, which runs only entries the step declared', async () => {
  const bodies: string[] = []
  const evaluator = (label: string) => defineTool({
    name: 'first_eval', description: `Evaluate through ${label}.`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { bodies.push(label); return label },
  })
  const trace: string[] = []
  const whileResponding: (() => void)[] = []
  const adapter = new MockAdapter([
    () => { for (const change of whileResponding) change(); return toolCalls('first_eval', 'echo') },
    textResponse('done'),
  ])
  const ctx = await setup(adapter)
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const { sections, contexts, variables } = await next()
    return { sections, contexts, variables }
  })
  const presetKey = { preset: 'first' }
  const preset = await scoped(ctx, presetKey)
  const presetRoot = new NativeToolRegistry.NativeToolRegistry()
  presetRoot.register(evaluator('preset'))
  preset.ctx.tools.setRoot(presetRoot)
  const agent = await ctx.agentLoop.create(brandString<SessionId>('changing'), { provider: 'mock', model: 'mock' })
  bindScopeParent(agent, presetKey)
  whileResponding.push(() => {
    const nearer = new NativeToolRegistry.NativeToolRegistry()
    nearer.register(evaluator('nearer'))
    const get = nearer.get.bind(nearer)
    nearer.get = (name, scope) => { trace.push(name); return get(name, scope) }
    agent.ctx.tools.setRoot(nearer)
  })
  await run(ctx, agent)
  expect(adapter.requests.map(request => request.tools?.map(tool => tool.description).sort())).toEqual([
    ['Evaluate through preset.', 'Shared capability.'], ['Evaluate through nearer.', 'Shared capability.'],
  ])
  // The batch resolves both calls through the nearer root selected at dispatch.
  expect(new Set(trace)).toEqual(new Set(['first_eval', 'echo']))
  // The nearer root's same-name entry is not the one the step declared; the shared definition is.
  expect(bodies).toEqual([])
  const results = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [event.data] : [])
  expect(results.map(result => [result.message.toolCallId, result.error?.code])).toEqual([
    ['call-first_eval', 'UNKNOWN_TOOL'], ['call-echo', undefined],
  ])
  expect(results[1]?.message.content).toEqual([{ type: 'text', text: 'shared' }])
})

it('fails a step whose selected root is unavailable before admitting model-visible input', async () => {
  const adapter = new MockAdapter([textResponse('unused')])
  const ctx = await setup(adapter)
  const key = { preset: 'unloaded' }
  const scope = await scoped(ctx, key)
  const agent = await ctx.agentLoop.create(brandString<SessionId>('unloaded'), { provider: 'mock', model: 'mock' })
  bindScopeParent(agent, key)
  scope.ctx.tools.setRoot(independent('unloaded_eval', []))()
  expect(() => ToolStep.capture(ctx.tools, agent)).toThrow(expect.objectContaining({ code: 'TOOL_REGISTRY_UNAVAILABLE' }) as Error)
  await run(ctx, agent)
  expect(adapter.requests).toEqual([])
  expect(agent.session.snapshotEvents().filter(event => ['request/header', 'system/message', 'user/message'].includes(event.type))).toEqual([])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data).toMatchObject({
    reason: { kind: 'error', error: { message: expect.stringContaining('selected tool registry is unavailable') as string } },
  })
})

it('rejects new batches after unload while an accepted batch settles on its original root', async () => {
  const trace: string[] = []
  const ctx = await setup()
  const key = { preset: 'temporary' }
  const scope = await scoped(ctx, key)
  const agent = await ctx.agentLoop.create(brandString<SessionId>('temporary'), { provider: 'mock', model: 'mock' })
  bindScopeParent(agent, key)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const provider = independent('old_eval', trace, async () => { entered.resolve(undefined); await release.promise })
  const dispose = scope.ctx.tools.setRoot(provider)
  const input = {
    calls: [{ type: 'tool-call', name: 'old_eval', id: brandString<ToolCallId>('accepted'), arguments: '{}' }],
    signal: new AbortController().signal,
    agent,
  } satisfies ToolBatchInput
  const pending = ctx.tools.execute(input)
  await entered.promise
  dispose()
  await expect(ctx.systemPrompt.assemble({ scope: key })).rejects.toThrow('selected tool registry is unavailable')
  await expect(ctx.tools.execute(input)).rejects.toMatchObject({ code: 'TOOL_REGISTRY_UNAVAILABLE' })
  scope.ctx.tools.setRoot(independent('replacement_eval', trace))
  release.resolve(undefined)
  const result = await pending
  expect(result.results[0]?.result).toMatchObject({ isError: false, value: 'old_eval:shared' })
  const replacement = await ctx.tools.execute({
    ...input,
    calls: [{ type: 'tool-call', name: 'replacement_eval', id: brandString<ToolCallId>('replacement'), arguments: '{}' }],
  })
  expect(replacement.results[0]?.result).toMatchObject({ isError: false, value: 'replacement_eval:shared' })
  expect(trace).toEqual(['old_eval:execute', 'replacement_eval:execute'])
})

it('refreshes root projections and emits a tool registry change when a root is selected or unloads', async () => {
  const ctx = await setup()
  let registryChanges = 0
  ctx.on('tools/change', () => { registryChanges++ })
  const key = { preset: 'refresh' }
  const scope = await scoped(ctx, key)
  const context: AssembleContext = { scope: key }
  expect((await ctx.systemPrompt.assemble(context)).tools.map(tool => tool.name)).toEqual(['echo'])
  const dispose = scope.ctx.tools.setRoot(independent('new_eval', []))
  expect((await ctx.systemPrompt.assemble(context)).tools.map(tool => tool.name)).toEqual(['new_eval'])
  expect(registryChanges).toBe(1)
  dispose()
  await expect(ctx.systemPrompt.assemble(context)).rejects.toThrow('selected tool registry is unavailable')
  expect(registryChanges).toBe(2)
})

it('rejects a second live root in one scope and keeps the first selected', async () => {
  const ctx = await setup()
  const key = { preset: 'occupied' }
  const scope = await scoped(ctx, key)
  scope.ctx.tools.setRoot(independent('first_eval', []))
  expect(() => scope.ctx.tools.setRoot(independent('second_eval', [])))
    .toThrow('Only one root tool registry may be installed in each scope')
  expect((await ctx.systemPrompt.assemble({ scope: key })).tools.map(tool => tool.name)).toEqual(['first_eval'])
})

it('assembles independent tools for overlapping prompt assemblies', async () => {
  const ctx = await setup()
  const key = { preset: 'overlapping' }
  const scope = await scoped(ctx, key)
  const context: AssembleContext = { scope: key }
  let entered!: () => void
  const reached = new Promise<void>((resolve) => { entered = resolve })
  let release!: () => void
  const resume = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    if (calls++ === 0) { entered(); await resume }
    return { ...await next() }
  })
  const pending = ctx.systemPrompt.assemble(context)
  await reached
  const replacement = independent('next_eval', [])
  let projections = 0
  let second: PromptAssembly
  try {
    scope.ctx.tools.setRoot(replacement)
    // Count only the assemblies' projections, not the selection's probe.
    const getAll = replacement.getAll.bind(replacement)
    replacement.getAll = (viewer) => { projections++; return getAll(viewer) }
    second = await ctx.systemPrompt.assemble(context)
  } finally {
    release()
  }
  const first = await pending
  expect(first.tools.map(tool => tool.name)).toEqual(['echo'])
  expect(first).not.toHaveProperty('toolExecutor')
  expect(second.tools.map(tool => tool.name)).toEqual(['next_eval'])
  expect(projections).toBe(1)
})

it('keeps the foundation usable for registration and requires an explicit root for calls', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.tools.register(defineTool({
    name: 'echo', description: 'Registered without a root.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'shared',
  }))
  expect(() => ctx.tools.getAll()).toThrow('selected tool registry is unavailable')
  expect(() => ctx.tools.get('echo')).toThrow('selected tool registry is unavailable')
  await expect(ctx.systemPrompt.assemble()).rejects.toThrow('selected tool registry is unavailable')
  await expect(ctx.tools.execute({
    calls: [{ type: 'tool-call', name: 'echo', id: brandString<ToolCallId>('unconfigured'), arguments: '{}' }], signal: new AbortController().signal,
  })).rejects.toMatchObject({ name: 'ToolRegistryUnavailableError', code: 'TOOL_REGISTRY_UNAVAILABLE' })
  // A root selected later receives the registrations made before it.
  ctx.tools.setRoot(new NativeToolRegistry.NativeToolRegistry())
  expect(ctx.tools.getAll().map(tool => tool.name)).toEqual(['echo'])
})

it.each([undefined, 1, 6])('hands ctx.tools raw calls, the step declarations, and the resolved loop limit %s', async (maxParallelToolCalls) => {
  const raw = ['{ "value": 1 }', '[2, 3]']
  const adapter = new MockAdapter([[
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>('one'), name: 'custom', arguments: raw[0]! } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: brandString<ToolCallId>('two'), name: 'custom', arguments: raw[1]! } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ], textResponse('done')])
  const ctx = await setup(adapter, maxParallelToolCalls)
  const agent = await ctx.agentLoop.create(brandString<SessionId>('raw-batch'), { provider: 'mock', model: 'mock' })
  const root = independent('custom', [])
  agent.ctx.tools.setRoot(root)
  const execute = vi.spyOn(ToolsService.prototype, 'execute')
  onTestFinished(() => { execute.mockRestore() })
  await run(ctx, agent)
  const batches = execute.mock.calls.map(([input]) => input)
  expect(batches).toHaveLength(1)
  expect(batches[0]?.calls.map(call => call.arguments)).toEqual(raw)
  expect(batches[0]?.agent).toBe(agent)
  expect(batches[0]?.log).toMatchObject({ turn: 1, step: 1 })
  expect(batches[0]?.maxParallelToolCalls).toBe(maxParallelToolCalls ?? 10)
  expect(batches[0]?.toolStep?.agent).toBe(agent)
  expect(batches[0]?.toolStep?.declarations).toEqual([root.get('custom')])
  expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data.message.toolCallId))
    .toEqual(['one', 'two'])
})

it('keeps Agent scope without a model step and logs raw calls only with a logging step', async () => {
  const ctx = await setup()
  const agent = await ctx.agentLoop.create(brandString<SessionId>('batch-scope'), { provider: 'mock', model: 'mock' })
  agent.ctx.tools.restrict({ deny: ['echo'] })
  const input = {
    calls: [{ type: 'tool-call', id: brandString<ToolCallId>('scoped'), name: 'echo', arguments: '{ }' }],
    signal: new AbortController().signal,
  } satisfies ToolBatchInput
  const scoped = await ctx.tools.execute({ ...input, agent })
  expect(scoped.results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(0)
  const owned = await ctx.tools.execute({ ...input, agent, log: { turn: 1, step: 1 } })
  expect(owned.results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
  const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.data.arguments).toBe('{ }')
  const unowned = await ctx.tools.execute(input)
  expect(unowned.results[0]?.result).toMatchObject({ isError: false, value: 'shared' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(1)
})
