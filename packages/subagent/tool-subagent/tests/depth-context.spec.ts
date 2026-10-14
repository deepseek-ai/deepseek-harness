import { describe, expect, it } from 'vitest'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as tool from '../src/index.ts'
import { disposeSetupProvider, modelSelectionSetupAgent, setup } from './harness.ts'
import { mountScriptedProvider } from './scripted-provider.ts'

/** Read the current tool-owned depth context through real prompt assembly. */
async function depthContext(ctx: Context, agent?: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble(agent === undefined ? undefined : assembleContextFor(agent))
  return assembly.contexts.filter(part => part.name.endsWith(':depth') && part.text !== '').map(part => part.text)
}

describe('delegation depth context', () => {
  it.each([
    { depth: 0, maxDepth: 0, remaining: 0 },
    { depth: 0, maxDepth: 1, remaining: 1 },
    { depth: 1, maxDepth: 1, remaining: 0 },
    { depth: 1, maxDepth: 2, remaining: 1 },
    { depth: 2, maxDepth: 1, remaining: 0 },
  ])('reports depth $depth with cap $maxDepth without changing system text or tools', async ({ depth, maxDepth, remaining }) => {
    const ctx = await setup({ provider: 'mock', maxDepth })
    const root = modelSelectionSetupAgent(ctx)
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('depth-context-child'),
      meta: { delegationDepth: depth },
      // Resumed agents can have fresh runtime options; the persisted depth wins.
      agentOptions: { subagentDepth: 0 },
    })
    const baseline = await ctx.systemPrompt.assemble(assembleContextFor(root))
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.sections).toEqual(baseline.sections)
    expect(assembly.tools).toEqual(baseline.tools)
    expect(await depthContext(ctx, agent)).toEqual(remaining === 0 ? [
      `Delegation depth for \`subagent\`: current ${depth}, maximum ${maxDepth}, remaining levels 0.`
        + ' Do not call `subagent` at this depth; carry out the work directly.',
    ] : [])
    const restore = agent.ctx.systemPrompt.suppressRuntimeContext()
    try {
      expect(await depthContext(ctx, agent)).toEqual([])
      expect(ctx.systemPrompt.refreshContext(assembly, assembleContextFor(agent))
        .contexts.some(part => part.name.endsWith(':depth'))).toBe(false)
    } finally {
      restore()
    }
    expect(await depthContext(ctx, agent)).toHaveLength(remaining === 0 ? 1 : 0)
  })

  it('uses the runtime depth when it is deeper than the saved header', async () => {
    const ctx = await setup({ provider: 'mock', maxDepth: 2 })
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('deeper-runtime'),
      agentOptions: { subagentDepth: 2 },
    })
    expect(await depthContext(ctx, agent)).toEqual([
      'Delegation depth for `subagent`: current 2, maximum 2, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly.',
    ])
  })

  it('omits unknown provider-managed limits and agentless diagnostics', async () => {
    const ctx = await setup({ provider: 'mock', maxDepth: 'provider-managed' })
    expect(await depthContext(ctx, modelSelectionSetupAgent(ctx))).toEqual([])
    await ctx.plugin(tool, { provider: 'mock', toolName: 'bounded', maxDepth: 0 })
    expect(await depthContext(ctx)).toEqual([])
    expect(await depthContext(ctx, modelSelectionSetupAgent(ctx))).toEqual([
      'Delegation depth for `bounded`: current 0, maximum 0, remaining levels 0. Do not call `bounded` at this depth; carry out the work directly.',
    ])
  })

  it('follows the visible definition and removes context with the provider', async () => {
    const ctx = await setup({ provider: 'mock', maxDepth: 0 })
    const root = modelSelectionSetupAgent(ctx)
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('scoped-depth-policy'),
      meta: { delegationDepth: 1 },
      setup: async (agentCtx) => { await agentCtx.plugin(tool, { provider: 'mock', maxDepth: 1 }) },
    })
    expect(await depthContext(ctx, agent)).toEqual([
      'Delegation depth for `subagent`: current 1, maximum 1, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly.',
    ])
    const restore = root.ctx.tools.restrict({ deny: ['subagent'] })
    expect(await depthContext(ctx, root)).toEqual([])
    restore()
    expect(await depthContext(ctx, root)).toEqual([
      'Delegation depth for `subagent`: current 0, maximum 0, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly.',
    ])
    const removeOverride = root.ctx.tools.register({ ...ctx.tools.get('subagent')!, description: 'Scoped replacement' })
    expect(await depthContext(ctx, root)).toEqual([])
    removeOverride()
    await disposeSetupProvider(ctx)
    expect(await depthContext(ctx, agent)).toEqual([])
    await mountScriptedProvider(ctx, { name: 'mock' })
    expect(await depthContext(ctx, agent)).toHaveLength(1)
  })

  it('disposes its depth contribution with the tool plugin', async () => {
    const ctx = await setup({ provider: 'mock', maxDepth: 0 })
    const agent = modelSelectionSetupAgent(ctx)
    const fiber = await ctx.plugin(tool, { provider: 'mock', toolName: 'extra', maxDepth: 0 })
    expect(await depthContext(ctx, agent)).toHaveLength(2)
    await fiber.dispose()
    expect(await depthContext(ctx, agent)).toHaveLength(1)
  })
})
