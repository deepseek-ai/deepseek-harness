import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import { TestSessionQuery } from '../../subagent/tests/test-session-query.ts'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime, { resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import {
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  preflightChildLlmRoute,
} from '../src/model-selection.ts'
import { callSubagent, modelSelectionSetupAgent, setup, text } from './harness.ts'

const REASONING = {
  efforts: [
    { id: brandString<ReasoningEffortId>('low'), name: 'Low' },
    { id: brandString<ReasoningEffortId>('high'), name: 'High' },
  ],
  defaultEffort: brandString<ReasoningEffortId>('high'),
} as const

const PARENT_MODEL = { provider: 'alpha', model: 'parent-model', reasoningEffort: brandString<ReasoningEffortId>('high') }

function parentWithRoute(
  options: Agent['options'] = PARENT_MODEL,
): Agent {
  const id = brandString<SessionId>('parent-with-route')
  return {
    id, options, session: Session.create(id),
    model: {
      current: () => options.provider === undefined || options.model === undefined
        ? undefined
        : {
          provider: options.provider, model: options.model,
          ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
        },
    },
  } as Agent
}

describe('dsh-tool-subagent model selection', () => {
  async function localTool(
    agentOptions?: Agent['options'],
    supportsOverrides = true,
    agentRouteDefaults?: Readonly<{ provider: string; model: string }>,
  ) {
    const ctx = await setup({
      provider: 'local', withModelSelection: supportsOverrides, parentAgentOptions: PARENT_MODEL,
      ...agentOptions === undefined ? {} : { agentOptions },
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-child-model-'))
    onTestFinished(async () => {
      try { await ctx.fiber.dispose() } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    })
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(TestSessionQuery)
    const prepare = vi.fn(async () => ({}))
    ctx.subagents.registerProvider({
      name: 'local',
      capabilities: { agentOptions: supportsOverrides, agentPreset: false, outputSchema: true, depthLimit: true },
      inheritsParentContext: false,
      ...agentRouteDefaults === undefined ? {} : { agentRouteDefaults },
      prepareContinuable: prepare,
    })
    const adapter = new MockAdapter(['hang'], REASONING)
    ctx.llm.registerAdapter(['alpha'], adapter)
    return { ctx, parent: modelSelectionSetupAgent(ctx), prepare, adapter }
  }

  async function childFromResult(ctx: Context, result: Awaited<ReturnType<typeof callSubagent>>): Promise<Agent> {
    expect(result.isError, text(result)).toBe(false)
    const match = /^started subagent (\S+)$/.exec(text(result))
    expect(match).not.toBeNull()
    const childId = await ctx.subagents.resolveName(modelSelectionSetupAgent(ctx), match![1]!, new AbortController().signal)
    const child = ctx.agents.get(childId)
    expect(child).toBeDefined()
    return child!
  }

  it('inherits the current model and retains configured output controls', async () => {
    const { ctx, parent } = await localTool({ maxTokens: 321 })
    parent.model.select({ provider: 'alpha', model: 'selected-model' })
    const child = await childFromResult(ctx, await callSubagent(ctx, { description: 'local route', prompt: 'work' }))
    expect(child.model.current()).toEqual({ provider: 'alpha', model: 'selected-model' })
    expect(child.options.maxTokens).toBe(321)
    expect(child.session.snapshotEvents().find(event => event.type === 'model/selection')?.data)
      .toEqual({ provider: 'alpha', model: 'selected-model' })
  })

  it('keeps the local choice fixed when the parent changes during route preflight', async () => {
    const { ctx, parent, prepare, adapter } = await localTool()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, model) => {
      entered.resolve(undefined)
      await release.promise
      return { provider, id: model, name: model, reasoning: REASONING }
    })
    const calling = callSubagent(ctx, {
      description: 'selected child', prompt: 'work', provider: 'alpha', model: 'selected-model',
    })
    try {
      await entered.promise
      expect(prepare).not.toHaveBeenCalled()
      parent.model.select({ provider: 'alpha', model: 'selected-model', reasoningEffort: brandString<ReasoningEffortId>('high') })
      release.resolve(undefined)
      const child = await childFromResult(ctx, await calling)
      expect(child.model.current()).toEqual({ provider: 'alpha', model: 'selected-model' })
      expect(child.session.snapshotEvents().find(event => event.type === 'model/selection')?.data)
        .toEqual({ provider: 'alpha', model: 'selected-model' })
    } finally {
      release.resolve(undefined)
      await calling
    }
  })

  it('allows inherited models when the local provider does not support overrides', async () => {
    const { ctx, prepare } = await localTool(undefined, false)
    const child = await childFromResult(ctx, await callSubagent(ctx, { description: 'inherited child', prompt: 'work' }))
    expect(child.model.current()).toEqual(PARENT_MODEL)
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('applies configured overrides over backend defaults without retaining the parent route effort', async () => {
    const { ctx } = await localTool(
      { model: 'configured-model', maxTokens: 321 }, true, { provider: 'alpha', model: 'child-model' },
    )
    const child = await childFromResult(ctx, await callSubagent(ctx, { description: 'configured child', prompt: 'work' }))
    expect(child.model.current()).toEqual({ provider: 'alpha', model: 'configured-model' })
    expect(child.options.maxTokens).toBe(321)
  })

  it('validates direct local overrides before provider preparation', async () => {
    const { ctx, parent, prepare } = await localTool()
    await expect(ctx.subagents.startActivation({
      provider: 'local', parent, label: 'invalid model', prompt: [], delivery: 'caller',
      agentOptions: { provider: 'missing', model: 'unavailable' }, signal: new AbortController().signal,
    })).rejects.toMatchObject({ name: 'LlmError', code: 'NO_ADAPTER' })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('reports an unsupported local effort as the tool preflight reports it for other providers', async () => {
    const args = { description: 'invalid effort', prompt: 'work', provider: 'alpha', model: 'selected-model', reasoning_effort: 'xhigh' }
    const { ctx: localCtx, prepare } = await localTool()
    const local = await callSubagent(localCtx, args)
    const otherCtx = await setup({ provider: 'mock', withModelSelection: true, parentAgentOptions: PARENT_MODEL })
    otherCtx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const other = await callSubagent(otherCtx, args)
    expect(local.error?.info).toEqual({ name: 'LlmError', code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(text(local)).toBe('Error: provider "alpha" model "selected-model" does not support reasoning effort "xhigh"')
    expect({ info: local.error?.info, text: text(local) }).toEqual({ info: other.error?.info, text: text(other) })
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each([
    { routes: [{ provider: '', model: 'model' }] },
    { routes: [{ provider: 'provider', model: '' }] },
    { routes: { provider: 'provider', model: 'model' } },
    { routes: [{ provider: 1, model: 'model' }] },
  ])('classifies malformed route settings (%j)', ({ routes }) => {
    expect(() => { assertAllowedModelRoutes(routes) }).toThrow(expect.objectContaining({
      name: 'SubagentError', code: 'INVALID_MODEL_SELECTION_SETTINGS',
    }))
  })

  it.each([true, false])('isolates invalid Host settings from ordinary delegation (modelSelection=%s)', async (modelSelection) => {
    for (const allowedModels of [[], [
      { provider: 'alpha', model: 'parent-model' },
      { provider: 'alpha', model: 'parent-model' },
    ]]) {
      let starts = 0
      const ctx = await setup({ provider: 'mock', modelSelection, modelDiscovery: true }, {
        onStart: () => { starts += 1 },
      })
      await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels })

      const ordinary = await callSubagent(ctx, { description: 'default route', prompt: 'do it' })
      expect(ordinary.isError).toBe(false)
      expect(starts).toBe(1)

      const selected = await callSubagent(ctx, {
        description: 'selected route', prompt: 'do it', provider: 'alpha', model: 'parent-model',
      })
      expect(selected.isError).toBe(true)
      expect(selected.error?.info).toEqual({
        name: 'SubagentError',
        code: modelSelection ? 'INVALID_MODEL_SELECTION_SETTINGS' : 'MODEL_SELECTION_DISABLED',
      })
      const discovered = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: brandString<ToolCallId>('invalid-settings-discovery'),
        name: 'list_subagent_models',
        arguments: {},
        agent: modelSelectionSetupAgent(ctx),
      })
      expect(discovered.isError).toBe(true)
      expect(discovered.error?.info).toEqual({ name: 'SubagentError', code: 'INVALID_MODEL_SELECTION_SETTINGS' })
      expect(starts).toBe(1)
    }
  })

  it('uses the parent route when disabled Host settings retain duplicate routes', async () => {
    let starts = 0
    const parentRoute = { provider: 'alpha', model: 'parent-model' }
    const ctx = await setup({
      provider: 'mock', modelSelection: true, modelDiscovery: true, parentAgentOptions: parentRoute,
    }, { onStart: () => { starts += 1 } })
    await ctx.plugin(SubagentModelSelectionConfig, {
      enabled: false,
      allowedModels: [parentRoute, parentRoute],
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const selected = await callSubagent(ctx, { description: 'parent route', prompt: 'do it', ...parentRoute })
    expect(selected.isError).toBe(false)
    expect(starts).toBe(1)
    const discovered = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: brandString<ToolCallId>('disabled-settings-discovery'),
      name: 'list_subagent_models',
      arguments: parentRoute,
      agent: modelSelectionSetupAgent(ctx),
    })
    expect(discovered.isError).toBe(false)
    expect(text(discovered)).toContain('parent-model')
  })

  it('checks complete explicit routes against Session authorization or the current parent route', () => {
    const policy = { routes: [{ provider: 'alpha', model: 'allowed-model' }] }
    const parent = { provider: 'alpha', model: 'parent-model' }
    expect(() => {
      assertAllowedModelSelection(policy, parent, { provider: 'alpha', model: 'allowed-model' })
    }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(policy, parent, parent)
    }).toThrow('alpha/parent-model')
    expect(() => {
      assertAllowedModelSelection(undefined, parent, parent)
    }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(undefined, parent, { provider: 'alpha', model: 'other-model' })
    }).toThrow('explicit selection is limited to the parent route')
  })

  it('points route rejections to list_subagent_models, if available', () => {
    const parent = { provider: 'alpha', model: 'parent-model' }
    const other = { provider: 'openai', model: 'other-model' }
    expect(() => { assertAllowedModelSelection(undefined, parent, other) })
      .toThrow('explicit selection is limited to the parent route. Call `list_subagent_models`, if available, to see the routes you may select.')
  })

  it('leaves deployment or parent defaults outside the allowlist usable when the call selects nothing', async () => {
    let starts = 0
    const ctx = await setup(
      { provider: 'mock', withModelSelection: true },
      { onStart: () => { starts += 1 } },
    )
    const parent = modelSelectionSetupAgent(ctx)
    parent.model.select({ provider: 'deployment-provider', model: 'deployment-model' })

    const result = await callSubagent(ctx, { description: 'default route', prompt: 'do it' })

    expect(result.isError).toBe(false)
    expect(starts).toBe(1)
  })
  it('exposes Session-authorized route fields and discovery when selection is enabled', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    const agent = modelSelectionSetupAgent(ctx)
    const schema = ctx.tools.getAll(agent).find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual([
      'description',
      'model',
      'name',
      'prompt',
      'provider',
      'reasoning_effort',
    ])
    expect(schema.description).not.toContain('list_subagent_models')
    expect(schema.description).not.toContain('Changing the route can prevent provider-side reuse')
    expect(ctx.tools.get('list_subagent_models', agent)).toBeDefined()
    expect(schema.description).not.toContain('alpha')

    const registration = ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))
    const definition = ctx.tools.get('subagent', agent)
    registration.replace(['beta'])
    expect(ctx.tools.get('subagent', agent)).toBe(definition)
    expect(definition?.description).not.toContain('beta')
  })

  it('rejects route arguments for a backend without Agent options support', async () => {
    const ctx = await setup({ provider: 'mock' }, { capabilities: { agentOptions: false } })
    const result = await callSubagent(ctx, {
      description: 'unsupported route', prompt: 'do it', provider: 'alpha', model: 'parent-model',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('model selection is disabled for this tool instance')
    expect(result.error?.info).toEqual({ name: 'SubagentError', code: 'MODEL_SELECTION_DISABLED' })
  })

  it('hides and rejects route fields without modelSelection', async () => {
    const ctx = await setup({ provider: 'mock', parentAgentOptions: { provider: 'alpha', model: 'parent-model' } })
    const schema = ctx.tools.getAll().find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'name', 'prompt'])
    expect(schema.description).not.toContain('list_subagent_models')
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()

    for (const selection of [
      { provider: 'alpha', model: 'parent-model' },
      { reasoning_effort: 'low' },
    ]) {
      const result = await callSubagent(ctx, { description: 'forced route', prompt: 'do it', ...selection })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('child model selection is disabled for this tool instance')
      expect(result.error?.info).toEqual({ name: 'SubagentError', code: 'MODEL_SELECTION_DISABLED' })
    }
  })

  it('tells the model when to set route fields and where provider ids come from', async () => {
    const routeDescriptions = (ctx: Awaited<ReturnType<typeof setup>>, name: string) => {
      const schema = ctx.tools.getAll(modelSelectionSetupAgent(ctx)).find(entry => entry.name === name)!
      const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
      return { tool: schema.description, provider: props['provider']!.description, effort: props['reasoning_effort']!.description }
    }
    const providerHint = 'LLM provider id for the subagent. Set it with `model` only when the task requires a specific model.'
    const owner = await setup({ provider: 'mock', withModelSelection: true })
    expect(routeDescriptions(owner, 'subagent')).toEqual({
      tool: expect.not.stringContaining('reasoning_effort') as string,
      provider: providerHint + ' Use a provider id listed by `list_subagent_models`.',
      effort: 'Reasoning effort id; requires `provider` and `model`. Omit to use that model\'s default effort.',
    })
    expect(owner.tools.get('list_subagent_models', modelSelectionSetupAgent(owner))?.description).toBe(
      'Inspect the routes available for explicit subagent model selection. No arguments: authorized providers. '
      + '`provider`: that provider\'s authorized models. `provider` + `model`: that model and its reasoning efforts.',
    )

    const selectionOnly = await setup({ provider: 'mock', modelSelection: true })
    expect(routeDescriptions(selectionOnly, 'subagent').provider).toBe(providerHint)
    const configured = await setup({
      provider: 'mock', modelSelection: true, agentOptions: { provider: 'alpha', model: 'configured-model' },
    })
    expect(routeDescriptions(configured, 'subagent').provider).toBe(providerHint)
  })

  it.each(['configured', 'provider'] as const)('rejects effort-only selection despite %s route defaults', async (source) => {
    const defaults = { provider: 'alpha', model: 'configured-model' }
    const start = vi.fn()
    const ctx = await setup({
      provider: 'mock', modelSelection: true,
      parentAgentOptions: { provider: 'alpha', model: 'parent-model' },
      ...source === 'configured' ? { agentOptions: defaults } : {},
    }, {
      onStart: start,
      ...source === 'provider' ? { agentRouteDefaults: defaults } : {},
    })
    const result = await callSubagent(ctx, {
      description: 'adjust effort', prompt: 'work', reasoning_effort: 'low',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`reasoning_effort` requires both `provider` and `model`')
    expect(result.error?.info).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps settings-owned route fields visible but rejects other routes without a Session policy', async () => {
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      hostSelectionEnabled: false,
      parentAgentOptions: { provider: 'alpha', model: 'parent-model' },
    })
    const agent = modelSelectionSetupAgent(ctx)
    const schema = ctx.tools.getAll(agent).find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'model', 'name', 'prompt', 'provider', 'reasoning_effort'])
    expect(schema.description).not.toContain('list_subagent_models')
    expect(schema.description).not.toContain('Changing the route can prevent provider-side reuse')
    expect(ctx.tools.get('list_subagent_models', agent)).toBeDefined()

    const result = await callSubagent(ctx, {
      description: 'forced route',
      prompt: 'do it',
      provider: 'alpha',
      model: 'fast-model',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('is not allowed by the current subagent model selection setting')
    expect(text(result)).toContain('Call `list_subagent_models`, if available, to see the routes you may select.')
    expect(result.error?.info).toEqual({ name: 'SubagentError', code: 'MODEL_ROUTE_NOT_ALLOWED' })
  })

  it('qualifies the discovery hint for an Agent whose list_subagent_models is restricted', async () => {
    const ctx = await setup({ provider: 'mock', modelSelection: true, modelDiscovery: true, parentAgentOptions: { provider: 'alpha', model: 'parent-model' } })
    const agent = modelSelectionSetupAgent(ctx)
    expect(ctx.tools.get('list_subagent_models', agent)).toBeDefined()
    agent.ctx.tools.restrict({ deny: ['list_subagent_models'] })
    expect(ctx.tools.get('list_subagent_models', agent)).toBeUndefined()
    for (const selection of [{ provider: 'alpha', model: 'fast-model' }, { provider: 'alpha' }]) {
      const result = await callSubagent(ctx, { description: 'forced route', prompt: 'do it', ...selection })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('Call `list_subagent_models`, if available, to see the routes you may select.')
    }
  })

  it('discovers only the parent route without a Session policy and permits its explicit route and effort', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      hostSelectionEnabled: false,
      parentAgentOptions: PARENT_MODEL,
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['alpha', 'other-provider'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    const discover = (args: unknown) => executeToolFixture(ctx, {
      callId: brandString<ToolCallId>('default-model-discovery'), name: 'list_subagent_models',
      arguments: args, agent: parent, signal: new AbortController().signal,
    })
    expect(text(await discover({}))).toContain('alpha')
    expect(text(await discover({}))).not.toContain('other-provider')
    expect(text(await discover({ provider: 'alpha' }))).toContain('alpha/parent-model')
    expect(text(await discover({ provider: 'alpha', model: 'parent-model' }))).toContain('low')
    expect((await discover({ provider: 'alpha', model: 'other-model' })).isError).toBe(true)

    const omitted = await callSubagent(ctx, { description: 'inherit', prompt: 'work' })
    expect(omitted.isError, text(omitted)).toBe(false)
    expect(requests[0]?.agentOptions).toBeUndefined()
    const explicit = await callSubagent(ctx, {
      description: 'same route', prompt: 'work', provider: 'alpha', model: 'parent-model',
    })
    expect(explicit.isError, text(explicit)).toBe(false)
    expect(requests[1]?.agentOptions).toEqual({ provider: 'alpha', model: 'parent-model' })
    const effort = await callSubagent(ctx, { description: 'effort', prompt: 'work', provider: 'alpha', model: 'parent-model', reasoning_effort: 'low' })
    expect(effort.isError, text(effort)).toBe(false)
    expect(requests[2]?.agentOptions).toEqual({ provider: 'alpha', model: 'parent-model', reasoningEffort: 'low' })
    const rejected = await callSubagent(ctx, {
      description: 'other route', prompt: 'work', provider: 'alpha', model: 'other-model',
    })
    expect(rejected.isError).toBe(true)
    expect(requests).toHaveLength(3)
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
        reasoningEffort: brandString<ReasoningEffortId>('high'),
        maxTokens: 321,
      },
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    parent.model.select(PARENT_MODEL)

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

  it.each([
    {},
    { provider: 'alpha' },
    { model: 'parent-model' },
  ])('rejects reasoning effort without a complete explicit route: %j', async (route) => {
    const start = vi.fn()
    const ctx = await setup({
      provider: 'mock', withModelSelection: true, parentAgentOptions: PARENT_MODEL,
    }, { onStart: start })
    const lookup = vi.spyOn(ctx.llm, 'resolveCallConfig')
    const result = await callSubagent(ctx, {
      description: 'effort work', prompt: 'do it', reasoning_effort: 'low', ...route,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`provider` and `model`')
    expect(lookup).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it.each(['parent', 'configured', 'different-configured'] as const)(
    'uses model-default effort for an explicit parent route despite %s effort', async (source) => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({
        provider: 'mock',
        withModelSelection: true,
        parentAgentOptions: PARENT_MODEL,
        ...source === 'parent' ? {} : {
          agentOptions: {
            provider: 'alpha',
            model: source === 'configured' ? 'parent-model' : 'configured-model',
            reasoningEffort: brandString<ReasoningEffortId>('high'),
          },
        },
      }, { onStart: (request) => { requests.push(request) } })
      ctx.llm.registerAdapter(['alpha'], new MockAdapter([], {
        ...REASONING, defaultEffort: brandString<ReasoningEffortId>('low'),
      }))
      const resolve = vi.spyOn(ctx.llm, 'resolveCallConfig')
      const result = await callSubagent(ctx, {
        description: 'same route work', prompt: 'do it', provider: 'alpha', model: 'parent-model',
      })
      expect(result.isError, text(result)).toBe(false)
      expect(resolve).toHaveBeenCalledWith({ provider: 'alpha', model: 'parent-model' }, expect.any(AbortSignal))
      const requested = requests[0]!.agentOptions
      expect(requested).toEqual({ provider: 'alpha', model: 'parent-model' })
      const child = resolveChildAgentOptions(modelSelectionSetupAgent(ctx), requested, 1)
      expect(child.reasoningEffort).toBeUndefined()
      expect(await ctx.llm.resolveCallConfig({
        provider: 'alpha', model: 'parent-model',
        ...child.reasoningEffort === undefined ? {} : { reasoningEffort: child.reasoningEffort },
      }))
        .toMatchObject({ reasoningEffort: 'low' })
    },
  )

  it.each([undefined, 'parent-model', 'configured-model'])(
    'preserves configured or inherited selection when all fields are omitted: %s', async (model) => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({
        provider: 'mock', withModelSelection: true,
        parentAgentOptions: PARENT_MODEL,
        ...model === undefined ? {} : { agentOptions: { provider: 'alpha', model } },
      }, { onStart: (request) => { requests.push(request) } })
      ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
      const result = await callSubagent(ctx, { description: 'default child', prompt: 'work' })
      expect(result.isError, text(result)).toBe(false)
      const child = resolveChildAgentOptions(modelSelectionSetupAgent(ctx), requests[0]!.agentOptions, 1)
      expect(child.model).toBe(model ?? 'parent-model')
      expect(child.reasoningEffort).toBe(model === 'configured-model' ? undefined : 'high')
    },
  )

  it('compares explicit routes with the parent choice before request use', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: { reasoningEffort: brandString<ReasoningEffortId>('high') },
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['current-provider'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    parent.model.select({
      provider: 'created-provider', model: 'created-model',
    })
    parent.session.append('request/header', {
      header: { config: { provider: 'created-provider', model: 'created-model' } },
      reason: 'initial',
    })
    parent.model.select({ provider: 'current-provider', model: 'current-model' })

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
    expect(text(result)).toContain('`reasoning_effort` requires both `provider` and `model`')
    expect(result.error?.info).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
  })

  it('rejects a configured partial route when the parent supplies no provider', async () => {
    const started = vi.fn()
    const ctx = await setup({ provider: 'mock', agentOptions: { model: 'configured-model' } }, { onStart: started })
    const result = await callSubagent(ctx, { description: 'incomplete route', prompt: 'work' })
    expect(result.isError).toBe(true)
    expect(result.error?.info).toEqual({ name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' })
    expect(text(result)).toContain('without an effective provider and model')
    expect(started).not.toHaveBeenCalled()
  })

  it('rejects preflight without an effective provider and model', async () => {
    const ctx = await setup({ provider: 'mock' })
    await expect(preflightChildLlmRoute(ctx.llm, {}, undefined, AbortSignal.abort()))
      .rejects.toMatchObject({
        name: 'ToolContextUnavailableError',
        code: 'TOOL_CONTEXT_UNAVAILABLE',
        message: 'cannot select child LLM values without an effective provider and model',
      })
  })

  it.each([
    { provider: 'alpha' },
    { model: 'fast-model' },
  ])('rejects a partial model-facing route before child creation', async (route) => {
    let starts = 0
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: () => { starts += 1 } })
    const result = await callSubagent(ctx, { description: 'partial route', prompt: 'do it', ...route })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`provider` and `model` must be supplied together.')
    expect(text(result)).toContain('Call `list_subagent_models`, if available, to see the routes you may select.')
    expect(result.error?.info).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
    expect(starts).toBe(0)
  })

  it('treats empty route fields as omitted', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: (request) => { requests.push(request) } })
    const result = await callSubagent(ctx, {
      description: 'empty route', prompt: 'do it', provider: '', model: '', reasoning_effort: '',
    })
    expect(result.isError, text(result)).toBe(false)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.agentOptions).toBeUndefined()

    const partial = await callSubagent(ctx, { description: 'empty provider', prompt: 'do it', provider: '', model: 'fast-model' })
    expect(partial.isError).toBe(true)
    expect(text(partial)).toContain('`provider` and `model` must be supplied together')
    expect(requests).toHaveLength(1)
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
        reasoningEffort: brandString<ReasoningEffortId>('high'),
      },
    }, { onStart: () => { starts += 1 } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], {
      efforts: [{ id: brandString<ReasoningEffortId>('low'), name: 'Low' }],
      defaultEffort: brandString<ReasoningEffortId>('low'),
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
    await ctx.plugin(NativeToolRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock' })
    await ctx.plugin(tool, {
      provider: 'mock',
      agentOptions: {
        provider: 'alpha',
        model: 'fast-model',
        reasoningEffort: brandString<ReasoningEffortId>('high'),
      },
    })

    const configured = await callSubagent(ctx, { description: 'configured effort', prompt: 'do it' }, { agent: parentWithRoute() })
    expect(configured.isError).toBe(true)
    expect(text(configured)).toContain('`llm` service is unavailable')
    expect(configured.error?.info).toEqual({ name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' })

  })

  it('keeps pure inherited routing usable without resolving an LLM route', async () => {
    const started = vi.fn()
    const ctx = await setup({ provider: 'mock' }, { onStart: started })
    const adapter = new MockAdapter([])
    const resolve = vi.spyOn(adapter, 'resolveModel')
    ctx.llm.registerAdapter(['alpha'], adapter)

    const result = await callSubagent(ctx, { description: 'inherit route', prompt: 'do it' })
    expect(result.isError).toBe(false)
    expect(started).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('enforces Session authorization when a fork tool explicitly enables model selection', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, {
      inheritsParentContext: true,
      onStart: (request) => { requests.push(request) },
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const agent = modelSelectionSetupAgent(ctx)
    const schema = ctx.tools.getAll(agent).find(entry => entry.name === 'subagent')!
    expect(schema.description).toContain('inherits this conversation')
    expect(schema.description).not.toContain('list_subagent_models')
    expect(schema.description).toContain('Changing the route can prevent provider-side reuse of the inherited conversation prefix.')

    const allowed = await callSubagent(ctx, {
      description: 'fork work', prompt: 'do it', provider: 'alpha', model: 'fast-model', reasoning_effort: 'low',
    })
    expect(allowed.isError, text(allowed)).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha', model: 'fast-model', reasoningEffort: brandString<ReasoningEffortId>('low'),
    })

    const denied = await callSubagent(ctx, {
      description: 'unauthorized route', prompt: 'do it', provider: 'alpha', model: 'denied-model',
    })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('is not allowed by the current subagent model selection setting')
    expect(denied.error?.info).toEqual({ name: 'SubagentError', code: 'MODEL_ROUTE_NOT_ALLOWED' })

    const invalidEffort = await callSubagent(ctx, {
      description: 'unsupported effort', prompt: 'do it', provider: 'alpha', model: 'fast-model', reasoning_effort: 'invalid',
    })
    expect(invalidEffort.isError).toBe(true)
    expect(text(invalidEffort)).toContain('invalid')
    expect(requests).toHaveLength(1)
  })

  it('keeps fork model selection unavailable without instance opt-in even with Host authorization', async () => {
    const started = vi.fn()
    const ctx = await setup({ provider: 'mock' }, {
      inheritsParentContext: true,
      onStart: started,
    })
    await ctx.plugin(SubagentModelSelectionConfig, {
      enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast-model' }],
    })
    const agent = modelSelectionSetupAgent(ctx)
    const schema = ctx.tools.getAll(agent).find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'name', 'prompt'])
    expect(schema.description).toContain('inherits this conversation')
    expect(schema.description).not.toContain('list_subagent_models')
    expect(ctx.tools.get('list_subagent_models', agent)).toBeUndefined()

    for (const selection of [
      { provider: 'alpha', model: 'fast-model' },
      { reasoning_effort: 'high' },
    ]) {
      const result = await callSubagent(ctx, { description: 'fork work', prompt: 'do it', ...selection })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('model selection is disabled for this tool instance')
      expect(result.error?.info).toEqual({ name: 'SubagentError', code: 'MODEL_SELECTION_DISABLED' })
    }
    expect(started).not.toHaveBeenCalled()

    const inherited = await callSubagent(ctx, { description: 'fork work', prompt: 'do it' })
    expect(inherited.isError).toBe(false)
    expect(started).toHaveBeenCalledOnce()
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
