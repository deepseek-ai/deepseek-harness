/** CUA tool and prompt ownership follows live Agent presets and provider disposal. */
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import Subprocess from '@deepseek-ai/dsh-subprocess'
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
      description: 'Fixture computer interaction', guidance: 'Fixture CUA guidance',
    })
  },
}

async function setup(presetIds = ['standard', 'ptc']) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
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

it('adds and removes CUA for existing and new PTC Agents without changing other presets', async () => {
  const { ctx, create } = await setup()
  const existing = await create('existing', 'ptc')
  const standard = await create('standard', 'standard')
  expect(ctx.tools.get('cua', existing.agent)).toBeUndefined()
  const mounted = await ctx.plugin(provider, {})
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeDefined()
  expect(ctx.tools.get('cua', standard.agent)).toBeUndefined()
  expect((await ctx.systemPrompt.assemble({ scope: existing.agent })).sections)
    .toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua', text: 'Fixture CUA guidance\n\nMaximum click holdMs: 5000 ms.' }))
  await ctx.agentPresets.select(existing.agent, 'ptc')
  expect(ctx.tools.schemas(existing.agent).filter(tool => tool.name === 'cua')).toHaveLength(1)
  const fresh = await create('fresh', 'ptc')
  expect(ctx.tools.get('cua', fresh.agent)).toBeDefined()
  await ctx.agentPresets.select(existing.agent, 'standard')
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeUndefined()
  expect((await ctx.systemPrompt.assemble({ scope: existing.agent })).sections)
    .not.toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua' }))
  await ctx.agentPresets.select(existing.agent, 'ptc')
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeDefined()
  await fresh.dispose()
  expect(ctx.tools.get('cua', fresh.agent)).toBeUndefined()
  await mounted.dispose()
  expect(ctx.tools.get('cua', existing.agent)).toBeUndefined()
  expect((await ctx.systemPrompt.assemble({ scope: existing.agent })).sections)
    .not.toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua' }))
  const reloaded = await ctx.plugin(provider, {})
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeDefined()
  expect(ctx.tools.get('cua', standard.agent)).toBeUndefined()
  await reloaded.dispose()
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
