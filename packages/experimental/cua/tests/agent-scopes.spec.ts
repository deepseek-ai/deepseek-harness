/** CUA tool and prompt ownership follows live Agent presets and provider disposal. */
import { resolve } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Subprocess from '@deepseek-ai/dsh-subprocess'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CuaConfig, installCua } from '../src/index.ts'

const programPrompt = 'Fixture CUA program guidance\n\nAX read defaults: maxElements=2000, maxDepth=25.\n\nMaximum click holdMs: 5000 ms.'

const provider = {
  name: 'test-cua-scopes',
  inject: ['computerUse', 'subprocess', 'tools', 'systemPrompt', 'agents'],
  Config: CuaConfig,
  apply(ctx: Context, config: CuaConfig) {
    installCua(ctx, config, {
      helperPath: resolve('unused-cua-helper'),
      createChannel() { throw new Error('Scope tests must not start a native helper') },
      permissionParameters: (_method, permission, locale) => ({ permission, locale }),
      getGuidance: kind => kind === 'raw' ? 'Fixture CUA guidance' : 'Fixture CUA program guidance',
      capabilities: {
        platform: 'macos', methods: ['getCapabilities', 'getApp', 'getState'], appLevelAccessibility: true,
        keyboard: ['app'], browser: false, coordinateSpace: 'screenshot-pixels',
      },
    })
  },
}

async function setup(presetIds = ['standard', 'ptc'], withSandbox = true) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  if (withSandbox) await ctx.plugin(Sandbox)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(Subprocess, [])
  await ctx.plugin(AgentPresets, { default: 'standard' })
  for (const id of presetIds) {
    await ctx.plugin({ inject: ['agentPresets'], async* apply(owner: Context) {
      yield await owner.agentPresets.register({ id, plugins: [] })
    } })
  }
  const create = (id: string, preset: string) => ctx.agents.create({
    sessionId: SessionId(id), setup: async (owner) => { await ctx.agentPresets.mount(owner, preset) },
  })
  return { ctx, create }
}

async function cuaPrompts(ctx: Context, agent: Agent): Promise<string[]> {
  return (await ctx.systemPrompt.assemble({ scope: agent })).sections
    .filter(section => section.name === 'computer-use:dsh-cua').map(section => section.text)
}

it.each([
  { executionMode: 'per-call' },
  { executionMode: 'persistent-in-memory' },
  { scriptPersistence: true },
  { scriptPersistence: false },
])('rejects explicit program evaluation settings %j', (unsupported) => {
  expect(() => CuaConfig({ standaloneRunCode: { runtime: { timeoutMs: 1000, ...unsupported } } })).toThrow()
  expect(CuaConfig({ standaloneRunCode: { runtime: { timeoutMs: 1000 } } }).standaloneRunCode.runtime.timeoutMs).toBe(1000)
})

it('gives every other composed preset a program tool without changing the shared runtime', async () => {
  const { ctx, create } = await setup(['standard', 'ptc', 'cordis', 'minimal', 'custom'])
  const shared = { programFormat: 'function-body', retainsState: false }
  ctx.provide('ptcRuntime', shared)
  const mounted = await ctx.plugin(provider, {})
  for (const preset of ['standard', 'cordis', 'minimal', 'custom']) {
    const handle = await create(`cua-${preset}`, preset)
    expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).toContain('cua_run_code')
    expect(ctx.tools.get('cua', handle.agent)).toBeUndefined()
    expect(ctx.tools.get('cua_run_code', handle.agent)?.description).toContain('global cua object is ready')
    await handle.dispose()
    expect(ctx.tools.get('cua_run_code', handle.agent)).toBeUndefined()
  }
  const uncomposed = await ctx.agents.create({ sessionId: SessionId('cua-uncomposed') })
  expect(ctx.tools.get('cua_run_code', uncomposed.agent)).toBeUndefined()
  expect(ctx.tools.get('cua', uncomposed.agent)).toBeUndefined()
  expect(ctx.get('ptcRuntime')).toMatchObject(shared)
  await mounted.dispose()
})

it('keeps explicitly configured global raw-tool registration', async () => {
  const { ctx, create } = await setup()
  const mounted = await ctx.plugin(provider, { agentPreset: false })
  const handle = await create('cua-global', 'standard')
  expect(ctx.tools.get('cua', handle.agent)).toBeDefined()
  expect(ctx.tools.get('cua_run_code', handle.agent)).toBeUndefined()
  await mounted.dispose()
  expect(ctx.tools.get('cua', handle.agent)).toBeUndefined()
})

