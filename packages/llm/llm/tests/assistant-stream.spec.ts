import { describe, expect, it } from 'vitest'
import {
  AssistantStreamAccumulator,
  ToolCallId,
  expandAssistantStream,
} from '@deepseek-ai/dsh-llm'
import type { TimedStreamChunk } from '@deepseek-ai/dsh-llm'

describe('AssistantStreamAccumulator', () => {
  it('keeps delta boundaries and timestamps while compacting one attempt', () => {
    const chunks: readonly TimedStreamChunk[] = [
      { time: 1_000, chunk: { type: 'text-delta', index: 0, text: 'hel' } },
      { time: 1_006, chunk: { type: 'text-delta', index: 0, text: 'lo' } },
      {
        time: 1_008,
        chunk: {
          type: 'tool-call-delta',
          index: 1,
          id: ToolCallId('call-1'),
          name: 'run_code',
          argumentsDelta: '{',
        },
      },
      {
        time: 1_011,
        chunk: {
          type: 'tool-call-delta',
          index: 1,
          id: ToolCallId('call-1'),
          name: 'run_code',
          argumentsDelta: '}',
        },
      },
      { time: 1_020, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ]
    const accumulator = new AssistantStreamAccumulator()
    for (const timed of chunks) accumulator.push(timed)

    expect(accumulator.snapshot()).toStrictEqual([
      { type: 'text-chunks', time0: 1_000, index: 0, dt: [6], texts: ['hel', 'lo'] },
      {
        type: 'tool-call-chunks',
        time0: 1_008,
        index: 1,
        id: 'call-1',
        name: 'run_code',
        dt: [3],
        args: ['{', '}'],
      },
      { type: 'chunk', time: 1_020, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ])
    expect(expandAssistantStream(accumulator.snapshot())).toStrictEqual(chunks)
  })

  it('snapshots each admitted chunk once and detaches earlier compact views', () => {
    const usage = { inputTokens: 3, outputTokens: 2 }
    const accumulator = new AssistantStreamAccumulator()
    accumulator.push({ time: 10, chunk: { type: 'text-delta', index: 0, text: 'a' } })
    accumulator.push({ time: 11, chunk: { type: 'usage', usage } })
    usage.inputTokens = 99

    const first = accumulator.snapshot()
    accumulator.push({ time: 12, chunk: { type: 'text-delta', index: 0, text: 'b' } })
    const second = accumulator.snapshot()

    expect(expandAssistantStream(first)).toStrictEqual([
      { time: 10, chunk: { type: 'text-delta', index: 0, text: 'a' } },
      { time: 11, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } } },
    ])
    expect(expandAssistantStream(second)).toHaveLength(3)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen((first[0] as { texts: readonly string[] }).texts)).toBe(true)
  })

  it('detaches raw records while expanding durable input', () => {
    const chunk = { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
    const expanded = expandAssistantStream([{
      type: 'chunk', time: 10, chunk,
    }] as never)

    chunk.usage.inputTokens = 99

    expect(expanded).toStrictEqual([{
      time: 10,
      chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    }])
  })

  it('keeps incompatible delta runs separate and expands reasoning and nameless tool calls', () => {
    const accumulator = new AssistantStreamAccumulator()
    const chunks: readonly TimedStreamChunk[] = [
      { time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'r1' } },
      { time: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'r2' } },
      { time: 3, chunk: { type: 'text-delta', index: 0, text: 'a' } },
      { time: 4, chunk: { type: 'text-delta', index: 1, text: 'b' } },
      {
        time: 5,
        chunk: { type: 'tool-call-delta', index: 0, id: ToolCallId('one'), argumentsDelta: '{' },
      },
      {
        time: 6,
        chunk: { type: 'tool-call-delta', index: 0, id: ToolCallId('one'), argumentsDelta: '}' },
      },
      {
        time: 7,
        chunk: {
          type: 'tool-call-delta', index: 0, id: ToolCallId('one'), name: 'read', argumentsDelta: '',
        },
      },
      {
        time: 8,
        chunk: {
          type: 'tool-call-delta', index: 1, id: ToolCallId('two'), name: 'read', argumentsDelta: 'x',
        },
      },
      { time: Number.MAX_SAFE_INTEGER, chunk: { type: 'text-delta', index: 1, text: 'far' } },
      { time: Number.MIN_SAFE_INTEGER, chunk: { type: 'text-delta', index: 1, text: 'apart' } },
    ]
    for (const chunk of chunks) accumulator.push(chunk)

    expect(expandAssistantStream(accumulator.snapshot())).toStrictEqual(chunks)
    expect(accumulator.snapshot().map(record => record.type)).toStrictEqual([
      'reasoning-chunks',
      'text-chunks',
      'text-chunks',
      'tool-call-chunks',
      'tool-call-chunks',
      'tool-call-chunks',
      'text-chunks',
      'text-chunks',
    ])
  })

  it('rejects unsafe values while preserving JSON-safe empty adapter identities', () => {
    const accumulator = new AssistantStreamAccumulator()
    expect(() => accumulator.push({
      time: 0.5,
      chunk: { type: 'finish', reason: { kind: 'stop' } },
    })).toThrow(/safe integer/)
    expect(() => accumulator.push({
      time: 1,
      chunk: { type: 'future', callback: () => undefined } as never,
    })).toThrow(/JSON-serializable/)
    expect(() => accumulator.push({
      time: 1,
      chunk: { type: 'text-delta', index: -1, text: 'bad' },
    })).toThrow(/index/)
    expect(() => accumulator.push({
      time: 1,
      chunk: { type: 'text-delta', index: 0, text: 1 } as never,
    })).toThrow(/text must be a string/)
    expect(accumulator.push({
      time: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: ToolCallId(''), argumentsDelta: '{}' },
    }).chunk).toMatchObject({ id: '' })
    expect(accumulator.push({
      time: 1,
      chunk: {
        type: 'tool-call-delta', index: 0, id: ToolCallId('call'), name: '', argumentsDelta: '{}',
      },
    }).chunk).toMatchObject({ name: '' })
    expect(() => accumulator.push({
      time: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: 1, argumentsDelta: '{}' } as never,
    })).toThrow(/id must be a string/)
    expect(() => accumulator.push({
      time: 1,
      chunk: {
        type: 'tool-call-delta', index: 0, id: ToolCallId('call'), name: 1, argumentsDelta: '{}',
      } as never,
    })).toThrow(/name must be a string/)
    expect(() => accumulator.push({
      time: 1,
      chunk: {
        type: 'tool-call-delta', index: 0, id: ToolCallId('call'), argumentsDelta: 1,
      } as never,
    })).toThrow(/argumentsDelta must be a string/)
    expect(() => accumulator.push({
      time: 1,
      chunk: { type: 'future' } as never,
    })).toThrow(/unreachable variant in AssistantStreamAccumulator\.push/)
    expect(accumulator.snapshot()).toStrictEqual([
      {
        type: 'chunk', time: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{}' },
      },
      {
        type: 'chunk', time: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call', name: '', argumentsDelta: '{}' },
      },
    ])
    expect(expandAssistantStream(accumulator.snapshot()).map(member => member.chunk)).toStrictEqual([
      { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{}' },
      { type: 'tool-call-delta', index: 0, id: 'call', name: '', argumentsDelta: '{}' },
    ])
  })

  it.each([
    [null, /must be an object/],
    [[], /must be an object/],
    [{ type: 'future' }, /Unsupported/],
    [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [] }, /non-empty/],
    [{ type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: [1] }, /string array/],
    [{ type: 'text-chunks', time0: 0.5, index: 0, dt: [], texts: ['a'] }, /safe integer/],
    [{ type: 'text-chunks', time0: 1, index: -0, dt: [], texts: ['a'] }, /index/],
    [{ type: 'text-chunks', time0: 1, index: -1, dt: [], texts: ['a'] }, /index/],
    [{ type: 'text-chunks', time0: 1, index: 0, dt: [0.5], texts: ['a', 'b'] }, /dt/],
    [{ type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['a'] }, /dt length/],
    [{
      type: 'text-chunks', time0: Number.MAX_SAFE_INTEGER, index: 0, dt: [1], texts: ['a', 'b'],
    }, /member times/],
    [{ type: 'tool-call-chunks', time0: 1, index: 0, id: '', dt: [], args: ['a'] }, /id/],
    [{ type: 'tool-call-chunks', time0: 1, index: 0, id: 'id', name: '', dt: [], args: ['a'] }, /name/],
    [{ type: 'tool-call-chunks', time0: 1, index: 0, id: 'id', dt: [], args: [] }, /non-empty/],
    [{ type: 'tool-call-chunks', time0: 1, index: 0, id: 'id', dt: [], args: [1] }, /string array/],
    [{ type: 'chunk', time: 0.5, chunk: { type: 'finish', reason: { kind: 'stop' } } }, /safe integer/],
    [{ type: 'chunk', time: 1, chunk: null }, /lossless JSON object/],
    [{ type: 'chunk', time: 1, chunk: [] }, /lossless JSON object/],
    [{ type: 'chunk', time: 1, chunk: { type: 'future', bad: undefined } }, /lossless JSON object/],
    [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'], extra: true }, /exactly/],
    [{ type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'stop' } }, extra: true }, /exactly/],
  ])('rejects malformed compact record %#', (record, message) => {
    expect(() => expandAssistantStream([record] as never)).toThrow(message)
  })
})
