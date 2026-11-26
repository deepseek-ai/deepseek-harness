/** Root selection, live inclusion, per-Agent tools, and model-step admission. */
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeRoot from '@deepseek-ai/dsh-tool-registry-native'
import { NativeToolRegistry } from '@deepseek-ai/dsh-tool-registry-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME, ToolCompositionError, ToolRegistryUnavailableError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult, ToolRegistry } from '@deepseek-ai/dsh-tools'
import { AgentToolRegistry, ToolEntries, ToolStep } from '@deepseek-ai/dsh-tools/pipeline'

const signal = new AbortController().signal
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function mount(options: { root?: boolean; toolOrder?: string[] } = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, options.toolOrder === undefined ? {} : { toolOrder: options.toolOrder })
  await ctx.plugin(ToolRuntime)
  if (options.root !== false) await ctx.plugin(NativeRoot)
  return ctx
}

/** Mint a scope whose key is an Agent-like object, optionally under a parent scope key. */
async function agentScope(ctx: Context, id: string, parent?: object): Promise<{ scope: Scope; agent: Agent }> {
  const agent = { id: brandString<SessionId>(id) } as Agent
  if (parent !== undefined) bindScopeParent(agent, parent)
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
  return { scope, agent }
}

/** Mint a non-Agent scope such as a preset. */
async function presetScope(ctx: Context): Promise<{ scope: Scope; key: object }> {
  const key = {}
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  return { scope, key }
}

function tool(name: string, reply = `ran:${name}`): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
    execute: (): Promise<string> => Promise.resolve(reply),
  }
}

function text(result: ToolExecutionResult): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

/** Execute one model call through the Agent's selected root. */
async function call(ctx: Context, name: string, agent?: Agent, toolStep?: ToolStep): Promise<ToolExecutionResult> {
  return executeModelToolFixture(ctx, {
    callId: brandString<ToolCallId>(`call-${name}`), name, arguments: {}, signal,
    ...agent === undefined ? {} : { agent },
    ...toolStep === undefined ? {} : { toolStep },
  })
}

const names = (tools: readonly ToolDefinition[]): string[] => tools.map(entry => entry.name)

/** The failure a model sees for a call whose tool composition is invalid. */
const misconfigured = (name: string): unknown => ({
  message: `tool "${name}" cannot run because it is misconfigured in this environment; do not retry it; use another tool or tell the user`,
  info: { name: 'ToolCompositionError', code: 'INVALID_TOOL_COMPOSITION' },
})

