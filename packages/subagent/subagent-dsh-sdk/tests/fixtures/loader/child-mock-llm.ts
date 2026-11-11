import type { Context } from '@deepseek-ai/cordis'
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/types'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Scripted model for the CHILD runtime: validates either the routed success
 * case or the diagnostic fixture's fixed route. Failure mode streams partial
 * text before a fixed provider error so the parent can assert safe diagnostics.
 */
class RouteEchoAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: brandString<ReasoningEffortId>('max'), name: 'Maximum' }],
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const failure = process.env.DSH_TEST_CHILD_FAILURE === '1'
    const dynamicRoute = options.provider === 'mock'
      && options.model === 'mock-routed'
      && options.reasoningEffort === 'max'
      && options.maxTokens === 777
    const diagnosticRoute = failure
      && options.provider === 'mock'
      && options.model === 'mock-echo'
    if (!dynamicRoute && !diagnosticRoute) {
      throw new Error(`unexpected child route: ${JSON.stringify({
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        maxTokens: options.maxTokens,
      })}`)
    }
    const ready = process.env.FAKE_INIT_READY
    const release = process.env.FAKE_INIT_GO
    if (ready !== undefined) writeFileSync(ready, 'ready\n')
    if (release !== undefined) {
      const deadline = Date.now() + 30_000
      while (!existsSync(release)) {
        if (Date.now() > deadline) throw new Error(`child mock timed out waiting for ${release}`)
        await setTimeout(10)
      }
    }
    const reply = failure
      ? 'partial child loader answer'
      : `child route: mock/mock-routed/max/777; cwd: ${process.cwd()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } }
    yield failure
      ? { type: 'finish', reason: { kind: 'error', failure: { code: 'CHILD_TEST_FAILURE', message: 'child loader failure' } } }
      : { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'child-mock-llm'
export const inject = ['llm']

/**
 * Register the cwd-echo adapter under the `mock` provider.
 * @param ctx - the plugin context supplying `ctx.llm`.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new RouteEchoAdapter())
}
