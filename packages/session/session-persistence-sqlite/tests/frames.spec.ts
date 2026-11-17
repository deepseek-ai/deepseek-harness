/** Frame encoding, physical frame layout, sliced reads across frames, and frame corruption refusals. @module */
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it, onTestFinished } from 'vitest'
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
    await writer.append(events(65)); await writer.close()
    const db = new DatabaseSync(join(root, '.segments', 'sessions.sqlite'))
    try {
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
    await writer.close()
    const db = inspect()
    expect(storedFrames(db, tailSegment(db, id)).map(frame => [frame.start, frame.end]))
      .toEqual([[0, 2], [2, 6], [6, 10], [10, 12], [12, 13]])
    expect((await logs.stat(id))?.eventCount).toBe(13)
    const reader = await logs.open(id, 'read')
    try { expect((await reader.read()).events).toEqual(events(13)) } finally { await reader.close() }
  })

  it('stores plain JSON lines when compression is none and compressed frames by default', async () => {
    const plain = await fixture({ compression: 'none' })
    const writer = await plain.logs.create(header)
    await writer.append(events(3)); await writer.close()
    const frames = storedFrames(plain.inspect(), tailSegment(plain.inspect(), id))
    expect(frames.map(frame => frame.codec)).toEqual([FRAME_CODEC_UTF8])
    expect(frames[0]?.texts).toEqual(events(3).map(entry => JSON.stringify(entry)))
    const compressed = await fixture()
    const other = await compressed.logs.create(header)
    await other.append(events(3)); await other.close()
    expect(storedFrames(compressed.inspect(), tailSegment(compressed.inspect(), id)).map(frame => frame.codec)).toEqual([FRAME_CODEC_ZSTD])
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
    expect(storedFrames(db, tailSegment(db, SessionId('child'))).map(frame => [frame.start, frame.end])).toEqual([[0, 2], [2, 3]])
    expect(storedFrames(db, tailSegment(db, SessionId('imported'))).map(frame => [frame.start, frame.end])).toEqual([[0, 2], [2, 4], [4, 5]])
    const reader = await logs.open(SessionId('child'), 'read')
    try { expect((await reader.read()).events).toEqual([event(0), marker, event(2), event(3)]) } finally { await reader.close() }
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
    db.exec('PRAGMA ignore_check_constraints = ON; DROP TRIGGER frames_no_update; DROP TRIGGER frames_no_delete')
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
