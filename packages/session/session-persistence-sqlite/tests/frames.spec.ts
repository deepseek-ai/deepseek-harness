/** Frame encoding, physical frame layout, sliced reads across frames, and frame corruption refusals. @module */
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { FRAME_CODEC_UTF8, FRAME_CODEC_ZSTD, decodeFrame, encodeFrame } from '../src/frame.ts'
import * as plugin from '../src/index.ts'
import { SqliteSessionPersistence } from '../src/persistence.ts'
import type { SqliteStoreOptions } from '../src/sqlite.ts'
import { persistenceFixture } from './fixtures/persistence.ts'
import { sqliteLogs, storedFrames, tailSegment } from './fixtures/store.ts'

const id = SessionId('framed')
const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }
// Deterministic per sequence, so stored events compare equal to freshly built ones; the text compresses even in a one-event frame.
const built = new Map<number, SessionEvent<'user/message'>>()
const event = (seq: number): SessionEvent<'user/message'> => {
  let entry = built.get(seq)
  if (entry === undefined) {
    entry = { type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq), time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: `event ${seq} ${'payload '.repeat(16)}` }], source: { kind: 'user' } }) }
    built.set(seq, entry)
  }
  return entry
}
const events = (count: number, from = 0): SessionEvent[] => Array.from({ length: count }, (_, index) => event(from + index))

async function fixture(overrides: Partial<SqliteStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-frames-')), path = join(root, 'sessions.sqlite')
  const logs = sqliteLogs(path, root, overrides)
  onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const inspect = (): DatabaseSync => {
    const db = new DatabaseSync(path)
    onTestFinished(() => { db.close() })
    return db
  }
  return { root, path, logs, inspect }
}

describe('frame codec', () => {
  const lines = events(40).map(entry => JSON.stringify(entry))

  it('compresses a batch that shrinks and decodes it back to its lines', async () => {
    const frame = encodeFrame(lines, 'zstd')
    expect(frame).toMatchObject({ codec: FRAME_CODEC_ZSTD, count: lines.length })
    expect(frame.bytes.length).toBeLessThan(Buffer.byteLength(lines.join('\n')))
    expect(await decodeFrame(frame.codec, frame.bytes)).toEqual(lines)
  })

  it('stores text when compression does not shrink the batch', async () => {
    const incompressible = [JSON.stringify({ text: randomBytes(64).toString('base64') })]
    const frame = encodeFrame(incompressible, 'zstd')
    expect(frame).toEqual({ codec: FRAME_CODEC_UTF8, bytes: Buffer.from(incompressible[0] ?? '', 'utf8'), count: 1 })
    expect(await decodeFrame(frame.codec, frame.bytes)).toEqual(incompressible)
  })

  it('stores text for every batch when compression is none', async () => {
    const frame = encodeFrame(lines, 'none')
    expect(frame).toEqual({ codec: FRAME_CODEC_UTF8, bytes: Buffer.from(lines.join('\n'), 'utf8'), count: lines.length })
    expect(await decodeFrame(frame.codec, frame.bytes)).toEqual(lines)
  })

  it('decodes a text frame from a view into a larger buffer', async () => {
    const frame = encodeFrame(lines, 'none')
    const padded = Buffer.concat([Buffer.from('padding'), frame.bytes, Buffer.from('padding')])
    expect(await decodeFrame(frame.codec, padded.subarray(7, 7 + frame.bytes.length))).toEqual(lines)
  })

  it('rejects an unknown codec and a corrupt compressed frame', async () => {
    await expect(decodeFrame(2, Buffer.from('x'))).rejects.toThrow(RangeError)
    await expect(decodeFrame(FRAME_CODEC_ZSTD, Buffer.from('not a zstd frame'))).rejects.toThrow()
  })
})

