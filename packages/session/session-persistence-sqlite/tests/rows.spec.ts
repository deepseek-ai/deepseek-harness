/** Event row encoding, physical row layout, sliced reads across rows, and row corruption refusals. @module */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import * as plugin from '../src/index.ts'
import { SqliteSessionPersistence } from '../src/persistence.ts'
import { EVENT_CODEC_JSON, EVENT_CODEC_ZSTD, decodeRow, encodeRow, eventRow } from '../src/row.ts'
import type { EventRow } from '../src/row.ts'
import type { SqliteStoreOptions } from '../src/sqlite.ts'
import { persistenceFixture } from './fixtures/persistence.ts'
import { headSegment, sqliteLogs, storedRows } from './fixtures/store.ts'

// Every real compression of JSON text shrinks it, so the fallback to text is reached by substituting one result.
vi.mock('node:zlib', async (original) => {
  const actual = await original<typeof import('node:zlib')>()
  return { ...actual, zstdCompressSync: vi.fn(actual.zstdCompressSync) }
})

const id = SessionId('rows')
const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }
// Deterministic per sequence, so stored events compare equal to freshly built ones.
const built = new Map<string, SessionEvent<'user/message'>>()
const message = (seq: number, repeat: number): SessionEvent<'user/message'> => {
  const key = `${seq}:${repeat}`
  let entry = built.get(key)
  if (entry === undefined) {
    entry = { type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq), time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: `event ${seq} ${'payload '.repeat(repeat)}` }], source: { kind: 'user' } }) }
    built.set(key, entry)
  }
  return entry
}
/** An event whose JSON value stays below the compression threshold. */
const event = (seq: number): SessionEvent<'user/message'> => message(seq, 16)
/** An event whose JSON value exceeds the compression threshold and shrinks. */
const large = (seq: number): SessionEvent<'user/message'> => message(seq, 400)
const events = (count: number, from = 0): SessionEvent[] => Array.from({ length: count }, (_, index) => event(from + index))
/** A title event whose `data` JSON text has exactly `length` characters. */
const sized = (length: number): SessionEvent<'session/title'> => {
  const data = (title: string) => ({ title, messageSeqs: [], source: { kind: 'user' as const } })
  return { type: 'session/title', seq: SessionSeq(0), time: 0, data: data('t'.repeat(length - JSON.stringify(data('')).length)) }
}

async function fixture(overrides: Partial<SqliteStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-rows-')), path = join(root, 'sessions.sqlite')
  const logs = sqliteLogs(path, root, overrides)
  onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const inspect = (): DatabaseSync => {
    const db = new DatabaseSync(path)
    onTestFinished(() => { db.close() })
    return db
  }
  return { root, path, logs, inspect }
}

