import { describe, expect, it } from 'vitest'
import { BlockAssembler, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

describe('BlockAssembler', () => {
  it('assembles interleaved text, reasoning, and tool-call deltas', () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking…' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking…' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello' },
      { type: 'text-delta', index: 1, text: ' world' },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: ToolCallId('call-1'), name: 'echo', argumentsDelta: '{"text":' },
      { type: 'tool-call-delta', index: 2, id: ToolCallId('call-1'), argumentsDelta: '"hi"}' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'thinking…' },
      { type: 'text', text: 'Hello world' },
      { type: 'tool-call', id: ToolCallId('call-1'), name: 'echo', arguments: '{"text":"hi"}' },
    ])
    expect(assembler.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.message({ provider: 'mock', model: 'mock' }).role).toBe('assistant')
  })

  it('records the completed block from block-end', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, text: 'hi' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('tolerates deltas without explicit block-start/end', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'text-delta', index: 0, text: 'implicit' })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'implicit' }])
    expect(assembler.finish).toEqual({ kind: 'stop' })
  })

  it('returns undefined usage when no usage chunk was received', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'text-delta', index: 0, text: 'no usage' })
    expect(assembler.usage).toBeUndefined()
  })

  it('reuses an existing partial when ensure() is called with a tracked index', () => {
    const assembler = new BlockAssembler()
    // block-start creates the partial; block-end calls ensure() on the same index
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    // push a delta first to guarantee the partial exists
    assembler.push({ type: 'text-delta', index: 0, text: 'hi' })
    // block-end's ensure() must find the existing partial (the second branch path)
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('throws from assemble() when a partial has an unhandled blockType', () => {
    const assembler = new BlockAssembler()
    // Unknown declaration-merged block types cannot be assembled from partial deltas. Opening a
    // plugin-added `video` block without its required `block-end` exercises that failure.
    assembler.push({ type: 'block-start', index: 0, blockType: 'video' } as unknown as StreamChunk)
    expect(() => assembler.blocks()).toThrow('cannot assemble incomplete block of type "video"')
  })

  it('mustGet throws when an index is missing from the partials map (invariant violation)', () => {
    const assembler = new BlockAssembler()
    // Force the invariant violation: manually corrupt the data structures.
    /* oxlint-disable */
    const hack = assembler as any
    hack.order.push(99)
    /* oxlint-enable */
    expect(() => assembler.blocks()).toThrow('BlockAssembler invariant violated')
  })

  it('ignores duplicate block-start for the same index', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, text: 'one' })
    // duplicate block-start — should be no-op (false branch of has check)
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, text: ' two' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'one two' } })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'one two' }])
  })

  it('ignores tool-call-delta stragglers after block-end', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'tool-call' })
    assembler.push({ type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), name: 'echo', argumentsDelta: '{}' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{}' } })
    // straggler after block-end — partial.block is set, so early return
    assembler.push({ type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), name: 'evil', argumentsDelta: 'oops' })
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{}' }])
  })

  it('assembles tool-call with generated id fallback when no id provided', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'tool-call-delta', index: 0, argumentsDelta: '{}' } as StreamChunk)
    // No id and no name provided — uses fallback id `call-{index}` and empty name
    const blocks = assembler.blocks()
    expect(blocks).toEqual([
      { type: 'tool-call', id: ToolCallId('call-0'), name: '', arguments: '{}' },
    ])
  })

  it('exposes usage via the getter when a usage chunk was received', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'text-delta', index: 0, text: 'msg' })
    assembler.push({ type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } })
    expect(assembler.usage).toEqual({ inputTokens: 5, outputTokens: 3 })
  })
})

