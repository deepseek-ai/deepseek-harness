import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** A completed turn with no tool or auxiliary model work. */
class AutoShutdownAdapter extends LlmAdapter {
  async * stream() {
    const text = 'AUTO_SHUTDOWN_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis fixture name. */
export const name = 'auto-shutdown-llm'
/** The production LLM registry owns the fixture adapter. */
export const inject = ['llm']

/**
 * Register the deterministic no-tool model.
 * @param {import('@deepseek-ai/cordis').Context} ctx - fixture context.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['auto-shutdown'], new AutoShutdownAdapter())
}
