/** Compiled synthetic model for the shipped sdk-minimal profile; tools remain production plugins. */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { response, WORKLOAD } from './workload.ts'

class ProfileAdapter extends LlmAdapter {
  private requests = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 1_000_000 })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const serial = this.requests++
    if (serial % 2 === 1) {
      yield* response(200_000 + serial, 0).chunks
      return
    }
    for (let index = 0; index < WORKLOAD.toolsPerLiveTurn; index++) {
      const id = ToolCallId('profile-call-' + String(serial) + '-' + String(index))
      const args = JSON.stringify({ command: 'view', path: process.cwd() + '/synthetic.txt' })
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: 'str_replace_editor', argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: 'str_replace_editor', arguments: args } }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** Loader plugin identity. */
export const name = 'backend-profile-benchmark-model'
/** The scripted provider requires the production LLM registry. */
export const inject = ['llm']

/**
 * Register the synthetic provider without changing any runtime services or tools.
 * @param ctx - profile-owned plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['bench'], new ProfileAdapter()))
}