describe('root registries', () => {
  it('declares and runs the tools a native root\'s scope sees', async () => {
    const ctx = await mount()
    const { scope, agent } = await agentScope(ctx, 'a')
    ctx.tools.register(tool('read'))
    scope.ctx.tools.register(tool('mine'))
    const step = ToolStep.capture(ctx.tools, agent)
    expect(step.agent).toBe(agent)
    expect(names(step.declarations)).toEqual(['read', 'mine'])
    expect(text(await call(ctx, 'mine', agent, step))).toBe('ran:mine')
    expect(text(await call(ctx, 'read'))).toBe('ran:read')
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, toolStep: step })
    expect(assembly.tools.map(schema => schema.name)).toEqual(['mine', 'read'])
  })

  it('selects the nearest root and keeps an unloaded root unavailable', async () => {
    const ctx = await mount()
    const preset = await presetScope(ctx)
    const { agent } = await agentScope(ctx, 'a', preset.key)
    ctx.tools.register(tool('read'))
    const entry = tool('program')
    const received: Pick<ToolRegistry, 'get' | 'getAll'>[] = []
    const root: ToolRegistry = {
      register: () => () => {},
      include: (source) => { received.push(source); return () => {} },
      get: name => name === entry.name ? entry : undefined,
      getAll: () => [entry],
    }
    const unset = preset.scope.ctx.tools.setRoot(root)
    expect(() => preset.scope.ctx.tools.setRoot(root)).toThrow('Only one root tool registry may be installed in each scope')
    expect(names(ToolStep.capture(ctx.tools, agent).declarations)).toEqual(['program'])
    // ctx.tools answers from the selected root; the root received the registrations its Agents see.
    expect(names(ctx.tools.getAll(agent))).toEqual(['program'])
    expect(ctx.tools.get('read', agent)).toBeUndefined()
    expect(received.map(source => names(source.getAll(agent)))).toEqual([['read']])
    unset()
    expect(() => ToolStep.capture(ctx.tools, agent)).toThrow(ToolRegistryUnavailableError)
    await expect(call(ctx, 'read', agent)).rejects.toMatchObject({ code: 'TOOL_REGISTRY_UNAVAILABLE' })
    await expect(ctx.systemPrompt.assemble({ scope: agent })).rejects.toBeInstanceOf(ToolRegistryUnavailableError)
    // A replacement root receives the same registrations.
    preset.scope.ctx.tools.setRoot(new NativeToolRegistry())
    expect(names(ToolStep.capture(ctx.tools, agent).declarations)).toEqual(['read'])
  })

  it('checks conflicts only for tools registered through ctx.tools', async () => {
    const ctx = await mount({ root: false })
    const root = new NativeToolRegistry()
    ctx.tools.setRoot(root)
    root.register(tool('slow', 'root'))
    // A tool registered in the root skips the scope's precheck, so the conflict surfaces at the next lookup.
    ctx.tools.register(tool('slow', 'scope'))
    expect(() => ctx.tools.getAll()).toThrow('tool "slow" has several definitions')
  })

  it('rejects a root that reads ctx.tools when it is selected, leaving no selection', async () => {
    const ctx = await mount({ root: false })
    ctx.tools.register(tool('read'))
    const reading: ToolRegistry = {
      register: () => () => {},
      include: () => () => {},
      get: (name, scope) => ctx.tools.get(name, scope),
      getAll: scope => ctx.tools.getAll(scope),
    }
    expect(() => ctx.tools.setRoot(reading)).toThrow(ToolCompositionError)
    expect(() => ctx.tools.setRoot(reading)).toThrow('a root tool registry must not include or read ctx.tools')
    expect(() => ctx.tools.getAll()).toThrow(ToolRegistryUnavailableError)
    ctx.tools.setRoot(new NativeToolRegistry())
    const preset = await presetScope(ctx)
    const native = new NativeToolRegistry()
    native.include(ctx.tools)
    expect(() => preset.scope.ctx.tools.setRoot(native)).toThrow('a root tool registry must not include or read ctx.tools')
    // The failed selection leaves the preset on the deployment root.
    expect(names(ctx.tools.getAll(preset.key))).toEqual(['read'])
  })

  it('fails a later lookup through a root that reads ctx.tools instead of recursing', async () => {
    const ctx = await mount({ root: false })
    const { agent } = await agentScope(ctx, 'a')
    ctx.tools.register(tool('read'))
    const native = new NativeToolRegistry()
    let reads = false
    const root: ToolRegistry = {
      register: entry => native.register(entry),
      include: source => native.include(source),
      get: (name, scope) => reads ? ctx.tools.get(name, scope) : native.get(name, scope),
      getAll: scope => reads ? ctx.tools.getAll(scope) : native.getAll(scope),
    }
    ctx.tools.setRoot(root)
    expect(names(ctx.tools.getAll())).toEqual(['read'])
    reads = true
    expect(() => ctx.tools.getAll(agent)).toThrow(ToolCompositionError)
    expect(() => ctx.tools.get('read', agent)).toThrow('a root tool registry must not include or read ctx.tools')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: brandString<ToolCallId>('read'), name: 'read', arguments: '{}' }],
      signal, agent,
    })
    // The batch settles; only the call whose lookup reached the read fails.
    expect(batch.results.map(outcome => outcome.result.error)).toEqual([misconfigured('read')])
    expect(warn.mock.calls).toEqual([[
      'tool "read" (call read from Agent a) cannot run: a root tool registry must not include or read ctx.tools; ctx.tools.setRoot() gives the root the registrations each scope sees',
    ]])
    // The rejected read leaves later lookups through a root that stops reading ctx.tools working.
    reads = false
    expect(names(ctx.tools.getAll(agent))).toEqual(['read'])
  })

  it('reports a later read of ctx.tools from an included registry as an inclusion cycle', async () => {
    const ctx = await mount()
    const { agent } = await agentScope(ctx, 'a')
    let reads = false
    ctx.tools.include({
      get: (name, scope) => reads ? ctx.tools.get(name, scope) : undefined,
      getAll: scope => reads ? ctx.tools.getAll(scope) : [],
    })
    reads = true
    // The read arrives while the root reads the registrations, so it is a cycle rather than a root reading ctx.tools.
    expect(() => ctx.tools.getAll(agent)).toThrow('tool registry inclusion cycle reaches ctx.tools')
    expect(() => ctx.tools.get('read', agent)).toThrow('tool registry inclusion cycle reaches ctx.tools')
  })

  it('reports a contribution an included registry makes while it is read as an inclusion cycle', async () => {
    const ctx = await mount()
    let contributes = false
    ctx.tools.include({
      get: () => undefined,
      getAll: () => {
        if (contributes) ctx.tools.register(tool('inside'))
        return []
      },
    })
    contributes = true
    expect(() => ctx.tools.getAll()).toThrow('tool registry inclusion cycle reaches ctx.tools')
  })

  it('includes the registrations once in a root selected again after it unloads', async () => {
    const ctx = await mount({ root: false })
    ctx.tools.register(tool('a'))
    const root = new NativeToolRegistry()
    const include = root.include.bind(root)
    let inclusions = 0
    root.include = (source) => { inclusions++; return include(source) }
    let changes = 0
    ctx.on('tools/change', () => { changes++ })
    ctx.tools.setRoot(root)()
    ctx.tools.setRoot(root)
    expect(inclusions).toBe(1)
    expect(changes).toBe(3)
    expect(names(ctx.tools.getAll())).toEqual(['a'])
  })

  it('rolls back a root selection when a tools/change observer throws', async () => {
    const ctx = await mount({ root: false })
    ctx.tools.register(tool('a'))
    let threw = false
    ctx.on('tools/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })
    const root = new NativeToolRegistry()
    expect(() => ctx.tools.setRoot(root)).toThrow('boom change listener')
    expect(() => ctx.tools.getAll()).toThrow(ToolRegistryUnavailableError)
    expect(names(root.getAll())).toEqual([])
    ctx.tools.setRoot(root)
    expect(names(ctx.tools.getAll())).toEqual(['a'])
    // A scope keeps its earlier selection, or none, when a later selection fails.
    const preset = await presetScope(ctx)
    threw = false
    expect(() => preset.scope.ctx.tools.setRoot(new NativeToolRegistry())).toThrow('boom change listener')
    expect(names(ctx.tools.getAll(preset.key))).toEqual(['a'])
    const unset = preset.scope.ctx.tools.setRoot(new NativeToolRegistry())
    unset()
    threw = false
    expect(() => preset.scope.ctx.tools.setRoot(new NativeToolRegistry())).toThrow('boom change listener')
    expect(() => ctx.tools.getAll(preset.key)).toThrow(ToolRegistryUnavailableError)
  })

  it('notifies again with the earlier selection when an observer fails a root selection', async () => {
    const ctx = await mount({ root: false })
    ctx.tools.register(tool('a'))
    const preset = await presetScope(ctx)
    ctx.tools.setRoot(new NativeToolRegistry())
    let fail = true
    ctx.on('tools/change', () => {
      if (fail) { fail = false; throw new Error('boom change listener') }
    })
    const seen: string[][] = []
    ctx.on('tools/change', () => { seen.push(names(ctx.tools.getAll(preset.key))) })
    const failing = new NativeToolRegistry()
    failing.register(tool('b'))
    const include = failing.include.bind(failing)
    let inclusions = 0
    failing.include = (source) => {
      inclusions++
      const remove = include(source)
      return () => { inclusions--; remove() }
    }
    expect(() => preset.scope.ctx.tools.setRoot(failing)).toThrow('boom change listener')
    // Observers after the failing one never saw the failed selection; the second notification shows the restored one.
    expect(seen).toEqual([['a']])
    // The failed selection removed its inclusion, so the root offers only its own entry.
    expect(inclusions).toBe(0)
    expect(names(failing.getAll())).toEqual(['b'])
    preset.scope.ctx.tools.setRoot(failing)
    expect(inclusions).toBe(1)
    expect(names(ctx.tools.getAll(preset.key))).toEqual(['b', 'a'])
  })

  it('resolves an inherited registration past a nearer scope that lacks it', async () => {
    const ctx = await mount()
    const preset = await presetScope(ctx)
    const { agent } = await agentScope(ctx, 'a', preset.key)
    ctx.tools.register(tool('global'))
    preset.scope.ctx.tools.register(tool('preset'))
    expect(text(await call(ctx, 'global', agent))).toBe('ran:global')
    expect(ctx.tools.get('global', agent)?.name).toBe('global')
  })

  it('fails without a deployment root', async () => {
    const ctx = await mount({ root: false })
    const { agent } = await agentScope(ctx, 'a')
    expect(() => ToolStep.capture(ctx.tools, agent)).toThrow('The selected tool registry is unavailable')
  })

  it('lists live root entries for an assembly without a matching step', async () => {
    const ctx = await mount()
    const first = await agentScope(ctx, 'first')
    const second = await agentScope(ctx, 'second')
    second.scope.ctx.tools.register(tool('second-only'))
    const step = ToolStep.capture(ctx.tools, first.agent)
    const assembly = await ctx.systemPrompt.assemble({ scope: second.agent, toolStep: step })
    expect(assembly.tools.map(schema => schema.name)).toEqual(['second-only'])
  })
})