describe('row codec', () => {
  it('stores a short value as its JSON text and decodes it back to the event', () => {
    const row = encodeRow(event(3), 'zstd')
    expect(row).toEqual({ seq: 3, type: 'user/message', time: 0, surface_op: 'append', source_seqs: null, ignorable: null,
      codec: EVENT_CODEC_JSON, data: JSON.stringify(event(3).data) })
    expect(decodeRow(row)).toEqual(event(3))
  })

  it('compresses a value from 1024 characters and keeps a shorter one as text', () => {
    expect(JSON.stringify(sized(1023).data)).toHaveLength(1023)
    expect(encodeRow(sized(1023), 'zstd')).toMatchObject({ codec: EVENT_CODEC_JSON, data: JSON.stringify(sized(1023).data) })
    const row = encodeRow(sized(1024), 'zstd')
    expect(row.codec).toBe(EVENT_CODEC_ZSTD)
    expect(row.data).toBeInstanceOf(Uint8Array)
    expect(row.data.length).toBeLessThan(1024)
    expect(decodeRow(row)).toEqual(sized(1024))
  })

  it('stores text when compression does not shrink the value', () => {
    const text = JSON.stringify(large(0).data)
    vi.mocked(zstdCompressSync).mockReturnValueOnce(Buffer.alloc(Buffer.byteLength(text)))
    const row = encodeRow(large(0), 'zstd')
    expect(row).toMatchObject({ codec: EVENT_CODEC_JSON, data: text })
    expect(decodeRow(row)).toEqual(large(0))
  })

  it('stores text for every value when compression is none', () => {
    const row = encodeRow(large(0), 'none')
    expect(row).toMatchObject({ codec: EVENT_CODEC_JSON, data: JSON.stringify(large(0).data) })
    expect(decodeRow(row)).toEqual(large(0))
  })

  it('decodes a compressed value from a view into a larger buffer', () => {
    const row = encodeRow(large(0), 'zstd')
    if (typeof row.data === 'string') throw new Error('expected a compressed value')
    const padded = Buffer.concat([Buffer.from('padding'), row.data, Buffer.from('padding')])
    expect(decodeRow({ ...row, data: padded.subarray(7, 7 + row.data.length) })).toEqual(large(0))
  })

  it('stores the optional envelope members as columns and restores only the stored ones', () => {
    const replace: SessionEvent<'user/message'> = { ...event(4), surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(3) },
      sourceEventSeqs: [SessionSeq(1), SessionSeq(2)], ignorable: true }
    const row = encodeRow(replace, 'zstd')
    expect(row).toMatchObject({ surface_op: '{"op":"replace","startSeq":1,"endSeq":3}', source_seqs: '[1,2]', ignorable: 1 })
    expect(decodeRow(row)).toEqual(replace)
    const bare: SessionEvent<'turn/start'> = { type: 'turn/start', seq: SessionSeq(0), time: 5, data: { turn: 1 } }
    const plain = encodeRow(bare, 'zstd')
    expect(plain).toMatchObject({ surface_op: null, source_seqs: null, ignorable: null })
    expect(Object.keys(decoded(decodeRow(plain))).sort()).toEqual(['data', 'seq', 'time', 'type'])
  })

  it('refuses an unknown codec and a value whose storage class contradicts its codec', () => {
    const row = encodeRow(event(0), 'none'), compressed = encodeRow(large(0), 'zstd')
    expect(() => decodeRow({ ...compressed, codec: 2 })).toThrow(new RangeError('SQLite event codec 2 does not match its stored bytes'))
    expect(() => decodeRow({ ...row, codec: EVENT_CODEC_ZSTD })).toThrow(new RangeError('SQLite event codec 1 does not match its stored text'))
    expect(() => decodeRow({ ...compressed, codec: EVENT_CODEC_JSON })).toThrow(RangeError)
  })

  it('refuses damaged compressed bytes and malformed JSON in any column', () => {
    const row = encodeRow(event(0), 'none')
    expect(() => decodeRow({ ...row, codec: EVENT_CODEC_ZSTD, data: Buffer.from('not a zstd frame') })).toThrow()
    expect(() => decodeRow({ ...row, data: '{' })).toThrow(SyntaxError)
    expect(() => decodeRow({ ...row, surface_op: '{' })).toThrow(SyntaxError)
    expect(() => decodeRow({ ...row, source_seqs: '[' })).toThrow(SyntaxError)
  })

  it('validates selected columns before decoding', () => {
    const row: EventRow = encodeRow(event(0), 'none')
    expect(eventRow.parse(row)).toEqual(row)
    for (const damaged of [{ seq: -1 }, { ignorable: 0 }, { data: 7 }, { codec: 0.5 }, { type: null }]) {
      expect(eventRow.safeParse({ ...row, ...damaged }).success).toBe(false)
    }
  })
})

/** Narrow a decoded row to an object for key inspection. */
function decoded(value: unknown): object {
  if (typeof value !== 'object' || value === null) throw new Error('expected a decoded event object')
  return value
}

