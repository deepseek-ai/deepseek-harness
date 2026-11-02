/** Scoped executor selection and lifetime through the real Agent loop. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, ToolsService } from '@deepseek-ai/dsh-tools'
import type { ToolExecutor, ToolBatchInput, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import AgentLoop from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/** An independent execution implementation: no PTC executor inheritance or delegation. */
function independent(ctx: Context, name: string, trace: string[]): ToolExecutor {
  const transport = defineTool({
    name, description: `Execute through ${name}.`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      const tool = ctx.tools.get('echo', exec.agent)
      if (tool === undefined) throw new Error('echo is not visible')
      return `${name}:${String(await tool.execute({}, exec))}`
    },
  })
  const executor: ToolExecutor = {
    sections: [
      { name: 'tools:transport', order: 800, text: `Call ${name}.`, interpolate: false },
      { name: 'tools:sdk', order: 5000, text: tools => tools.map(tool => tool.name).join(', '), interpolate: false },
    ],
    describe: () => ({ schemas: [transport], knownNames: [name] }),
    async execute(input) {
      trace.push(`${name}:execute`)
      const results = []
      for (const call of input.calls) {
        if (call.name !== name) throw new Error(`unexpected transport ${call.name}`)
        const callSeq = input.log === undefined ? undefined : input.agent!.session.append('tool/call', {
          turn: input.log.turn, step: input.log.step,
          callId: call.id, name: call.name, arguments: call.arguments,
        }).seq
        const exec: ToolRunContext = {
          callId: call.id, name: call.name, arguments: JSON.parse(call.arguments), signal: input.signal,
          ...input.agent === undefined ? {} : { agent: input.agent },
          rootCallId: call.id, token: Symbol() as ToolExecutionToken,
          deferContext() {}, concludeTurn() {},
        }
        const value = String(await transport.execute(exec.arguments, exec))
        const result = { isError: false as const, value, content: [{ type: 'text' as const, text: value }] }
        if (input.log !== undefined) {
          const { agent, log: { turn, step } } = input
          agent!.session.append('tool/result', {
            turn, step, message: createToolResultMessage({ callId: call.id, content: result.content, isError: false }),
          }, { surfaceOp: 'append', ...callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] } })
        }
        results.push({ callId: call.id, result })
      }
      return { results, additionalContexts: [], concluded: false }
    },
  }
  return executor
}

async function setup(adapter = new MockAdapter([]), maxParallelToolCalls?: number) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
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

it('shares the registry and selects an independent executor through the preset scope chain', async () => {
  const trace: string[] = []
  const adapter = new MockAdapter([
    toolCallResponse('sdk-call', 'sdk_eval', {}), textResponse('sdk done'),
    toolCallResponse('native-call', 'echo', {}), textResponse('native done'),
  ])
  const ctx = await setup(adapter)
  const presetKey = { preset: 'sdk' }
  const preset = await scoped(ctx, presetKey)
  preset.ctx.tools.setExecutor(independent(preset.ctx, 'sdk_eval', trace))
  const sdk = await ctx.agentLoop.create(SessionId('sdk'), { provider: 'mock', model: 'mock' })
  bindScopeParent(sdk, presetKey)
  const native = await ctx.agentLoop.create(SessionId('native'), { provider: 'mock', model: 'mock' })
  expect(ctx.tools).toBeInstanceOf(ToolsService)
  expect('registerExecutor' in ctx.tools).toBe(false)
  expect(sdk.ctx.tools.get('echo', sdk)).toBe(ctx.tools.get('echo'))
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

it('dispatches through the current Agent scope after prompt listeners rebuild the assembly', async () => {
  const trace: string[] = []
  const adapter = new MockAdapter([
    () => { selectNearer(); return toolCallResponse('held', 'first_eval', {}) },
    textResponse('done'),
  ])
  const ctx = await setup(adapter)
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const { sections, contexts, variables } = await next()
    return { sections, contexts, variables }
  })
  const presetKey = { preset: 'first' }
  const preset = await scoped(ctx, presetKey)
  preset.ctx.tools.setExecutor(independent(preset.ctx, 'first_eval', trace))
  const agent = await ctx.agentLoop.create(SessionId('changing'), { provider: 'mock', model: 'mock' })
  bindScopeParent(agent, presetKey)
  const selectNearer = () => {
    const nearer = independent(agent.ctx, 'first_eval', trace)
    const execute = nearer.execute.bind(nearer)
    nearer.execute = (input) => { trace.push('nearer'); return execute(input) }
    agent.ctx.tools.setExecutor(nearer)
  }
  await run(ctx, agent)
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['first_eval'])
  expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toEqual(['first_eval'])
  expect(trace).toEqual(['nearer', 'first_eval:execute'])
})

