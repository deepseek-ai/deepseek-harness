/** Script only the external model; Source delivery and the write executor remain real. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'

class SourceConfinementAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const id = brandString<ToolCallId>('source-confinement-write')
    const hasSourceInput = options.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('source_input_json:')))
    const hasResult = options.messages.some(message => message.role === 'tool' && message.toolCallId === id)
    if (hasSourceInput && !hasResult) {
      const args = JSON.stringify({ file_path: 'source-confinement-sentinel.txt', content: 'Source write reached the filesystem.\n' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = hasResult ? 'The source-triggered write was attempted.' : 'Ready for source observations.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Deterministic external-model fixture for Source filesystem-policy expectations. */
export const name = 'source-confinement-model-adapter'
/** The shipped LLM service owns adapter registration. */
export const inject = ['llm']

/**
 * Produce one Source-triggered write attempt without an external API.
 * @param ctx - Isolated test composition and registration lifetime.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['source-fixture'], new SourceConfinementAdapter()))
}