describe('model steps', () => {
  it('executes only the definitions a step declared', async () => {
    const ctx = await mount()
    const { scope, agent } = await agentScope(ctx, 'a')
    const remove = scope.ctx.tools.register(tool('swap', 'old'))
    const step = ToolStep.capture(ctx.tools, agent)
    expect(step.declares(ctx.tools.get('swap', agent)!)).toBe(true)
    remove()
    scope.ctx.tools.register(tool('swap', 'new'))
    scope.ctx.tools.register(tool('later'))
    expect(step.declares(ctx.tools.get('swap', agent)!)).toBe(false)
    expect((await call(ctx, 'swap', agent, step)).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect((await call(ctx, 'later', agent, step)).error?.info?.code).toBe('UNKNOWN_TOOL')
    const next = ToolStep.capture(ctx.tools, agent)
    expect(text(await call(ctx, 'swap', agent, next))).toBe('new')
    expect(text(await call(ctx, 'later', agent, next))).toBe('ran:later')
  })

  it('applies a step to staged pipeline calls', async () => {
    const ctx = await mount()
    const { scope, agent } = await agentScope(ctx, 'a')
    const step = ToolStep.capture(ctx.tools, agent)
    scope.ctx.tools.register(tool('late'))
    const input = { agent, name: 'late', arguments: {}, callId: brandString<ToolCallId>('late'), signal }
    expect((await executeToolFixture(ctx, { ...input, toolStep: step })).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(text(await executeToolFixture(ctx, input))).toBe('ran:late')
  })
})

describe('model-direct calls to tools a root binds only in programs', () => {
  /** A root offering one program entry; it binds the registrations it receives. */
  function programRoot(entries: ToolDefinition[]): ToolRegistry {
    return {
      register: () => () => {},
      include: () => () => {},
      get: name => entries.find(entry => entry.name === name),
      getAll: () => entries,
    }
  }

  it('fails as UNKNOWN_TOOL before policy, approval, guards, and wrappers', async () => {
    const ctx = await mount({ root: false })
    const { agent } = await agentScope(ctx, 'a')
    ctx.tools.register(tool('read'))
    ctx.tools.setRoot(programRoot([tool('program')]))
    const seen: string[] = []
    ctx.on('tools/pre-execute', async (exec) => { seen.push(`pre:${exec.name}`); return { kind: 'ask' } as const })
    ctx.provide('approval', { request: () => { seen.push('approval'); return Promise.resolve('allowed-once' as const) } } as never)
    ctx.tools.guard((exec) => { seen.push(`guard:${exec.name}`); return undefined })
    ctx.on('tools/execute', async (exec, next) => { seen.push(`execute:${exec.name}`); return next() })
    ctx.on('tools/post-execute', async (exec, _result, next) => { seen.push(`post:${exec.name}`); return next() })
    const observed: string[] = []
    ctx.on('tools/result', (exec, result) => { observed.push(`${exec.name}:${result.error?.info?.code ?? 'ok'}`) })
    const refused = await call(ctx, 'read', agent)
    expect(refused.error).toEqual({
      message: 'unknown tool "read"; tools you can call directly: program',
      info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
    })
    expect(seen).toEqual([])
    expect(observed).toEqual(['read:UNKNOWN_TOOL'])
    // A name nothing registers keeps today's order: policy runs, then dispatch fails.
    const ghost = await call(ctx, 'ghost', agent)
    expect(ghost.error).toEqual({ message: 'unknown tool "ghost"', info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } })
    expect(seen).toEqual(['pre:ghost', 'approval', 'guard:ghost', 'execute:ghost', 'post:ghost'])
  })

  it('fails only the call whose refusal check meets an ambiguity that appears during the step', async () => {
    const ctx = await mount({ root: false })
    const { agent } = await agentScope(ctx, 'a')
    ctx.tools.register(tool('read'))
    const late = new AgentToolRegistry()
    ctx.tools.include(late)
    ctx.tools.setRoot(programRoot([tool('program')]))
    const toolStep = ToolStep.capture(ctx.tools, agent)
    late.register(tool('read', 'other'))
    late.set(agent, ['read'])
    const batch = await ctx.tools.execute({
      calls: [
        { type: 'tool-call', id: brandString<ToolCallId>('read'), name: 'read', arguments: '{}' },
        { type: 'tool-call', id: brandString<ToolCallId>('program'), name: 'program', arguments: '{}' },
      ],
      signal, agent, toolStep,
    })
    expect(batch.results.map(outcome => outcome.result.error?.info?.code ?? text(outcome.result))).toEqual([
      'INVALID_TOOL_COMPOSITION', 'ran:program',
    ])
    expect(batch.results[0]?.result.error).toEqual(misconfigured('read'))
  })

  it('names each entry once when the root lists it twice', async () => {
    const ctx = await mount({ root: false })
    const { agent } = await agentScope(ctx, 'a')
    ctx.tools.register(tool('read'))
    const program = tool('program')
    ctx.tools.setRoot(programRoot([program, program]))
    expect((await call(ctx, 'read', agent)).error?.message).toBe('unknown tool "read"; tools you can call directly: program')
  })

  it('reports cancellation before the refusal and names nothing when the root offers no entry', async () => {
    const ctx = await mount({ root: false })
    const { agent } = await agentScope(ctx, 'a')
    ctx.tools.register(tool('read'))
    ctx.tools.setRoot(programRoot([]))
    let policyCalls = 0
    ctx.on('tools/pre-execute', async (_exec, next) => { policyCalls++; return next() })
    const cancelled = await executeModelToolFixture(ctx, {
      callId: brandString<ToolCallId>('cancelled'), name: 'read', arguments: {}, agent, signal: AbortSignal.abort(),
    })
    expect(cancelled.error?.info?.code).toBe('ABORTED_BEFORE_DISPATCH')
    expect((await call(ctx, 'read', agent)).error?.message).toBe('unknown tool "read"')
    expect(policyCalls).toBe(0)
  })

  it('names only the step\'s declarations that the batch\'s root still offers', async () => {
    const ctx = await mount({ root: false })
    const { scope, agent } = await agentScope(ctx, 'a')
    const other = tool('other')
    ctx.tools.register(tool('read'))
    ctx.tools.register(other)
    ctx.tools.setRoot(new NativeToolRegistry())
    const toolStep = ToolStep.capture(ctx.tools, agent)
    expect(names(toolStep.declarations)).toEqual(['read', 'other'])
    // The Agent's scope selects a program root while the step runs; it offers `other` but binds `read` only in programs.
    scope.ctx.tools.setRoot(programRoot([other]))
    expect((await call(ctx, 'read', agent, toolStep)).error).toEqual({
      message: 'unknown tool "read"; tools you can call directly: other',
      info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
    })
    expect(text(await call(ctx, 'other', agent, toolStep))).toBe('ran:other')
  })
})

describe('dispatch', () => {
  it('fails only the call whose lookup meets an ambiguity that appears during the step under a native root', async () => {
    const ctx = await mount()
    const { agent } = await agentScope(ctx, 'a')
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('other'))
    const late = new AgentToolRegistry()
    ctx.tools.include(late)
    const toolStep = ToolStep.capture(ctx.tools, agent)
    late.register({ ...tool('read', 'conflicting'), description: 'Conflicting read.\nSecond line.' })
    late.set(agent, ['read'])
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const batch = await ctx.tools.execute({
      calls: [
        { type: 'tool-call', id: brandString<ToolCallId>('read'), name: 'read', arguments: '{}' },
        { type: 'tool-call', id: brandString<ToolCallId>('other'), name: 'other', arguments: '{}' },
      ],
      signal, agent, toolStep,
    })
    expect(batch.results.map(outcome => outcome.result.error?.info?.code ?? text(outcome.result))).toEqual([
      'INVALID_TOOL_COMPOSITION', 'ran:other',
    ])
    expect(batch.results[0]?.result.error).toEqual(misconfigured('read'))
    // The deployment log names the conflicting definitions once for the failed call.
    expect(warn.mock.calls).toEqual([[
      'tool "read" (call read from Agent a) cannot run: tool "read" has several definitions in the scope that decides it (described as "tool read", "Conflicting read."); register or include one definition per name',
    ]])
  })

  it('fails a call whose lookup throws another error with that error, before policy', async () => {
    const ctx = await mount({ root: false })
    ctx.tools.setRoot({ register: () => () => {}, include: () => () => {}, get: () => { throw new Error('lookup failed') }, getAll: () => [] })
    let policy = 0
    ctx.on('tools/pre-execute', async (_exec, next) => { policy++; return next() })
    expect((await call(ctx, 'read')).error?.message).toBe('lookup failed')
    expect(policy).toBe(0)
  })

  it('reports a composition failure of a call without an Agent', async () => {
    const ctx = await mount()
    const source = new NativeToolRegistry()
    ctx.tools.include(source)
    ctx.tools.register(tool('dup', 'global'))
    source.register(tool('dup', 'included'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    expect((await call(ctx, 'dup')).error).toEqual(misconfigured('dup'))
    expect(warn.mock.calls).toEqual([[
      'tool "dup" (call call-dup) cannot run: tool "dup" has several definitions in the scope that decides it (described as "tool dup", "tool dup"); register or include one definition per name',
    ]])
  })

  it('runs exactly the definition prepare captured', async () => {
    const ctx = await mount()
    const { scope, agent } = await agentScope(ctx, 'a')
    let remove = scope.ctx.tools.register(tool('swap', 'old'))
    let replaced = false
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'swap' && !replaced) {
        replaced = true
        remove()
        remove = scope.ctx.tools.register(tool('swap', 'new'))
      }
      if (exec.name === 'late') scope.ctx.tools.register(tool('late'))
      return next()
    })
    expect((await call(ctx, 'swap', agent)).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(text(await call(ctx, 'swap', agent))).toBe('new')
    // A tool registered while policy runs did not exist when the call was prepared.
    expect((await call(ctx, 'late', agent)).error?.info?.code).toBe('UNKNOWN_TOOL')
  })
})

