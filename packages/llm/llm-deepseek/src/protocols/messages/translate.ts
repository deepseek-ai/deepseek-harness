/** Translate Messages events while preserving block order and cumulative usage. */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { object, replayState } from './replay.ts'
import type { ReplayBlock } from './replay.ts'

interface Block {
  index: number
  content: Extract<ContentBlock, { type: ReplayBlock['type'] }>
  replay: ReplayBlock
  closed: boolean
  json: string
}

/** Decode a required string from provider JSON.
 * @param value - provider field.
 * @returns the validated string.
 */
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new LlmError('DeepSeek Messages expected a string field', 'MALFORMED_RESPONSE')
  return value
}

function malformed(detail: string): never {
  throw new LlmError(`DeepSeek Messages stream: ${detail}`, 'MALFORMED_RESPONSE')
}

function indexOf(event: Record<string, unknown>): number {
  if (!Number.isSafeInteger(event.index) || (event.index as number) < 0) return malformed('invalid block index')
  return event.index as number
}

function updateUsage(usage: TokenUsage, raw: unknown): void {
  const fields = object(raw)
  const keys = { input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_input_tokens: 'cacheReadTokens', cache_creation_input_tokens: 'cacheWriteTokens' } as const
  for (const [wire, local] of Object.entries(keys)) {
    const value = fields[wire]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || (value as number) < 0) return malformed(`invalid ${wire}`)
    usage[local] = value as number
  }
}

function startBlock(event: Record<string, unknown>, index: number): Block {
  const native = object(event.content_block)
  let content: Block['content']
  let replay: ReplayBlock
  switch (native.type) {
    case 'text': content = { type: 'text', text: string(native.text) }; replay = { type: 'text' }; break
    case 'thinking':
      content = { type: 'reasoning', text: string(native.thinking) }
      replay = { type: 'reasoning', ...native.signature === undefined ? {} : { signature: string(native.signature) } }
      break
    case 'tool_use':
      content = { type: 'tool-call', id: ToolCallId(string(native.id)), name: string(native.name), arguments: JSON.stringify(object(native.input)) }
      if (!content.id || !content.name) return malformed('empty tool identity')
      replay = { type: 'tool-call' }
      break
    default: throw new LlmError(`DeepSeek Messages does not support response block ${String(native.type)}`, 'UNSUPPORTED_CONTENT')
  }
  return { index, content, replay, closed: false, json: '' }
}

function deltaChunk(block: Block, raw: unknown): StreamChunk | undefined {
  const delta = object(raw)
  const content = block.content
  if (delta.type === 'text_delta' && content.type === 'text') {
    const text = string(delta.text)
    content.text += text
    return { type: 'text-delta', index: block.index, text }
  }
  if (delta.type === 'thinking_delta' && content.type === 'reasoning') {
    const text = string(delta.thinking)
    content.text += text
    return { type: 'reasoning-delta', index: block.index, text }
  }
  if (delta.type === 'signature_delta' && content.type === 'reasoning') {
    block.replay.signature = (block.replay.signature ?? '') + string(delta.signature)
    return undefined
  }
  if (delta.type === 'input_json_delta' && content.type === 'tool-call') {
    const argumentsDelta = string(delta.partial_json)
    block.json += argumentsDelta
    return { type: 'tool-call-delta', index: block.index, id: content.id, argumentsDelta }
  }
  return malformed(`unsupported delta ${String(delta.type)} for ${content.type}`)
}

function stopReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'end_turn': case 'stop_sequence': return { kind: 'stop' }
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    default: return malformed(`unsupported stop reason ${String(raw)}`)
  }
}

/** Translate decoded SSE data into the Harness stream protocol.
 * @param events - framed, decoded provider events in arrival order.
 * @param model - requested model id stored in durable replay state.
 * @returns blocks, one final usage value, and exactly one terminal finish.
 */
export async function* translate(events: AsyncIterable<Record<string, unknown>>, model: string): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, Block>()
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let started = false
  let reason: FinishReason | undefined
  for await (const event of events) {
    if (event.type === 'message_start') {
      if (started) return malformed('duplicate message_start')
      updateUsage(usage, object(event.message).usage)
      started = true
      continue
    }
    if (!['content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(String(event.type))) {
      // Anthropic permits additional event types; content-bearing events remain validated below.
      continue
    }
    if (!started) return malformed('event precedes message_start')
    if (event.type === 'content_block_start') {
      const wireIndex = indexOf(event)
      if (blocks.has(wireIndex) || reason !== undefined) return malformed('block starts after settlement or repeats an index')
      const block = startBlock(event, blocks.size)
      blocks.set(wireIndex, block)
      yield { type: 'block-start', index: block.index, blockType: block.content.type }
      if (block.content.type === 'text' || block.content.type === 'reasoning') {
        if (block.content.text) yield { type: block.content.type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: block.content.text }
      } else {
        yield { type: 'tool-call-delta', index: block.index, id: block.content.id, name: block.content.name, argumentsDelta: '' }
      }
    } else if (event.type === 'content_block_delta' || event.type === 'content_block_stop') {
      const block = blocks.get(indexOf(event))
      if (block === undefined || block.closed) return malformed('delta/stop without an open block')
      if (event.type === 'content_block_delta') {
        const chunk = deltaChunk(block, event.delta)
        if (chunk !== undefined) yield chunk
      } else {
        block.closed = true
        if (block.content.type === 'tool-call' && block.json.length > 0) block.content.arguments = block.json
        yield { type: 'block-end', index: block.index, block: { ...block.content } }
      }
    } else if (event.type === 'message_delta') {
      const delta = object(event.delta)
      if (delta.stop_reason != null) reason = stopReason(delta.stop_reason)
      if (event.usage !== undefined) updateUsage(usage, event.usage)
    } else {
      if (reason === undefined || [...blocks.values()].some(block => !block.closed)) return malformed('message_stop without settled blocks and stop reason')
      if (blocks.size === 0 && reason.kind === 'stop') throw new LlmError('DeepSeek Messages returned no content', 'EMPTY_RESPONSE')
      // Truncated tool JSON is retained in the stream, then pruned by the shared assembler.
      if (reason.kind !== 'max-tokens') {
        for (const { content } of blocks.values()) {
          if (content.type !== 'tool-call') continue
          let parsed: unknown
          try { parsed = JSON.parse(content.arguments) } catch (_invalidProviderToolJson) { return malformed('tool input is invalid JSON') }
          object(parsed)
        }
      }
      usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      yield { type: 'usage', usage }
      yield { type: 'finish', reason, replayState: replayState(model, [...blocks.values()].map(block => block.replay)) }
      return
    }
  }
  throw new LlmError('DeepSeek Messages stream ended before message_stop', 'STREAM_CLOSED')
}
