/** Released JSONL Zstandard framing and decoder interoperability. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compressZstdFrame, createZstdFrameDecoder, decompressZstdFrame, scanZstdFrames,
  type ZstdFrameDecoder,
} from '../src/zstd.ts'
import { NodePrivateZstdFrameDecoder } from '../src/zstd-private-decoder.ts'
import { PublicZstdFrameDecoder } from '../src/zstd-public-decoder.ts'
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
afterEach(() => vi.restoreAllMocks())
function emptyStructuralFrame(descriptor: number): Buffer {
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03]!
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const variableHeader = Buffer.alloc((singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes)
  const lastEmptyRawBlock = Buffer.from([1, 0, 0])
  const checksum = (descriptor & 0x04) === 0 ? Buffer.alloc(0) : Buffer.alloc(4)
  return Buffer.concat([MAGIC, Buffer.from([descriptor]), variableHeader, lastEmptyRawBlock, checksum])
}

describe('Zstandard frame structure', () => {
  it('scans concatenated checksummed frames and honors a frame limit', async () => {
    const first = await compressZstdFrame('header\n')
    const second = await compressZstdFrame('event\n')
    const stream = Buffer.concat([first, second])
    expect(scanZstdFrames(Buffer.alloc(0))).toEqual({ frames: [] })
    expect(scanZstdFrames(stream)).toEqual({
      frames: [{ start: 0, end: first.length }, { start: first.length, end: stream.length }],
    })
    expect(scanZstdFrames(stream, 1)).toEqual({ frames: [{ start: 0, end: first.length }] })
    expect(first[4]! & 0x04).toBe(0x04)
    expect(second[4]! & 0x04).toBe(0x04)
    expect((await decompressZstdFrame(first)).toString()).toBe('header\n')
    const decoder = createZstdFrameDecoder()
    try {
      const plaintext = Array.from(decoder.decode(stream, scanZstdFrames(stream).frames), chunk => Buffer.from(chunk))
      expect(Buffer.concat(plaintext).toString()).toBe('header\nevent\n')
    } finally {
      decoder.close()
    }
  })

  it('keeps the public and Node-private synchronous decoders interchangeable', async () => {
    const frames = [await compressZstdFrame('first\n'), await compressZstdFrame('second\n')]
    const stream = Buffer.concat(frames)
    const ranges = scanZstdFrames(stream).frames
    const privateDecoder = NodePrivateZstdFrameDecoder.create()
    expect(privateDecoder).toBeDefined()

    for (const decoder of [new PublicZstdFrameDecoder(), privateDecoder!]) {
      try {
        const plaintext = Array.from(decoder.decode(stream, ranges), chunk => Buffer.from(chunk))
        expect(plaintext).toHaveLength(2)
        expect(Buffer.concat(plaintext).toString()).toBe('first\nsecond\n')
      } finally {
        decoder.close()
      }
    }
  })

  it('falls back to the public decoder when the private Node contract is unavailable', () => {
    vi.spyOn(NodePrivateZstdFrameDecoder, 'create').mockReturnValue(undefined)
    const decoder = createZstdFrameDecoder()
    expect(decoder).toBeInstanceOf(PublicZstdFrameDecoder)
    decoder.close()
  })

  it('enforces decoder lifecycle and checksum errors through both implementations', async () => {
    const frame = await compressZstdFrame('frame\n')
    const range = [{ start: 0, end: frame.length }]
    const corrupt = Buffer.from(frame)
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xFF
    const factories: Array<() => ZstdFrameDecoder> = [
      () => new PublicZstdFrameDecoder(),
      () => NodePrivateZstdFrameDecoder.create()!,
    ]

    for (const create of factories) {
      const interrupted = create()
      const iterator = interrupted.decode(frame, range)
      expect(iterator.next().value?.toString()).toBe('frame\n')
      iterator.return()
      expect(() => Array.from(interrupted.decode(frame, range))).toThrow(/already started/)
      interrupted.close()

      const closed = create()
      closed.close()
      closed.close()
      expect(() => Array.from(closed.decode(frame, range))).toThrow(/closed/)

      const invalid = create()
      expect(() => Array.from(invalid.decode(corrupt, range))).toThrow(/frame at byte 0 failed validation/)
    }
  })

  it('assembles private-decoder output at and beyond its reusable chunk boundary', async () => {
    for (const length of [8, 9]) {
      const plaintext = Buffer.alloc(length, 0x61)
      const frame = await compressZstdFrame(plaintext)
      const decoder = NodePrivateZstdFrameDecoder.create()!
      ;(decoder as unknown as { output: Buffer }).output = Buffer.allocUnsafe(8)
      const [decoded] = Array.from(
        decoder.decode(frame, [{ start: 0, end: frame.length }]),
        chunk => Buffer.from(chunk),
      )
      expect(decoded).toEqual(plaintext)
    }
  })

  it('normalizes private decoder stream failures', async () => {
    interface PrivateDecoderInternals {
      stream: {
        [key: symbol]: unknown
        emit(event: string, error: Error): boolean
      }
      errorKey: symbol
    }
    const frame = await compressZstdFrame('frame\n')
    const range = [{ start: 0, end: frame.length }]

    const emitted = NodePrivateZstdFrameDecoder.create()!
    const emittedInternals = emitted as unknown as PrivateDecoderInternals
    const first = new Error('first emitted decoder failure')
    emittedInternals.stream.emit('error', first)
    emittedInternals.stream.emit('error', new Error('later emitted decoder failure'))
    try {
      Array.from(emitted.decode(frame, range))
      throw new Error('expected emitted decoder failure')
    } catch (error) {
      expect((error as Error).cause).toBe(first)
    }

    for (const internalFailure of [new Error('internal decoder failure'), 'not an Error']) {
      const decoder = NodePrivateZstdFrameDecoder.create()!
      const internals = decoder as unknown as PrivateDecoderInternals
      internals.stream[internals.errorKey] = internalFailure
      try {
        Array.from(decoder.decode(frame, range))
        throw new Error('expected internal decoder failure')
      } catch (error) {
        const cause = (error as Error).cause
        if (internalFailure instanceof Error) {
          expect(cause).toBe(internalFailure)
        } else {
          expect(cause).toMatchObject({ message: 'Zstandard decoder exposed a non-Error internal failure' })
        }
      }
    }
  })

  it('distinguishes incomplete frame regions from invalid complete structure', () => {
    expect(scanZstdFrames(MAGIC.subarray(0, 2))).toEqual({ frames: [], tornStart: 0 })
    expect(scanZstdFrames(MAGIC)).toEqual({ frames: [], tornStart: 0 })
    expect(() => scanZstdFrames(Buffer.alloc(4))).toThrow(/invalid frame magic/)
    expect(() => scanZstdFrames(Buffer.concat([MAGIC, Buffer.from([0x08])]))).toThrow(/reserved frame-header bit/)

    // Non-single-segment descriptor with no window descriptor.
    expect(scanZstdFrames(Buffer.concat([MAGIC, Buffer.from([0x00])]))).toEqual({ frames: [], tornStart: 0 })
    // Single-segment header followed by only two bytes of the three-byte block header.
    expect(scanZstdFrames(Buffer.concat([MAGIC, Buffer.from([0x20, 0x00, 0x01, 0x00])]))).toEqual({
      frames: [],
      tornStart: 0,
    })

    const rawFiveBytes = Buffer.from([(5 << 3) | 1, 0, 0])
    expect(scanZstdFrames(Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x00]),
      rawFiveBytes,
      Buffer.from([0x01, 0x02]),
    ]))).toEqual({ frames: [], tornStart: 0 })

    const reservedBlock = Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x00, 0x07, 0x00, 0x00]),
    ])
    expect(() => scanZstdFrames(reservedBlock)).toThrow(/reserved block type/)
  })

  it('covers standard header variants, RLE blocks, multiple blocks, and checksums', () => {
    for (const descriptor of [0x00, 0x21, 0x42, 0x83, 0xE3]) {
      const frame = emptyStructuralFrame(descriptor)
      expect(scanZstdFrames(frame)).toEqual({ frames: [{ start: 0, end: frame.length }] })
    }

    const rle = Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x01]),
      Buffer.from([(1 << 3) | (1 << 1) | 1, 0, 0]),
      Buffer.from([0x41]),
    ])
    expect(scanZstdFrames(rle)).toEqual({ frames: [{ start: 0, end: rle.length }] })

    const twoBlocks = Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x00]),
      Buffer.from([0, 0, 0]),
      Buffer.from([1, 0, 0]),
    ])
    expect(scanZstdFrames(twoBlocks)).toEqual({ frames: [{ start: 0, end: twoBlocks.length }] })

    const checksummed = emptyStructuralFrame(0x24)
    expect(scanZstdFrames(checksummed.subarray(0, -1))).toEqual({ frames: [], tornStart: 0 })
    expect(scanZstdFrames(checksummed)).toEqual({ frames: [{ start: 0, end: checksummed.length }] })
  })
})