it('rejects new batches after unload while an accepted batch settles on its original executor', async () => {
  const trace: string[] = []
  const ctx = await setup()
  const key = { preset: 'temporary' }
  const scope = await scoped(ctx, key)
  const agent = await ctx.agentLoop.create(SessionId('temporary'), { provider: 'mock', model: 'mock' })
  bindScopeParent(agent, key)
  const provider = independent(scope.ctx, 'old_eval', trace)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const execute = provider.execute.bind(provider)
  provider.execute = async (input) => { entered.resolve(undefined); await release.promise; return execute(input) }
  const dispose = scope.ctx.tools.setExecutor(provider)
  const input = {
    calls: [{ type: 'tool-call', name: 'old_eval', id: ToolCallId('accepted'), arguments: '{}' }],
    signal: new AbortController().signal,
    agent,
  } satisfies ToolBatchInput
  const pending = ctx.tools.execute(input)
  await entered.promise
  dispose()
  await expect(ctx.systemPrompt.assemble({ scope: key })).rejects.toThrow('selected tool executor is unavailable')
  await expect(ctx.tools.execute(input)).rejects.toThrow('selected tool executor is unavailable')
  scope.ctx.tools.setExecutor(independent(scope.ctx, 'replacement_eval', trace))
  release.resolve(undefined)
  const result = await pending
  expect(result.results[0]?.result).toMatchObject({ isError: false, value: 'old_eval:shared' })
  const replacement = await ctx.tools.execute({
    ...input,
    calls: [{ type: 'tool-call', name: 'replacement_eval', id: ToolCallId('replacement'), arguments: '{}' }],
  })
  expect(replacement.results[0]?.result).toMatchObject({ isError: false, value: 'replacement_eval:shared' })
  expect(trace).toEqual(['old_eval:execute', 'replacement_eval:execute'])
})

it('refreshes executor projections without emitting tool registry changes', async () => {
  const ctx = await setup()
  let registryChanges = 0
  ctx.on('tools/change', () => { registryChanges++ })
  const key = { preset: 'refresh' }
  const scope = await scoped(ctx, key)
  const context: AssembleContext = { scope: key }
  expect((await ctx.systemPrompt.assemble(context)).tools.map(tool => tool.name)).toEqual(['echo'])
  const dispose = scope.ctx.tools.setExecutor(independent(scope.ctx, 'new_eval', []))
  expect((await ctx.systemPrompt.assemble(context)).tools.map(tool => tool.name)).toEqual(['new_eval'])
  expect(registryChanges).toBe(0)
  dispose()
  await expect(ctx.systemPrompt.assemble(context)).rejects.toThrow('selected tool executor is unavailable')
  expect(registryChanges).toBe(0)
})