describe('results of a dispatched call', () => {
  it('keep the dispatched definition when the tool is withdrawn while its body runs', async () => {
    const ctx = await mount()
    const { scope, agent } = await agentScope(ctx, 'a')
    const removals = new Map<string, () => void>()
    const vanishing = (name: string): ToolDefinition => ({
      ...tool(name),
      execute: () => { removals.get(name)?.(); return Promise.resolve(`ran:${name}`) },
    })
    for (const name of ['wrapped', 'replaced']) removals.set(name, scope.ctx.tools.register(vanishing(name)))
    // A wrapper that returns its own copy of the result has it normalized through the dispatched definition.
    ctx.on('tools/execute', async (exec, next) => {
      const result = await next()
      return exec.name === 'wrapped' ? { ...result } : result
    })
    ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'replaced' ? { kind: 'accept', value: 'new value' } : next())
    expect(text(await call(ctx, 'wrapped', agent))).toBe('ran:wrapped')
    expect(text(await call(ctx, 'replaced', agent))).toBe('new value')
    expect(ctx.tools.getAll(agent)).toEqual([])
  })
})

describe('include()', () => {
  it('reads a source registry live and stops at disposal', async () => {
    const ctx = await mount()
    const source = new NativeToolRegistry()
    source.register(tool('a'))
    const remove = ctx.tools.include(source)
    expect(names(ctx.tools.getAll())).toEqual(['a'])
    const addB = source.register(tool('b'))
    expect(ctx.tools.get('b')?.name).toBe('b')
    expect(text(await call(ctx, 'b'))).toBe('ran:b')
    addB()
    addB()
    expect(ctx.tools.get('b')).toBeUndefined()
    expect(source.get('a')?.name).toBe('a')
    remove()
    expect(ctx.tools.getAll()).toEqual([])
  })

  it('treats a parent scope\'s inclusion as inherited by child restrictions', async () => {
    const ctx = await mount()
    const preset = await presetScope(ctx)
    const { scope, agent } = await agentScope(ctx, 'child', preset.key)
    const source = new NativeToolRegistry()
    source.register(tool('x'))
    source.register(tool('y'))
    preset.scope.ctx.tools.include(source)
    expect(names(ctx.tools.getAll(agent))).toEqual(['x', 'y'])
    // The including scope's own entries are exempt from its own restrictions.
    expect(() => preset.scope.ctx.tools.restrict({ allow: ['y'] })).toThrow('unknown inherited tool "y"')
    preset.scope.ctx.tools.restrict({ deny: ['x'] })
    expect(names(ctx.tools.getAll(preset.key))).toEqual(['x', 'y'])
    scope.ctx.tools.restrict({ deny: ['x'] })
    expect(names(ctx.tools.getAll(agent))).toEqual(['y'])
    expect((await call(ctx, 'x', agent)).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(text(await call(ctx, 'y', agent))).toBe('ran:y')
    expect(names(ctx.tools.getAll(preset.key))).toEqual(['x', 'y'])
  })

  it('rejects a contribution that makes its own scope ambiguous', async () => {
    const ctx = await mount()
    const { scope, agent } = await agentScope(ctx, 'a')
    const source = new NativeToolRegistry()
    source.register(tool('dup', 'included'))
    ctx.tools.register(tool('dup', 'global'))
    expect(() => ctx.tools.include(source)).toThrow(ToolCompositionError)
    expect(text(await call(ctx, 'dup'))).toBe('global')
    ctx.tools.include(new NativeToolRegistry())
    scope.ctx.tools.include(source)
    expect(() => scope.ctx.tools.register(tool('dup', 'scoped'))).toThrow('tool "dup" has several definitions')
    expect(text(await call(ctx, 'dup', agent))).toBe('included')
  })

  it('lets the nearest scope decide a name and fails only on its own ambiguity', async () => {
    const ctx = await mount()
    const { scope, agent } = await agentScope(ctx, 'a')
    const source = new NativeToolRegistry()
    ctx.tools.include(source)
    ctx.tools.register(tool('dup', 'global'))
    source.register(tool('dup', 'included'))
    expect(() => ctx.tools.get('dup')).toThrow(ToolCompositionError)
    expect(() => ctx.tools.getAll()).toThrow('tool "dup" has several definitions')
    scope.ctx.tools.register(tool('dup', 'scoped'))
    expect(text(await call(ctx, 'dup', agent))).toBe('scoped')
    expect(names(ctx.tools.getAll(agent))).toEqual(['dup'])
  })

  it('lets a nearer scope shadow a conflict inside a nested inclusion', async () => {
    const ctx = await mount()
    const { scope, agent } = await agentScope(ctx, 'a')
    const nested = new NativeToolRegistry()
    const outer = new NativeToolRegistry()
    outer.register(tool('x', 'outer'))
    outer.include(nested)
    ctx.tools.include(outer)
    nested.register(tool('x', 'nested'))
    expect(() => outer.get('x')).toThrow('tool "x" has several definitions')
    expect(names(outer.getAll())).toEqual(['x', 'x'])
    expect(() => ctx.tools.getAll()).toThrow('tool "x" has several definitions')
    // Contributions that do not offer the conflicting name are accepted.
    outer.register(tool('y'))
    const extra = new NativeToolRegistry()
    extra.register(tool('z'))
    outer.include(extra)
    ctx.tools.register(tool('w'))
    const more = new NativeToolRegistry()
    more.register(tool('v'))
    ctx.tools.include(more)
    scope.ctx.tools.register(tool('x', 'scoped'))
    expect(text(await call(ctx, 'x', agent))).toBe('scoped')
    expect(names(ctx.tools.getAll(agent))).toEqual(['w', 'x', 'y', 'z', 'v'])
    const toolStep = ToolStep.capture(ctx.tools, agent)
    expect(names(toolStep.declarations)).toEqual(['w', 'x', 'y', 'z', 'v'])
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, toolStep })
    expect(assembly.tools.map(schema => schema.name)).toEqual(['v', 'w', 'x', 'y', 'z'])
    expect(() => scope.ctx.tools.include(outer)).toThrow('tool "x" has several definitions')
    expect(() => ctx.tools.include(outer)).toThrow('tool "x" has several definitions')
  })

  it('lets a restriction hide a conflict inside an included registry', async () => {
    const ctx = await mount()
    const { scope, agent } = await agentScope(ctx, 'a')
    const nested = new NativeToolRegistry()
    const outer = new NativeToolRegistry()
    outer.register(tool('x', 'outer'))
    outer.register(tool('y'))
    outer.include(nested)
    ctx.tools.include(outer)
    nested.register(tool('x', 'nested'))
    scope.ctx.tools.restrict({ allow: ['x', 'y'] })
    scope.ctx.tools.restrict({ deny: ['x'] })
    expect(names(ctx.tools.getAll(agent))).toEqual(['y'])
    expect(ctx.tools.get('x', agent)).toBeUndefined()
    const toolStep = ToolStep.capture(ctx.tools, agent)
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, toolStep })
    expect(assembly.tools.map(schema => schema.name)).toEqual(['y'])
    expect(text(await call(ctx, 'y', agent, toolStep))).toBe('ran:y')
    expect(() => ctx.tools.getAll()).toThrow('tool "x" has several definitions')
  })

  it('keeps one candidate for a definition reached twice', async () => {
    const ctx = await mount()
    const source = new NativeToolRegistry()
    source.register(tool('same'))
    ctx.tools.include(source)
    ctx.tools.include(source)
    expect(names(ctx.tools.getAll())).toEqual(['same'])
  })

  it('reports inclusion cycles as composition errors', async () => {
    const ctx = await mount()
    const looping = new NativeToolRegistry()
    looping.include(ctx.tools)
    expect(() => ctx.tools.include(looping)).toThrow('tool registry inclusion cycle reaches ctx.tools')
    expect(ctx.tools.getAll()).toEqual([])
    const late = new ToolEntries('late')
    const lateRegistry: ToolRegistry = {
      register: tool => late.register(tool),
      include: registry => late.include(registry),
      get: (name, scope) => late.get(name, scope),
      getAll: scope => late.getAll(scope),
    }
    ctx.tools.include(lateRegistry)
    expect(() => late.include(ctx.tools)).toThrow('tool registry inclusion cycle reaches late')
    expect(ctx.tools.getAll()).toEqual([])
    const first = new ToolEntries('first')
    const second = new ToolEntries('second')
    const asRegistry = (entries: ToolEntries): ToolRegistry => ({
      register: tool => entries.register(tool),
      include: registry => entries.include(registry),
      get: (name, scope) => entries.get(name, scope),
      getAll: scope => entries.getAll(scope),
    })
    first.include(asRegistry(second))
    expect(() => second.include(asRegistry(first))).toThrow('tool registry inclusion cycle reaches second')
    second.register(tool('x'))
    const third = new ToolEntries('third')
    third.register(tool('x', 'other'))
    expect(() => first.include(asRegistry(third))).toThrow('tool "x" has several definitions')
    expect(() => third.include(asRegistry(second))).toThrow('tool "x" has several definitions')
    expect(first.get('x')?.name).toBe('x')
  })
})

