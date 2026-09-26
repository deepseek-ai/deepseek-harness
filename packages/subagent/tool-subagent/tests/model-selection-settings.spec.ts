/** Default-off settings and per-session model-selection decisions. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as tool from '../src/index.ts'
import * as ToolInvariant from '../src/invariant.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import {
  subagentModelSelectionPolicy,
  subagentModelSelectionProjectionDefinition,
} from '../src/model-selection-state.ts'
import { callSubagent, text } from './harness.ts'

const ALLOWED_MODELS = [{ provider: 'alpha', model: 'fast-model' }]

const selectionConfigs = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()
const subagentConfigs = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()

/** Read whether one Agent's delegation definition contains route fields. */
function selectable(ctx: Context, agent: Awaited<ReturnType<Context['agents']['create']>>['agent']): boolean {
  const schema = ctx.tools.schemas(agent).find(candidate => candidate.name === 'subagent')
  const properties = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties?.['provider'] !== undefined
    && properties['model'] !== undefined
    && properties['reasoning_effort'] !== undefined
    && ctx.tools.schemas(agent).some(candidate => candidate.name === 'list_subagent_models')
}

const modelSelectionPresets = new WeakMap<Context, ReturnType<typeof createScope>>()

/** Mount the real settings, Agent, provider, and optional preset tool services. */
async function boot(withPreset = true): Promise<Context> {
  const ctx = new Context()

  selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  subagentConfigs.set(ctx, await liveConfig(ctx, SubagentRuntime))
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  if (withPreset) {
    const preset = createScope(ctx, { preset: 'model-selection-test' })
    await preset.ctx.plugin(tool, {
      provider: 'spawn',
      modelSelectionSettings: true,
      backgroundMode: 'continuable',
    })
    modelSelectionPresets.set(ctx, preset)
  }
  return ctx
}

/** Create one Agent joined to the test's standing preset. */
async function createAgent(ctx: Context, id: string, options: {
  meta?: { parentSession: SessionId; origin: 'subagent' }
  seed?: readonly SessionEvent[]
} = {}) {
  const preset = modelSelectionPresets.get(ctx)
  if (preset === undefined) throw new Error('context has no model-selection preset')
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    ...options,
    setup: (agentCtx) => {
      bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!)
    },
  })
  return handle.agent
}

