import { describe, expect, it } from 'vitest'
import { decodeSeqRanges, encodeSeqRanges, SessionSeq } from '@deepseek-ai/dsh-session'

const seqs = (values: readonly number[]) => values.map(SessionSeq)

describe('sourceEventSeqs ranges', () => {
  it.each([
    [],
    [5],
    [10, 11, 12, 13, 14],
    [16, 17, 100, 200, 201, 202, 203],
    [3, 2],
    [Number.MAX_SAFE_INTEGER - 1, 0, Number.MAX_SAFE_INTEGER - 2],
  ].map(values => [values]))('round-trips %j', (values) => {
    expect(decodeSeqRanges(encodeSeqRanges(seqs(values)))).toEqual(values)
  })

  it('encodes only profitable increasing runs', () => {
    expect(encodeSeqRanges(seqs([1, 3, 4, 5, 7]))).toEqual([1, [3, 5], 7])
    expect(encodeSeqRanges(seqs([1, 3, 4, 7]))).toEqual([1, 3, 4, 7])
    expect(encodeSeqRanges(seqs([3, 2]))).toEqual([3, 2])
  })

  it('does not impose a persistence-only provenance length limit', () => {
    const values = Array.from({ length: 1_000_001 }, (_, index) => SessionSeq(index))
    expect(encodeSeqRanges(values)).toEqual([[0, 1_000_000]])
  })

  it('rejects malformed or impossible expansions', () => {
    expect(() => decodeSeqRanges('nope')).toThrow(/must be an array/)
    expect(() => decodeSeqRanges([-1])).toThrow(/non-negative safe integers/)
    expect(() => decodeSeqRanges([[1]])).toThrow(/\[start, end\] pairs/)
    expect(() => decodeSeqRanges([[4, 2]])).toThrow(/start <= end/)
    expect(() => decodeSeqRanges([[2, 5], [4, 7]])).toThrow(/strictly increasing/)
    expect(() => decodeSeqRanges([0], 0)).toThrow(/exceeds its event sequence/)
    expect(() => decodeSeqRanges([[0, 10]], 10)).toThrow(/exceeds its event sequence/)
  })
})
