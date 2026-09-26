import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import {
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  preflightChildLlmRoute,
} from '../src/model-selection.ts'
import { callSubagent, modelSelectionSetupAgent, setup, text } from './harness.ts'

const REASONING = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
} as const

function parentWithRoute(
  options: Agent['options'] = {
    provider: 'alpha',
    model: 'parent-model',
    reasoningEffort: ReasoningEffortId('high'),
  },
): Agent {
  const id = SessionId('parent-with-route')
  return { id, options, session: Session.create(id) } as unknown as Agent
}

describe('dsh-tool-subagent model selection', () => {
  it('rejects empty route ids at the configuration boundary', () => {
    expect(() => { assertAllowedModelRoutes([{ provider: '', model: 'model' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertAllowedModelRoutes([{ provider: 'provider', model: '' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertAllowedModelRoutes({ provider: 'provider', model: 'model' }) })
      .toThrow('requires an array of routes')
    expect(() => { assertAllowedModelRoutes([{ provider: 1, model: 'model' }]) })
      .toThrow('requires non-empty provider and model ids')
  })

  it('allows pure inheritance but rejects explicit values outside a Session allowlist', () => {
    const policy = {
      routes: [{ provider: 'alpha', model: 'allowed-model' }],
    }
    const parent = { provider: 'alpha', model: 'parent-model' }

    expect(() => { assertAllowedModelSelection(policy, parent, undefined, {}) }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(
        policy,
        parent,
        { provider: 'alpha', model: 'allowed-model' },
        { provider: 'alpha', model: 'allowed-model' },
      )
    }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(
        policy,
        parent,
        { provider: 'alpha', model: 'other-model' },
        { provider: 'alpha', model: 'other-model' },
      )
    }).toThrow('is not allowed for this Session')
    expect(() => {
      assertAllowedModelSelection(
        policy,
        parent,
        { reasoningEffort: ReasoningEffortId('low') },
        { reasoning_effort: 'low' },
      )
    }).toThrow('alpha/parent-model')
    expect(() => {
      assertAllowedModelSelection(
        policy,
        {},
        { reasoningEffort: ReasoningEffortId('low') },
        { reasoning_effort: 'low' },
      )
    }).toThrow('without an effective provider and model')
  })

  it('leaves deployment or parent defaults outside the allowlist usable when the call selects nothing', async () => {
    let starts = 0
    const ctx = await setup(
      { provider: 'mock', withModelSelection: true },
      { onStart: () => { starts += 1 } },
    )
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = {
      provider: 'deployment-provider',
      model: 'deployment-model',
    }

    const result = await callSubagent(ctx, { description: 'default route', prompt: 'do it' })

    expect(result.isError).toBe(false)
    expect(starts).toBe(1)
  })
  it('exposes Session-authorized route fields and discovery when selection is enabled', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    const agent = modelSelectionSetupAgent(ctx)
    const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual([
      'description',
      'model',
      'prompt',
      'provider',
      'reasoning_effort',
      'run_in_background',
    ])
    expect(schema.description).toContain('list_subagent_models')
    expect(ctx.tools.get('list_subagent_models', agent)).toBeDefined()
    expect(schema.description).not.toContain('alpha')

    const registration = ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))
    const definition = ctx.tools.get('subagent', agent)
    registration.replace(['beta'])
    expect(ctx.tools.get('subagent', agent)).toBe(definition)
    expect(definition?.description).not.toContain('beta')
  })

  it('hides and rejects route fields when selection is disabled', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'prompt', 'run_in_background'])
    expect(schema.description).not.toContain('list_subagent_models')
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()

    const result = await callSubagent(ctx, {
      description: 'forced route',
      prompt: 'do it',
      provider: 'alpha',
      model: 'fast-model',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('child model selection is disabled for this tool instance')
  })

  it('rejects enabled model selection when the provider cannot apply Agent options', async () => {
    await expect(setup(
      { provider: 'mock', withModelSelection: true, maxDepth: 'provider-managed' },
      { capabilities: { agentOptions: false } },
    )).rejects.toThrow('provider "mock" does not support child model selection')
  })

  it('selects an unlisted complete route and clears a configured effort when the route changes', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: {
        provider: 'alpha',
        model: 'configured-model',
        reasoningEffort: ReasoningEffortId('high'),
        maxTokens: 321,
      },
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = parentWithRoute().options

    const selected = await callSubagent(ctx, {
      description: 'route work',
      prompt: 'do it',
      provider: 'alpha',
      model: 'unlisted-model',
    })
    expect(selected.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'unlisted-model',
      maxTokens: 321,
    })

    const effort = await callSubagent(ctx, {
      description: 'same route effort',
      prompt: 'do it',
      provider: 'alpha',
      model: 'configured-model',
      reasoning_effort: 'low',
    })
    expect(effort.isError).toBe(false)
    expect(requests[1]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'configured-model',
      reasoningEffort: 'low',
      maxTokens: 321,
    })
  })

  it('accepts an effort-only override for the effective configured or parent route', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: { provider: 'alpha' },
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = parentWithRoute().options

    const result = await callSubagent(ctx, {
      description: 'effort work',
      prompt: 'do it',
      reasoning_effort: 'low',
    })
    expect(result.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'alpha', reasoningEffort: 'low' })

    const inherited = await setup({ provider: 'mock', withModelSelection: true })
    inherited.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const inheritedParent = modelSelectionSetupAgent(inherited)
    ;(inheritedParent as { options: Agent['options'] }).options = parentWithRoute().options
    const inheritedResult = await callSubagent(inherited, {
      description: 'parent effort work',
      prompt: 'do it',
      reasoning_effort: 'low',
    })
    expect(inheritedResult.isError).toBe(false)
  })

  it('inherits a parent effort only when an explicit route stays unchanged', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = parentWithRoute().options
    const result = await callSubagent(ctx, {
      description: 'same route work',
      prompt: 'do it',
      provider: 'alpha',
      model: 'parent-model',
    })
    expect(result.isError).toBe(false)
  })

  it('compares explicit routes with the latest logged parent selection', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: { reasoningEffort: ReasoningEffortId('high') },
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['current-provider'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = {
      provider: 'created-provider', model: 'created-model',
    }
    parent.session.append('request/header', {
      header: { config: { provider: 'current-provider', model: 'current-model' } },
      reason: 'initial',
    })

    const result = await callSubagent(ctx, {
      description: 'same current route',
      prompt: 'do it',
      provider: 'current-provider',
      model: 'current-model',
    })

    expect(result.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'high',
    })
  })

  it('rejects an effort without any effective route', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    const result = await callSubagent(ctx, {
      description: 'missing route',
      prompt: 'do it',
      reasoning_effort: 'low',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('without an effective provider and model')
  })

  it('rejects preflight without an effective provider and model', async () => {
    const ctx = await setup({ provider: 'mock' })
    await expect(preflightChildLlmRoute(ctx.llm, {}, undefined, AbortSignal.abort()))
      .rejects.toThrow('without an effective provider and model')
  })

  it.each([
    { provider: 'alpha' },
    { model: 'fast-model' },
  ])('rejects a partial model-facing route before child creation', async (route) => {
    let starts = 0
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: () => { starts += 1 } })
    const result = await callSubagent(ctx, { description: 'partial route', prompt: 'do it', ...route })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`provider` and `model` must be supplied together')
    expect(starts).toBe(0)
  })

  it.each([
    { provider: '', model: 'fast-model', expected: '`provider` must be non-empty' },
    { provider: 'alpha', model: '', expected: '`model` must be non-empty' },
    { reasoning_effort: '', expected: '`reasoning_effort` must be non-empty' },
  ])('rejects empty model-facing values', async ({ expected, ...selection }) => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    const result = await callSubagent(ctx, { description: 'empty route', prompt: 'do it', ...selection })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(expected)
  })

  it('uses the LLM runtime for provider and reasoning-effort validation before child creation', async () => {
    let starts = 0
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: () => { starts += 1 } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))

    const unsupported = await callSubagent(ctx, {
      description: 'bad effort',
      prompt: 'do it',
      provider: 'alpha',
      model: 'fast-model',
      reasoning_effort: 'max',
    })
    expect(unsupported.isError).toBe(true)
    expect(text(unsupported)).toContain('does not support reasoning effort "max"')

    const missing = await callSubagent(ctx, {
      description: 'bad provider',
      prompt: 'do it',
      provider: 'missing',
      model: 'fast-model',
    })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('no adapter registered for provider "missing"')
    expect(starts).toBe(0)
  })

  it('validates a configured effort before child creation', async () => {
    let starts = 0
    const ctx = await setup({
      provider: 'mock',
      agentOptions: {
        provider: 'alpha',
        model: 'parent-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
    }, { onStart: () => { starts += 1 } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
      defaultEffort: ReasoningEffortId('low'),
    }))

    const result = await callSubagent(
      ctx,
      { description: 'same route', prompt: 'do it' },
      { agent: parentWithRoute() },
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support reasoning effort "high"')
    expect(starts).toBe(0)
  })

  it('validates a configured route before child creation', async () => {
    let starts = 0
    const ctx = await setup({
      provider: 'mock',
      agentOptions: { provider: 'missing', model: 'configured-model' },
    }, { onStart: () => { starts += 1 } })

    const result = await callSubagent(
      ctx,
      { description: 'configured route', prompt: 'do it' },
      { agent: parentWithRoute() },
    )

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no adapter registered for provider "missing"')
    expect(starts).toBe(0)
  })

  it('rejects selected routes or configured efforts when the LLM service is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock' })
    await ctx.plugin(tool, {
      provider: 'mock',
      agentOptions: {
        provider: 'alpha',
        model: 'fast-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
    })

    const configured = await callSubagent(ctx, { description: 'configured effort', prompt: 'do it' })
    expect(configured.isError).toBe(true)
    expect(text(configured)).toContain('`llm` service is unavailable')

  })

  it('keeps pure inherited routing usable without an LLM service lookup', async () => {
    let starts = 0
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock', onStart: () => { starts += 1 } })
    await ctx.plugin(tool, { provider: 'mock' })

    const result = await callSubagent(ctx, { description: 'inherit route', prompt: 'do it' })
    expect(result.isError).toBe(false)
    expect(starts).toBe(1)
  })

  it('warns that changing a fork route can lose inherited-prefix reuse', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { inheritsParentContext: true })
    const schema = ctx.tools.schemas(modelSelectionSetupAgent(ctx)).find(entry => entry.name === 'subagent')!
    expect(schema.description).toContain('inherits this conversation')
    expect(schema.description).toContain('can prevent provider-side reuse of the inherited conversation prefix')
  })

  it('propagates an exact-route resolver failure before child creation', async () => {
    let starts = 0
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: () => { starts += 1 } })
    const adapter = new MockAdapter([])
    vi.spyOn(adapter, 'resolveModel').mockRejectedValue(new Error('selected route unavailable'))
    ctx.llm.registerAdapter(['alpha'], adapter)

    const result = await callSubagent(ctx, {
      description: 'route work',
      prompt: 'do it',
      provider: 'alpha',
      model: 'fast-model',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('selected route unavailable')
    expect(starts).toBe(0)
  })
})
