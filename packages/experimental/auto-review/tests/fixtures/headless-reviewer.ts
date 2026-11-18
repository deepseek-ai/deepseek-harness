/** Script only the external reviewer; the shipped tool pipeline executes or refuses each body. */
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Test-only review result selection; omission selects by the pending write target. */
export interface Config {
  mode?: 'allow' | 'deny' | 'malformed' | 'failed'
}

export const name = 'headless-auto-review-fixture'
export const inject = ['llm']

/**
 * Supply deterministic reviewer responses without intercepting main-agent calls.
 * @param ctx - fixture plugin context.
 * @param config - optional fixed response for the CLI smoke.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('llm/stream', async function* (options, next): AsyncIterable<StreamChunk> {
    if (!options.system?.startsWith('REVIEW_POLICY\n')) {
      yield* next()
      return
    }
    const texts = options.messages.map(message => message.content.find(block => block.type === 'text')?.text ?? '')
    if (!texts.some(text => text.includes('"role": "user-instruction"'))) {
      throw new Error('headless task has no user authority')
    }
    const pending = texts.at(-1) ?? ''
    const mode = config.mode ?? (pending.includes('denied.txt') ? 'deny'
      : pending.includes('malformed.txt') ? 'malformed'
        : pending.includes('failed.txt') ? 'failed' : 'allow')
    if (mode === 'failed') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'review provider unavailable' } } }
      return
    }
    const response = mode === 'malformed' ? '{"risk":"low","decision":"deny"}'
      : mode === 'deny' ? '{"risk":"medium","decision":"deny","reason":"The caller did not authorize this target."}'
        : '{"risk":"medium","decision":"allow"}'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }, { prepend: true })
}
