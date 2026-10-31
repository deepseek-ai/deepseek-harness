import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { assertImageInputRoute } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, onTestFinished } from 'vitest'

const MODELS: readonly LlmModelInfo[] = [
  { provider: 'visual', id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] },
  { provider: 'visual', id: 'text-model', name: 'Text', inputModalities: ['text'] },
  { provider: 'visual', id: 'legacy-model', name: 'Legacy' },
]

/** Catalog-only adapter; `stream` is unreachable. */
class CatalogAdapter extends LlmAdapter {
  override listModels(): Promise<readonly LlmModelInfo[]> { return Promise.resolve(MODELS) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = MODELS.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider, id: model, name: model,
      ...found?.inputModalities === undefined ? {} : { inputModalities: [...found.inputModalities] },
    })
  }
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('never streams') }
}

const refusals = { unresolved: 'route unknown', unsupported: (model: string) => `${model} cannot see images` }
const signal = new AbortController().signal

async function setup(llm = true): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  if (llm) {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['visual'], new CatalogAdapter())
  }
  return ctx
}

function agent(header: { provider: string; model: string } | undefined, options: { provider?: string; model?: string } = {}): Agent {
  // The check reads only the Session request header and the agent options.
  return { options, session: { requestHeader: () => header === undefined ? undefined : { config: header } } } as never
}

describe('assertImageInputRoute', () => {
  it('accepts a request-header route that declares image input', async () => {
    const ctx = await setup()
    await expect(assertImageInputRoute(ctx, { signal, agent: agent({ provider: 'visual', model: 'vision-model' }) }, refusals)).resolves.toBeUndefined()
  })

  it('falls back to the agent options when the Session has no request header', async () => {
    const ctx = await setup()
    await expect(assertImageInputRoute(ctx, { signal, agent: agent(undefined, { provider: 'visual', model: 'vision-model' }) }, refusals)).resolves.toBeUndefined()
    await expect(assertImageInputRoute(ctx, { signal, agent: agent(undefined, { provider: 'visual', model: 'text-model' }) }, refusals))
      .rejects.toThrow('text-model cannot see images')
  })

  it('refuses a model without declared image input, including unknown capability', async () => {
    const ctx = await setup()
    await expect(assertImageInputRoute(ctx, { signal, agent: agent({ provider: 'visual', model: 'text-model' }) }, refusals))
      .rejects.toThrow('text-model cannot see images')
    await expect(assertImageInputRoute(ctx, { signal, agent: agent({ provider: 'visual', model: 'legacy-model' }) }, refusals))
      .rejects.toThrow('legacy-model cannot see images')
  })

  it('refuses an unresolved route: no agent, no provider or model, or no llm service', async () => {
    const ctx = await setup()
    await expect(assertImageInputRoute(ctx, { signal }, refusals)).rejects.toThrow('route unknown')
    await expect(assertImageInputRoute(ctx, { signal, agent: agent(undefined, { model: 'vision-model' }) }, refusals)).rejects.toThrow('route unknown')
    await expect(assertImageInputRoute(ctx, { signal, agent: agent(undefined, { provider: 'visual' }) }, refusals)).rejects.toThrow('route unknown')
    const bare = await setup(false)
    await expect(assertImageInputRoute(bare, { signal, agent: agent({ provider: 'visual', model: 'vision-model' }) }, refusals)).rejects.toThrow('route unknown')
  })
})
