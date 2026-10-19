/** Parent model fixture for a composition that must not start a turn. */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

class CompositionOnlyAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('OAR composition must not invoke a model')
  }
}

export const name = 'oar-loader-fixture'
export const inject = ['llm']

/**
 * Complete the parent composition without contacting a model.
 * @param ctx - Loader context containing the LLM registry.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new CompositionOnlyAdapter())
}