describe('registration disposers', () => {
  it('removes only the registration whose disposer runs', async () => {
    const ctx = await mount()
    const registries: Pick<ToolRegistry, 'register' | 'get'>[] = [
      new ToolEntries('fixture registry'), new NativeToolRegistry(), new AgentToolRegistry(), ctx.tools,
    ]
    for (const registry of registries) {
      const again = tool('again')
      const first = registry.register(again)
      first()
      const second = registry.register(again)
      first()
      expect(registry.get('again')).toBe(again)
      second()
      second()
      expect(registry.get('again')).toBeUndefined()
    }
  })
})

describe('registries without scopes', () => {
  it('validates definitions and rejects duplicate names', () => {
    const entries = new ToolEntries('fixture registry')
    entries.register(tool('a'))
    expect(() => entries.register(tool('a'))).toThrow('tool "a" is already registered in fixture registry')
    const { output: _output, ...outputless } = tool('bad')
    expect(() => entries.register(outputless as ToolDefinition)).toThrow(TypeError)
    const unrendered = tool('unrendered')
    Reflect.set(unrendered.output, 'render', 'text')
    expect(() => entries.register(unrendered)).toThrow('must declare output { schema, render, presentationMeta? }')
    const projected = tool('projected')
    Reflect.set(projected.output, 'presentationMeta', {})
    expect(() => entries.register(projected)).toThrow('must declare output { schema, render, presentationMeta? }')
    expect(() => entries.register({ ...tool('slow'), timeoutMs: 0 })).toThrow('timeoutMs must be a positive finite number')
    expect(() => entries.register(tool(RUN_CODE_NAME))).toThrow('reserved for the PTC program entry')
  })

  it('names every conflicting definition once and shortens long descriptions', () => {
    const entries = new ToolEntries('fixture registry')
    const sources = [new NativeToolRegistry(), new NativeToolRegistry(), new NativeToolRegistry()]
    for (const source of [...sources, sources[0]!]) entries.include(source)
    sources[0]!.register({ ...tool('x'), description: 'First x.' })
    sources[1]!.register({ ...tool('x'), description: 'Second x.\nMore detail.' })
    sources[2]!.register({ ...tool('x'), description: 'y'.repeat(100) })
    const message = `tool "x" has several definitions in the scope that decides it (described as "First x.", "Second x.", "${'y'.repeat(79)}…"); register or include one definition per name`
    expect(() => entries.resolveAll()).toThrow(message)
    expect(() => entries.get('x')).toThrow(message)
    expect(entries.getAll().map(definition => definition.description)).toEqual(['First x.', 'Second x.\nMore detail.', 'y'.repeat(100)])
  })
})

