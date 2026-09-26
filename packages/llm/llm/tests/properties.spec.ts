/**
 * Property-based tests for the BlockAssembler (the property-testing Agent Note).
 *
 * The assembler is protocol-shaped: arbitrary interleavings of block-start,
 * deltas, block-end, usage, and finish — valid and malformed (duplicate
 * indices, stragglers after block-end, missing block-start, delta-only). The
 * invariants below are the contract the agent loop relies on.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

// A small pool of indices so collisions (duplicate-index bugs) are common.
const indexArb = fc.integer({ min: 0, max: 4 })

const blockEndArb = (index: number): fc.Arbitrary<StreamChunk> => fc.oneof(
  fc.record({ text: fc.string() }).map((r): StreamChunk => (
    { type: 'block-end', index, block: { type: 'text', text: r.text } }
  )),
  fc.record({ text: fc.string() }).map((r): StreamChunk => (
    { type: 'block-end', index, block: { type: 'reasoning', text: r.text } }
  )),
  fc.record({ id: fc.string({ minLength: 1 }), name: fc.string(), args: fc.string() }).map((r): StreamChunk => (
    { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(r.id), name: r.name, arguments: r.args } }
  )),
)

/** One arbitrary chunk over the small index pool — valid and malformed mixes. */
const chunkArb: fc.Arbitrary<StreamChunk> = indexArb.chain(index => fc.oneof(
  fc.constant<StreamChunk>({ type: 'block-start', index, blockType: 'text' }),
  fc.constant<StreamChunk>({ type: 'block-start', index, blockType: 'reasoning' }),
  fc.constant<StreamChunk>({ type: 'block-start', index, blockType: 'tool-call' }),
  fc.string().map((text): StreamChunk => ({ type: 'text-delta', index, text })),
  fc.string().map((text): StreamChunk => ({ type: 'reasoning-delta', index, text })),
  fc.record({ id: fc.string({ minLength: 1 }), argumentsDelta: fc.string() })
    .map((r): StreamChunk => ({ type: 'tool-call-delta', index, id: ToolCallId(r.id), argumentsDelta: r.argumentsDelta })),
  blockEndArb(index),
  fc.constant<StreamChunk>({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }),
  fc.constant<StreamChunk>({ type: 'finish', reason: { kind: 'stop' } }),
  fc.constant<StreamChunk>({ type: 'finish', reason: { kind: 'tool-calls' } }),
  fc.string({ minLength: 1 }).map((message): StreamChunk => ({
    type: 'finish',
    reason: { kind: 'error', failure: { message, code: 'UNKNOWN' } },
  })),
))

/** A stream is an arbitrary list of chunks (we do NOT force a terminal finish). */
const streamArb = fc.array(chunkArb, { maxLength: 30 })

/** Feed a fresh assembler, return it. */
function feed(chunks: StreamChunk[]): BlockAssembler {
  const a = new BlockAssembler()
  for (const chunk of chunks) a.push(chunk)
  return a
}

describe('BlockAssembler properties', () => {
  it('partials map size never exceeds the number of distinct indices seen', () => {
    fc.assert(fc.property(streamArb, (chunks) => {
      const distinct = new Set<number>()
      for (const chunk of chunks) {
        if ('index' in chunk) distinct.add(chunk.index)
      }
      const a = feed(chunks)
      // blocks() length equals the number of distinct indices that became
      // partials (block-bearing chunks). It can never exceed distinct indices.
      expect(a.blocks().length).toBeLessThanOrEqual(distinct.size)
    }))
  })

  it('re-assembly is idempotent: blocks() is stable across repeated calls', () => {
    fc.assert(fc.property(streamArb, (chunks) => {
      const a = feed(chunks)
      expect(a.blocks()).toEqual(a.blocks())
      // And message().content mirrors blocks().
      expect(a.message({ provider: 'mock', model: 'mock' }).content).toEqual(a.blocks())
    }))
  })

  it('blocks() never throws and yields only valid content-block tags', () => {
    fc.assert(fc.property(streamArb, (chunks) => {
      const blocks = feed(chunks).blocks()
      for (const block of blocks) {
        expect(['text', 'reasoning', 'tool-call', 'tool-result']).toContain(block.type)
      }
    }))
  })

  it('finish reflects the last finish chunk, or defaults to stop when none arrives', () => {
    fc.assert(fc.property(streamArb, (chunks) => {
      const a = feed(chunks)
      const finishes = chunks.filter(c => c.type === 'finish')
      if (finishes.length === 0) {
        expect(a.finish).toEqual({ kind: 'stop' })
      } else {
        // last-write-wins: the assembler keeps the most recent finish reason.
        const last = finishes[finishes.length - 1]
        if (last?.type === 'finish') expect(a.finish).toEqual(last.reason)
      }
    }))
  })
})
