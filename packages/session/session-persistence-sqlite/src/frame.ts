/**
 * Frame encoding for stored event batches: one durable write stores one frame
 * holding its events as JSON lines, Zstandard-compressed when the store's
 * compression is `zstd` and the frame shrinks, otherwise as UTF-8 text. Rows
 * compress together, so a frame of many events reaches the ratio of a
 * compressed log file, while a frame of one event costs no more than storing
 * it raw. @module
 */
import { constants, zstdCompressSync, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

const decompress = promisify(zstdDecompress)

/** Physical frame encoding selected by the plugin's `compression` config. */
export type FrameCompression = 'zstd' | 'none'

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
 * @param compression - `zstd` compresses when that is smaller; `none` stores the text.
 * @returns the frame to store.
 */
export function encodeFrame(lines: readonly string[], compression: FrameCompression): EncodedFrame {
  const utf8 = Buffer.from(lines.join('\n'), 'utf8')
  if (compression === 'zstd') {
    const frame = zstdCompressSync(utf8, ZSTD_OPTIONS)
    if (frame.length < utf8.length) return { codec: FRAME_CODEC_ZSTD, bytes: frame, count: lines.length }
  }
  return { codec: FRAME_CODEC_UTF8, bytes: utf8, count: lines.length }
}

/**
 * Decode one stored frame back to its event JSON texts. A compressed frame
 * decompresses on the libuv thread pool, so callers may decode several frames
 * concurrently; a text frame decodes inline.
 * @param codec - the frame's stored codec.
 * @param bytes - the frame's stored bytes.
 * @returns the JSON text of each event, in sequence order.
 * @throws {RangeError} for an unknown codec; a corrupt frame rejects with the Zstandard error.
 */
export async function decodeFrame(codec: number, bytes: Uint8Array): Promise<string[]> {
  switch (codec) {
    case FRAME_CODEC_UTF8: return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8').split('\n')
    case FRAME_CODEC_ZSTD: return (await decompress(bytes)).toString('utf8').split('\n')
    default: throw new RangeError(`unknown SQLite frame codec ${String(codec)}`)
  }
}