describe('plugin configuration', () => {
  it('validates the frame size with the JSONL fields and applies the defaults', () => {
    expect(plugin.Config({ root: 'r' })).toEqual({ root: 'r', compression: 'zstd', listConcurrency: 3, frameEvents: 64 })
    expect(plugin.Config({ root: 'r', compression: 'none', frameEvents: 1 })).toMatchObject({ compression: 'none', frameEvents: 1 })
    expect(() => plugin.Config({ root: 'r', frameEvents: 0 })).toThrow()
    expect(() => plugin.Config({ root: 'r', frameEvents: 1.5 })).toThrow()
  })

  it('stores frames by the mounted compression and frame size', async () => {
    const fixture = await persistenceFixture()
    const { persistence, context } = await fixture.mount('sqlite', 'none', 2)
    const writer = await persistence.create(header)
    await writer.append(events(5)); await writer.close()
    await context.fiber.dispose()
    const db = new DatabaseSync(join(fixture.root, '.segments', 'sessions.sqlite'))
    try {
      expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end, frame.codec]))
        .toEqual([[0, 2, 0], [2, 4, 0], [4, 5, 0]])
    } finally { db.close() }
  })

  it('applies the plugin defaults when constructed without frame settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-frame-defaults-'))
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    const provider = new SqliteSessionPersistence(ctx, ctx, { root }, {
      hasStoredJsonl: async () => false, list: async () => [], stat: async () => undefined,
      prepare: async () => { throw new Error('no legacy history') },
    })
    const writer = await provider.create(header)
    await writer.append(events(65))
    const db = new DatabaseSync(join(root, '.segments', 'sessions.sqlite'))
    try {
      expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end, frame.codec]))
        .toEqual([[0, 64, FRAME_CODEC_ZSTD], [64, 65, FRAME_CODEC_UTF8]])
      await writer.close()
      expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end, frame.codec]))
        .toEqual([[0, 64, FRAME_CODEC_ZSTD], [64, 65, FRAME_CODEC_ZSTD]])
    } finally { db.close() }
  })
})

