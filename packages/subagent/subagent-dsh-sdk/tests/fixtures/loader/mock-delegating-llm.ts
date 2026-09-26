import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync } from 'node:fs'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/**
 * Test adapter for the `mock-delegate` model: the first request calls the
 * `subagent` tool once, and the follow-up streams the tool result text back
 * verbatim — so the SDK child runtime's answer (the scripted child model's
 * cwd echo) reaches the parent session log for the driving e2e to assert.
 */
class MockDelegatingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (process.env.DSH_TEST_PARENT_MODEL_RECORD !== undefined) {
      appendFileSync(process.env.DSH_TEST_PARENT_MODEL_RECORD, `${provider}/${model}\n`)
    }
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('max'), name: 'Maximum' }],
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    const toolResultText = last?.role === 'tool'
      ? last.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      : ''

    if (toolResultText.length === 0) {
      const selectedRoute = process.env.DSH_TEST_CHILD_DEFAULT_ROUTE === '1'
        ? { reasoning_effort: 'max' }
        : { provider: 'mock', model: 'mock-routed', reasoning_effort: 'max' }
      const args = JSON.stringify({
        description: 'route probe',
        prompt: 'report your route and workspace',
        ...selectedRoute,
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-delegate'), name: 'subagent', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-delegate'), name: 'subagent', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const reply = `child reported:\n${toolResultText}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'mock-llm'
export const inject = ['llm']

/**
 * Register the delegating mock adapter under the `mock` provider.
 * @param ctx - the plugin context supplying `ctx.llm`.
 */
export function apply(ctx: Context): void {
  const providers = process.env.DSH_TEST_PARENT_PROVIDER === 'deepseek-official'
    ? ['deepseek-official', 'mock']
    : ['mock']
  ctx.llm.registerAdapter(providers, new MockDelegatingAdapter())
}