it('selects one CUA transport for existing and new Agents and removes both on unload', async () => {
  const { ctx, create } = await setup()
  const existing = await create('existing', 'ptc')
  const standard = await create('standard', 'standard')
  expect(ctx.tools.get('cua', existing.agent)).toBeUndefined()
  const mounted = await ctx.plugin(provider, {})
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeDefined()
  expect(ctx.tools.get('cua', standard.agent)).toBeUndefined()
  await expect.poll(() => ctx.tools.get('cua_run_code', standard.agent)).toBeDefined()
  expect(ctx.tools.get('cua_run_code', existing.agent)).toBeUndefined()
  expect(ctx.get('ptcRuntime')).toBeUndefined()
  const { sections } = await ctx.systemPrompt.assemble({ scope: existing.agent })
  expect(sections.find(section => section.name === 'computer-use:dsh-cua')?.text).toContain('Fixture CUA guidance')
  await ctx.agentPresets.select(existing.agent, 'ptc')
  expect(ctx.tools.schemas(existing.agent).filter(tool => tool.name === 'cua')).toHaveLength(1)
  const fresh = await create('fresh', 'ptc')
  expect(ctx.tools.get('cua', fresh.agent)).toBeDefined()
  await ctx.agentPresets.select(existing.agent, 'standard')
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeUndefined()
  await expect.poll(() => ctx.tools.get('cua_run_code', existing.agent)).toBeDefined()
  const standardSections = (await ctx.systemPrompt.assemble({ scope: existing.agent })).sections
  expect(standardSections.find(section => section.name === 'computer-use:dsh-cua')?.text).toContain('Fixture CUA program guidance')
  await ctx.agentPresets.select(existing.agent, 'ptc')
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeDefined()
  await fresh.dispose()
  expect(ctx.tools.get('cua', fresh.agent)).toBeUndefined()
  await mounted.dispose()
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeUndefined()
  expect(ctx.tools.get('cua', existing.agent)).toBeUndefined()
  expect((await ctx.systemPrompt.assemble({ scope: existing.agent })).sections)
    .not.toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua' }))
  const reloaded = await ctx.plugin(provider, {})
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeDefined()
  expect(ctx.tools.get('cua', standard.agent)).toBeUndefined()
  await reloaded.dispose()
})

it('keeps initialization registered while program tools reload their directory dependency', async () => {
  const { ctx, create } = await setup()
  const register = vi.spyOn(NodeRuntime.prototype, 'registerEnvironmentInitializer')
  onTestFinished(() => { register.mockRestore() })
  await ctx.plugin(provider, {})
  expect(register).toHaveBeenCalledOnce()
  const standard = await create('cua-dependency-standard', 'standard')
  const ptc = await create('cua-dependency-ptc', 'ptc')
  const previous = ctx.tools.get('cua_run_code', standard.agent)
  const raw = ctx.tools.get('cua', ptc.agent)
  const rawPrompts = await cuaPrompts(ctx, ptc.agent)
  expect(previous).toBeDefined()
  expect(raw).toBeDefined()
  expect(rawPrompts).toHaveLength(1)
  const directoryProvider = [...ctx.registry.get(WorkingDirectory)?.fibers ?? []][0]
  expect(directoryProvider).toBeDefined()
  await directoryProvider?.dispose()
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeUndefined()
  expect(ctx.tools.get('cua', ptc.agent)).toBe(raw)
  expect(await cuaPrompts(ctx, ptc.agent)).toEqual(rawPrompts)
  expect(await cuaPrompts(ctx, standard.agent)).toEqual([])
  await ctx.plugin(WorkingDirectory)
  await expect.poll(() => ctx.tools.get('cua_run_code', standard.agent)).toBeDefined()
  expect(ctx.tools.get('cua_run_code', standard.agent) === previous).toBe(false)
  expect(register).toHaveBeenCalledOnce()
  expect(ctx.tools.get('cua', ptc.agent)).toBe(raw)
  expect(await cuaPrompts(ctx, ptc.agent)).toEqual(rawPrompts)
  await ctx.agentPresets.select(standard.agent, 'ptc')
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeUndefined()
  expect(ctx.tools.get('cua', standard.agent)).toBeDefined()
  await ctx.agentPresets.select(standard.agent, 'standard')
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeDefined()
  expect(ctx.tools.get('cua', standard.agent)).toBeUndefined()
})