describe('frame layout', () => {
  it('stores one frame per write up to the frame size and keeps earlier frames at their written size', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const writer = await logs.create(header)
    await writer.append(events(2))
    await writer.append(events(10, 2))
    await writer.append([event(12)])
    const db = inspect()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end]))
      .toEqual([[0, 2], [2, 6], [6, 10], [10, 12], [12, 13]])
    await writer.close()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end]))
      .toEqual([[0, 2], [2, 6], [6, 10], [10, 13]])
    expect((await logs.stat(id))?.eventCount).toBe(13)
    const reader = await logs.open(id, 'read')
    try { expect((await reader.read()).events).toEqual(events(13)) } finally { await reader.close() }
  })

  it('merges trailing short frames into full frames once they hold the frame size', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const writer = await logs.create(header)
    for (let seq = 0; seq < 3; seq++) await writer.append([event(seq)])
    let db = inspect()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end])).toEqual([[0, 1], [1, 2], [2, 3]])
    const payloadBytes = () => z.array(z.object({ bytes: z.number() })).parse(db.prepare(
      'SELECT length(payload) AS bytes FROM frames WHERE segment_uuid = ? ORDER BY start_seq').all(tailSegment(db, id))).map(row => row.bytes)
    const short = payloadBytes()
    await writer.append([event(3)])
    const merged = payloadBytes()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end, frame.codec])).toEqual([[0, 4, FRAME_CODEC_ZSTD]])
    // Four events compressed together take fewer bytes than the three one-event frames before the merge.
    expect(merged[0]).toBeLessThan(short.reduce((total, bytes) => total + bytes, 0))
    await writer.append([event(4)])
    await writer.append([event(5)])
    await writer.append(events(5, 6))
    await writer.close()
    db = inspect()
    // Closing seals the short frames that no append merged.
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end]))
      .toEqual([[0, 4], [4, 6], [6, 10], [10, 11]])
    expect(storedFrames(db, tailSegment(db, id))[0]?.texts).toEqual(events(4).map(entry => JSON.stringify(entry)))
    expect((await logs.stat(id))?.eventCount).toBe(11)
    const reader = await logs.open(id, 'read')
    try {
      expect((await reader.read()).events).toEqual(events(11))
      expect((await reader.read(3, 3)).events).toEqual(events(3, 3))
    } finally { await reader.close() }
  })

  it('merges a parent tail without changing the prefix a fork child shares', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const parent = await logs.create(header)
    for (let seq = 0; seq < 3; seq++) await parent.append([event(seq)])
    await parent.flush()
    const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(2), time: 0, data: { inherited: true } }
    const child = await logs.create({ ...header, id: SessionId('child'), isSeeded: true }, { inheritedEventCount: SessionLogOffset(2),
      parentSource: { sessionId: id, endSeq: SessionLogOffset(2), events: [event(0), event(1), marker] } })
    await parent.append(events(3, 3))
    await parent.close()
    const db = inspect()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end])).toEqual([[0, 4], [4, 6]])
    try { expect((await child.read()).events).toEqual([event(0), event(1), marker]) } finally { await child.close() }
  })

  it.each([
    { fault: 'undecodable', mutate: 'UPDATE frames SET codec = 1, payload = X\'00\' WHERE segment_uuid = ? AND start_seq = 1',
      error: { name: 'SessionPersistenceCorruptionError' } },
    { fault: 'invalid row', mutate: 'UPDATE frames SET end_seq = 0 WHERE segment_uuid = ? AND start_seq = 1',
      error: { name: 'SessionPersistenceCorruptionError' } },
    { fault: 'missing frame', mutate: 'DELETE FROM frames WHERE segment_uuid = ? AND start_seq = 1',
      error: { code: 'SESSION_STORAGE_CORRUPT', message: 'SQLite segment is incomplete' } },
    { fault: 'short frame', mutate: 'UPDATE frames SET end_seq = 3 WHERE segment_uuid = ? AND start_seq = 1',
      error: { code: 'SESSION_STORAGE_CORRUPT', message: 'SQLite frame does not match its recorded range' } },
  ] as const)('rejects an append whose merge finds a $fault and keeps the stored frames', async ({ fault, mutate, error }) => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const writer = await logs.create(header)
    onTestFinished(() => writer.close().catch((_error: unknown) => undefined))
    await writer.append([event(0)]); await writer.append([event(1)]); await writer.append([event(2)])
    const db = inspect()
    const segment = tailSegment(db, id)
    db.exec('PRAGMA ignore_check_constraints = ON; DROP TRIGGER frames_no_update')
    if (fault === 'short frame') db.prepare('DELETE FROM frames WHERE segment_uuid = ? AND start_seq = 2').run(segment)
    db.prepare(mutate).run(segment)
    const before = db.prepare('SELECT start_seq, end_seq FROM frames WHERE segment_uuid = ? ORDER BY start_seq').all(segment)
    await expect(writer.append([event(3), event(4), event(5)])).rejects.toMatchObject(error)
    expect(db.prepare('SELECT start_seq, end_seq FROM frames WHERE segment_uuid = ? ORDER BY start_seq').all(segment)).toEqual(before)
  })

  it('merges only the newest frames that reach a larger frame size', async () => {
    const before = await fixture({ frameEvents: 1 })
    const writer = await before.logs.create(header)
    for (let seq = 0; seq < 10; seq++) await writer.append([event(seq)])
    await writer.close(); await before.logs.close()
    const after = sqliteLogs(before.path, before.root, { frameEvents: 4 })
    onTestFinished(() => after.close())
    const reopened = await after.open(id, 'write')
    await reopened.append([event(10)])
    await reopened.close()
    const db = before.inspect()
    // The append merged the newest run; closing sealed the older short frames.
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end]))
      .toEqual([[0, 3], [3, 7], [7, 11]])
    const reader = await after.open(id, 'read')
    try { expect((await reader.read()).events).toEqual(events(11)) } finally { await reader.close() }
  })

  it('merges in a database created with the delete trigger', async () => {
    const before = await fixture({ frameEvents: 4 })
    const writer = await before.logs.create(header)
    for (let seq = 0; seq < 3; seq++) await writer.append([event(seq)])
    await writer.close(); await before.logs.close()
    const db = before.inspect()
    db.exec("CREATE TRIGGER frames_no_delete BEFORE DELETE ON frames BEGIN SELECT RAISE(ABORT, 'frames are append-only'); END")
    const after = sqliteLogs(before.path, before.root, { frameEvents: 4 })
    onTestFinished(() => after.close())
    const reopened = await after.open(id, 'write')
    await reopened.append([event(3)])
    await reopened.close()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end])).toEqual([[0, 4]])
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'frames_no_delete'").all()).toEqual([])
  })

  it('merges a fork child suffix in its own Segment and reads across the shared prefix', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4, compression: 'none' })
    const parent = await logs.create(header)
    await parent.append(events(3)); await parent.close()
    const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(2), time: 0, data: { inherited: true } }
    const childId = SessionId('child')
    const child = await logs.create({ ...header, id: childId, isSeeded: true }, { inheritedEventCount: SessionLogOffset(2),
      parentSource: { sessionId: id, endSeq: SessionLogOffset(2), events: [event(0), event(1), marker] } })
    for (let seq = 3; seq < 7; seq++) await child.append([event(seq)])
    await child.close()
    const db = inspect()
    const frames = storedFrames(db, tailSegment(db, childId))
    expect(frames.map(frame => [frame.start, frame.end, frame.codec])).toEqual([[0, 4, FRAME_CODEC_UTF8], [4, 5, FRAME_CODEC_UTF8]])
    const reader = await logs.open(childId, 'read')
    try { expect((await reader.read(1)).events).toEqual([event(1), marker, ...events(4, 3)]) } finally { await reader.close() }
  })

  it('accepts appends after a rejected merge once the frame is repaired', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const writer = await logs.create(header)
    onTestFinished(() => writer.close().catch((_error: unknown) => undefined))
    await writer.append([event(0)]); await writer.append([event(1)]); await writer.append([event(2)])
    const db = inspect()
    const segment = tailSegment(db, id)
    db.exec('DROP TRIGGER frames_no_update')
    // A short frame is stored as text; marking it compressed makes it undecodable.
    db.prepare('UPDATE frames SET codec = ? WHERE segment_uuid = ? AND start_seq = 1').run(FRAME_CODEC_ZSTD, segment)
    await expect(writer.append([event(3)])).rejects.toMatchObject({ name: 'SessionPersistenceCorruptionError' })
    db.prepare('UPDATE frames SET codec = ? WHERE segment_uuid = ? AND start_seq = 1').run(FRAME_CODEC_UTF8, segment)
    await writer.append([event(3)])
    expect(storedFrames(db, segment).map(frame => [frame.start, frame.end])).toEqual([[0, 4]])
  })

  it('keeps the short frames and accepts a retry when reinserting the merged frame fails', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const writer = await logs.create(header)
    onTestFinished(() => writer.close().catch((_error: unknown) => undefined))
    await writer.append([event(0)]); await writer.append([event(1)]); await writer.append([event(2)])
    const db = inspect()
    const segment = tailSegment(db, id)
    // Only the merged frame holds four events, so the failure follows the merge's DELETE.
    db.exec("CREATE TRIGGER fail_merge BEFORE INSERT ON frames WHEN NEW.end_seq - NEW.start_seq >= 4 BEGIN SELECT RAISE(ABORT, 'merge insert failed'); END")
    await expect(writer.append([event(3)])).rejects.toThrow('merge insert failed')
    expect(storedFrames(db, segment).map(frame => [frame.start, frame.end])).toEqual([[0, 1], [1, 2], [2, 3]])
    db.exec('DROP TRIGGER fail_merge')
    await writer.append([event(3)])
    expect(storedFrames(db, segment).map(frame => [frame.start, frame.end])).toEqual([[0, 4]])
    const reader = await logs.open(id, 'read')
    try { expect((await reader.read()).events).toEqual(events(4)) } finally { await reader.close() }
  })

  it.each([
    // Two stored events alone exceed the limit, so that run is skipped before decoding.
    { content: 'incompressible', text: (seq: number) => `${seq} ${randomBytes(2304 * 1024).toString('base64')}` },
    // Stored bytes are small; two decoded events exceed the limit.
    { content: 'compressible', text: (seq: number) => `${seq} ${'x'.repeat(2560 * 1024)}` },
  ])('keeps short frames above the merge byte limit ($content)', async ({ text }) => {
    const { logs, inspect } = await fixture({ frameEvents: 2 })
    const large = (seq: number): SessionEvent<'user/message'> => ({ type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq), time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: text(seq) }], source: { kind: 'user' } }) })
    const stored = [large(0), large(1), large(2)]
    const writer = await logs.create(header)
    for (const entry of stored) await writer.append([entry])
    for (let seq = 3; seq < 7; seq++) await writer.append([event(seq)])
    await writer.close()
    const db = inspect()
    // Runs holding two large events exceed the limit and stay short; one large event with small ones fits and merges.
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end])).toEqual([[0, 1], [1, 2], [2, 4], [4, 6], [6, 7]])
    const reader = await logs.open(id, 'read')
    try { expect((await reader.read()).events).toEqual([...stored, ...events(4, 3)]) } finally { await reader.close() }
  })

  it('merges frames written through live Session events and flushes', async () => {
    const storage = await persistenceFixture()
    const { context } = await storage.mount('sqlite', 'zstd', 4)
    const liveId = SessionId('live')
    await context.plugin({ name: 'live-writer', inject: ['sessionPersistence', 'sessions'],
      async apply(consumerCtx: Context) {
        const sessions = consumerCtx.sessions
        const live = sessions.prepare(liveId)
        consumerCtx.effect(function* () {
          yield sessions.enter(live)
          sessions.announce(live)
        })
        await consumerCtx.sessionPersistence.create(live.header)
        for (let turn = 1; turn <= 3; turn++) {
          live.append('turn/start', { turn })
          await sessions.flush(live)
          live.append('turn/end', { turn, reason: { kind: 'completed' } })
          await sessions.flush(live)
        }
      },
    })
    const db = new DatabaseSync(join(storage.root, '.segments', 'sessions.sqlite'))
    onTestFinished(() => { db.close() })
    const frames = storedFrames(db, tailSegment(db, liveId))
    expect(frames.map(frame => [frame.start, frame.end])).toEqual([[0, 4], [4, 5], [5, 6]])
    expect(frames[0]?.codec).toBe(FRAME_CODEC_ZSTD)
    const reader = await context.sessionPersistence.open(liveId, 'read')
    try {
      expect((await reader.read()).events.map(entry => entry.type))
        .toEqual(['turn/start', 'turn/end', 'turn/start', 'turn/end', 'turn/start', 'turn/end'])
    } finally { await reader.close() }
  })

  it('stores plain JSON lines when compression is none and compresses full frames by default', async () => {
    const plain = await fixture({ compression: 'none', frameEvents: 3 })
    const writer = await plain.logs.create(header)
    await writer.append(events(3)); await writer.close()
    const frames = storedFrames(plain.inspect(), tailSegment(plain.inspect(), id))
    expect(frames.map(frame => frame.codec)).toEqual([FRAME_CODEC_UTF8])
    expect(frames[0]?.texts).toEqual(events(3).map(entry => JSON.stringify(entry)))
    const compressed = await fixture({ frameEvents: 3 })
    const other = await compressed.logs.create(header)
    await other.append(events(3)); await other.close()
    expect(storedFrames(compressed.inspect(), tailSegment(compressed.inspect(), id)).map(frame => frame.codec)).toEqual([FRAME_CODEC_ZSTD])
  })

  // A user message whose JSON text is exactly `bytes` long, padded with `unit`.
  const sized = (seq: number, bytes: number, unit = 'x'): SessionEvent<'user/message'> => {
    const build = (text: string): SessionEvent<'user/message'> => ({ type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq), time: 0,
      data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) })
    const overhead = Buffer.byteLength(JSON.stringify(build('')))
    const room = bytes - overhead, width = Buffer.byteLength(unit)
    const result = build(unit.repeat(Math.floor(room / width)) + 'x'.repeat(room % width))
    expect(Buffer.byteLength(JSON.stringify(result))).toBe(bytes)
    return result
  }

  it.each([
    { name: 'one byte below the text limit', entry: () => sized(0, 64 * 1024 - 1), codec: FRAME_CODEC_UTF8 },
    { name: 'at the text limit', entry: () => sized(0, 64 * 1024), codec: FRAME_CODEC_ZSTD },
    { name: 'multibyte text at the byte limit', entry: () => sized(0, 64 * 1024, '中'), codec: FRAME_CODEC_ZSTD },
  ])('chooses the codec of a short frame by its JSON byte size ($name)', async ({ entry, codec }) => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const writer = await logs.create(header)
    onTestFinished(() => writer.close())
    await writer.append([entry()])
    const db = inspect()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => frame.codec)).toEqual([codec])
  })

  it('lowers the text limit so a run of short text frames fits one merge under a large frame size', async () => {
    // 2 MiB / 1024 events leaves 2 KiB per short frame.
    const { logs, inspect } = await fixture({ frameEvents: 1024 })
    const writer = await logs.create(header)
    onTestFinished(() => writer.close())
    await writer.append([sized(0, 2047)]); await writer.append([sized(1, 2048)])
    const db = inspect()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => frame.codec)).toEqual([FRAME_CODEC_UTF8, FRAME_CODEC_ZSTD])
  })

  it('stores the short remainder of a merge as text until the writer closes', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const writer = await logs.create(header)
    for (let seq = 0; seq < 3; seq++) await writer.append([event(seq)])
    await writer.append(events(3, 3))
    const db = inspect()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end, frame.codec]))
      .toEqual([[0, 4, FRAME_CODEC_ZSTD], [4, 6, FRAME_CODEC_UTF8]])
    await writer.close()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end, frame.codec]))
      .toEqual([[0, 4, FRAME_CODEC_ZSTD], [4, 6, FRAME_CODEC_ZSTD]])
    const reader = await logs.open(id, 'read')
    try { expect((await reader.read()).events).toEqual(events(6)) } finally { await reader.close() }
  })

  it('stores a short frame as text until a merge compresses it, unless the frame is large', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const large: SessionEvent<'user/message'> = { type: 'user/message', surfaceOp: 'append', seq: SessionSeq(2), time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: 'large '.repeat(12 * 1024) }], source: { kind: 'user' } }) }
    const writer = await logs.create(header)
    await writer.append(events(2))
    await writer.append([large])
    const db = inspect()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => frame.codec)).toEqual([FRAME_CODEC_UTF8, FRAME_CODEC_ZSTD])
    await writer.append([event(3)]); await writer.close()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end, frame.codec])).toEqual([[0, 4, FRAME_CODEC_ZSTD]])
    const reader = await logs.open(id, 'read')
    try { expect((await reader.read()).events).toEqual([...events(2), large, event(3)]) } finally { await reader.close() }
  })

  it('frames a fork child suffix and an imported history by the frame size', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 2 })
    const parent = await logs.create(header)
    await parent.append(events(2)); await parent.close()
    const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(1), time: 0, data: { inherited: true } }
    const child = await logs.create({ ...header, id: SessionId('child'), isSeeded: true }, { inheritedEventCount: SessionLogOffset(1),
      parentSource: { sessionId: id, endSeq: SessionLogOffset(1), events: [event(0), marker, event(2), event(3)] } })
    await child.close()
    await logs.importLegacy({ ...header, id: SessionId('imported') }, SessionLogOffset(0), events(5))
    const db = inspect()
    expect(storedFrames(db, tailSegment(db, SessionId('child'))).map(frame => [frame.start, frame.end, frame.codec]))
      .toEqual([[0, 2, FRAME_CODEC_ZSTD], [2, 3, FRAME_CODEC_ZSTD]])
    // An import compresses its short final frame: no later append merges it.
    expect(storedFrames(db, tailSegment(db, SessionId('imported'))).map(frame => [frame.start, frame.end, frame.codec]))
      .toEqual([[0, 2, FRAME_CODEC_ZSTD], [2, 4, FRAME_CODEC_ZSTD], [4, 5, FRAME_CODEC_ZSTD]])
    const reader = await logs.open(SessionId('child'), 'read')
    try { expect((await reader.read()).events).toEqual([event(0), marker, event(2), event(3)]) } finally { await reader.close() }
  })
})

