/**
 * Frame encoding for stored event batches: one durable write stores one frame
 * holding its events as JSON lines, Zstandard-compressed when that is smaller
 * than the UTF-8 text. Rows compress together, so a frame of many events
 * reaches the ratio of a compressed log file, while a frame of one event costs
 * no more than storing it raw. @module
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Stored `frames.codec` for UTF-8 JSON lines; a format constant, never reinterpreted. */
export const FRAME_CODEC_UTF8 = 0
/** Stored `frames.codec` for one Zstandard frame of UTF-8 JSON lines; a format constant, never reinterpreted. */
export const FRAME_CODEC_ZSTD = 1
/**
 * Zstandard level for stored frames: the format default, chosen for decode
 * speed on the read path; a level change needs no schema change because every
 * frame is self-describing.
 */
const ZSTD_LEVEL = 3
const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }

/** One encoded frame: the stored bytes, their codec, and the number of events they hold. */
export interface EncodedFrame {
  readonly codec: typeof FRAME_CODEC_UTF8 | typeof FRAME_CODEC_ZSTD
  readonly bytes: Buffer
  readonly count: number
}

/**
 * Encode one batch of event JSON texts as a frame. Synchronous: a batch costs
 * milliseconds at most, and callers yield between batches of a long import.
 * @param lines - the batch's events, each serialized as one JSON text without newlines.
 * @returns the frame to store.
 */
export function encodeFrame(lines: readonly string[]): EncodedFrame {
  const utf8 = Buffer.from(lines.join('\n'), 'utf8')
  const frame = zstdCompressSync(utf8, ZSTD_OPTIONS)
  return frame.length < utf8.length
    ? { codec: FRAME_CODEC_ZSTD, bytes: frame, count: lines.length }
    : { codec: FRAME_CODEC_UTF8, bytes: utf8, count: lines.length }
}

/**
 * Decode one stored frame back to its event JSON texts.
 * @param codec - the frame's stored codec.
 * @param bytes - the frame's stored bytes.
 * @returns the JSON text of each event, in sequence order.
 * @throws {RangeError} for an unknown codec; a corrupt frame throws the Zstandard error.
 */
export function decodeFrame(codec: number, bytes: Uint8Array): string[] {
  switch (codec) {
    case FRAME_CODEC_UTF8: return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8').split('\n')
    case FRAME_CODEC_ZSTD: return zstdDecompressSync(bytes).toString('utf8').split('\n')
    default: throw new RangeError(`unknown SQLite frame codec ${String(codec)}`)
  }
}
