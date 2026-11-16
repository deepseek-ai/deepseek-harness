import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync } from 'node:fs'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm/types'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Delegation argument sequences selected by `DSH_TEST_PARENT_ROUTE_SCRIPT`. */
const ROUTE_SCRIPTS: Readonly<Record<string, readonly Readonly<Record<string, string>>[]>> = {
  // An unauthorized route, then the empty optional strings some models send for omitted fields.
  'empty-after-denied': [
    { provider: 'mock', model: 'unlisted-model' },
    { provider: '', model: '', reasoning_effort: '' },
  ],
}

/** Yield one scripted `subagent` call. */
async function * delegate(id: string, selectedRoute: Readonly<Record<string, string>>): AsyncIterable<StreamChunk> {
  const args = JSON.stringify({
    description: 'route probe',
    prompt: 'report your route and workspace',
    ...selectedRoute,
  })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: brandString<ToolCallId>(id), name: 'subagent', argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(id), name: 'subagent', arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** Script delegation calls, then acknowledge the receipt and the completion notice. */
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
        efforts: [{ id: brandString<ReasoningEffortId>('max'), name: 'Maximum' }],
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

    const toolResults = options.messages.filter(message => message.role === 'tool').length
    const script = ROUTE_SCRIPTS[process.env.DSH_TEST_PARENT_ROUTE_SCRIPT ?? '']
    if (script !== undefined) {
      const scripted = script[toolResults]
      if (scripted !== undefined) {
        yield * delegate(toolResults === 0 ? 'call-delegate' : `call-delegate-${toolResults + 1}`, scripted)
        return
      }
    } else if (toolResults === 0) {
      yield * delegate('call-delegate', process.env.DSH_TEST_CHILD_EFFORT_ONLY === '1'
        ? { reasoning_effort: 'max' }
        : { provider: 'mock', model: 'mock-routed', reasoning_effort: 'max' })
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