it('keeps raw CUA and the shared runtime while the private runtime is absent', async () => {
  const { ctx, create } = await setup()
  const shared = { programFormat: 'repl', retainsState: true }
  ctx.provide('ptcRuntime', shared)
  await ctx.plugin(provider, {})
  const standard = await create('private-loss-standard', 'standard')
  const ptc = await create('private-loss-ptc', 'ptc')
  const raw = ctx.tools.get('cua', ptc.agent)
  const rawPrompts = await cuaPrompts(ctx, ptc.agent)
  const previous = ctx.tools.get('cua_run_code', standard.agent)
  const privateRuntime = [...ctx.registry.get(NodeRuntime)?.fibers ?? []][0]
  if (privateRuntime === undefined) throw new Error('missing private runtime fixture')
  await privateRuntime.dispose()
  expect(ctx.tools.get('cua', ptc.agent)).toBe(raw)
  expect(await cuaPrompts(ctx, ptc.agent)).toEqual(rawPrompts)
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeUndefined()
  expect(await cuaPrompts(ctx, standard.agent)).toEqual([])
  expect(ctx.get('ptcRuntime')).toBe(shared)
  const fresh = await create('private-loss-new-ptc', 'ptc')
  expect(ctx.tools.get('cua', fresh.agent)).toBe(raw)
  await privateRuntime.parent.plugin(NodeRuntime, { executionMode: 'persistent-in-memory' })
  await expect.poll(() => ctx.tools.get('cua_run_code', standard.agent)).toBeDefined()
  expect(ctx.tools.get('cua_run_code', standard.agent) === previous).toBe(false)
  expect(ctx.tools.get('cua', ptc.agent)).toBe(raw)
  expect(ctx.get('ptcRuntime')).toBe(shared)
})

it('creates raw Agents while private runtime startup is pending', async () => {
  const { ctx, create } = await setup(undefined, false)
  await ctx.plugin(provider, {})
  const ptc = await create('private-pending-ptc', 'ptc')
  const raw = ctx.tools.get('cua', ptc.agent)
  expect(raw).toBeDefined()
  expect((await cuaPrompts(ctx, ptc.agent)).join('')).toContain('Fixture CUA guidance')
  await expect(create('private-pending-standard', 'standard')).rejects.toThrow('CUA program tool is unavailable')
  await ctx.plugin(Sandbox)
  const standard = await create('private-restored-standard', 'standard')
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeDefined()
  expect(ctx.tools.get('cua', ptc.agent)).toBe(raw)
})

it('uses a corrected private runtime after the failed instance is replaced', async () => {
  const { ctx, create } = await setup()
  const report = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { report.mockRestore() })
  await ctx.plugin(provider, { standaloneRunCode: { runtime: { maxOutputBytes: 1 } } })
  const ptc = await create('failed-node-ptc', 'ptc')
  const raw = ctx.tools.get('cua', ptc.agent)
  expect(raw).toBeDefined()
  const failed = [...ctx.registry.get(NodeRuntime)?.fibers ?? []][0]
  if (failed === undefined) throw new Error('missing failed private runtime')
  await expect(create('failed-node-standard', 'standard')).rejects.toThrow('maxOutputBytes')
  await failed.dispose()
  await failed.parent.plugin(NodeRuntime, { executionMode: 'persistent-in-memory' })
  const standard = await create('replacement-node-standard', 'standard')
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeDefined()
  expect(ctx.tools.get('cua', ptc.agent)).toBe(raw)
  expect((await cuaPrompts(ctx, ptc.agent)).join('')).toContain('Fixture CUA guidance')
})

it('ignores a queued raw creation listener after optional CUA unload', async () => {
  const { ctx, create } = await setup()
  const mounted = await ctx.plugin(provider, {})
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const resume: PromiseWithResolvers<void> = Promise.withResolvers()
  ctx.on('agent/created', async () => { entered.resolve(); await resume.promise }, { prepend: true })
  const creating = create('queued-raw-unload', 'ptc')
  try {
    await entered.promise
    await mounted.dispose()
    resume.resolve()
    const handle = await creating
    expect(ctx.tools.get('cua', handle.agent)).toBeUndefined()
    expect(ctx.tools.get('cua_run_code', handle.agent)).toBeUndefined()
    expect(await cuaPrompts(ctx, handle.agent)).toEqual([])
  } finally { resume.resolve(); await creating }
})