describe('plugin configuration', () => {
  it('applies the defaults and validates the storage root, compression, list concurrency and recovery', () => {
    expect(plugin.Config({ root: 'r' })).toEqual({ root: 'r', compression: 'zstd', listConcurrency: 3, recovery: 'replace', coldAfterDays: 30 })
    expect(plugin.Config({ root: 'r', compression: 'none', listConcurrency: 1, recovery: 'report' }))
      .toEqual({ root: 'r', compression: 'none', listConcurrency: 1, recovery: 'report', coldAfterDays: 30 })
    expect(() => plugin.Config({ compression: 'none' } as never)).toThrow()
    expect(() => plugin.Config({ root: 'r', compression: 'gzip' } as never)).toThrow()
    expect(() => plugin.Config({ root: 'r', listConcurrency: 0 })).toThrow()
    expect(() => plugin.Config({ root: 'r', recovery: 'ignore' } as never)).toThrow()
  })

  it('stores rows by the mounted compression', async () => {
    const fixture = await persistenceFixture()
    const { persistence, context } = await fixture.mount('sqlite', 'none')
    const writer = await persistence.create(header)
    await writer.append([event(0), large(1)]); await writer.close()
    await context.fiber.dispose()
    const db = new DatabaseSync(join(fixture.root, '.segments', 'sessions.sqlite'))
    try {
      expect(storedRows(db, headSegment(db, id)).map(row => [row.seq, row.codec])).toEqual([[0, EVENT_CODEC_JSON], [1, EVENT_CODEC_JSON]])
    } finally { db.close() }
  })

  it('compresses large values and keeps the built-in derived tables when constructed without a compression setting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-row-defaults-'))
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    const provider = new SqliteSessionPersistence(ctx, ctx, { root }, {
      hasStoredJsonl: async () => false, list: async () => [], stat: async () => undefined,
      prepare: async () => { throw new Error('no legacy history') },
    })
    const writer = await provider.create(header)
    await writer.append([event(0), large(1)]); await writer.close()
    const db = new DatabaseSync(join(root, '.segments', 'sessions.sqlite'))
    try {
      expect(storedRows(db, headSegment(db, id)).map(row => [row.seq, row.codec])).toEqual([[0, EVENT_CODEC_JSON], [1, EVENT_CODEC_ZSTD]])
      expect(db.prepare('SELECT name FROM derivations ORDER BY name').all().map(row => row.name))
        .toEqual(['compactions', 'llm_calls', 'tool_calls', 'tool_results'])
    } finally { db.close() }
  })
})

