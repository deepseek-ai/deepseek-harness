/**
 * Event row encoding: one stored row per Session event. The envelope fields are
 * columns, and `data` is JSON text or, for a large value under `zstd`
 * compression, one Zstandard frame of that text. Each row names its own codec,
 * so rows written under different settings decode alike. @module
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { z } from 'zod'
import type { StoredEnvelope } from './codec.ts'

/** Physical `data` encoding selected by the plugin's `compression` config. */
export type EventCompression = 'zstd' | 'none'

/** Stored `events.codec` for JSON text; a format constant, never reinterpreted. */
export const EVENT_CODEC_JSON = 0
/** Stored `events.codec` for one Zstandard frame of JSON text; a format constant, never reinterpreted. */
export const EVENT_CODEC_ZSTD = 1
/**
 * Stored `events.codec` of a row that stands in for an event a schema upgrade could not read. No reader
 * decodes it, so a read that reaches the row is refused as corruption while the Segment keeps its event count.
 */
export const EVENT_CODEC_UNREADABLE = 255
/**
 * JSON text length from which `data` is compressed. Shorter values stay text so
 * SQL JSON operators read them directly; they are most rows and a few percent of
 * stored bytes. A format-neutral writer constant: readers follow each row's codec.
 */
const COMPRESS_MIN_LENGTH = 1024
/** Level 3 favors decode speed on the read path; the checksum lets a reader detect a damaged value. */
const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_checksumFlag]: 1 } }

/** One event as bound to, or selected from, the `events` table without its Segment. */
export interface EventRow {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly surface_op: string | null
  readonly source_seqs: string | null
  readonly ignorable: number | null
  readonly codec: number
  readonly data: string | Uint8Array
}

/** Validates the columns a read selects; `data` holds text for the JSON codec and bytes otherwise. */
export const eventRow: z.ZodType<EventRow> = z.object({
  seq: z.number().int().nonnegative(), type: z.string(), time: z.number().int(),
  surface_op: z.string().nullable(), source_seqs: z.string().nullable(), ignorable: z.literal(1).nullable(),
  codec: z.number().int(), data: z.union([z.string(), z.instanceof(Uint8Array)]),
})

/**
 * Encode one event as a row. Synchronous: one event costs microseconds, and
 * callers yield between chunks of a long batch.
 * @param event - event envelope to store; a materialized Session event is one.
 * @param compression - `zstd` compresses a large `data` when that is smaller; `none` stores text.
 * @returns the row to insert.
 */
export function encodeRow(event: StoredEnvelope, compression: EventCompression): EventRow {
  const text = JSON.stringify(event.data)
  let codec = EVENT_CODEC_JSON, data: string | Uint8Array = text
  if (compression === 'zstd' && text.length >= COMPRESS_MIN_LENGTH) {
    const utf8 = Buffer.from(text, 'utf8'), frame = zstdCompressSync(utf8, ZSTD_OPTIONS)
    if (frame.length < utf8.length) { codec = EVENT_CODEC_ZSTD; data = frame }
  }
  return {
    seq: event.seq, type: event.type, time: event.time, codec, data,
    surface_op: event.surfaceOp === undefined ? null : typeof event.surfaceOp === 'string' ? event.surfaceOp : JSON.stringify(event.surfaceOp),
    source_seqs: event.sourceEventSeqs === undefined ? null : JSON.stringify(event.sourceEventSeqs),
    ignorable: event.ignorable === true ? 1 : null,
  }
}

/**
 * Rebuild the logical event JSON value of one stored row for vocabulary validation.
 * @param row - selected event columns.
 * @returns the untrusted event value, with optional envelope members present only when stored.
 * @throws {RangeError} for an unknown codec or a `data` storage class that contradicts it; damaged
 * Zstandard bytes and malformed JSON throw their decoder's error.
 */
export function decodeRow(row: EventRow): unknown {
  let text: string
  if (row.codec === EVENT_CODEC_JSON && typeof row.data === 'string') text = row.data
  else if (row.codec === EVENT_CODEC_ZSTD && typeof row.data !== 'string') text = zstdDecompressSync(row.data).toString('utf8')
  else throw new RangeError(`SQLite event codec ${String(row.codec)} does not match its stored ${typeof row.data === 'string' ? 'text' : 'bytes'}`)
  const data: unknown = JSON.parse(text)
  const surfaceOp: unknown = row.surface_op === null ? undefined : row.surface_op.startsWith('{') ? JSON.parse(row.surface_op) : row.surface_op
  const sourceEventSeqs: unknown = row.source_seqs === null ? undefined : JSON.parse(row.source_seqs)
  return {
    type: row.type, seq: row.seq, time: row.time, data,
    ...row.ignorable === null ? {} : { ignorable: true },
    ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs },
    ...surfaceOp === undefined ? {} : { surfaceOp },
  }
}
