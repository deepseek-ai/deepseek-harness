/** Keyless two-model adapter for the generic ACP control-surface conformance test. */

import type { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

/** Adapter whose deterministic tool turn proves model selection and MCP attachment. */
class ControlSurfaceAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    if (provider !== 'control-fixture') throw new Error(`unknown fixture provider: ${provider}`)
    return { id: provider, name: 'Control fixture' }
  }

  override listModels(provider: string) {
    if (provider !== 'control-fixture') return Promise.resolve([])
    return Promise.resolve([
      { provider, id: 'alpha', name: 'Alpha', inputModalities: ['text'] as const },
      { provider, id: 'beta', name: 'Beta', inputModalities: ['text'] as const },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 2_048 },
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const lastUserIndex = options.messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user')
    const current = options.messages.slice(lastUserIndex)
    const userText = current.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('')
    const hasToolResult = current.some(message => message.role === 'tool')
    if (!hasToolResult) {
      const callId = ToolCallId(userText.includes('cancel') ? 'control-cancel-add' : 'control-add')
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'checking the attached tool' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'checking the attached tool' } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 1,
        id: callId,
        name: 'mcp__fixture__add',
        argumentsDelta: '{"a":2,"b":3}',
      }
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: callId,
          name: 'mcp__fixture__add',
          arguments: '{"a":2,"b":3}',
        },
      }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (userText.includes('cancel')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'waiting' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new Error('cancelled'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
      })
      return
    }
    const text = `model=${options.model}; tool=5`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'control-surface-llm'
export const inject = ['llm']

/** Register the deterministic control-surface provider. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['control-fixture'], new ControlSurfaceAdapter())
}