describe('sealing on writer close', () => {
  const layout = (db: DatabaseSync, session = id) =>
    storedFrames(db, tailSegment(db, session)).map(frame => [frame.start, frame.end, frame.codec])

  it('compresses a Session that never gathers the frame size in short frames', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const writer = await logs.create(header)
    for (let seq = 0; seq < 3; seq++) await writer.append([event(seq)])
    const db = inspect()
    expect(layout(db)).toEqual([[0, 1, FRAME_CODEC_UTF8], [1, 2, FRAME_CODEC_UTF8], [2, 3, FRAME_CODEC_UTF8]])
    await writer.close()
    expect(layout(db)).toEqual([[0, 3, FRAME_CODEC_ZSTD]])
    const reader = await logs.open(id, 'read')
    try { expect((await reader.read()).events).toEqual(events(3)) } finally { await reader.close() }
  })

  it('seals short frames that a full batch follows and the short remainder after it', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const writer = await logs.create(header)
    await writer.append([event(0)]); await writer.append(events(2, 1)); await writer.append(events(6, 3))
    const db = inspect()
    expect(layout(db)).toEqual([[0, 1, FRAME_CODEC_UTF8], [1, 3, FRAME_CODEC_UTF8], [3, 7, FRAME_CODEC_ZSTD], [7, 9, FRAME_CODEC_UTF8]])
    await writer.close()
    expect(layout(db)).toEqual([[0, 3, FRAME_CODEC_ZSTD], [3, 7, FRAME_CODEC_ZSTD], [7, 9, FRAME_CODEC_ZSTD]])
    const reader = await logs.open(id, 'read')
    try {
      expect((await reader.read()).events).toEqual(events(9))
      expect((await reader.read(2, 6)).events).toEqual(events(6, 2))
    } finally { await reader.close() }
  })

  it('joins adjacent short frames as text when compression is none', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4, compression: 'none' })
    const writer = await logs.create(header)
    await writer.append([event(0)]); await writer.append([event(1)]); await writer.append(events(4, 2)); await writer.append([event(6)])
    await writer.close()
    expect(layout(inspect())).toEqual([[0, 2, FRAME_CODEC_UTF8], [2, 6, FRAME_CODEC_UTF8], [6, 7, FRAME_CODEC_UTF8]])
  })

  it('leaves a reader, an unmaterialized writer and a compressed short frame unchanged', async () => {
    const { logs, inspect } = await fixture({ frameEvents: 4 })
    const unused = await logs.create({ ...header, id: SessionId('unused') })
    await unused.close()
    expect(await logs.stat(SessionId('unused'))).toBeUndefined()
    const writer = await logs.create(header)
    await writer.append([event(0)]); await writer.close()
    const db = inspect()
    const sealed = layout(db)
    expect(sealed).toEqual([[0, 1, FRAME_CODEC_ZSTD]])
    const reopened = await logs.open(id, 'write')
    await reopened.close()
    const reader = await logs.open(id, 'read')
    await reader.close()
    expect(layout(db)).toEqual(sealed)
  })

  it('reports a seal failure and still releases the writer', async () => {
    const reports: unknown[] = []
    const { logs, inspect } = await fixture({ frameEvents: 4, report: (_session, error) => { reports.push(error) } })
    const writer = await logs.create(header)
    await writer.append([event(0)]); await writer.append([event(1)])
    const db = inspect()
    db.exec('DROP TRIGGER frames_no_update')
    // A short frame is stored as text; marking it compressed makes it undecodable.
    db.prepare('UPDATE frames SET codec = ? WHERE segment_uuid = ? AND start_seq = 1').run(FRAME_CODEC_ZSTD, tailSegment(db, id))
    await writer.close()
    expect(reports).toEqual([expect.any(SessionPersistenceCorruptionError)])
    expect(db.prepare('SELECT start_seq, end_seq FROM frames ORDER BY start_seq').all().map(row => [row['start_seq'], row['end_seq']]))
      .toEqual([[0, 1], [1, 2]])
    const reopened = await logs.open(id, 'write').catch((error: unknown) => error)
    expect(reopened).toBeInstanceOf(SessionPersistenceCorruptionError)
  })

  it('reports a frame with an invalid stored range before sealing', async () => {
    const reports: unknown[] = []
    const { logs, inspect } = await fixture({ frameEvents: 4, report: (_session, error) => { reports.push(error) } })
    const writer = await logs.create(header)
    await writer.append([event(0)]); await writer.append([event(1)])
    const db = inspect()
    db.exec('PRAGMA ignore_check_constraints = ON; DROP TRIGGER frames_no_update')
    db.prepare('UPDATE frames SET start_seq = -1 WHERE segment_uuid = ? AND start_seq = 0').run(tailSegment(db, id))
    await writer.close()
    expect(reports).toHaveLength(1)
    expect(String(reports[0])).toContain('stored SQLite frame is invalid')
  })
})

