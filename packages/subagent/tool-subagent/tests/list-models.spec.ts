import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as tool from '../src/index.ts'
import { registerListSubagentModels } from '../src/list-models.ts'
import { testToolSignal, text } from './harness.ts'

class CatalogAdapter extends LlmAdapter {
  constructor(private readonly empty = false) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: `${provider.toUpperCase()} API` }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.empty) return Promise.resolve([])
    return Promise.resolve([
      { provider, id: 'fast', name: 'Fast', description: 'Focused work.' },
      { provider, id: 'plain', name: 'Plain' },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model === 'plain') return Promise.resolve({ provider, id: model, name: 'Plain' })
    return Promise.resolve({
      provider,
      id: model,
      name: 'Fast',
      description: 'Focused work.',
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High', description: 'Quality first.' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } })()
  }
}

async function setupListTool(routes = [
  { provider: 'alpha', model: 'fast' },
  { provider: 'alpha', model: 'plain' },
  { provider: 'beta', model: 'fast' },
  { provider: 'beta', model: 'plain' },
]) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  registerListSubagentModels(ctx, { routes })
  return ctx
}

async function setupAllowedListTool() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  registerListSubagentModels(ctx, {
    routes: [
      { provider: 'alpha', model: 'fast' },
      { provider: 'alpha', model: 'unlisted' },
      { provider: 'missing', model: 'hidden' },
    ],
  })
  return ctx
}

let counter = 0

function call(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`list-models-${++counter}`),
    name: 'list_subagent_models',
    arguments: args,
  })
}

describe('list_subagent_models', () => {
  it('is omitted unless its delegation-tool instance owns discovery', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(tool, { provider: 'unused' })
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
  })

  it('stays registered without the optional LLM service and rejects discovery calls', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    registerListSubagentModels(ctx, { routes: [{ provider: 'alpha', model: 'fast' }] })
    const result = await call(ctx, {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`llm` service is unavailable')
  })

  it('rejects two discovery-owning instances in one tool scope', async () => {
    const ctx = await setupListTool()
    expect(() => {
      registerListSubagentModels(ctx, { routes: [{ provider: 'alpha', model: 'fast' }] })
    }).toThrow('tool "list_subagent_models" is already registered')
  })

  it('lists registered providers and follows live registration changes', async () => {
    const ctx = await setupListTool()
    const empty = await call(ctx, {})
    expect(empty.isError).toBe(false)
    expect(text(empty)).toBe('(no LLM providers)')

    const registration = ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const providers = await call(ctx, {})
    expect(providers.isError).toBe(false)
    expect(text(providers)).toBe('alpha — ALPHA API')

    registration.replace(['beta'])
    const changed = await call(ctx, {})
    expect(text(changed)).toBe('beta — BETA API')

    const tools = ctx.tools
    await ctx.fiber.dispose()
    expect(tools.get('list_subagent_models')).toBeUndefined()
  })

  it('lists one provider\'s advertised models without treating the catalog as a whitelist', async () => {
    const ctx = await setupListTool()
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'alpha' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('alpha/fast — Fast: Focused work.\nalpha/plain — Plain')
  })

  it('intersects provider and model discovery with the Session allowlist', async () => {
    const ctx = await setupAllowedListTool()
    ctx.llm.registerAdapter(['alpha', 'beta'], new CatalogAdapter())

    expect(text(await call(ctx, {}))).toBe('alpha — ALPHA API')
    expect(text(await call(ctx, { provider: 'alpha' }))).toBe('alpha/fast — Fast: Focused work.')
    expect(text(await call(ctx, { provider: 'alpha', model: 'unlisted' })))
      .toContain('alpha/unlisted — Fast')

    const denied = await call(ctx, { provider: 'alpha', model: 'plain' })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('is not allowed for this Session')
  })

  it('rejects an unauthorized provider before calling its adapter catalog', async () => {
    const ctx = await setupListTool([{ provider: 'alpha', model: 'fast' }])
    const adapter = new CatalogAdapter()
    const listModels = vi.spyOn(adapter, 'listModels')
    ctx.llm.registerAdapter(['alpha', 'secret'], adapter)

    const result = await call(ctx, { provider: 'secret' })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('provider "secret" is not allowed for this Session')
    expect(listModels).not.toHaveBeenCalled()
  })

  it('renders an empty advertised model list', async () => {
    const ctx = await setupListTool([{ provider: 'alpha', model: 'fast' }])
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter(true))
    const result = await call(ctx, { provider: 'alpha' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('(no advertised models for alpha)')
  })

  it('inspects exact-model efforts, descriptions, and defaults', async () => {
    const ctx = await setupListTool()
    ctx.llm.registerAdapter(['alpha', 'secret'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'alpha', model: 'fast' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'alpha/fast — Fast: Focused work.\nReasoning efforts:\n'
      + 'low — Low\nhigh (default) — High: Quality first.',
    )
  })

  it('renders exact models without reasoning metadata', async () => {
    const ctx = await setupListTool()
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'alpha', model: 'plain' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('alpha/plain — Plain\nReasoning efforts:\n(no advertised reasoning efforts)')
  })

  it.each([
    { args: { model: 'fast' }, expected: '`model` requires `provider`' },
    { args: { provider: '' }, expected: '`provider` must be non-empty' },
    { args: { provider: 'missing' }, expected: 'is not allowed for this Session' },
  ])('rejects incomplete or unavailable provider requests', async ({ args, expected }) => {
    const ctx = await setupListTool()
    const result = await call(ctx, args)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(expected)
  })

  it('rejects an empty exact model after resolving the provider', async () => {
    const ctx = await setupListTool()
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'alpha', model: '' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`model` must be non-empty')
  })

  it('reports registered alternatives for an unavailable provider', async () => {
    const ctx = await setupListTool([
      { provider: 'alpha', model: 'fast' },
      { provider: 'missing', model: 'fast' },
    ])
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'missing' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('available providers: alpha')
    expect(text(result)).not.toContain('secret')
  })

  it('reports no available provider when the authorized registry intersection is empty', async () => {
    const ctx = await setupListTool([{ provider: 'missing', model: 'fast' }])
    const result = await call(ctx, { provider: 'missing' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('available providers: (none)')
  })
})