describe('row layout', () => {
  it('stores one row per event at its Session sequence across writes', async () => {
    const { logs, inspect } = await fixture()
    const writer = await logs.create(header)
    await writer.append(events(2))
    await writer.append(events(10, 2))
    await writer.append([event(12)])
    await writer.close()
    const db = inspect()
    expect(storedRows(db, headSegment(db, id)).map(row => row.seq)).toEqual(Array.from({ length: 13 }, (_, seq) => seq))
    expect((await logs.stat(id))?.eventCount).toBe(13)
    const reader = await logs.open(id, 'read')
    try { expect((await reader.read()).events).toEqual(events(13)) } finally { await reader.close() }
  })

  it('selects the codec of each row by its own value', async () => {
    const mixed = [event(0), large(1), event(2)]
    const compressed = await fixture()
    const writer = await compressed.logs.create(header)
    await writer.append(mixed); await writer.close()
    const db = compressed.inspect()
    expect(storedRows(db, headSegment(db, id)).map(row => row.codec)).toEqual([EVENT_CODEC_JSON, EVENT_CODEC_ZSTD, EVENT_CODEC_JSON])
    expect(db.prepare('SELECT seq, typeof(data) AS stored FROM events ORDER BY seq').all())
      .toEqual([{ seq: 0, stored: 'text' }, { seq: 1, stored: 'blob' }, { seq: 2, stored: 'text' }])
    const reader = await compressed.logs.open(id, 'read')
    try { expect((await reader.read()).events).toEqual(mixed) } finally { await reader.close() }
    const plain = await fixture({ compression: 'none' })
    const other = await plain.logs.create(header)
    await other.append(mixed); await other.close()
    expect(plain.inspect().prepare('SELECT data FROM events ORDER BY seq').all().map(row => row.data))
      .toEqual(mixed.map(entry => JSON.stringify(entry.data)))
  })

  it('exposes the envelope columns and short values to SQL', async () => {
    const { logs, inspect } = await fixture()
    const writer = await logs.create(header)
    await writer.append([
      { type: 'turn/start', seq: SessionSeq(0), time: 7, data: { turn: 1 } },
      { ...event(1), ignorable: true, sourceEventSeqs: [SessionSeq(0)] },
    ])
    await writer.close()
    expect(inspect().prepare("SELECT seq, type, time, surface_op, source_seqs, ignorable, data ->> '$.turn' AS turn FROM events ORDER BY seq").all()).toEqual([
      { seq: 0, type: 'turn/start', time: 7, surface_op: null, source_seqs: null, ignorable: null, turn: 1 },
      { seq: 1, type: 'user/message', time: 0, surface_op: 'append', source_seqs: '[0]', ignorable: 1, turn: null },
    ])
  })

  it('stores a fork child suffix from its base sequence and an imported history from zero', async () => {
    const { logs, inspect } = await fixture()
    const parent = await logs.create(header)
    await parent.append(events(2)); await parent.close()
    const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(1), time: 0, data: { inherited: true } }
    const child = await logs.create({ ...header, id: SessionId('child'), isSeeded: true }, { inheritedEventCount: SessionLogOffset(1),
      parentSource: { sessionId: id, endSeq: SessionLogOffset(1), events: [event(0), marker, event(2), event(3)] } })
    await child.close()
    await logs.importLegacy({ ...header, id: SessionId('imported') }, SessionLogOffset(0), events(5))
    const db = inspect()
    expect(storedRows(db, headSegment(db, SessionId('child'))).map(row => row.seq)).toEqual([1, 2, 3])
    expect(storedRows(db, headSegment(db, SessionId('imported'))).map(row => row.seq)).toEqual([0, 1, 2, 3, 4])
    const reader = await logs.open(SessionId('child'), 'read')
    try { expect((await reader.read()).events).toEqual([event(0), marker, event(2), event(3)]) } finally { await reader.close() }
  })
})