it.each([
  ['occupied', 1, 'already registered'],
  ['invalid-order', Number.NaN, 'order must be a finite number'],
] as const)('rolls back executor section registrations when %s is rejected', async (name, order, message) => {
  const ctx = await setup()
  const key = { preset: name }
  const scope = await scoped(ctx, key)
  scope.ctx.systemPrompt.section({ name: 'occupied', order: 1, text: 'Existing guidance.' })
  const executor: ToolExecutor = {
    ...independent(scope.ctx, 'rejected_eval', []),
    sections: [
      { name: 'transient', order: 0, text: 'Must be rolled back.' },
      { name, order, text: 'Invalid contribution.' },
    ],
  }
  expect(() => scope.ctx.tools.setExecutor(executor)).toThrow(message)
  const assembly = await ctx.systemPrompt.assemble({ scope: key })
  expect(assembly.tools.map(tool => tool.name)).toEqual(['echo'])
  expect(assembly.sections.map(section => section.name)).not.toContain('transient')
})

it('assembles independent tools and section text for overlapping prompt assemblies', async () => {
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
  const replacement = independent(scope.ctx, 'next_eval', [])
  const describe = replacement.describe.bind(replacement)
  let projections = 0
  replacement.describe = (tools) => { projections++; return describe(tools) }
  let second: PromptAssembly
  try {
    scope.ctx.tools.setExecutor(replacement)
    second = await ctx.systemPrompt.assemble(context)
  } finally {
    release()
  }
  const first = await pending
  expect(first.tools.map(tool => tool.name)).toEqual(['echo'])
  expect(first).not.toHaveProperty('toolExecutor')
  expect(second.tools.map(tool => tool.name)).toEqual(['next_eval'])
  expect(second.sections).toContainEqual({ name: 'tools:transport', text: 'Call next_eval.', interpolate: false })
  expect(second.sections).toContainEqual({ name: 'tools:sdk', text: 'echo', interpolate: false })
  expect(projections).toBe(1)
})

it('keeps the foundation usable for registration and requires an explicit executor for calls', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.tools.register(defineTool({
    name: 'echo', description: 'Registered without an executor.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'shared',
  }))
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['echo'])
  await expect(ctx.systemPrompt.assemble()).rejects.toThrow('selected tool executor is unavailable')
  await expect(ctx.tools.execute({
    calls: [{ type: 'tool-call', name: 'echo', id: ToolCallId('unconfigured'), arguments: '{}' }], signal: new AbortController().signal,
  })).rejects.toThrow('selected tool executor is unavailable')
})

it.each([undefined, 1, 6])('hands the executor raw calls and the resolved loop limit %s', async (maxParallelToolCalls) => {
  const raw = ['{ "value": 1 }', '[2, 3]']
  const adapter = new MockAdapter([[
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('one'), name: 'custom', arguments: raw[0]! } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('two'), name: 'custom', arguments: raw[1]! } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ], textResponse('done')])
  const ctx = await setup(adapter, maxParallelToolCalls)
  const agent = await ctx.agentLoop.create(SessionId('raw-batch'), { provider: 'mock', model: 'mock' })
  const executor = independent(agent.ctx, 'custom', [])
  const batches: ToolBatchInput[] = []
  const execute = executor.execute.bind(executor)
  executor.execute = (input) => { batches.push(input); return execute(input) }
  agent.ctx.tools.setExecutor(executor)
  await run(ctx, agent)
  expect(batches).toHaveLength(1)
  expect(batches[0]?.calls.map(call => call.arguments)).toEqual(raw)
  expect(batches[0]?.agent).toBe(agent)
  expect(batches[0]?.log).toMatchObject({ turn: 1, step: 1 })
  expect(batches[0]?.maxParallelToolCalls).toBe(maxParallelToolCalls ?? 10)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data.message.toolCallId))
    .toEqual(['one', 'two'])
})

it('keeps Agent scope without a model step and logs raw calls only with a logging step', async () => {
  const ctx = await setup()
  const agent = await ctx.agentLoop.create(SessionId('batch-scope'), { provider: 'mock', model: 'mock' })
  agent.ctx.tools.restrict({ deny: ['echo'] })
  const input = {
    calls: [{ type: 'tool-call', id: ToolCallId('scoped'), name: 'echo', arguments: '{ }' }],
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
