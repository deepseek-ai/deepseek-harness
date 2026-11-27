/** Default-off Host settings read at each delegation and discovery call. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/types'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as tool from '../src/index.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import { callSubagent, ownContext, text } from './harness.ts'

const ALLOWED_MODELS = [{ provider: 'alpha', model: 'fast-model' }]

const selectionConfigs = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()
const subagentConfigs = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()

/** Read whether one Agent's delegation definition contains route fields. */
function selectable(ctx: Context, agent: Awaited<ReturnType<Context['agents']['create']>>['agent']): boolean {
  const schema = ctx.tools.getAll(agent).find(candidate => candidate.name === 'subagent')
  const properties = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties?.['provider'] !== undefined
    && properties['model'] !== undefined
    && properties['reasoning_effort'] !== undefined
    && ctx.tools.getAll(agent).some(candidate => candidate.name === 'list_subagent_models')
}

/** Mount the real settings, Agent, provider, and optional preset tool services. */
async function boot(withPreset = true): Promise<Context> {
  const ctx = ownContext(new Context())
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.subagentTool = tool

  await mountAgentLoopTestDependencies(ctx)
  selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  subagentConfigs.set(ctx, await liveConfig(ctx, SubagentRuntime))
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(AgentPresets, { default: 'model-selection-test' })
  if (withPreset) {
    await ctx.agentPresets.register({ id: 'model-selection-test', plugins: [{
      name: 'cordis:subagentTool',
      config: { provider: 'spawn', modelSelection: true, modelDiscovery: true },
    }] })
  }
  return ctx
}

/** Create one Agent joined to the test's standing preset. */
async function createAgent(ctx: Context, id: string, options: {
  meta?: { parentSession: SessionId; origin: 'subagent' }
  seed?: readonly SessionEvent[]
} = {}) {
  const handle = await ctx.agents.create({
    sessionId: brandString<SessionId>(id),
    ...options,
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'model-selection-test') },
  })
  return handle.agent
}

/** Delegate one explicit route from an Agent and return the tool result. */
function delegate(ctx: Context, agent: Awaited<ReturnType<typeof createAgent>>, id: string, model = 'fast-model') {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: brandString<ToolCallId>(id),
    name: 'subagent',
    arguments: { description: 'routed work', prompt: 'do it', provider: 'alpha', model },
    agent,
  })
}

