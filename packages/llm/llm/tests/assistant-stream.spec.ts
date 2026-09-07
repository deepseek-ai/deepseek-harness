import { describe, expect, it } from 'vitest'
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  ToolCallId,
  assembleAssistantStream,
  assistantStreamChunks,
  assistantStreamFirstTokenTime,
  assistantStreamHasVisibleContent,
  assistantStreamHasVisibleText,
  chunkHasVisibleText,
  expandAssistantStream,
  isTokenDelta,
  isVisibleChunk,
  joinAssistantStreamText,
  lastAssistantStreamChunk,
  runFirstTokenTime,
  runFirstVisibleTime,
} from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, AssistantStreamRun, StreamChunk, TimedStreamChunk } from '@deepseek-ai/dsh-llm'

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

/** Fragment array that counts index reads, so a scan's early exit is observable. */
function countedFragments(values: readonly string[]): { readonly fragments: readonly string[]; reads(): number } {
  let reads = 0
  const fragments = new Proxy([...values], {
    get(target, property, receiver): unknown {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1
      return Reflect.get(target, property, receiver)
    },
  })
  return { fragments, reads: () => reads }
}

/** Record whose every property read throws, proving a stream scan never reached it. */
const unreachableRecord = new Proxy({}, {
  get() {
    throw new Error('scan continued past the first qualifying record')
  },
}) as AssistantStreamRecord

type RunOf<Type extends AssistantStreamRun['type']> = Extract<AssistantStreamRun, { type: Type }>

function textRun(time0: number, dt: readonly number[], texts: readonly string[], index = 0): RunOf<'text-chunks'> {
  return { type: 'text-chunks', time0, index, dt, texts }
}

function reasoningRun(
  time0: number,
  dt: readonly number[],
  texts: readonly string[],
  index = 0,
): RunOf<'reasoning-chunks'> {
  return { type: 'reasoning-chunks', time0, index, dt, texts }
}

function toolRun(
  time0: number,
  dt: readonly number[],
  args: readonly string[],
  name?: string,
): RunOf<'tool-call-chunks'> {
  return {
    type: 'tool-call-chunks', time0, index: 0, dt, id: ToolCallId('call'),
    ...name === undefined ? {} : { name },
    args,
  }
}

function raw(time: number, chunk: StreamChunk): AssistantStreamRecord {
  return { type: 'chunk', time, chunk }
}