it('finishes Agent creation when optional CUA unloads during private readiness', async () => {
  const { ctx, create } = await setup()
  const mounted = await ctx.plugin(provider, {})
  const runtime = [...ctx.registry.get(NodeRuntime)?.fibers ?? []][0]
  if (runtime === undefined) throw new Error('missing private runtime fixture')
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const resume: PromiseWithResolvers<void> = Promise.withResolvers()
  const ready = runtime.await.bind(runtime)
  const waiting = vi.spyOn(runtime, 'await').mockImplementationOnce(async () => {
    entered.resolve()
    await resume.promise
    return ready()
  })
  onTestFinished(() => { waiting.mockRestore(); resume.resolve() })
  const creating = create('waiting-program-unload', 'standard')
  try {
    await entered.promise
    await mounted.dispose()
    resume.resolve()
    const handle = await creating
    expect(ctx.tools.get('cua', handle.agent)).toBeUndefined()
    expect(ctx.tools.get('cua_run_code', handle.agent)).toBeUndefined()
    expect(await cuaPrompts(ctx, handle.agent)).toEqual([])
  } finally { resume.resolve(); await creating }
})

it('creates raw Agents even when private initialization registration fails', async () => {
  const { ctx, create } = await setup()
  const register = vi.spyOn(NodeRuntime.prototype, 'registerEnvironmentInitializer')
    .mockImplementation(() => { throw new Error('private initializer failed') })
  const report = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { register.mockRestore(); report.mockRestore() })
  await ctx.plugin(provider, {})
  const ptc = await create('private-failed-ptc', 'ptc')
  expect(ctx.tools.get('cua', ptc.agent)).toBeDefined()
  expect((await cuaPrompts(ctx, ptc.agent)).join('')).toContain('Fixture CUA guidance')
  await expect(create('private-failed-standard', 'standard')).rejects.toThrow('private initializer failed')
  expect(ctx.tools.get('cua', ptc.agent)).toBeDefined()
})

it('switches modes synchronously without exposing both tools while programs are unavailable', async () => {
  const { ctx, create } = await setup()
  await ctx.plugin(provider, {})
  const owner = await create('unavailable-switch', 'ptc')
  const directoryProvider = [...ctx.registry.get(WorkingDirectory)?.fibers ?? []][0]
  if (directoryProvider === undefined) throw new Error('missing directory fixture')
  await directoryProvider.dispose()
  const counts: number[] = []
  ctx.on('tools/change', () => {
    counts.push(ctx.tools.schemas(owner.agent).filter(tool => tool.name === 'cua' || tool.name === 'cua_run_code').length)
  })
  await ctx.agentPresets.select(owner.agent, 'standard')
  expect(ctx.tools.get('cua', owner.agent)).toBeUndefined()
  expect(ctx.tools.get('cua_run_code', owner.agent)).toBeUndefined()
  expect(await cuaPrompts(ctx, owner.agent)).toEqual([])
  await ctx.agentPresets.select(owner.agent, 'ptc')
  expect(ctx.tools.get('cua', owner.agent)).toBeDefined()
  expect((await cuaPrompts(ctx, owner.agent)).join('')).toContain('Fixture CUA guidance')
  await ctx.plugin(WorkingDirectory)
  await ctx.agentPresets.select(owner.agent, 'standard')
  await expect.poll(() => ctx.tools.get('cua_run_code', owner.agent)).toBeDefined()
  expect(ctx.tools.get('cua', owner.agent)).toBeUndefined()
  expect(await cuaPrompts(ctx, owner.agent)).toEqual([programPrompt])
  expect(counts.length).toBeGreaterThan(0)
  expect(counts.every(count => count <= 1)).toBe(true)
})

