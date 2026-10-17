/**
 * Zstandard frame primitives for the JSONL persistence backend. The backend
 * owns a concatenated-frame container so it can append and recover batches
 * without exposing compression mechanics through the persistence seam.
 * @module dsh-session-persistence-jsonl/zstd
 */

import {
  constants, zstdCompress, zstdDecompress, type ZstdOptions,
} from 'node:zlib'
import { promisify } from 'node:util'
import { NodePrivateZstdFrameDecoder } from './zstd-private-decoder.ts'
import { PublicZstdFrameDecoder } from './zstd-public-decoder.ts'

const ZSTD_MAGIC = 0xFD2FB528
const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)
const CHECKSUM_OPTIONS: ZstdOptions = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}
const INCOMPLETE_FRAME_OPTIONS: ZstdOptions = {
  finishFlush: constants.ZSTD_e_flush,
}

/** Byte range occupied by one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number
  /** Exclusive frame end. */
  end: number
}

/** Structural scan result for a concatenated Zstandard stream. */
export interface ZstdFrameScan {
  /** Complete frames in file order. */
  frames: ZstdFrameRange[]
  /** Start of an incomplete final frame, when EOF interrupts one. */
  tornStart?: number
}

/**
 * Locate complete frames without decompressing their blocks. Invalid complete
 * structure rejects; EOF inside the final frame returns its start for repair.
 * @param buffer - complete bytes currently present in the session artifact.
 * @param maxFrames - optional complete-frame limit for metadata-only readers.
 * @returns complete frame ranges and an optional incomplete-final-frame start.
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}

/**
 * Compress one independently decodable, checksummed Zstandard frame.
 * @param input - JSONL bytes for a header or durable event batch.
 * @returns the complete encoded frame.
 */
export async function compressZstdFrame(input: Buffer | string): Promise<Buffer> {
  return zstdCompressAsync(input, CHECKSUM_OPTIONS)
}

/**
 * Decompress one complete frame and validate its checksum.
 * @param input - one structurally complete Zstandard frame.
 * @returns the frame plaintext.
 */
export async function decompressZstdFrame(input: Buffer): Promise<Buffer> {
  return zstdDecompressAsync(input)
}

/** Common lifecycle for interchangeable synchronous multi-frame decoders. */
export interface ZstdFrameDecoder {
  /**
   * Decode and checksum complete frames in source order. Each yielded buffer
   * remains valid only until the iterator advances to the next frame.
   * @param source - concatenated Zstandard frame bytes.
   * @param frames - structurally complete ranges within `source`.
   * @returns one plaintext buffer per frame.
   */
  decode(source: Buffer, frames: readonly ZstdFrameRange[]): Generator<Buffer, void, void>
  /** Release decoder-owned resources; repeated calls are harmless. */
  close(): void
}

/**
 * Select the shared private decoder when the running Node 24/26 shape is
 * compatible, otherwise preserve correctness with the public one-shot API.
 * @returns a synchronous decoder with an implementation-independent lifecycle.
 */
export function createZstdFrameDecoder(): ZstdFrameDecoder {
  return NodePrivateZstdFrameDecoder.create() ?? new PublicZstdFrameDecoder()
}

/**
 * Recover available plaintext from a structurally incomplete final frame.
 * `ZSTD_e_flush` deliberately suppresses final-frame and checksum completion;
 * callers must establish the torn frame boundary before using this helper.
 * @param input - available bytes from a known incomplete Zstandard frame.
 * @returns plaintext produced from the available input.
 */
export async function decompressZstdPrefix(input: Buffer): Promise<Buffer> {
  return zstdDecompressAsync(input, INCOMPLETE_FRAME_OPTIONS)
}
