/** Lossless range encoding for JSONL `sourceEventSeqs` arrays. */

import { SessionSeq } from './types.ts'
import type { SessionSeq as SessionSeqType } from './types.ts'

/** A stored source sequence or inclusive consecutive range. */
export type EncodedSeq = number | [number, number]

function isStrictlyIncreasing(values: readonly SessionSeqType[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] as SessionSeqType))
}

/**
 * Replace profitable consecutive runs with inclusive pairs.
 * @param values - validated in-memory source sequences.
 * @returns a lossless JSON storage form.
 */
export function encodeSeqRanges(values: readonly SessionSeqType[]): EncodedSeq[] {
  if (!isStrictlyIncreasing(values)) return [...values]
  const encoded: EncodedSeq[] = []
  for (let start = 0; start < values.length;) {
    let end = start
    while (end + 1 < values.length && values[end + 1] === (values[end] as number) + 1) end += 1
    if (end - start >= 2) encoded.push([values[start] as number, values[end] as number])
    else for (let index = start; index <= end; index += 1) encoded.push(values[index] as number)
    start = end + 1
  }
  return encoded
}

/**
 * Expand a JSON storage-form source sequence array.
 * @param value - parsed storage value.
 * @param maxEntries - largest list permitted by the owning event.
 * @returns the in-memory source sequences.
 */
export function decodeSeqRanges(value: unknown, maxEntries = Number.MAX_SAFE_INTEGER): SessionSeqType[] {
  if (!Array.isArray(value)) throw new TypeError('sourceEventSeqs must be an array')
  const decoded: SessionSeqType[] = []
  let hasRange = false
  for (const entry of value) {
    if (typeof entry === 'number') {
      assertSeq(entry)
      if (decoded.length >= maxEntries) throw new TypeError('sourceEventSeqs exceeds its event sequence')
      decoded.push(SessionSeq(entry))
      continue
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('sourceEventSeqs range entries must be [start, end] pairs')
    }
    const start: unknown = entry[0]
    const end: unknown = entry[1]
    assertSeq(start)
    assertSeq(end)
    if (end < start) throw new TypeError('sourceEventSeqs ranges require start <= end')
    const length = end - start + 1
    if (length > maxEntries - decoded.length) {
      throw new TypeError('sourceEventSeqs range exceeds its event sequence')
    }
    for (let seq = start; seq <= end; seq += 1) decoded.push(SessionSeq(seq))
    hasRange = true
  }
  if (hasRange && !isStrictlyIncreasing(decoded)) {
    throw new TypeError('sourceEventSeqs ranges must be strictly increasing')
  }
  return decoded
}

function assertSeq(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('sourceEventSeqs must contain non-negative safe integers')
  }
}
