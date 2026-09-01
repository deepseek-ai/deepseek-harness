/** Default-off settings and per-session model-selection decisions. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as tool from '../src/index.ts'
import * as ToolInvariant from '../src/invariant.ts'
import SubagentModelSelectionConfig, {
  SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
} from '../src/model-selection-settings.ts'
import {
  subagentModelSelectionPolicy,
  subagentModelSelectionProjectionDefinition,
} from '../src/model-selection-state.ts'
import { text } from './harness.ts'

const ALLOWED_MODELS = [{ provider: 'alpha', model: 'fast-model' }]

/** Writable in-memory settings provider for the package integration. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** Read whether one Agent's delegation definition contains route fields. */
function selectable(ctx: Context, agent: Awaited<ReturnType<Context['agents']['create']>>['agent']): boolean {
  const schema = ctx.tools.schemas(agent).find(candidate => candidate.name === 'subagent')
  const properties = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties?.['provider'] !== undefined
    && properties['model'] !== undefined
    && properties['reasoning_effort'] !== undefined
    && ctx.tools.schemas(agent).some(candidate => candidate.name === 'list_subagent_models')
}

/** Mount the real settings, Agent, provider, and tool services. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SubagentModelSelectionConfig)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  return ctx
}

/** Create one Agent whose setup mounts the settings-controlled tool preset row. */
async function createAgent(ctx: Context, id: string, options: {
  meta?: { parentSession: SessionId; origin: 'subagent' }
  seed?: readonly SessionEvent[]
} = {}) {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    ...options,
    setup: async (agentCtx) => {
      await agentCtx.plugin(tool, {
        provider: 'spawn',
        modelSelectionSettings: true,
        backgroundMode: 'continuable',
      })
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
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SubagentModelSelectionConfig)

    expect(ctx.subagentModelSelection.current()).toEqual({ enabled: false, allowedModels: [] })
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    expect(ctx.subagentModelSelection.current()).toEqual({ enabled: true, allowedModels: ALLOWED_MODELS })
    await ctx.fiber.dispose()
  })

  it('rejects duplicate routes, enabled empty settings, and an empty durable policy', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SubagentModelSelectionConfig)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)

    await expect(ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      allowedModels: [...ALLOWED_MODELS, ...ALLOWED_MODELS],
    })).rejects.toThrow('repeats route "alpha/fast-model"')

    await expect(ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      enabled: true,
      allowedModels: [],
    })).rejects.toThrow('enabled subagent model selection requires at least one allowed model')
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      enabled: false,
      allowedModels: ALLOWED_MODELS,
    })
    expect(ctx.subagentModelSelection.current()).toEqual({ enabled: false, allowedModels: ALLOWED_MODELS })
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { allowedModels: [] })
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

  it('samples each new root session without changing existing Agents', async () => {
    const ctx = await boot()
    const disabled = await createAgent(ctx, 'disabled')
    expect(selectable(ctx, disabled)).toBe(false)
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, disabled.session)).toBeUndefined()

    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const enabled = await createAgent(ctx, 'enabled')
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, enabled.session)).toEqual(ALLOWED_MODELS)
    expect(selectable(ctx, enabled)).toBe(true)
    expect(selectable(ctx, disabled)).toBe(false)

    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: false })
    const disabledAgain = await createAgent(ctx, 'disabled-again')
    expect(selectable(ctx, disabledAgain)).toBe(false)
    expect(selectable(ctx, enabled)).toBe(true)
    await ctx.fiber.dispose()
  })

  it('rejects a forced route outside the Session policy before child creation', async () => {
    const ctx = await boot()
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
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
    const ctx = await boot()
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
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
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
    const ctx = await boot()
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
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const parent = await createAgent(ctx, 'parent')
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: false })
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
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
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

  it('requires both the Host setting owner and a composition scope', async () => {
    const withoutSettings = new Context()
    await mountAgentLoopTestDependencies(withoutSettings)
    await withoutSettings.plugin(SessionProjectionRegistry)
    await withoutSettings.plugin(SubagentRuntime)
    expect(() => {
      tool.apply(withoutSettings, {
        provider: 'missing',
        modelSelectionSettings: true,
        maxDepth: 'provider-managed',
      })
    }).toThrow('requires @deepseek-ai/dsh-tool-subagent/model-selection-settings')
    await withoutSettings.fiber.dispose()

    const withoutAgent = await boot()
    expect(() => {
      tool.apply(withoutAgent, {
        provider: 'spawn',
        modelSelectionSettings: true,
        backgroundMode: 'continuable',
      })
    }).toThrow('requires an Agent or preset scope')
    await withoutAgent.fiber.dispose()
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

    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
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
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: false })
    const withoutPolicy = await createAgent(ctx, 'invariant-without-policy')
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', { ...payload, agent: withoutPolicy }, next))
      .rejects.toThrow('require a durable policy, route fields, and list_subagent_models')
    await ctx.fiber.dispose()
  })
})
