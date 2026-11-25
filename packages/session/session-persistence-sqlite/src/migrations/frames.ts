/**
 * Schema version 1 to 2: the frame layout to event rows. Version 1 stored each
 * durable write as one row of `frames` holding its events as JSON lines, as text
 * or one Zstandard frame, with Segments and Sessions keyed by UUID in `segments`,
 * `segment_ancestors` and `traces`. This module is the only reader of that
 * layout. Its statements are the files of `resources/sql/upgrade/1-to-2/`; it
 * reads no other SQL file except the version 2 schema it writes. @module
 */
import type { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { z } from 'zod'
import { decodeEnvelope } from '../codec.ts'
import type { StoredEnvelope } from '../codec.ts'
import { EVENT_CODEC_UNREADABLE, encodeRow } from '../row.ts'
import type { Migration } from './types.ts'

/** `events.type` of a row that stands in for stored data this step could not read. */
const UNREADABLE_TYPE = 'storage/unreadable'
/** Version 1 `frames.codec` for one Zstandard frame; every other stored value was UTF-8 text. */
const FRAME_CODEC_ZSTD = 1
const FRAME_TABLES = ['frames', 'traces', 'segments', 'segment_ancestors']
const segmentV1 = z.object({ segment_uuid: z.string(), parent_segment_uuid: z.string().nullable(),
  base_seq: z.number().int().nonnegative() })
const frame = z.object({ frame: z.number().int(), segment_id: z.number().int(), segment_uuid: z.string(),
  base_seq: z.number().int().nonnegative(),
  start_seq: z.number().int().nonnegative(), end_seq: z.number().int().positive(),
  codec: z.number().int(), payload: z.instanceof(Uint8Array) })

/**
 * Rewrites a frame-layout database as event rows. Segment and Session
 * identities, ancestry and inherited counts carry over; version 1 sequences
 * were Segment-local, and each event's own `seq` supplies the Session sequence.
 * Events are carried over by their envelope alone, so an event type this build
 * does not know upgrades with the rest and is judged when its Session is read.
 * Damage that made a read fail before the upgrade makes the same read fail after
 * it, and nothing else. A frame whose bytes cannot be split into its recorded
 * number of lines gets one row that no reader decodes, at its last sequence. A
 * frame that splits is carried over event by event, and only an event that
 * cannot be read (not JSON, out of sequence, or an envelope the event row cannot
 * hold) gets such a row. The Segment keeps its event count either way. Each
 * damaged frame is reported once and copied unchanged into `frames_set_aside`,
 * a table that exists only then.
 */
export const frames: Migration = {
  from: 1,
  to: 2,
  apply(db: DatabaseSync, { compression, sql, onSetAside }): void {
    const present = new Set(db.prepare(sql.text('upgrade/1-to-2/table-names')).all().map(row => row.name))
    if (!FRAME_TABLES.every(name => present.has(name))) {
      throw new Error('schema version 1 is stored without the tables of the frame layout')
    }
    // Parents precede children so the path trigger of the new schema sees each parent's path.
    db.exec(sql.text('upgrade/1-to-2/retire-v1-objects'))
    db.exec(sql.text('schema/v2'))
    // One statement per Segment: a single INSERT ... SELECT reads `segments` before it stores any row,
    // so no child would find its parent.
    const segment = db.prepare(sql.text('upgrade/1-to-2/insert-segment'))
    for (const raw of db.prepare(sql.text('upgrade/1-to-2/segments-parents-first')).all()) {
      const { segment_uuid: uuid, parent_segment_uuid: parent, base_seq: base } = segmentV1.parse(raw)
      segment.run(uuid, parent, base)
    }
    db.exec(sql.text('upgrade/1-to-2/insert-sessions'))
    const insert = db.prepare(sql.text('upgrade/1-to-2/insert-event'))
    const stored = db.prepare(sql.text('upgrade/1-to-2/frames-by-segment'))
    const damaged: number[] = []
    const standIn = (segment: number, seq: number): void => {
      insert.run(segment, seq, UNREADABLE_TYPE, 0, null, null, null, EVENT_CODEC_UNREADABLE, new Uint8Array())
    }
    for (const raw of stored.iterate()) {
      const { frame: rowid, segment_id: segment, segment_uuid: uuid, base_seq: base, start_seq: start, end_seq: end,
        codec, payload } = frame.parse(raw)
      const setAside = (error: unknown): void => {
        if (damaged.at(-1) === rowid) return
        damaged.push(rowid)
        onSetAside(`frame at ${base + start} of Segment ${uuid}`, error)
      }
      let texts: string[]
      try {
        const bytes = codec === FRAME_CODEC_ZSTD ? zstdDecompressSync(payload) : payload
        texts = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8').split('\n')
        if (texts.length !== end - start) throw new RangeError(`SQLite frame at ${start} does not hold its recorded range`)
      } catch (error: unknown) {
        // No line of the frame can be placed. A row no reader decodes holds its last sequence, so the Segment
        // keeps its event count and a read that reaches the frame is refused, as it was before the upgrade.
        setAside(error)
        standIn(segment, base + end - 1)
        continue
      }
      for (const [index, text] of texts.entries()) {
        const seq = base + start + index
        let event: StoredEnvelope
        try {
          event = decodeEnvelope(JSON.parse(text))
          if (event.seq !== seq) throw new RangeError(`SQLite frame event ${event.seq} is out of sequence`)
        } catch (error: unknown) {
          // The frame layout parsed only the lines a read asked for, so the other events of this frame stayed
          // readable; they are carried over, and only this event is replaced.
          setAside(error)
          standIn(segment, seq)
          continue
        }
        const row = encodeRow(event, compression)
        insert.run(segment, row.seq, row.type, row.time, row.surface_op, row.source_seqs, row.ignorable, row.codec, row.data)
      }
    }
    if (damaged.length > 0) {
      db.exec(sql.text('upgrade/1-to-2/create-frames-set-aside'))
      db.prepare(sql.text('upgrade/1-to-2/set-aside-frames')).run(JSON.stringify(damaged))
    }
    db.exec(sql.text('upgrade/1-to-2/drop-v1-tables'))
  },
}