describe('stream chunk classification', () => {
  it('recognizes the first token as a non-empty fragment or a name-bearing Tool-call delta', () => {
    expect(isTokenDelta({ type: 'text-delta', index: 0, text: ' ' })).toBe(true)
    expect(isTokenDelta({ type: 'text-delta', index: 0, text: '' })).toBe(false)
    expect(isTokenDelta({ type: 'reasoning-delta', index: 0, text: 'r' })).toBe(true)
    expect(isTokenDelta({ type: 'reasoning-delta', index: 0, text: '' })).toBe(false)
    expect(isTokenDelta({ type: 'tool-call-delta', index: 0, id: ToolCallId('c'), argumentsDelta: '{' })).toBe(true)
    expect(isTokenDelta({ type: 'tool-call-delta', index: 0, id: ToolCallId('c'), argumentsDelta: '' })).toBe(false)
    expect(isTokenDelta({ type: 'tool-call-delta', index: 0, id: ToolCallId('c'), name: 'read', argumentsDelta: '' })).toBe(true)
    expect(isTokenDelta({ type: 'tool-call-delta', index: 0, id: ToolCallId('c'), name: '', argumentsDelta: '' })).toBe(true)
    expect(isTokenDelta({ type: 'block-start', index: 0, blockType: 'text' })).toBe(false)
    expect(isTokenDelta({ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } })).toBe(false)
    expect(isTokenDelta({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })).toBe(false)
    expect(isTokenDelta({ type: 'finish', reason: { kind: 'stop' } })).toBe(false)
  })

  it('classifies reader-visible chunks by non-whitespace text and non-Tool-call block kinds', () => {
    expect(isVisibleChunk({ type: 'text-delta', index: 0, text: ' \t\n' })).toBe(false)
    expect(isVisibleChunk({ type: 'text-delta', index: 0, text: ' x' })).toBe(true)
    expect(isVisibleChunk({ type: 'reasoning-delta', index: 0, text: '\u00a0' })).toBe(false)
    expect(isVisibleChunk({ type: 'reasoning-delta', index: 0, text: 'r' })).toBe(true)
    expect(isVisibleChunk({ type: 'block-start', index: 0, blockType: 'text' })).toBe(false)
    expect(isVisibleChunk({ type: 'block-start', index: 0, blockType: 'reasoning' })).toBe(false)
    expect(isVisibleChunk({ type: 'block-start', index: 0, blockType: 'tool-call' })).toBe(false)
    expect(isVisibleChunk({ type: 'block-start', index: 0, blockType: 'image' })).toBe(true)
    expect(isVisibleChunk({ type: 'block-end', index: 0, block: { type: 'text', text: '  ' } })).toBe(false)
    expect(isVisibleChunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } })).toBe(true)
    expect(isVisibleChunk({
      type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c'), name: 'read', arguments: '{}' },
    })).toBe(false)
    expect(isVisibleChunk({ type: 'block-end', index: 0, block: { type: 'image', attachment: {} as never } })).toBe(true)
    expect(isVisibleChunk({ type: 'tool-call-delta', index: 0, id: ToolCallId('c'), name: 'read', argumentsDelta: '{}' })).toBe(false)
    expect(isVisibleChunk({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })).toBe(false)
    expect(isVisibleChunk({ type: 'finish', reason: { kind: 'stop' } })).toBe(false)
  })

  it('counts visible text only from text deltas and completed text blocks', () => {
    expect(chunkHasVisibleText({ type: 'text-delta', index: 0, text: 'a' })).toBe(true)
    expect(chunkHasVisibleText({ type: 'text-delta', index: 0, text: '\r\n' })).toBe(false)
    expect(chunkHasVisibleText({ type: 'reasoning-delta', index: 0, text: 'a' })).toBe(false)
    expect(chunkHasVisibleText({ type: 'block-end', index: 0, block: { type: 'text', text: ' a ' } })).toBe(true)
    expect(chunkHasVisibleText({ type: 'block-end', index: 0, block: { type: 'text', text: ' ' } })).toBe(false)
    expect(chunkHasVisibleText({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'a' } })).toBe(false)
    expect(chunkHasVisibleText({ type: 'block-start', index: 0, blockType: 'text' })).toBe(false)
    expect(chunkHasVisibleText({ type: 'finish', reason: { kind: 'stop' } })).toBe(false)
  })
})

describe('packed run boundaries', () => {
  it('reconstructs the first token member time from time0 and the preceding gaps', () => {
    expect(runFirstTokenTime(textRun(1_000, [5, -3, 10], ['', '', 'x', 'y']))).toBe(1_002)
    expect(runFirstTokenTime(textRun(1_000, [5], ['a', 'b']))).toBe(1_000)
    expect(runFirstTokenTime(reasoningRun(7, [1, 1], ['', '', '']))).toBeUndefined()
    expect(runFirstTokenTime(toolRun(50, [2, 2], ['', '', '{']))).toBe(54)
    expect(runFirstTokenTime(toolRun(50, [2], ['', '']))).toBeUndefined()
    expect(runFirstTokenTime(toolRun(50, [2], ['', ''], 'read'))).toBe(50)
  })

  it('reconstructs the first visible member time from non-whitespace fragments only', () => {
    expect(runFirstVisibleTime(textRun(1_000, [5, 1, 1], ['', '   ', '\t', 'answer']))).toBe(1_007)
    expect(runFirstVisibleTime(reasoningRun(20, [3], [' ', 'think']))).toBe(23)
    expect(runFirstVisibleTime(textRun(20, [3], [' ', '\n']))).toBeUndefined()
    expect(runFirstVisibleTime(toolRun(20, [3], ['{"x":', '1}'], 'read'))).toBeUndefined()
  })

  it('stops reading fragments at the first qualifying member', () => {
    const token = countedFragments(['', 'x', 'unread', 'unread'])
    expect(runFirstTokenTime({ ...textRun(0, [1, 1, 1], []), texts: token.fragments })).toBe(1)
    expect(token.reads()).toBe(2)

    const visible = countedFragments([' ', ' ', 'v', 'unread'])
    expect(runFirstVisibleTime({ ...reasoningRun(0, [1, 1, 1], []), texts: visible.fragments })).toBe(2)
    expect(visible.reads()).toBe(3)

    const named = countedFragments(['unread'])
    expect(runFirstTokenTime({ ...toolRun(9, [], [], 'read'), args: named.fragments })).toBe(9)
    expect(named.reads()).toBe(0)
  })
})

