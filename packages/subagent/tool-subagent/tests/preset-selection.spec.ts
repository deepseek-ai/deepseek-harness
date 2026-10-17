/** Deployment configuration and model-facing selection for spawn presets. */
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as tool from '../src/index.ts'
import { SubagentPresetSelection } from '../src/preset-selection.ts'
import { mountScriptedProvider, type Config as ProviderConfig } from './scripted-provider.ts'
import { callSubagent, text } from './harness.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function setup(config: Omit<tool.Config, 'provider'>, providerConfig: Partial<ProviderConfig> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'writer' })
  const presets = new Map<string, () => Promise<void>>()
  for (const id of ['writer', 'reviewer']) {
    presets.set(id, await ctx.agentPresets.register({ id, description: `${id} persona`, plugins: [] }))
  }
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const onStart = vi.fn()
  const provider = await mountScriptedProvider(ctx, {
    name: 'custom-spawn', capabilities: { agentPreset: true }, onStart, ...providerConfig,
  })
  ctx.loader.builtins.subagentTool = tool
  await ctx.loader.root.update([{
    id: 'tool', name: 'cordis:subagentTool', inject: ['agentPresets'],
    config: { provider: 'custom-spawn', ...config },
  }])
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { ctx, onStart, provider, presets }
}

const args = { description: 'review task', prompt: 'Review this change.' }

