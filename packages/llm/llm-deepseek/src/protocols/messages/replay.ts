/** Minimal native thinking metadata; durable Harness blocks own all response text. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Message, ReplayEnvelope } from '@deepseek-ai/dsh-llm'

/** Index-aligned metadata retained alongside each emitted Harness block. */
export interface ReplayBlock {
  type: 'text' | 'reasoning' | 'tool-call'
  signature?: string
}

/** Reject malformed JSON objects at provider and durable-data reads.
 * @param value - untrusted decoded JSON.
 * @param code - owning failure category.
 * @returns the validated object.
 */
export function object(value: unknown, code = 'MALFORMED_RESPONSE'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LlmError('DeepSeek Messages expected a JSON object', code)
  }
  return value as Record<string, unknown>
}

/** Construct response metadata without duplicating the assistant text.
 * @param model - requested model identity.
 * @param blocks - metadata in emitted block order.
 * @returns the versioned envelope persisted by the existing assembler.
 */
export function replayState(model: string, blocks: ReplayBlock[]): ReplayEnvelope {
  return { response: { kind: 'deepseek-messages', version: 1, model }, blocks }
}

/** Validate native replay, discarding unusable metadata before serializing durable content.
 * @param message - durable assistant content and source metadata.
 * @param model - target model; cross-model signatures are not portable.
 * @param onDegrade - diagnostic for unusable metadata; receives no message content or signatures.
 * @returns index-aligned metadata, absent for foreign, cross-model or degraded history.
 */
export function readReplay(message: Message, model: string, onDegrade?: (reason: string) => void): ReplayBlock[] | undefined {
  try { return validateReplay(message, model) } catch (error) {
    /* v8 ignore next -- the validator only throws INVALID_REPLAY_STATE; preserve future non-replay failures. */
    if (!(error instanceof LlmError) || error.code !== 'INVALID_REPLAY_STATE') throw error
    onDegrade?.(error.message)
    return undefined
  }
}

function validateReplay(message: Message, model: string): ReplayBlock[] | undefined {
  if (message.source.kind !== 'model' || message.source.replayState === undefined) return undefined
  const fail = (detail: string): never => { throw new LlmError(`DeepSeek Messages replay: ${detail}`, 'INVALID_REPLAY_STATE') }
  const envelope = object(message.source.replayState, 'INVALID_REPLAY_STATE')
  const response = object(envelope.response, 'INVALID_REPLAY_STATE')
  if (response.kind !== 'deepseek-messages' || response.version !== 1) return fail('unsupported kind or version')
  if (response.model !== message.source.model) return fail('model does not match assistant source model')
  if (!Array.isArray(envelope.blocks) || envelope.blocks.length !== message.content.length) return fail('block count mismatch')
  const blocks = envelope.blocks.map((value, index): ReplayBlock => {
    const block = object(value, 'INVALID_REPLAY_STATE')
    if (block.type !== message.content[index]?.type
      || !['text', 'reasoning', 'tool-call'].includes(String(block.type))) return fail('block type mismatch')
    if (block.signature !== undefined && (block.type !== 'reasoning' || typeof block.signature !== 'string')) return fail('invalid signature')
    return block as unknown as ReplayBlock
  })
  return response.model === model ? blocks : undefined
}