it('rolls back a partial program publication without withdrawing raw CUA', async () => {
  const { ctx, create } = await setup()
  await ctx.plugin(provider, {})
  const standard = await create('publication-standard', 'standard')
  const ptc = await create('publication-ptc', 'ptc')
  const raw = ctx.tools.get('cua', ptc.agent)
  const directoryProvider = [...ctx.registry.get(WorkingDirectory)?.fibers ?? []][0]
  if (directoryProvider === undefined) throw new Error('missing directory fixture')
  await directoryProvider.dispose()
  const attempted: PromiseWithResolvers<void> = Promise.withResolvers()
  const section = vi.spyOn(ctx.systemPrompt, 'section').mockImplementationOnce(() => {
    attempted.resolve()
    throw new Error('program prompt failed')
  })
  const report = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { section.mockRestore(); report.mockRestore() })
  await ctx.plugin(WorkingDirectory)
  await attempted.promise
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeUndefined()
  expect(await cuaPrompts(ctx, standard.agent)).toEqual([])
  expect(ctx.tools.get('cua', ptc.agent)).toBe(raw)
  expect((await cuaPrompts(ctx, ptc.agent)).join('')).toContain('Fixture CUA guidance')
  const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
  const failed = fibers.find(fiber => fiber.runtime?.name === 'cua-program-tools')
  const initializer = fibers.find(fiber => fiber.runtime?.name === 'cua-program-initializer')
  if (failed === undefined || initializer === undefined) throw new Error('missing program lifecycle fixture')
  await expect(failed.await()).rejects.toThrow('program prompt failed')
  expect(failed.state).toBe(FiberState.FAILED)
  expect(initializer.state).toBe(FiberState.ACTIVE)
  section.mockRestore()
  await failed.update(failed.rawConfig)
  await expect.poll(() => ctx.tools.get('cua_run_code', standard.agent)).toBeDefined()
  expect(await cuaPrompts(ctx, standard.agent)).toEqual([programPrompt])
  expect(ctx.tools.get('cua', ptc.agent)).toBe(raw)
})

it('ignores unloaded Session selections and reports a failed live scope update', async () => {
  const { ctx, create } = await setup()
  const handle = await create('active', 'ptc')
  const mounted = await ctx.plugin(provider, {})
  await expect.poll(() => ctx.tools.get('cua', handle.agent)).toBeDefined()
  const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => {})
  const lookup = vi.spyOn(ctx.agentPresets, 'composedPreset')
  onTestFinished(() => { lookup.mockRestore(); warn.mockRestore() })
  ctx.emit('agent-preset/selected', SessionId('unloaded'), 'ptc')
  expect(lookup).not.toHaveBeenCalled()
  lookup.mockImplementationOnce(() => { throw new Error('Preset lookup failed during reload') })
  ctx.emit('agent-preset/selected', handle.agent.id, 'ptc')
  await expect.poll(() => warn.mock.calls).toEqual([['CUA tool scope update failed: Error: Preset lookup failed during reload']])
  expect(ctx.tools.get('cua', handle.agent)).toBeDefined()
  await ctx.agentPresets.select(handle.agent, 'standard')
  await expect.poll(() => ctx.tools.get('cua', handle.agent)).toBeUndefined()
})

it('accepts a matching preset registered after the CUA provider', async () => {
  const { ctx, create } = await setup([])
  await ctx.plugin(provider, {})
  expect(ctx.tools.get('cua')).toBeUndefined()
  await ctx.plugin({ inject: ['agentPresets'], async* apply(owner: Context) {
    yield await owner.agentPresets.register({ id: 'ptc', plugins: [] })
  } })
  const handle = await create('late-preset', 'ptc')
  expect(ctx.tools.get('cua', handle.agent)).toBeDefined()
})

it.each([
  { programFormat: 'script', retainsState: true },
  { programFormat: 'script', retainsState: false },
  { programFormat: 'repl', retainsState: false },
  { programFormat: 'function-body', retainsState: true },
] as const)('selects CUA initialization from retention for $programFormat/$retainsState', async (runtime) => {
  const { ctx, create } = await setup()
  ctx.provide('ptcRuntime', runtime)
  await ctx.plugin(provider, {})
  const owner = await create('cua-runtime-guidance', 'ptc')
  const prompt = (await ctx.systemPrompt.assemble({ scope: owner.agent })).sections.find(section => section.name === 'computer-use:dsh-cua')?.text
  expect(prompt).toBeDefined()
  expect(prompt?.includes('Persistent PTC initialization:')).toBe(runtime.retainsState)
  expect(prompt?.includes('use the host-provided bridge initialization once and retain the returned objects')).toBe(runtime.retainsState)
  expect(prompt?.includes('cua comes from that bridge and is not a preinstalled global')).toBe(runtime.retainsState)
  expect(prompt?.includes('var cua = connectCua(() => tools.cua, text => console.log(text));')).toBe(runtime.retainsState)
})