describe('BlockAssembler replay metadata', () => {
  const response = { responseId: 'resp-1' }

  it('prunes per-block replay entries with the tool calls a max-tokens finish drops', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'lead' } })
    assembler.push({
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{"text":' },
    })
    assembler.push({ type: 'block-end', index: 2, block: { type: 'reasoning', text: 'tail' } })
    assembler.push({
      type: 'finish',
      reason: { kind: 'max-tokens' },
      replayState: { response, blocks: ['meta-0', 'meta-1', 'meta-2'] },
    })

    expect(assembler.blocks()).toEqual([
      { type: 'text', text: 'lead' },
      { type: 'reasoning', text: 'tail' },
    ])
    expect(assembler.replayState).toEqual({ response, blocks: ['meta-0', 'meta-2'] })
  })

  it('omits replay metadata whose per-block entries misalign with the emitted blocks', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'one' } })
    assembler.push({ type: 'block-end', index: 1, block: { type: 'text', text: 'two' } })
    assembler.push({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { response, blocks: ['meta-0'] },
    })

    expect(assembler.blocks()).toHaveLength(2)
    expect(assembler.replayState).toBeUndefined()
  })

  it('passes replay metadata through unchanged when assembly drops nothing', () => {
    const replayState = { response, blocks: ['meta-0', 'meta-1'] }
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } })
    assembler.push({
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{}' },
    })
    assembler.push({ type: 'finish', reason: { kind: 'tool-calls' }, replayState })

    expect(assembler.replayState).toBe(replayState)
  })

  it('keeps a max-tokens replay state with no per-block entries across a tool-call drop', () => {
    const replayState = { response }
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } })
    assembler.push({
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{"text":' },
    })
    assembler.push({ type: 'finish', reason: { kind: 'max-tokens' }, replayState })

    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'partial' }])
    expect(assembler.replayState).toBe(replayState)
  })

  it('keeps a text-only max-tokens response and its replay metadata intact', () => {
    const replayState = { response, blocks: ['meta-0'] }
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } })
    assembler.push({ type: 'finish', reason: { kind: 'max-tokens' }, replayState })

    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'partial' }])
    expect(assembler.replayState).toBe(replayState)
  })
})

describe('assertNever', () => {
  it('throws with diagnostics when a value escapes a closed union at runtime', async () => {
    const { assertNever } = await import('@deepseek-ai/dsh-util-values')
    expect(() => assertNever({ type: 'rogue' } as never, 'test-context'))
      .toThrow('unreachable variant in test-context: {"type":"rogue"}')
    expect(() => assertNever(undefined as never)).toThrow('unreachable variant: undefined')
  })

  it('BlockAssembler.push rejects chunks outside the closed StreamChunk union', () => {
    const assembler = new BlockAssembler()
    expect(() => { assembler.push({ type: 'rogue-chunk' } as unknown as StreamChunk) })
      .toThrow('unreachable variant in BlockAssembler.push')
  })
})

describe('BlockAssembler duplicate-close contract', () => {
  it('first block-end wins: a duplicate block-end for a closed index is ignored', () => {
    // The first close wins so streamed and final output cannot disagree.
    const chunks: StreamChunk[] = [
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'first' } },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'second' } },
    ]
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([{ type: 'reasoning', text: 'first' }])
  })
})

describe('BlockAssembler.interruptedBlocks', () => {
  it('keeps closed and open text/reasoning blocks with streamed content, in order', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
    assembler.push({ type: 'reasoning-delta', index: 0, text: 'planning' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'planning' } })
    assembler.push({ type: 'block-start', index: 1, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 1, text: 'half an ans' })
    expect(assembler.interruptedBlocks()).toEqual([
      { type: 'reasoning', text: 'planning' },
      { type: 'text', text: 'half an ans' },
    ])
  })

  it('drops tool calls whether open or closed — interruption precedes dispatch', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, text: 'calling' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'calling' } })
    assembler.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
    assembler.push({ type: 'tool-call-delta', index: 1, id: ToolCallId('c1'), name: 'read', argumentsDelta: '{"a":1}' })
    assembler.push({ type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{"a":1}' } })
    assembler.push({ type: 'block-start', index: 2, blockType: 'tool-call' })
    assembler.push({ type: 'tool-call-delta', index: 2, id: ToolCallId('c2'), name: 'read', argumentsDelta: '{"pa' })
    expect(assembler.interruptedBlocks()).toEqual([{ type: 'text', text: 'calling' }])
  })

  it('drops empty and whitespace-only text/reasoning blocks and unknown open block types', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, text: '  \n' })
    // A merge-extended block kind this build does not know how to assemble.
    assembler.push({ type: 'block-start', index: 1, blockType: 'mystery' } as unknown as StreamChunk)
    assembler.push({ type: 'block-start', index: 2, blockType: 'reasoning' })
    expect(assembler.interruptedBlocks()).toEqual([])
  })
})