describe('sliced reads', () => {
  it('returns exactly the requested slice', async () => {
    const { logs } = await fixture()
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

  it('reads a slice spanning shared parent rows and the child suffix', async () => {
    const { logs } = await fixture()
    const parent = await logs.create(header)
    await parent.append(events(6)); await parent.close()
    const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(5), time: 0, data: { inherited: true } }
    const child = await logs.create({ ...header, id: SessionId('child'), isSeeded: true }, { inheritedEventCount: SessionLogOffset(5),
      parentSource: { sessionId: id, endSeq: SessionLogOffset(5), events: [...events(5), marker, event(6)] } })
    try {
      expect((await child.read(3, 3)).events).toEqual([event(3), event(4), marker])
      expect((await child.read(4)).events).toEqual([event(4), marker, event(6)])
      expect((await child.read(6)).events).toEqual([event(6)])
    } finally { await child.close() }
  })

  it('decodes a long history in groups and yields between them', async () => {
    const { logs } = await fixture()
    const writer = await logs.create(header)
    await writer.append(events(600)); await writer.close()
    let yields = 0, running = true
    const tick = () => { if (!running) return; yields++; setImmediate(tick) }
    const reader = await logs.open(id, 'read')
    try {
      setImmediate(tick)
      expect((await reader.read()).events).toEqual(events(600))
    } finally { running = false; await reader.close() }
    expect(yields).toBeGreaterThan(0)
  })
})

describe('row corruption', () => {
  async function corrupted(mutate: (db: DatabaseSync, segment: number) => void) {
    const { logs, inspect } = await fixture()
    const writer = await logs.create(header)
    await writer.append(events(5)); await writer.close()
    const db = inspect()
    db.exec('PRAGMA ignore_check_constraints = ON; DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete')
    mutate(db, headSegment(db, id))
    const reader = await logs.open(id, 'read')
    onTestFinished(() => reader.close())
    return reader
  }
  async function refusal(reader: Awaited<ReturnType<typeof corrupted>>): Promise<SessionPersistenceCorruptionError> {
    const failure = await reader.read().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionPersistenceCorruptionError)
    if (!(failure instanceof SessionPersistenceCorruptionError)) throw new Error('expected a corruption refusal')
    return failure
  }

  it('refuses a missing row between stored rows', async () => {
    const reader = await corrupted((db, segment) => { db.prepare('DELETE FROM events WHERE segment_id = ? AND seq = 2').run(segment) })
    await expect(reader.read()).rejects.toMatchObject({ code: 'SESSION_STORAGE_CORRUPT', message: 'SQLite segment is incomplete' })
    await expect(reader.read(1, 3)).rejects.toMatchObject({ code: 'SESSION_STORAGE_CORRUPT', message: 'SQLite segment is incomplete' })
    await expect(reader.read(0, 2)).resolves.toMatchObject({ events: [event(0), event(1)] })
    await expect(reader.read(3)).resolves.toMatchObject({ events: [event(3), event(4)] })
  })

  it('refuses an unknown row codec', async () => {
    const reader = await corrupted((db, segment) => { db.prepare('UPDATE events SET codec = 7 WHERE segment_id = ? AND seq = 2').run(segment) })
    const failure = await refusal(reader)
    expect(failure.message).toContain('stored event at index 2 is invalid')
    expect(failure.cause).toBeInstanceOf(RangeError)
    await expect(reader.read(0, 2)).resolves.toMatchObject({ events: [event(0), event(1)] })
  })

  it('refuses a text value recorded as compressed', async () => {
    const reader = await corrupted((db, segment) => { db.prepare('UPDATE events SET codec = 1 WHERE segment_id = ? AND seq = 2').run(segment) })
    expect((await refusal(reader)).cause).toBeInstanceOf(RangeError)
  })

  it('refuses a compressed value whose bytes are damaged', async () => {
    const reader = await corrupted((db, segment) => {
      db.prepare('UPDATE events SET codec = ?, data = ? WHERE segment_id = ? AND seq = 2').run(EVENT_CODEC_ZSTD, Buffer.from('damaged'), segment)
    })
    expect((await refusal(reader)).message).toContain('stored event at index 2 is invalid')
  })

  it('refuses a compressed value that does not decode to JSON', async () => {
    const reader = await corrupted((db, segment) => {
      db.prepare('UPDATE events SET codec = ?, data = ? WHERE segment_id = ? AND seq = 2').run(EVENT_CODEC_ZSTD, zstdCompressSync(Buffer.from('not json')), segment)
    })
    const failure = await refusal(reader)
    expect(failure.message).toContain('stored event at index 2 is invalid')
    expect(failure.cause).toBeInstanceOf(SyntaxError)
  })

  it('refuses a row whose columns do not form an event envelope', async () => {
    const reader = await corrupted((db, segment) => {
      db.prepare('UPDATE events SET surface_op = ? WHERE segment_id = ? AND seq = 2').run('{"op":"rewrite"}', segment)
    })
    expect((await refusal(reader)).message).toContain('stored event at index 2 is invalid')
  })

  it('refuses a row whose stored columns are invalid', async () => {
    const reader = await corrupted((db, segment) => { db.prepare('UPDATE events SET ignorable = 2 WHERE segment_id = ? AND seq = 0').run(segment) })
    await expect(reader.read(0, 1)).rejects.toThrow('stored SQLite event row is invalid')
  })
})

it('appends an empty batch without storing a row', async () => {
  const { logs, inspect } = await fixture()
  const writer = await logs.create(header)
  await writer.append([]); await writer.append(events(1)); await writer.append([])
  await writer.close()
  const db = inspect()
  expect(storedRows(db, headSegment(db, id)).map(row => row.seq)).toEqual([0])
})

it('refuses to update or delete a stored event row', async () => {
  const { logs, inspect } = await fixture()
  const writer = await logs.create(header)
  await writer.append(events(1)); await writer.close()
  const db = inspect()
  expect(() => { db.exec('UPDATE events SET time = 1') }).toThrow('events are append-only')
  expect(() => { db.exec('DELETE FROM events') }).toThrow('events are append-only')
})