describe('AgentToolRegistry', () => {
  it('shows each Agent only the tools added for it', async () => {
    const ctx = await mount()
    const parent = await agentScope(ctx, 'parent')
    const child = await agentScope(ctx, 'child', parent.agent)
    const offers = new AgentToolRegistry()
    offers.register(tool('offered'))
    offers.register(tool('other'))
    ctx.tools.include(offers)
    expect(names(ctx.tools.getAll())).toEqual(['offered', 'other'])
    expect(ctx.tools.getAll(parent.agent)).toEqual([])
    expect(offers.get('offered')?.name).toBe('offered')
    expect(offers.get('offered', parent.agent)).toBeUndefined()
    offers.set(parent.agent, ['offered'])
    expect(offers.get('offered', parent.agent)?.name).toBe('offered')
    expect(names(ctx.tools.getAll(parent.agent))).toEqual(['offered'])
    expect(ctx.tools.get('other', parent.agent)).toBeUndefined()
    expect(ctx.tools.getAll(child.agent)).toEqual([])
    expect(text(await call(ctx, 'offered', parent.agent))).toBe('ran:offered')
    expect((await call(ctx, 'offered', child.agent)).error?.info?.code).toBe('UNKNOWN_TOOL')
    offers.set(parent.agent, [])
    expect(ctx.tools.getAll(parent.agent)).toEqual([])
    expect(() => { offers.set(parent.agent, ['ghost', 'wraith']) }).toThrow('cannot add unregistered tools "ghost", "wraith" to an Agent')
    expect(() => { offers.set(parent.agent, ['ghost']) }).toThrow('cannot add unregistered tool "ghost" to an Agent')
  })

  it('accepts restrictions and tool order for tools an Agent does not see yet', async () => {
    const ctx = await mount({ toolOrder: ['offered', TOOL_ORDER_REST] })
    const { scope, agent } = await agentScope(ctx, 'a')
    const offers = new AgentToolRegistry()
    offers.register(tool('offered'))
    offers.register(tool('kept'))
    ctx.tools.include(offers)
    expect((await ctx.systemPrompt.assemble({ scope: agent, toolStep: ToolStep.capture(ctx.tools, agent) })).tools).toEqual([])
    scope.ctx.tools.restrict({ deny: ['offered'] })
    offers.set(agent, ['offered', 'kept'])
    expect(names(ctx.tools.getAll(agent))).toEqual(['kept'])
  })

  it('runs added tools through ctx.tools with step admission', async () => {
    const ctx = await mount()
    const { agent } = await agentScope(ctx, 'a')
    const offers = new AgentToolRegistry()
    offers.register(tool('offered'))
    ctx.tools.include(offers)
    const before = ToolStep.capture(ctx.tools, agent)
    offers.set(agent, ['offered'])
    const run = (toolStep?: ToolStep) => ctx.tools.execute({
      calls: [{ type: 'tool-call', id: brandString<ToolCallId>('offered'), name: 'offered', arguments: '{}' }],
      signal, agent, ...toolStep === undefined ? {} : { toolStep },
    }).then(batch => batch.results[0]!.result)
    expect(text(await run())).toBe('ran:offered')
    expect(text(await run(ToolStep.capture(ctx.tools, agent)))).toBe('ran:offered')
    expect((await run(before)).error).toMatchObject({ message: 'unknown tool "offered"', info: { code: 'UNKNOWN_TOOL' } })
  })
})