describe('spawn preset selection', () => {
  it.each([false, true])('selects presets with modelSelection=%s and enforces route authorization', async (modelSelection) => {
    const { ctx, onStart } = await setup({
      allowedAgentPresets: ['writer', 'reviewer'],
      modelSelection,
    })
    const schema = ctx.tools.schemas().find(schema => schema.name === 'subagent')
    expect(JSON.stringify(schema)).toContain('agent_preset')
    expect(JSON.stringify(schema)).toContain('reviewer persona')
    expect(schema?.parameters.properties).toHaveProperty('agent_preset')
    expect(Object.hasOwn(schema!.parameters.properties!, 'model')).toBe(modelSelection)
    expect((await callSubagent(ctx, { ...args, agent_preset: 'reviewer' })).isError).not.toBe(true)
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      agentPreset: 'reviewer',
    }))
    const rejected = await callSubagent(ctx, {
      ...args, agent_preset: 'reviewer', provider: 'unapproved', model: 'unapproved',
    })
    expect(rejected.isError).toBe(true)
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('uses a default without exposing a model selector', async () => {
    const { ctx, onStart } = await setup({ agentPreset: 'reviewer' })
    expect(JSON.stringify(ctx.tools.schemas())).not.toContain('agent_preset')
    await callSubagent(ctx, args)
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ agentPreset: 'reviewer' }))
    const forced = await callSubagent(ctx, { ...args, agent_preset: 'writer' })
    expect(forced.isError).toBe(true)
    expect(text(forced)).toContain('selection is disabled')
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it.each([{}, { allowedAgentPresets: ['writer', 'reviewer'] }])('preserves inheritance when no default or argument is supplied: %j', async (config) => {
    const { ctx, onStart } = await setup(config)
    await callSubagent(ctx, args)
    expect(onStart.mock.calls[0]?.[0]).not.toHaveProperty('agentPreset')
  })

  it('uses the default when a selectable argument is omitted and rejects unlisted ids', async () => {
    const { ctx, onStart } = await setup({ agentPreset: 'reviewer', allowedAgentPresets: ['writer', 'reviewer'] })
    await callSubagent(ctx, args)
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ agentPreset: 'reviewer' }))
    expect((await callSubagent(ctx, { ...args, agent_preset: 'absent' })).isError).toBe(true)
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it.each([
    { allowedAgentPresets: [] },
    { allowedAgentPresets: ['writer', 'writer'] },
    { allowedAgentPresets: [''] },
    { agentPreset: 'writer', allowedAgentPresets: ['reviewer'] },
    { agentPreset: 'absent' },
    { agentPreset: '' },
  ])('rejects invalid deployment choices before registration: %j', async (config) => {
    await expect(setup(config)).rejects.toThrow()
  })

  it.each([
    { inheritsParentContext: true },
    { capabilities: { agentPreset: false } },
  ])('rejects providers that cannot independently compose a child: %j', async (providerConfig) => {
    await expect(setup({ agentPreset: 'reviewer' }, providerConfig)).rejects.toThrow(/independent agent preset/)
  })

  it('rejects forced selection at the model JSON resolver', () => {
    const selection = new SubagentPresetSelection({ allowedAgentPresets: ['writer'] })
    expect(() => selection.resolve({ agent_preset: 'unlisted' })).toThrow(/must be one of/)
    expect(() => selection.resolve({ agent_preset: 1 })).toThrow(/must be one of/)
  })

  it('requires the preset service when selection is configured', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(tool.apply(ctx, { provider: 'spawn', agentPreset: 'writer' })).rejects.toThrow(/requires the agent-presets service/)
    const selection = new SubagentPresetSelection({ agentPreset: 'writer' })
    await expect(selection.validate(ctx)).rejects.toThrow(/requires the agent-presets service/)
  })

  it('reads declared metadata for a broken preset and rejects mounting its composition', async () => {
    const { ctx, presets } = await setup({})
    await presets.get('reviewer')!()
    await ctx.agentPresets.register({
      id: 'reviewer', description: 'Review with unavailable tools.',
      plugins: [{ name: 'cordis:missing-plugin' }],
    })
    const selection = new SubagentPresetSelection({ allowedAgentPresets: ['reviewer'] })
    await selection.validate(ctx)
    expect(selection.description).toContain('reviewer: Review with unavailable tools.')
    await expect(ctx.agents.create({
      sessionId: SessionId('broken-preset'),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'reviewer') },
    })).rejects.toMatchObject({ code: 'agent-preset/invalid' })
    expect(ctx.agents.list()).toEqual([])
  })

  it('creates an Agent from a preset whose delegation tool selects itself', async () => {
    const { ctx } = await setup({})
    await ctx.agentPresets.register({
      id: 'self', description: 'Self-selected composition.',
      plugins: [{
        name: 'cordis:subagentTool',
        config: { provider: 'custom-spawn', toolName: 'self_delegate', allowedAgentPresets: ['self'] },
      }],
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('self-selecting-preset'),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'self') },
    })
    const schema = ctx.tools.schemas(handle.agent).find(schema => schema.name === 'self_delegate')
    expect(schema).toHaveProperty('parameters.properties.agent_preset.enum', ['self'])
    expect(JSON.stringify(schema)).toContain('self: Self-selected composition.')
  })

  it.each([
    ['alpha', 'beta'], ['beta', 'alpha'],
  ])('creates Agents from mutually selecting presets registered in %s/%s order', async (first, second) => {
    const { ctx } = await setup({})
    for (const id of [first, second]) {
      const other = id === 'alpha' ? 'beta' : 'alpha'
      await ctx.agentPresets.register({
        id, description: `${id} composition.`,
        plugins: [{
          name: 'cordis:subagentTool',
          config: { provider: 'custom-spawn', toolName: 'peer_delegate', allowedAgentPresets: [other] },
        }],
      })
    }
    for (const id of [first, second]) {
      const other = id === 'alpha' ? 'beta' : 'alpha'
      const handle = await ctx.agents.create({
        sessionId: SessionId(`mutually-selecting-${id}`),
        setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, id) },
      })
      const schema = ctx.tools.schemas(handle.agent).find(schema => schema.name === 'peer_delegate')
      expect(schema).toHaveProperty('parameters.properties.agent_preset.enum', [other])
      expect(JSON.stringify(schema)).toContain(`${other}: ${other} composition.`)
    }
  })

  it('rejects Agent publication when a preset delegation tool names an absent preset', async () => {
    const { ctx } = await setup({})
    await ctx.agentPresets.register({
      id: 'missing-reference',
      plugins: [{
        name: 'cordis:subagentTool',
        config: { provider: 'custom-spawn', toolName: 'missing_delegate', agentPreset: 'absent' },
      }],
    })
    const published = vi.fn()
    ctx.on('agent/created', published)
    await expect(ctx.agents.create({
      sessionId: SessionId('unpublished-preset'),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'missing-reference') },
    })).rejects.toThrow('Unknown agent preset: absent')
    expect(published).not.toHaveBeenCalled()
    expect(ctx.agents.list()).toEqual([])
    expect(ctx.sessions.list()).toEqual([])
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('missing_delegate')
  })

  it('can advertise a preset without a description', async () => {
    const { ctx, presets } = await setup({})
    await presets.get('reviewer')!()
    await ctx.agentPresets.register({ id: 'reviewer', plugins: [] })
    const selection = new SubagentPresetSelection({ allowedAgentPresets: ['reviewer'] })
    await selection.validate(ctx)
    expect(selection.description).not.toContain('Available presets:')
  })

})
