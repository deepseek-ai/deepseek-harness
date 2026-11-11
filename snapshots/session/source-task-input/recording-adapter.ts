/** Deterministic initial recording; replay reads the harvested Session through llm-replay. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

class SourceRecordingAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const hasSourceInput = options.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('source_input_json:')))
    const text = hasSourceInput ? 'Both observations were delivered.' : 'Ready for source observations.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Snapshot-only deterministic adapter name. */
export const name = 'source-recording-adapter'
/** The adapter registers on the shipped LLM service. */
export const inject = ['llm']

/**
 * Install the keyless model used only to produce the initial canonical recording.
 * @param ctx - Recording composition context.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['source-fixture'], new SourceRecordingAdapter())
}
