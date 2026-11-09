/** CUA tool and prompt ownership follows live Agent presets and provider disposal. */
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import Subprocess from '@deepseek-ai/dsh-subprocess'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CuaConfig, installCua } from '../src/index.ts'

const provider = {
  name: 'test-cua-scopes',
  inject: ['computerUse', 'subprocess', 'tools', 'systemPrompt', 'agents'],
  Config: CuaConfig,
  apply(ctx: Context, config: CuaConfig) {
    installCua(ctx, config, {
      helperPath: resolve('unused-cua-helper'),
      createChannel() { throw new Error('Scope tests must not start a native helper') },
      permissionParameters: (_method, permission, locale) => ({ permission, locale }),
      guidance: 'Fixture CUA guidance',
      capabilities: {
        platform: 'macos', methods: ['getCapabilities', 'getApp', 'getState'], appLevelAccessibility: true,
        keyboard: ['app'], browser: false, coordinateSpace: 'screenshot-pixels',
      },
    })
  },
}

async function setup(presetIds = ['standard', 'ptc']) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Sandbox)
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
  // The host reset entry lives with the dedicated runtime and leaves with the provider.
  await expect(ctx.get('cuaPrograms')?.reset(uncomposed.agent)).resolves.toBeUndefined()
  const image = { attachmentId: 'sha256:' + 'b'.repeat(64), mediaType: 'image/png', bytes: 1, width: 400, height: 200 } as const
  expect(ctx.get('cuaPrograms')?.screenshotRequestTarget(image as never)).toBeUndefined()
  await mounted.dispose()
  expect(ctx.get('cuaPrograms')).toBeUndefined()
})

it('keeps explicitly configured global raw-tool registration', async () => {
  const { ctx, create } = await setup()
  const mounted = await ctx.plugin(provider, { agentPreset: false })
  const handle = await create('cua-global', 'standard')
  expect(ctx.tools.get('cua', handle.agent)).toBeDefined()
  expect(ctx.tools.get('cua_run_code', handle.agent)).toBeUndefined()
  expect(ctx.get('cuaPrograms')).toBeUndefined()
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
  expect((await ctx.systemPrompt.assemble({ scope: existing.agent })).sections)
    .toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua', text: 'Fixture CUA guidance\n\nMaximum click holdMs: 5000 ms.' }))
  await ctx.agentPresets.select(existing.agent, 'ptc')
  expect(ctx.tools.schemas(existing.agent).filter(tool => tool.name === 'cua')).toHaveLength(1)
  const fresh = await create('fresh', 'ptc')
  expect(ctx.tools.get('cua', fresh.agent)).toBeDefined()
  await ctx.agentPresets.select(existing.agent, 'standard')
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeUndefined()
  await expect.poll(() => ctx.tools.get('cua_run_code', existing.agent)).toBeDefined()
  expect((await ctx.systemPrompt.assemble({ scope: existing.agent })).sections)
    .toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua', text: 'Fixture CUA guidance\n\nMaximum click holdMs: 5000 ms.' }))
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

it('withdraws tools when a runtime dependency unloads and rebinds live Agents after reload', async () => {
  const { ctx, create } = await setup()
  await ctx.plugin(provider, {})
  const standard = await create('cua-dependency-standard', 'standard')
  const ptc = await create('cua-dependency-ptc', 'ptc')
  const previous = ctx.tools.get('cua_run_code', standard.agent)
  expect(previous).toBeDefined()
  const directoryProvider = [...ctx.registry.get(WorkingDirectory)?.fibers ?? []][0]
  expect(directoryProvider).toBeDefined()
  await directoryProvider?.dispose()
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeUndefined()
  expect(ctx.tools.get('cua', ptc.agent)).toBeUndefined()
  await ctx.plugin(WorkingDirectory)
  await expect.poll(() => ctx.tools.get('cua_run_code', standard.agent)).toBeDefined()
  expect(ctx.tools.get('cua_run_code', standard.agent)).not.toBe(previous)
  expect(ctx.tools.get('cua', ptc.agent)).toBeDefined()
  await ctx.agentPresets.select(standard.agent, 'ptc')
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeUndefined()
  expect(ctx.tools.get('cua', standard.agent)).toBeDefined()
  await ctx.agentPresets.select(standard.agent, 'standard')
  expect(ctx.tools.get('cua_run_code', standard.agent)).toBeDefined()
  expect(ctx.tools.get('cua', standard.agent)).toBeUndefined()
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
  expect(prompt?.includes('var cua = connectCua(() => tools.cua, text => console.log(text));')).toBe(runtime.retainsState)
})
