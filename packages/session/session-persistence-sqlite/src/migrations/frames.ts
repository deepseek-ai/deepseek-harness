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
/** Version 1 `frames.codec` for one Zstandard frame; version 1 allowed only this and text (`0`). */
const FRAME_CODEC_ZSTD = 1
const FRAME_TABLES = ['frames', 'traces', 'segments', 'segment_ancestors']
const segmentV1 = z.object({ segment_uuid: z.string(), parent_segment_uuid: z.string().nullable(),
  parent_end_seq: z.number().int().nonnegative().nullable(), base_seq: z.number().int().nonnegative() })
const frame = z.object({ frame: z.number().int(), segment_id: z.number().int(), segment_uuid: z.string(),
  base_seq: z.number().int().nonnegative(),
  start_seq: z.number().int().nonnegative(), end_seq: z.number().int().positive(),
  codec: z.number().int(), payload: z.instanceof(Uint8Array) })
const orphanFrame = z.object({ frame: z.number().int(), segment_uuid: z.string(), start_seq: z.number().int().nonnegative() })

/**
 * Rewrites a frame-layout database as event rows. Segment and Session
 * identities, ancestry and inherited counts carry over; version 1 sequences
 * were Segment-local, and each event's own `seq` supplies the Session sequence.
 * Events are carried over by their envelope alone, so an event type this build
 * does not know upgrades with the rest and is judged when its Session is read.
 * Damage that made a read fail before the upgrade makes the same read fail after
 * it, and nothing else: the frame layout served whatever prefix of a frame it
 * could read, so every sequence of the recorded range is carried over that way
 * and only a sequence with no readable line gets a row that no reader decodes.
 * Lines past the recorded range are not part of the Segment's history and were
 * never readable, so they are dropped. The Segment keeps its event count either
 * way. Each damaged frame is reported once and copied unchanged into
 * `frames_set_aside`, a table that exists only then.
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
    // Read every Segment before checking any, so the order the rows arrive in cannot decide whether a parent is found.
    const v1Segments = db.prepare(sql.text('upgrade/1-to-2/segments-parents-first')).all().map((raw) => {
      const segment = segmentV1.parse(raw)
      return { uuid: segment.segment_uuid, parent: segment.parent_segment_uuid, base: segment.base_seq,
        parentEnd: segment.parent_end_seq }
    })
    const segmentBase = new Map(v1Segments.map(segment => [segment.uuid, segment.base]))
    for (const { uuid, parent, parentEnd, base } of v1Segments) {
      if (parent !== null) {
        const parentBase = segmentBase.get(parent)
        // The frame layout refused a child that did not start where its parent ended, so rows that disagree describe no
        // history this build can carry over. The upgrade stops rather than give the child a history it never had.
        if (parentBase === undefined) throw new Error(`schema version 1 Segment "${uuid}" names parent "${parent}", which is not stored`)
        // A version 1 table refused a parent without a recorded end, so `parentEnd` is present whenever `parent` is.
        /* v8 ignore next -- the version 1 table refuses a null parent_end_seq beside a parent. */
        const parentEnded = parentEnd ?? 0
        if (base !== parentBase + parentEnded) {
          throw new Error(`schema version 1 Segment "${uuid}" starts at ${base}, not at its parent's end ${parentBase + parentEnded}`)
        }
      }
    }
    // One statement per Segment: a single INSERT ... SELECT reads `segments` before it stores any row,
    // so no child would find its parent.
    const segment = db.prepare(sql.text('upgrade/1-to-2/insert-segment'))
    for (const { uuid, parent, base } of v1Segments) segment.run(uuid, parent, base)
    db.exec(sql.text('upgrade/1-to-2/insert-sessions'))
    const insert = db.prepare(sql.text('upgrade/1-to-2/insert-event'))
    const stored = db.prepare(sql.text('upgrade/1-to-2/frames-by-segment'))
    const orphaned = db.prepare(sql.text('upgrade/1-to-2/orphan-frames')).all()
    const damaged: number[] = []
    /**
     * Record one unreadable sequence; a row no reader decodes keeps the Segment's event count. The `time` repeats the
     * nearest readable event of the same Segment, so a Session's last event time stays a real instant instead of the epoch
     * whenever that Segment has a readable event before the damaged one. The time resets to 0 at each Segment because no
     * earlier event of a new Segment has been read yet, so a damaged first frame keeps 0 and reports the epoch.
     */
    const standIn = (segment: number, seq: number, time: number): void => {
      insert.run(segment, seq, UNREADABLE_TYPE, time, null, null, null, EVENT_CODEC_UNREADABLE, new Uint8Array())
    }
    // Frames arrive ordered by Segment and start sequence, so the last time read carries into the next frame.
    let time = 0
    let timeSegment: number | undefined
    for (const raw of stored.iterate()) {
      const { frame: rowid, segment_id: segment, segment_uuid: uuid, base_seq: base, start_seq: start, end_seq: end,
        codec, payload } = frame.parse(raw)
      if (segment !== timeSegment) { time = 0; timeSegment = segment }
      const setAside = (error: unknown): void => {
        if (damaged.at(-1) === rowid) return
        damaged.push(rowid)
        onSetAside(`frame at ${base + start} of Segment ${uuid}`, error)
      }
      let texts: string[]
      try {
        // Version 1's `CHECK(codec IN (0, 1))` makes every other value impossible in a database it wrote.
        const bytes = codec === FRAME_CODEC_ZSTD ? zstdDecompressSync(payload) : payload
        texts = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8').split('\n')
      } catch (error: unknown) {
        // No line of the frame can be placed, so no sequence of its range is readable: each one stands in, and a read
        // that reaches the frame is refused at its first sequence, as the whole frame was refused before the upgrade.
        setAside(error)
        for (let seq = base + start; seq < base + end; seq++) standIn(segment, seq, time)
        continue
      }
      for (let index = 0; index < end - start; index++) {
        const seq = base + start + index
        const text = texts[index]
        if (text === undefined) {
          // Fewer lines than recorded: the frame layout served this prefix, so only the missing tail stands in.
          setAside(new RangeError(`SQLite frame at ${start} holds ${texts.length} of its ${end - start} recorded events`))
          standIn(segment, seq, time)
          continue
        }
        let event: StoredEnvelope
        try {
          event = decodeEnvelope(JSON.parse(text))
          if (event.seq !== seq) throw new RangeError(`SQLite frame event ${event.seq} is out of sequence`)
        } catch (error: unknown) {
          // The frame layout parsed only the lines a read asked for, so the other events of this frame stayed
          // readable; they are carried over, and only this event is replaced.
          setAside(error)
          standIn(segment, seq, time)
          continue
        }
        time = event.time
        const row = encodeRow(event, compression)
        insert.run(segment, row.seq, row.type, row.time, row.surface_op, row.source_seqs, row.ignorable, row.codec, row.data)
      }
    }
    for (const raw of orphaned) {
      const orphan = orphanFrame.parse(raw)
      damaged.push(orphan.frame)
      onSetAside(`frame at ${orphan.start_seq} of Segment ${orphan.segment_uuid}`,
        new Error('the Segment of this frame is not stored, so no Session reaches it'))
    }
    if (damaged.length > 0) {
      db.exec(sql.text('upgrade/1-to-2/create-frames-set-aside'))
      db.prepare(sql.text('upgrade/1-to-2/set-aside-frames')).run(JSON.stringify(damaged))
    }
    db.exec(sql.text('upgrade/1-to-2/drop-v1-tables'))
  },
}
