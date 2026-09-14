import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { DONE, parseSse } from '../src/protocols/chat-completions/sse.ts'

/**
 * DeepSeek protocol contract only: the [DONE] sentinel and STREAM_CLOSED on
 * EOF without it. SSE framing (chunk splits, CRLF, multi-data joins, comments)
 * is eventsource-parser's contract, not re-proven here.
 */

/** Build an SSE byte stream from string fragments (fragments = network reads). */
function bytes(...fragments: string[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const fragment of fragments) controller.enqueue(encoder.encode(fragment))
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const item of stream) out.push(item)
  return out
}

describe('parseSse', () => {
  it('yields event payloads and the DONE sentinel', async () => {
    const events = await collect(parseSse(bytes('data: {"a":1}\n\ndata: [DONE]\n\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('reports comments out of band without yielding them', async () => {
    const comments: string[] = []
    const events = await collect(parseSse(
      bytes(': keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\n'),
      (comment) => { comments.push(comment) },
    ))
    expect(comments).toEqual(['keep-alive'])
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('stops yielding after DONE even when more data follows', async () => {
    const events = await collect(parseSse(bytes('data: [DONE]\n\ndata: {"late":1}\n\n')))
    expect(events).toEqual([DONE])
  })

  it('throws STREAM_CLOSED when the stream ends without DONE', async () => {
    await expect(collect(parseSse(bytes('data: {"a":1}\n\n')))).rejects.toThrow(LlmError)
    await expect(collect(parseSse(bytes('data: {"a":1}\n\n')))).rejects.toThrow(/without \[DONE\]/)
  })

  it('throws STREAM_CLOSED for an empty stream', async () => {
    await expect(collect(parseSse(bytes()))).rejects.toThrow(/without \[DONE\]/)
  })

  it('throws STREAM_CLOSED for a mid-event close', async () => {
    await expect(collect(parseSse(bytes('data: {"a"')))).rejects.toThrow(/without \[DONE\]/)
  })

  it('treats a final DONE missing its blank-line terminator as truncation', async () => {
    // Spec-strict framing: an event dispatches only on its blank-line
    // terminator, so an unterminated tail at EOF is STREAM_CLOSED — real
    // providers always terminate events, so a missing terminator is truncation.
    await expect(collect(parseSse(bytes('data: {"a":1}\n\ndata: [DONE]')))).rejects.toThrow(/without \[DONE\]/)
  })
})