describe('compact stream readers', () => {
  const usage = { inputTokens: 10, outputTokens: 4 }
  const laterUsage = { inputTokens: 10, outputTokens: 9 }
  const stream: readonly AssistantStreamRecord[] = [
    raw(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
    reasoningRun(101, [2, 2], ['', ' ', 'think']),
    raw(106, { type: 'block-end', index: 0, block: { type: 'reasoning', text: ' think' } }),
    raw(107, { type: 'block-start', index: 1, blockType: 'text' }),
    textRun(108, [1, 1], ['\n', 'ans', 'wer'], 1),
    raw(111, { type: 'block-end', index: 1, block: { type: 'text', text: '\nanswer' } }),
    raw(112, { type: 'usage', usage }),
    raw(113, { type: 'usage', usage: laterUsage }),
    raw(114, { type: 'finish', reason: { kind: 'stop' } }),
  ]

  it('answers first token, visibility, text, and usage questions from records', () => {
    expect(assistantStreamFirstTokenTime(stream)).toBe(103)
    expect(assistantStreamHasVisibleContent(stream)).toBe(true)
    expect(assistantStreamHasVisibleText(stream)).toBe(true)
    expect(lastAssistantStreamChunk(stream, 'usage')?.usage).toBe(laterUsage)
    expect(lastAssistantStreamChunk(stream, 'finish')).toStrictEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(lastAssistantStreamChunk(stream, 'block-start')).toStrictEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(assistantStreamChunks(stream, 'block-end').map(chunk => chunk.index)).toStrictEqual([0, 1])
    expect(assistantStreamChunks(stream, 'usage').map(chunk => chunk.usage)).toStrictEqual([usage, laterUsage])
    expect(joinAssistantStreamText(stream)).toBe('\nanswer')
  })

  it('reports absence on empty, whitespace-only, and Tool-call-only streams', () => {
    const silent: readonly AssistantStreamRecord[] = [
      raw(1, { type: 'block-start', index: 0, blockType: 'tool-call' }),
      toolRun(2, [1], ['', ''], 'read'),
      raw(4, { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call'), name: 'read', arguments: '' } }),
      textRun(5, [1], [' ', '\t'], 1),
      reasoningRun(7, [], ['  '], 2),
      raw(8, { type: 'block-end', index: 1, block: { type: 'text', text: ' \t' } }),
    ]
    expect(assistantStreamFirstTokenTime([])).toBeUndefined()
    expect(assistantStreamFirstTokenTime(silent)).toBe(2)
    expect(assistantStreamHasVisibleContent([])).toBe(false)
    expect(assistantStreamHasVisibleContent(silent)).toBe(false)
    expect(assistantStreamHasVisibleText([])).toBe(false)
    expect(assistantStreamHasVisibleText(silent)).toBe(false)
    expect(lastAssistantStreamChunk(silent, 'usage')).toBeUndefined()
    expect(lastAssistantStreamChunk([], 'finish')).toBeUndefined()
    expect(assistantStreamChunks(silent, 'usage')).toStrictEqual([])
    expect(joinAssistantStreamText(silent)).toBe(' \t')
    expect(joinAssistantStreamText([])).toBe('')
  })

  it('reads raw text deltas and empty-argument Tool-call deltas the accumulator kept as chunks', () => {
    const degenerate: readonly AssistantStreamRecord[] = [
      raw(1, { type: 'tool-call-delta', index: 0, id: ToolCallId(''), argumentsDelta: '' }),
      raw(2, { type: 'tool-call-delta', index: 0, id: ToolCallId('call'), name: '', argumentsDelta: '' }),
      raw(3, { type: 'text-delta', index: 1, text: ' ' }),
      raw(4, { type: 'text-delta', index: 1, text: 'raw' }),
    ]
    expect(assistantStreamFirstTokenTime(degenerate)).toBe(2)
    expect(assistantStreamHasVisibleContent(degenerate)).toBe(true)
    expect(assistantStreamHasVisibleContent(degenerate.slice(0, 3))).toBe(false)
    expect(assistantStreamHasVisibleText(degenerate)).toBe(true)
    expect(assistantStreamHasVisibleText(degenerate.slice(0, 3))).toBe(false)
    expect(joinAssistantStreamText(degenerate)).toBe(' raw')
  })

  it('stops at the first qualifying record', () => {
    expect(assistantStreamFirstTokenTime([textRun(5, [], ['x']), unreachableRecord])).toBe(5)
    expect(assistantStreamFirstTokenTime([
      raw(6, { type: 'tool-call-delta', index: 0, id: ToolCallId('call'), name: '', argumentsDelta: '' }),
      unreachableRecord,
    ])).toBe(6)
    expect(assistantStreamHasVisibleContent([raw(1, { type: 'block-start', index: 0, blockType: 'image' }), unreachableRecord])).toBe(true)
    expect(assistantStreamHasVisibleContent([reasoningRun(1, [], ['r']), unreachableRecord])).toBe(true)
    expect(assistantStreamHasVisibleText([textRun(1, [], ['t']), unreachableRecord])).toBe(true)
    expect(assistantStreamHasVisibleText([
      raw(1, { type: 'block-end', index: 0, block: { type: 'text', text: 't' } }),
      unreachableRecord,
    ])).toBe(true)
    expect(lastAssistantStreamChunk([unreachableRecord, raw(9, { type: 'finish', reason: { kind: 'stop' } })], 'finish')?.type)
      .toBe('finish')
  })

  it('assembles the same blocks, usage, finish, and replay state as the expanded members', () => {
    const accumulator = new AssistantStreamAccumulator()
    const chunks: readonly StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'th' },
      { type: 'reasoning-delta', index: 0, text: 'ink' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
      { type: 'text-delta', index: 1, text: 'an' },
      { type: 'text-delta', index: 1, text: 'swer' },
      { type: 'tool-call-delta', index: 2, id: ToolCallId('call-1'), name: 'read', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 2, id: ToolCallId('call-1'), argumentsDelta: '{"path":' },
      { type: 'tool-call-delta', index: 2, id: ToolCallId('call-1'), argumentsDelta: '"a"}' },
      { type: 'tool-call-delta', index: 3, id: ToolCallId(''), argumentsDelta: '{}' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { response: { id: 'r' } } },
    ]
    for (const [index, chunk] of chunks.entries()) accumulator.push({ time: 1_000 + index, chunk })
    const stream = accumulator.snapshot()
    expect(stream.filter(record => record.type !== 'chunk')).toHaveLength(4)

    const expanded = new BlockAssembler()
    for (const member of expandAssistantStream(stream)) expanded.push(member.chunk)
    const assembled = assembleAssistantStream(stream)

    expect(assembled.blocks()).toStrictEqual(expanded.blocks())
    expect(assembled.blocks().map(block => block.type)).toStrictEqual(['reasoning', 'text', 'tool-call', 'tool-call'])
    expect(assembled.usage).toStrictEqual({ inputTokens: 3, outputTokens: 2 })
    expect(assembled.finish).toStrictEqual({ kind: 'tool-calls' })
    expect(assembled.replayState).toStrictEqual(expanded.replayState)

    const reused = new BlockAssembler()
    expect(assembleAssistantStream([], reused)).toBe(reused)
    expect(reused.blocks()).toStrictEqual([])
    expect(() => assembleAssistantStream([{ type: 'future' }] as never)).toThrow(/unreachable variant in assembleAssistantStream/)
  })
})