describe('sliced reads', () => {
  it('returns exactly the requested slice from the frames it overlaps', async () => {
    const { logs } = await fixture({ frameEvents: 4 })
    const writer = await logs.create(header)
    await writer.append(events(11)); await writer.close()
    const reader = await logs.open(id, 'read')
    try {
      expect((await reader.read(0, 1)).events).toEqual([event(0)])
      expect((await reader.read(3, 2)).events).toEqual([event(3), event(4)])
      expect((await reader.read(1, 8)).events).toEqual(events(8, 1))
      expect((await reader.read(10)).events).toEqual([event(10)])
      expect((await reader.read(11)).events).toEqual([])
      expect((await reader.read(5, 0)).events).toEqual([])
    } finally { await reader.close() }
  })

  it('reads a slice spanning a shared parent frame and the child suffix', async () => {
    const { logs } = await fixture({ frameEvents: 4 })
    const parent = await logs.create(header)
    await parent.append(events(6)); await parent.close()
    const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(5), time: 0, data: { inherited: true } }
    const child = await logs.create({ ...header, id: SessionId('child'), isSeeded: true }, { inheritedEventCount: SessionLogOffset(5),
      parentSource: { sessionId: id, endSeq: SessionLogOffset(5), events: [...events(5), marker, event(6)] } })
    try {
      expect((await child.read(3, 3)).events).toEqual([event(3), event(4), marker])
      expect((await child.read(4)).events).toEqual([event(4), marker, event(6)])
    } finally { await child.close() }
  })

  it('decodes many frames in groups and yields between them', async () => {
    const { logs } = await fixture({ frameEvents: 1 })
    const writer = await logs.create(header)
    await writer.append(events(20)); await writer.close()
    let yields = 0, running = true
    const tick = () => { if (!running) return; yields++; setImmediate(tick) }
    const reader = await logs.open(id, 'read')
    try {
      setImmediate(tick)
      expect((await reader.read()).events).toEqual(events(20))
    } finally { running = false; await reader.close() }
    expect(yields).toBeGreaterThan(0)
  })
})

