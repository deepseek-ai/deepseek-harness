import { describe, expect, it } from 'vitest'
import { OutputRing } from '../src/ring.ts'

describe('OutputRing', () => {
  it('assigns absolute offsets by UTF-8 byte length and drops empty chunks silently', () => {
    const ring = new OutputRing()
    expect(ring.append('', undefined, 1024)).toBe(false)
    expect(ring.append('héllo', { channel: 'stdout' }, 1024)).toBe(true)
    expect(ring.append('wörld', { channel: 'stderr', gapBefore: true }, 1024)).toBe(true)
    expect(ring.total).toBe(12)
    expect(ring.earliest).toBe(0)
    expect(ring.retainedBytes).toBe(12)
    expect(ring.readFrom(0)).toEqual({
      chunks: [
        { at: 0, text: 'héllo', channel: 'stdout' },
        { at: 6, text: 'wörld', channel: 'stderr', gapBefore: true },
      ],
      next: 12,
      lossy: false,
    })
  })

  it('reads from a foreign offset by returning the whole overlapping chunk', () => {
    const ring = new OutputRing()
    ring.append('abc', undefined, 1024)
    ring.append('def', undefined, 1024)
    expect(ring.readFrom(4).chunks).toEqual([{ at: 3, text: 'def' }])
    expect(ring.readFrom(6)).toEqual({ chunks: [], next: 6, lossy: false })
  })

  it('trims whole head chunks past the cap and reports the evicted span as lossy', () => {
    const ring = new OutputRing()
    ring.append('aaaa', undefined, 8)
    ring.append('bbbb', undefined, 8)
    ring.append('cc', undefined, 8)
    // 10 bytes retained > cap 8: the oldest whole chunk goes.
    expect(ring.earliest).toBe(4)
    expect(ring.retainedBytes).toBe(6)
    expect(ring.readFrom(0)).toEqual({ chunks: [{ at: 4, text: 'bbbb' }, { at: 8, text: 'cc' }], next: 10, lossy: true })
    expect(ring.readFrom(4).lossy).toBe(false)
  })

  it('keeps a lone oversized chunk as a UTF-8-safe tail marked gapBefore', () => {
    const ring = new OutputRing()
    // 3 two-byte code points = 6 bytes; a 3-byte cap must not start inside a code point.
    ring.append('ééé', undefined, 3)
    expect(ring.retainedBytes).toBe(2)
    expect(ring.earliest).toBe(4)
    expect(ring.readFrom(0)).toEqual({ chunks: [{ at: 4, text: 'é', gapBefore: true }], next: 6, lossy: true })
  })

  it('re-trims to a smaller cap on demand and leaves total untouched', () => {
    const ring = new OutputRing()
    ring.append('12345678', undefined, 64)
    ring.append('abcdefgh', undefined, 64)
    ring.trim(8)
    expect(ring.total).toBe(16)
    expect(ring.earliest).toBe(8)
    expect(ring.readFrom(8)).toEqual({ chunks: [{ at: 8, text: 'abcdefgh' }], next: 16, lossy: false })
    // Trimming an empty ring is a no-op that keeps earliest at total.
    const empty = new OutputRing()
    empty.trim(1)
    expect(empty.earliest).toBe(0)
  })
})
