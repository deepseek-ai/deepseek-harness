/**
 * The bounded output ring behind one job: chunks at absolute byte offsets,
 * head eviction that never moves an assigned offset, and non-consuming reads
 * from any offset.
 * @module @deepseek-ai/dsh-jobs-local/ring
 */

import type { JobAppendOptions, JobChannel, JobOutputRead } from '@deepseek-ai/dsh-jobs'

/** One retained ring entry; `bytes` caches the chunk's UTF-8 length. */
interface RingChunk {
  at: number
  text: string
  bytes: number
  channel?: JobChannel
  gapBefore?: true
}

/**
 * The UTF-8-safe tail of `text` no longer than `maxBytes`: the byte cut
 * advances past continuation bytes so the surviving text never starts inside
 * a code point.
 * @param text - the oversized chunk text.
 * @param maxBytes - positive byte budget for the surviving tail.
 * @returns the surviving tail and its exact byte length.
 */
function utf8Tail(text: string, maxBytes: number): { text: string; bytes: number } {
  const raw = Buffer.from(text, 'utf8')
  let start = raw.length - maxBytes
  // The loop bound proves the index is in range; the assertion only
  // discharges noUncheckedIndexedAccess.
  while (start < raw.length && ((raw[start] as number) & 0xC0) === 0x80) start += 1
  const tail = raw.subarray(start)
  return { text: tail.toString('utf8'), bytes: tail.length }
}

/** Offsets stay absolute across eviction: `earliest` only ever advances. */
export class OutputRing {
  /** Retained chunks in offset order. */
  private readonly chunks: RingChunk[] = []
  /** Sum of the retained chunks' byte lengths. */
  retainedBytes = 0
  /** Total UTF-8 bytes ever appended — the offset the next chunk starts at. */
  total = 0
  /** Offset of the oldest retained byte (equals {@link total} when nothing is retained). */
  earliest = 0

  /**
   * Append one chunk and trim the head to `cap`.
   * @param text - the chunk text, exactly as produced.
   * @param options - stream label and gap marker.
   * @param cap - retention cap in UTF-8 bytes after this append.
   * @returns false when the chunk was empty and nothing changed.
   */
  append(text: string, options: JobAppendOptions | undefined, cap: number): boolean {
    if (text.length === 0) return false
    const bytes = Buffer.byteLength(text, 'utf8')
    this.chunks.push({
      at: this.total,
      text,
      bytes,
      ...options?.channel !== undefined ? { channel: options.channel } : {},
      ...options?.gapBefore !== undefined ? { gapBefore: options.gapBefore } : {},
    })
    this.total += bytes
    this.retainedBytes += bytes
    this.trim(cap)
    return true
  }

  /**
   * Drop retained head chunks until the ring fits `cap`; a single oversized
   * chunk keeps only its UTF-8-safe tail with a `gapBefore` marker.
   * @param cap - retention cap in UTF-8 bytes.
   */
  trim(cap: number): void {
    while (this.retainedBytes > cap && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      /* v8 ignore next -- the length guard proves shift() returns a chunk; the check only satisfies noUncheckedIndexedAccess. */
      if (dropped === undefined) break
      this.retainedBytes -= dropped.bytes
    }
    const single = this.chunks.length === 1 ? this.chunks[0] : undefined
    if (single !== undefined && single.bytes > cap) {
      const tail = utf8Tail(single.text, cap)
      single.at += single.bytes - tail.bytes
      single.text = tail.text
      single.bytes = tail.bytes
      single.gapBefore = true
      this.retainedBytes = tail.bytes
    }
    this.earliest = this.chunks[0]?.at ?? this.total
  }

  /**
   * Retained chunks overlapping `[from, total)` as fresh wire chunks.
   * @param from - absolute byte offset to read from.
   * @returns the chunks, the resume offset, and whether bytes before them were evicted.
   */
  readFrom(from: number): JobOutputRead {
    const chunks = []
    for (const chunk of this.chunks) {
      if (chunk.at + chunk.bytes <= from) continue
      chunks.push({
        at: chunk.at,
        text: chunk.text,
        ...chunk.channel !== undefined ? { channel: chunk.channel } : {},
        ...chunk.gapBefore !== undefined ? { gapBefore: chunk.gapBefore } : {},
      })
    }
    return { chunks, next: this.total, lossy: from < this.earliest }
  }
}