describe('frame corruption', () => {
  async function corrupted(mutate: (db: DatabaseSync, segment: string) => void) {
    const { logs, inspect } = await fixture({ frameEvents: 2 })
    const writer = await logs.create(header)
    await writer.append(events(5)); await writer.close()
    const db = inspect()
    db.exec('PRAGMA ignore_check_constraints = ON; DROP TRIGGER frames_no_update')
    mutate(db, tailSegment(db, id))
    const reader = await logs.open(id, 'read')
    onTestFinished(() => reader.close())
    return reader
  }

  it('refuses a missing frame between stored frames', async () => {
    const reader = await corrupted((db, segment) => { db.prepare('DELETE FROM frames WHERE segment_uuid = ? AND start_seq = 2').run(segment) })
    await expect(reader.read()).rejects.toMatchObject({ code: 'SESSION_STORAGE_CORRUPT', message: 'SQLite segment is incomplete' })
    await expect(reader.read(0, 2)).resolves.toMatchObject({ events: [event(0), event(1)] })
    await expect(reader.read(4)).resolves.toMatchObject({ events: [event(4)] })
  })

  it('refuses a frame holding fewer events than its recorded range', async () => {
    const reader = await corrupted((db, segment) => { db.prepare('UPDATE frames SET end_seq = 6 WHERE segment_uuid = ? AND start_seq = 4').run(segment) })
    await expect(reader.read(2, 2)).resolves.toMatchObject({ events: [event(2), event(3)] })
    await expect(reader.read()).rejects
      .toMatchObject({ code: 'SESSION_STORAGE_CORRUPT', message: 'SQLite frame is shorter than its recorded range' })
  })

  it('refuses an unknown frame codec', async () => {
    const reader = await corrupted((db, segment) => { db.prepare('UPDATE frames SET codec = 7 WHERE segment_uuid = ? AND start_seq = 2').run(segment) })
    const failure = await reader.read().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionPersistenceCorruptionError)
    if (!(failure instanceof SessionPersistenceCorruptionError)) throw new Error('expected a corruption refusal')
    expect(failure.message).toContain('cannot be decoded')
    expect(failure.cause).toBeInstanceOf(RangeError)
  })

  it('refuses a compressed frame whose bytes are damaged', async () => {
    const reader = await corrupted((db, segment) => {
      db.prepare('UPDATE frames SET codec = ?, payload = ? WHERE segment_uuid = ? AND start_seq = 2').run(FRAME_CODEC_ZSTD, Buffer.from('damaged'), segment)
    })
    await expect(reader.read()).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  })

  it('refuses a compressed frame whose decoded lines are not events', async () => {
    const reader = await corrupted((db, segment) => {
      db.prepare('UPDATE frames SET codec = ?, payload = ? WHERE segment_uuid = ? AND start_seq = 2').run(FRAME_CODEC_ZSTD, zstdCompressSync(Buffer.from('{}\nnot json')), segment)
    })
    const failure = await reader.read().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionPersistenceCorruptionError)
    if (!(failure instanceof SessionPersistenceCorruptionError)) throw new Error('expected a corruption refusal')
    expect(failure.message).toContain('stored event at index 2 is invalid')
  })

  it('refuses a frame whose stored range is invalid', async () => {
    const reader = await corrupted((db, segment) => { db.prepare('UPDATE frames SET start_seq = -1 WHERE segment_uuid = ? AND start_seq = 0').run(segment) })
    await expect(reader.read(0, 1)).rejects.toThrow('stored SQLite frame is invalid')
  })
})

it('appends an empty batch without storing a frame', async () => {
  const { logs, inspect } = await fixture()
  const writer = await logs.create(header)
  await writer.append([]); await writer.append(events(1)); await writer.append([])
  await writer.close()
  const db = inspect()
  expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end])).toEqual([[0, 1]])
})