describe('SubagentModelSelectionConfig', () => {
  it('uses the composed default without a settings provider', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: ALLOWED_MODELS })

    expect(ctx.subagentModelSelection.current()).toEqual({ enabled: true, allowedModels: ALLOWED_MODELS })
    await ctx.fiber.dispose()
  })

  it('defaults off and follows the validated user layer', async () => {
    const ctx = new Context()

    selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))

    expect(ctx.subagentModelSelection.current()).toEqual({ enabled: false, allowedModels: [] })
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    expect(ctx.subagentModelSelection.current()).toEqual({ enabled: true, allowedModels: ALLOWED_MODELS })
    await ctx.fiber.dispose()
  })

  it('rejects duplicate routes, enabled empty settings, and an empty durable policy', async () => {
    const ctx = new Context()

    selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)

    // A stored policy the service cannot apply fails when it is read, not when the profile row is written.
    await selectionConfigs.get(ctx)!.update({ allowedModels: [...ALLOWED_MODELS, ...ALLOWED_MODELS] })
    expect(() => ctx.subagentModelSelection.current()).toThrow('repeats route "alpha/fast-model"')

    await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: [] })
    expect(() => ctx.subagentModelSelection.current()).toThrow('enabled subagent model selection requires at least one allowed model')
    await selectionConfigs.get(ctx)!.update({
      enabled: false,
      allowedModels: ALLOWED_MODELS,
    })
    expect(ctx.subagentModelSelection.current()).toEqual({ enabled: false, allowedModels: ALLOWED_MODELS })
    await selectionConfigs.get(ctx)!.update({ allowedModels: [] })
    expect(ctx.subagentModelSelection.current()).toEqual({ enabled: false, allowedModels: [] })

    const invalid = Session.create(SessionId('empty-policy'))
    invalid.append('subagent/model-selection-policy', { allowedModels: [] })
    expect(() => subagentModelSelectionPolicy(ctx.sessionProjections, invalid)).toThrow('requires at least one route')

    const malformed = Session.create(SessionId('malformed-policy'))
    malformed.append('subagent/model-selection-policy', {
      allowedModels: [{ provider: 1, model: 'fast-model' }],
    } as never)
    expect(() => subagentModelSelectionPolicy(ctx.sessionProjections, malformed))
      .toThrow('requires non-empty provider and model ids')
    await ctx.fiber.dispose()
  })

  it('samples each new root Session without changing existing definitions', async () => {
    const ctx = await boot()
    const disabled = await createAgent(ctx, 'disabled')
    expect(selectable(ctx, disabled)).toBe(false)
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, disabled.session)).toBeUndefined()

    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const enabled = await createAgent(ctx, 'enabled')
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, enabled.session)).toEqual(ALLOWED_MODELS)
    expect(selectable(ctx, enabled)).toBe(true)
    expect(selectable(ctx, disabled)).toBe(false)

    await selectionConfigs.get(ctx)!.update({ enabled: false })
    const disabledAgain = await createAgent(ctx, 'disabled-again')
    expect(selectable(ctx, disabledAgain)).toBe(false)
    expect(selectable(ctx, enabled)).toBe(true)
    await ctx.fiber.dispose()
  })

  it('installs a direct Agent setup before Session publication', async () => {
    const ctx = await boot(false)
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    let prepared: Awaited<ReturnType<Context['agents']['create']>>['agent'] | undefined
    let visibleAtSessionCreated = false
    ctx.on('session/created', () => {
      visibleAtSessionCreated = prepared !== undefined && selectable(ctx, prepared)
    })

    const handle = await ctx.agents.create({
      sessionId: SessionId('direct-agent-setup'),
      setup: async (agentCtx, agent) => {
        prepared = agent
        const fiber = agentCtx.inject(tool.inject, (runtimeCtx) => {
          tool.apply(runtimeCtx, {
            provider: 'spawn',
            modelSelectionSettings: true,
            backgroundMode: 'continuable',
          }, agent.session)
        })
        await fiber.await()
      },
    })

    expect(visibleAtSessionCreated).toBe(true)
    expect(selectable(ctx, handle.agent)).toBe(true)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('installs one tool when recording the Session policy triggers a registry refresh', async () => {
    const ctx = await boot()
    try {
      await selectionConfigs.get(ctx)!.update({
        enabled: true,
        allowedModels: ALLOWED_MODELS,
      })
      const preset = modelSelectionPresets.get(ctx)!
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'subagent/model-selection-policy') {
          ctx.emit(scopeTarget({}, scopeOf(preset.ctx)), 'tools/change')
        }
      })
      const register = vi.spyOn(ctx.tools, 'register')

      const agent = await createAgent(ctx, 'policy-refresh')

      expect(selectable(ctx, agent)).toBe(true)
      expect(register.mock.calls.filter(([definition]) => definition.name === 'subagent')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a forced route outside the Session policy before child creation', async () => {
    const ctx = await boot()
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const agent = await createAgent(ctx, 'enforced')

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('disallowed-session-route'),
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
    expect(text(result)).toContain('is not allowed for this Session')
    await ctx.fiber.dispose()
  })

  it('installs per-Agent definitions for a shared preset scope', async () => {
    const ctx = await boot(false)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(ToolInvariant)
    const preset = createScope(ctx, { preset: 'standard' })
    const other = createScope(ctx, { preset: 'minimal' })
    await preset.ctx.plugin(tool, {
      provider: 'spawn',
      modelSelectionSettings: true,
      backgroundMode: 'continuable',
    })

    let enabledBinding: ReturnType<typeof bindScopeParent> | undefined
    const createComposed = async (id: string) => ctx.agents.create({
      sessionId: SessionId(id),
      setup: (agentCtx) => {
        const binding = bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!)
        if (id === 'preset-enabled') enabledBinding = binding
      },
    })

    const disabled = await createComposed('preset-disabled')
    expect(selectable(ctx, disabled.agent)).toBe(false)
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const enabled = await createComposed('preset-enabled')
    expect(selectable(ctx, enabled.agent)).toBe(true)
    expect(selectable(ctx, disabled.agent)).toBe(false)

    enabledBinding!.rebind(scopeOf(other.ctx)!)
    ctx.emit(scopeTarget({}, scopeOf(preset.ctx)), 'tools/change')
    await vi.waitFor(() => { expect(selectable(ctx, enabled.agent)).toBe(false) })
    const next = () => Promise.resolve({ kind: 'enter' as const, messages: [] })
    const payload = {
      agent: enabled.agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', payload, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })

    enabledBinding!.rebind(scopeOf(preset.ctx)!)
    ctx.emit(scopeTarget({}, scopeOf(preset.ctx)), 'tools/change')
    await vi.waitFor(() => { expect(selectable(ctx, enabled.agent)).toBe(true) })
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', payload, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })

    await enabled.dispose()
    ctx.emit(scopeTarget({}, scopeOf(preset.ctx)), 'tools/change')
    await disabled.dispose()
    await ctx.fiber.dispose()
  })

  it('releases a shared-preset installation reservation after policy selection fails', async () => {
    const ctx = await boot(false)
    const preset = createScope(ctx, { preset: 'standard' })
    const other = createScope(ctx, { preset: 'minimal' })
    await preset.ctx.plugin(tool, {
      provider: 'spawn',
      modelSelectionSettings: true,
      backgroundMode: 'continuable',
    })
    let binding: ReturnType<typeof bindScopeParent> | undefined
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-policy-retry'),
      setup: (agentCtx) => {
        binding = bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!)
      },
    })
    expect(selectable(ctx, handle.agent)).toBe(false)

    binding!.rebind(scopeOf(other.ctx)!)
    ctx.emit(scopeTarget({}, scopeOf(preset.ctx)), 'tools/change')
    binding!.rebind(scopeOf(preset.ctx)!)
    vi.spyOn(ctx.subagentModelSelection, 'current')
      .mockImplementationOnce(() => { throw new Error('transient settings read') })
      .mockReturnValue({ enabled: true, allowedModels: ALLOWED_MODELS })

    expect(() => { ctx.emit(scopeTarget({}, scopeOf(preset.ctx)), 'tools/change') })
      .toThrow('transient settings read')
    ctx.emit(scopeTarget({}, scopeOf(preset.ctx)), 'tools/change')
    await vi.waitFor(() => { expect(selectable(ctx, handle.agent)).toBe(true) })

    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('inherits the parent decision and preserves seeded decisions across composition', async () => {
    const ctx = await boot()
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const parent = await createAgent(ctx, 'parent')
    await selectionConfigs.get(ctx)!.update({ enabled: false })
    const child = await createAgent(ctx, 'child', {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    expect(selectable(ctx, child)).toBe(true)
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, child.session)).toEqual(ALLOWED_MODELS)

    const orphan = await createAgent(ctx, 'orphan', {
      meta: { parentSession: SessionId('missing-parent'), origin: 'subagent' },
    })
    expect(selectable(ctx, orphan)).toBe(false)

    const enabledSeed = Session.create(SessionId('enabled-seed'))
    enabledSeed.append('subagent/model-selection-policy', { allowedModels: ALLOWED_MODELS })
    const resumedEnabled = await createAgent(ctx, 'resumed-enabled', { seed: enabledSeed.snapshotEvents() })
    expect(selectable(ctx, resumedEnabled)).toBe(true)

    const oldSeed = Session.create(SessionId('old-seed'), [])
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const resumedEmpty = await createAgent(ctx, 'resumed-empty', { seed: [] })
    expect(selectable(ctx, resumedEmpty)).toBe(false)
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, resumedEmpty.session)).toBeUndefined()

    const resumedDisabled = await createAgent(ctx, 'resumed-disabled', { seed: oldSeed.snapshotEvents() })
    expect(selectable(ctx, resumedDisabled)).toBe(false)
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, resumedDisabled.session)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('requires both the Host setting owner and a scoped standing preset', async () => {
    const withoutSettings = new Context()
    await mountAgentLoopTestDependencies(withoutSettings)
    await withoutSettings.plugin(SubagentRuntime)
    expect(() => {
      tool.apply(withoutSettings, {
        provider: 'missing',
        modelSelectionSettings: true,
        maxDepth: 'provider-managed',
      })
    }).toThrow('requires @deepseek-ai/dsh-tool-subagent/model-selection-settings')
    await withoutSettings.fiber.dispose()

    const withoutAgent = await boot(false)
    expect(() => {
      tool.apply(withoutAgent, {
        provider: 'spawn',
        modelSelectionSettings: true,
        backgroundMode: 'continuable',
      })
    }).toThrow('requires a scoped preset Context')

    await withoutAgent.fiber.dispose()
  })

  it('requires the Session registry when a child inherits its parent policy', async () => {
    const ctx = new Context()
    try {
      selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))
      await ctx.plugin(SessionProjectionRegistry)
      subagentConfigs.set(ctx, await liveConfig(ctx, SubagentRuntime))
      const childId = SessionId('child-without-session-registry')
      const child = Session.create(childId, undefined, {
        version: SESSION_FORMAT_VERSION,
        id: childId,
        createdAt: 1,
        isSeeded: false,
        origin: 'subagent',
        parentSession: SessionId('missing-parent'),
      })

      expect(() => {
        tool.apply(ctx, {
          provider: 'missing',
          modelSelectionSettings: true,
          maxDepth: 'provider-managed',
        }, child)
      }).toThrow('child model-selection inheritance requires the Session registry')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('checks model-selectable definitions without rejecting a policy-only preset', async () => {
    const ctx = await boot()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(ToolInvariant)
    const disabled = await createAgent(ctx, 'invariant-disabled')
    const next = () => Promise.resolve({ kind: 'enter' as const, messages: [] })
    const payload = {
      agent: disabled,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', payload, next)).resolves.toEqual({
      kind: 'enter', messages: [],
    })

    disabled.session.append('subagent/model-selection-policy', { allowedModels: ALLOWED_MODELS })
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', payload, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })

    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const enabled = await createAgent(ctx, 'invariant-enabled')
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', { ...payload, agent: enabled }, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })

    const enabledSchemas = ctx.tools.schemas(enabled)
    const schemas = vi.spyOn(ctx.tools, 'schemas')
    schemas.mockReturnValue(enabledSchemas.filter(schema => schema.name !== 'list_subagent_models'))
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', { ...payload, agent: enabled }, next))
      .rejects.toThrow('require a durable policy, route fields, and list_subagent_models')

    schemas.mockReturnValue(enabledSchemas)
    await selectionConfigs.get(ctx)!.update({ enabled: false })
    const withoutPolicy = await createAgent(ctx, 'invariant-without-policy')
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', { ...payload, agent: withoutPolicy }, next))
      .rejects.toThrow('require a durable policy, route fields, and list_subagent_models')
    await ctx.fiber.dispose()
  })
})


it('reads the saved default depth at each delegation without remounting the tool', async () => {
  const ctx = await boot(false)
  const depths: Array<number | undefined> = []
  try {
    ctx.subagents.registerProvider({
      name: 'capture-depth',
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: async (request) => {
        depths.push(request.maxDepth)
        return { id: SessionId(`depth-${depths.length}`), localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'completed' as const }), dispose: async () => {} }
      },
    })
    await ctx.plugin(tool, { provider: 'capture-depth' })
    await callSubagent(ctx, { description: 'first', prompt: 'work' })
    await subagentConfigs.get(ctx)!.update({ maxDepth: 5 })
    await callSubagent(ctx, { description: 'second', prompt: 'work' })
    await subagentConfigs.get(ctx)!.update({ maxDepth: 0 })
    await callSubagent(ctx, { description: 'disabled', prompt: 'work' })
    expect(depths).toEqual([1, 5, 0])
  } finally {
    await ctx.fiber.dispose()
  }
})
