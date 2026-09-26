/** Protocol invariants at JSON/SSE boundaries, including partial and failed responses. */
import { describe, expect, it } from 'vitest'
import { translate } from '../src/translate.ts'
import { parseSse } from '../src/sse.ts'
import { providerError } from '../src/transport.ts'
import { assemble, chunks, end, events, MODEL, sse, start, textEvents } from './helpers.ts'

describe('Messages stream', () => {
  it('streams text already present in the starting block', async () => {
    const result = await chunks(translate(events([start, { ...textEvents[1], content_block: { type: 'text', text: 'initial' } }, textEvents[3]!, ...end()]), MODEL))
    expect(result).toContainEqual({ type: 'text-delta', index: 0, text: 'initial' })
    expect(providerError({ error: { code: 'insufficient_balance' } }, 400)).toMatchObject({ code: 'QUOTA' })
  })

  it('emits first-seen blocks, raw tool JSON and cumulative disjoint usage before finish', async () => {
    const values = [
      { ...start, message: { usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 7 } } },
      { type: 'content_block_start', index: 4, content_block: { type: 'thinking', thinking: 'first', signature: '' } },
      { type: 'content_block_delta', index: 4, delta: { type: 'thinking_delta', thinking: ' thought' } },
      { type: 'content_block_delta', index: 4, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_delta', index: 4, delta: { type: 'signature_delta', signature: 'nature' } },
      { type: 'content_block_stop', index: 4 },
      { type: 'content_block_start', index: 9, content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: ' "a"}' } },
      { type: 'content_block_stop', index: 9 },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 3 } },
      ...end('tool_use'),
    ]
    const result = await assemble(translate(events(values), MODEL))
    expect(result.message.content).toEqual([{ type: 'reasoning', text: 'first thought' }, { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path": "a"}' }])
    expect(result.output.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 7, totalTokens: 54 } })
    expect(result.output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' }, replayState: { blocks: [{ type: 'reasoning', signature: 'signature' }, { type: 'tool-call' }] } })
    expect(result.output.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.index)).toEqual([0, 1])
  })

  it.each(['end_turn', 'stop_sequence'])('maps %s and ignores forward-compatible envelope events', async (reason) => {
    const result = await chunks(translate(events([start, { type: 'future_event' }, ...textEvents.slice(1, 4), ...end(reason)]), MODEL))
    expect(result.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })

  it.each([{}, { key: 'initial' }])('preserves initial tool input %j without JSON deltas', async (input) => {
    const result = await assemble(translate(events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read', input } },
      { type: 'content_block_stop', index: 0 }, ...end('tool_use')]), MODEL))
    expect(result.message.content[0]).toMatchObject({ arguments: JSON.stringify(input) })
  })

  it('preserves signature-only thinking and prunes truncated tools with their replay entries', async () => {
    const result = await assemble(translate(events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{' } },
      { type: 'content_block_stop', index: 1 }, ...end('max_tokens')]), MODEL))
    expect(result.message.content).toEqual([{ type: 'reasoning', text: '' }])
    expect(result.message.source.replayState).toMatchObject({ blocks: [{ type: 'reasoning', signature: 'opaque' }] })
  })

  it.each([
    [start, start],
    [textEvents[1]],
    [start, { ...textEvents[1], index: -1 }],
    [start, textEvents[1], textEvents[1]],
    [start, { type: 'content_block_stop', index: 0 }],
    [start, textEvents[1], textEvents[3], textEvents[3]],
    [start, { ...textEvents[1], content_block: { type: 'text', text: 2 } }],
    [start, textEvents[1], { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'bad' } }],
    [start, { type: 'message_delta', delta: { stop_reason: 'mystery' } }],
    [start, { type: 'message_stop' }],
    [start, textEvents[1], ...end()],
    [start, { type: 'message_delta', delta: {}, usage: { input_tokens: -1 } }],
    [start, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, textEvents[1]],
    [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: '', name: 'read', input: {} } }],
    [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'read', input: [] } }],
  ])('rejects malformed event ordering or fields %#', async (...values) => {
    await expect(chunks(translate(events(values as Record<string, unknown>[]), MODEL))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it.each(['{', '[]'])('refuses completed non-object tool JSON %s without repairing it', async (partial_json) => {
    await expect(chunks(translate(events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } },
      { type: 'content_block_stop', index: 0 }, ...end('tool_use')]), MODEL))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('refuses unsupported response content, empty responses and premature EOF', async () => {
    await expect(chunks(translate(events([start, { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'x' } }]), MODEL))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(chunks(translate(events([start, ...end()]), MODEL))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    await expect(chunks(translate(events(textEvents.slice(0, -1)), MODEL))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})

describe('SSE framing and provider failures', () => {
  async function read(text: string, bytewise = false) {
    const bytes = new TextEncoder().encode(text)
    let offset = 0
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return }
      const end = bytewise ? offset + 1 : bytes.length
      controller.enqueue(bytes.slice(offset, end)); offset = end
    } })
    let activity = 0
    const result = await chunks(translate(parseSse(body, () => { activity++ }), MODEL))
    return { result, activity }
  }
  it('frames UTF-8 split at every byte and counts comments and ping as transport activity', async () => {
    const result = await read(`\uFEFF: heartbeat\r\n\r\n${sse([{ type: 'ping' }, ...textEvents]).replaceAll('\n', '\r\n')}`, true)
    expect(result.result).toContainEqual({ type: 'text-delta', index: 0, text: 'Hello 世界' })
    expect(result.activity).toBe(textEvents.length + 2)
  })
  it.each(['data: not-json\n\n', 'data: []\n\n', 'event: ping\ndata: {"type":"other"}\n\n', 'data: {}\n\n'])('rejects malformed SSE %#', async (text) => {
    await expect(read(text)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('does not flush an unterminated terminal event', async () => {
    await expect(read(sse(textEvents).trimEnd())).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
  it('normalizes in-band overloads', async () => {
    await expect(read(sse([{ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]))).rejects.toMatchObject({ code: 'SERVER' })
  })
  it.each([
    [401, {}, 'AUTH'], [403, {}, 'AUTH'], [402, {}, 'QUOTA'], [429, {}, 'RATE_LIMIT'],
    [400, {}, 'INVALID_REQUEST'], [413, {}, 'INVALID_REQUEST'], [503, {}, 'SERVER'], [404, {}, 'HTTP_404'],
    [undefined, { type: 'authentication_error' }, 'AUTH'], [undefined, { type: 'rate_limit_error' }, 'RATE_LIMIT'],
    [undefined, { type: 'invalid_request_error' }, 'INVALID_REQUEST'], [undefined, {}, 'SERVER'],
    [400, { message: 'maximum context length exceeded' }, 'CONTEXT_WINDOW_EXCEEDED'],
    [400, { message: 'insufficient balance' }, 'QUOTA'],
  ])('classifies status %s and error %j', (status, error, code) => {
    expect(providerError({ error }, status)).toMatchObject({ code })
  })
  it('retains request identity and valid Retry-After without inventing missing counters', () => {
    expect(providerError(null, 429, new Headers({ 'retry-after': '2', 'request-id': 'r1' })).failure).toMatchObject({ requestId: 'r1', providerRetryAfterMs: 2000 })
    expect(providerError({}, 503, new Headers({ 'retry-after': new Date(Date.now() + 60_000).toUTCString(), 'x-request-id': 'r2' })).failure.providerRetryAfterMs).toBeGreaterThan(0)
    expect(providerError({}, 500, new Headers({ 'retry-after': 'invalid', 'x-deepseek-request-id': 'r3' })).failure).toMatchObject({ requestId: 'r3' })
  })
})