describe('SubagentModelSelectionConfig', () => {
  it('uses the composed default without a settings provider', async () => {
    const ctx = ownContext(new Context())
    await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: ALLOWED_MODELS })
    expect(ctx.subagentModelSelection.allowedRoutes()).toEqual(ALLOWED_MODELS)
    await ctx.fiber.dispose()
  })

  it('defaults off and reads the current user layer at each call', async () => {
    const ctx = ownContext(new Context())
    selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))
    expect(ctx.subagentModelSelection.allowedRoutes()).toBeUndefined()
    await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: ALLOWED_MODELS })
    const routes = ctx.subagentModelSelection.allowedRoutes()
    expect(routes).toEqual(ALLOWED_MODELS)
    routes!.pop()
    expect(ctx.subagentModelSelection.allowedRoutes()).toEqual(ALLOWED_MODELS)
    await selectionConfigs.get(ctx)!.update({ enabled: false })
    expect(ctx.subagentModelSelection.allowedRoutes()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reads the default route live and independently of the enabled switch', async () => {
    const ctx = ownContext(new Context())
    selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))
    expect(ctx.subagentModelSelection.defaultRoute()).toBeUndefined()
    await selectionConfigs.get(ctx)!.update({ defaultModel: ALLOWED_MODELS[0] })
    const route = ctx.subagentModelSelection.defaultRoute()
    expect(route).toEqual(ALLOWED_MODELS[0])
    expect(route).not.toBe(ALLOWED_MODELS[0])
    await selectionConfigs.get(ctx)!.update({ enabled: false, defaultModel: undefined })
    expect(ctx.subagentModelSelection.defaultRoute()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('ignores disabled routes and rejects duplicate or empty routes only while enabled', async () => {
    const ctx = ownContext(new Context())
    selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))
    await selectionConfigs.get(ctx)!.update({ allowedModels: [...ALLOWED_MODELS, ...ALLOWED_MODELS] })
    expect(ctx.subagentModelSelection.allowedRoutes()).toBeUndefined()
    await selectionConfigs.get(ctx)!.update({ enabled: true })
    expect(() => ctx.subagentModelSelection.allowedRoutes()).toThrow(expect.objectContaining({
      name: 'SubagentError', code: 'INVALID_MODEL_SELECTION_SETTINGS',
      message: 'subagent model selection repeats route "alpha/fast-model"',
    }))
    await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: [] })
    expect(() => ctx.subagentModelSelection.allowedRoutes())
      .toThrow(expect.objectContaining({ name: 'SubagentError', code: 'INVALID_MODEL_SELECTION_SETTINGS' }))
    await selectionConfigs.get(ctx)!.update({ enabled: false })
    expect(ctx.subagentModelSelection.allowedRoutes()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('applies setting edits to the next delegation in existing parent and child Sessions', async () => {
    const ctx = await boot()
    const parent = await createAgent(ctx, 'live-parent')
    const child = await createAgent(ctx, 'live-child', { meta: { parentSession: parent.id, origin: 'subagent' } })
    for (const agent of [parent, child]) {
      const denied = await delegate(ctx, agent, `${agent.id}-before`)
      expect(text(denied)).toContain('explicit selection is limited to the parent route')
      expect(denied.error?.info).toEqual({ name: 'SubagentError', code: 'MODEL_ROUTE_NOT_ALLOWED' })
    }

    await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: ALLOWED_MODELS })
    for (const agent of [parent, child]) {
      const allowed = await delegate(ctx, agent, `${agent.id}-enabled`)
      expect(allowed.error?.info).not.toMatchObject({ code: 'MODEL_ROUTE_NOT_ALLOWED' })
      const other = await delegate(ctx, agent, `${agent.id}-other`, 'other-model')
      expect(other.error?.info).toEqual({ name: 'SubagentError', code: 'MODEL_ROUTE_NOT_ALLOWED' })
    }

    await selectionConfigs.get(ctx)!.update({ enabled: false })
    const disabled = await delegate(ctx, parent, 'live-parent-disabled')
    expect(disabled.error?.info).toEqual({ name: 'SubagentError', code: 'MODEL_ROUTE_NOT_ALLOWED' })
    for (const agent of [parent, child]) {
      expect(agent.session.snapshotEvents().some(event => event.type === 'subagent/model-selection-policy')).toBe(false)
    }
    await ctx.fiber.dispose()
  })

  it('keeps the parent prompt and tool schemas stable when the default child route changes', async () => {
    const ctx = await boot()
    const parent = assembleContextFor(await createAgent(ctx, 'default-route-parent'))
    const before = await ctx.systemPrompt.assemble(parent)
    await selectionConfigs.get(ctx)!.update({ defaultModel: ALLOWED_MODELS[0] })
    const after = await ctx.systemPrompt.assemble(parent)
    expect(after.sections).toEqual(before.sections)
    expect(after.tools).toEqual(before.tools)
    expect(after.contexts).toEqual(before.contexts)
    await ctx.fiber.dispose()
  })

  it('ignores a policy recorded in a resumed Session', async () => {
    const ctx = await boot()
    const seed = Session.create(brandString<SessionId>('legacy-seed'))
    seed.append('subagent/model-selection-policy', { allowedModels: ALLOWED_MODELS })
    const resumed = await createAgent(ctx, 'legacy-resumed', { seed: seed.snapshotEvents() })
    const result = await delegate(ctx, resumed, 'legacy-route')
    expect(text(result)).toContain('explicit selection is limited to the parent route')
    expect(result.error?.info).toEqual({ name: 'SubagentError', code: 'MODEL_ROUTE_NOT_ALLOWED' })
    await ctx.fiber.dispose()
  })

  it('installs a direct Agent setup before Agent publication', async () => {
    const ctx = await boot(false)
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    let prepared: Awaited<ReturnType<Context['agents']['create']>>['agent'] | undefined
    let visibleAtAgentCreated = false
    ctx.on('agent/created', () => {
      visibleAtAgentCreated = prepared !== undefined && selectable(ctx, prepared)
    })

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('direct-agent-setup'),
      setup: async (agentCtx, agent) => {
        prepared = agent
        const fiber = agentCtx.inject(tool.inject, (runtimeCtx) => {
          tool.apply(runtimeCtx, {
            provider: 'spawn',
            modelSelection: true,
            modelDiscovery: true,
          })
        })
        await fiber.await()
      },
    })

    expect(visibleAtAgentCreated).toBe(true)
    expect(selectable(ctx, handle.agent)).toBe(true)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects a forced route outside the current setting before child creation', async () => {
    const ctx = await boot()
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const agent = await createAgent(ctx, 'enforced')

    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: brandString<ToolCallId>('disallowed-session-route'),
      name: 'subagent',
      arguments: {
        description: 'forced route',
        prompt: 'do it',
        provider: 'alpha',
        model: 'other-model',
      },
      agent,
    })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('is not allowed by the current subagent model selection setting')
    expect(result.error?.info).toEqual({ name: 'SubagentError', code: 'MODEL_ROUTE_NOT_ALLOWED' })
    await ctx.fiber.dispose()
  })

  it('shares definitions across Agents and updates visibility when selecting another preset', async () => {
    const ctx = await boot()
    await ctx.agentPresets.register({ id: 'minimal', plugins: [] })
    const createComposed = async (id: string) => ctx.agents.create({
      sessionId: brandString<SessionId>(id),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'model-selection-test') },
    })

    const disabled = await createComposed('preset-disabled')
    expect(selectable(ctx, disabled.agent)).toBe(true)
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const enabled = await createComposed('preset-enabled')
    expect(selectable(ctx, enabled.agent)).toBe(true)
    expect(selectable(ctx, disabled.agent)).toBe(true)
    expect(ctx.tools.get('subagent', enabled.agent)).toBe(ctx.tools.get('subagent', disabled.agent))
    expect(ctx.tools.get('subagent')).toBeUndefined()
    const preset = await ctx.agentPresets.acquireScope('model-selection-test')
    try { expect(ctx.tools.get('subagent', enabled.agent)).toBe(ctx.tools.get('subagent', preset.key)) }
    finally { await preset[Symbol.asyncDispose]() }

    await ctx.agentPresets.select(enabled.agent, 'minimal')
    expect(selectable(ctx, enabled.agent)).toBe(false)
    const next = () => Promise.resolve({ kind: 'enter' as const, messages: [] })
    const payload = {
      agent: enabled.agent,
      modelSelection: { provider: 'mock', model: 'mock' },
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', payload, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })

    await ctx.agentPresets.select(enabled.agent, 'model-selection-test')
    expect(selectable(ctx, enabled.agent)).toBe(true)
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', payload, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })

    await enabled.dispose()
    expect(selectable(ctx, disabled.agent)).toBe(true)
    await disabled.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps shared delegation and discovery hidden by the existing inherited-tool filter', async () => {
    const ctx = await boot()
    try {
      const parent = await createAgent(ctx, 'filter-parent')
      const child = (await ctx.agents.create({
        sessionId: brandString<SessionId>('filter-child'),
        meta: { parentSession: parent.id, origin: 'subagent' },
        setup: async (childCtx) => {
          await ctx.agentPresets.mount(childCtx, 'model-selection-test')
          childCtx.tools.restrict({ deny: ['subagent', 'list_subagent_models'] })
        },
      })).agent
      expect(ctx.tools.get('subagent', parent)).toBeDefined()
      expect(ctx.tools.get('subagent', child)).toBeUndefined()
      expect(ctx.tools.get('list_subagent_models', child)).toBeUndefined()
      const result = await executeToolFixture(ctx, {
        name: 'subagent', callId: brandString<ToolCallId>('filtered-delegation'), arguments: {},
        agent: child, signal: new AbortController().signal,
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('unknown tool')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('permits independently configured delegation tools without a settings service', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(tool, { provider: 'spawn', modelSelection: true })
    await ctx.plugin(tool, { provider: 'spawn', toolName: 'another_spawn', modelSelection: true })
    expect(ctx.tools.get('subagent')).toBeDefined()
    expect(ctx.tools.get('another_spawn')).toBeDefined()
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

it('reads the saved default depth at each delegation without remounting the tool', async () => {
  const ctx = await boot(false)
  const depths: Array<number | undefined> = []
  try {
    ctx.subagents.registerProvider({
      name: 'capture-depth',
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
      inheritsParentContext: false,
      start: async (request) => {
        depths.push(request.maxDepth)
        return { id: brandString<SessionId>(`depth-${depths.length}`),
          result: Promise.resolve({ output: [], stopReason: 'completed' as const }), dispose: async () => {} }
      },
    })
    await ctx.plugin(tool, { provider: 'capture-depth' })
    const { agent } = await ctx.agents.create({ sessionId: brandString<SessionId>('live-depth-context') })
    const initial = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(initial.contexts.find(part => part.name === 'tool:subagent:depth')?.text)
      .toBe('')
    await callSubagent(ctx, { description: 'first', prompt: 'work' })
    await subagentConfigs.get(ctx)!.update({ maxDepth: 5 })
    const updated = ctx.systemPrompt.refreshContext(initial, assembleContextFor(agent))
    expect(updated.contexts.find(part => part.name === 'tool:subagent:depth')?.text)
      .toBe('')
    await callSubagent(ctx, { description: 'second', prompt: 'work' })
    await subagentConfigs.get(ctx)!.update({ maxDepth: 0 })
    const disabled = ctx.systemPrompt.refreshContext(initial, assembleContextFor(agent))
    expect(disabled.contexts.find(part => part.name === 'tool:subagent:depth')?.text)
      .toBe('Delegation depth for `subagent`: current 0, maximum 0, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly.')
    expect(disabled.sections).toEqual(initial.sections)
    expect(disabled.tools).toEqual(initial.tools)
    await subagentConfigs.get(ctx)!.update({ maxDepth: 2 })
    expect(ctx.systemPrompt.refreshContext(disabled, assembleContextFor(agent))
      .contexts.find(part => part.name === 'tool:subagent:depth')?.text).toBe('')
    await subagentConfigs.get(ctx)!.update({ maxDepth: 0 })
    await callSubagent(ctx, { description: 'disabled', prompt: 'work' })
    expect(depths).toEqual([1, 5, 0])
  } finally {
    await ctx.fiber.dispose()
  }
})
