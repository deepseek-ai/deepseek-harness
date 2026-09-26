/**
 * PartialAccumulator: six-variant chunk folding, sparse-index compaction, and
 * the block/snapshot reference discipline (a delta swaps only that block).
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-api-remotes/client'
import { PartialAccumulator } from '../src/client/conversation-nodes/partial.ts'

const chunk = (c: Record<string, unknown>): StreamChunk => c as StreamChunk

describe('PartialAccumulator', () => {
  it('builds empty blocks per block-start type, unknown type falls to other', () => {
    const acc = new PartialAccumulator(1, 0)
    acc.push(chunk({ type: 'block-start', index: 0, blockType: 'text' }))
    acc.push(chunk({ type: 'block-start', index: 1, blockType: 'reasoning' }))
    acc.push(chunk({ type: 'block-start', index: 2, blockType: 'tool-call' }))
    acc.push(chunk({ type: 'block-start', index: 3, blockType: 'no-such' }))
    expect(acc.toPartial().blocks).toEqual([
      { kind: 'text', text: '' },
      { kind: 'reasoning', text: '' },
      { kind: 'tool-call', callId: '', name: '', argsRaw: '' },
      { kind: 'other', block: null },
    ])
  })

  it('accumulates text deltas, starting from empty when prev is missing or another kind', () => {
    const acc = new PartialAccumulator(1, 0)
    acc.push(chunk({ type: 'text-delta', index: 0, text: '无 start ' })) // prev missing
    acc.push(chunk({ type: 'text-delta', index: 0, text: '也累积' }))
    expect(acc.toPartial().blocks).toEqual([{ kind: 'text', text: '无 start 也累积' }])
    acc.push(chunk({ type: 'reasoning-delta', index: 0, text: '换型重起' })) // prev is text → restart
    expect(acc.toPartial().blocks).toEqual([{ kind: 'reasoning', text: '换型重起' }])
  })

  it('accumulates reasoning deltas on the reasoning lane', () => {
    const acc = new PartialAccumulator(1, 0)
    acc.push(chunk({ type: 'block-start', index: 0, blockType: 'reasoning' }))
    acc.push(chunk({ type: 'reasoning-delta', index: 0, text: '思' }))
    acc.push(chunk({ type: 'reasoning-delta', index: 0, text: '考' }))
    expect(acc.toPartial().blocks).toEqual([{ kind: 'reasoning', text: '思考' }])
  })

  it('continues from a materialized history prefix', () => {
    const acc = new PartialAccumulator(1, 0, [{ kind: 'text', text: '已有' }])
    acc.push(chunk({ type: 'text-delta', index: 0, text: '增量' }))
    expect(acc.toPartial().blocks).toEqual([{ kind: 'text', text: '已有增量' }])
  })

  it('folds tool-call deltas: first id pins callId, late name overrides, argsRaw concatenates', () => {
    const acc = new PartialAccumulator(1, 0)
    acc.push(chunk({ type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{"a"' }))
    acc.push(chunk({ type: 'tool-call-delta', index: 0, id: 'c2-late', name: 'echo', argumentsDelta: ':1}' }))
    expect(acc.toPartial().blocks).toEqual([
      { kind: 'tool-call', callId: 'c1', name: 'echo', argsRaw: '{"a":1}' },
    ])
  })

  it('replaces the accumulated block wholesale on block-end', () => {
    const acc = new PartialAccumulator(1, 0)
    acc.push(chunk({ type: 'text-delta', index: 0, text: '中间态' }))
    acc.push(chunk({ type: 'block-end', index: 0, block: { type: 'text', text: '定稿全文' } }))
    expect(acc.toPartial().blocks).toEqual([{ kind: 'text', text: '定稿全文' }])
  })

  it('returns false (no notification) for usage/finish/unknown variants and keeps blocks', () => {
    const acc = new PartialAccumulator(1, 0)
    acc.push(chunk({ type: 'text-delta', index: 0, text: 'x' }))
    const before = acc.toPartial()
    expect(acc.push(chunk({ type: 'usage', usage: {} }))).toBe(false)
    expect(acc.push(chunk({ type: 'finish', reason: 'stop' }))).toBe(false)
    expect(acc.push(chunk({ type: 'future-variant' }))).toBe(false)
    expect(acc.toPartial()).toBe(before) // unchanged: same snapshot reference
  })

  it('compacts sparse indexes into a dense render-order array', () => {
    const acc = new PartialAccumulator(1, 0)
    acc.push(chunk({ type: 'block-start', index: 2, blockType: 'text' }))
    acc.push(chunk({ type: 'text-delta', index: 2, text: '先到的高位' }))
    acc.push(chunk({ type: 'block-start', index: 0, blockType: 'reasoning' }))
    const { blocks } = acc.toPartial()
    expect(blocks).toHaveLength(2) // no undefined holes
    expect(blocks[0]).toEqual({ kind: 'reasoning', text: '' })
    expect(blocks[1]).toEqual({ kind: 'text', text: '先到的高位' })
  })

  it('keeps the snapshot reference stable without changes and swaps it once per mutation', () => {
    const acc = new PartialAccumulator(3, 1)
    const first = acc.toPartial()
    expect(first).toMatchObject({ turn: 3, step: 1, blocks: [] })
    expect(acc.toPartial()).toBe(first)
    acc.push(chunk({ type: 'text-delta', index: 0, text: 'a' }))
    const second = acc.toPartial()
    expect(second).not.toBe(first)
    expect(acc.toPartial()).toBe(second)
  })
})
