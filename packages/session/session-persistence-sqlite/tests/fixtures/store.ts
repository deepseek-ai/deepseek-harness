/** SQLite store fixtures and observations of durable frame rows. @module */
import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SqliteStore } from '../../src/sqlite.ts'
import type { SqliteStoreOptions } from '../../src/sqlite.ts'
import { FRAME_CODEC_ZSTD, encodeFrame } from '../../src/frame.ts'
import type { FrameCompression } from '../../src/frame.ts'
import { SessionWriteLease } from '../../src/lease.ts'
import { sessionDir } from '../../src/paths.ts'

/** Plugin defaults for the frame encoding of a directly constructed store. */
export const FRAME_DEFAULTS = { compression: 'zstd', frameEvents: 64 } as const satisfies Partial<SqliteStoreOptions>

/**
 * Construct a store with the plugin defaults and no-op provider callbacks.
 * @param path - database path.
 * @param root - legacy root holding lock directories and routing records.
 * @param overrides - option replacements for the test.
 * @returns an unopened store.
 */
export function sqliteLogs(path: string, root: string, overrides: Partial<SqliteStoreOptions> = {}): SqliteStore {
  return new SqliteStore({ path, legacyRoot: root, ...FRAME_DEFAULTS,
    acquireCreationLease: header => SessionWriteLease.acquire(sessionDir(root, header.cwd, header.id), header.id),
    publish: async () => {}, report: () => {}, ...overrides })
}

const storedFrame = z.object({ start_seq: z.number(), end_seq: z.number(), codec: z.number(), payload: z.instanceof(Uint8Array) })

/**
 * Resolve the tail Segment of one stored Trace.
 * @param db - open database connection.
 * @param id - Session identity.
 * @returns the Segment identity.
 */
export function tailSegment(db: DatabaseSync, id: SessionId): string {
  return z.object({ tail_segment_uuid: z.string() })
    .parse(db.prepare('SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?').get(id)).tail_segment_uuid
}

/**
 * Store one frame of event JSON texts through the fixture's own connection.
 * @param db - open database connection.
 * @param segment - Segment holding the frame.
 * @param start - sequence of the frame's first event within the Segment.
 * @param texts - the frame's events as JSON texts.
 * @param compression - physical encoding; the plugin default unless a test selects otherwise.
 */
export function insertFrame(db: DatabaseSync, segment: string, start: number, texts: readonly string[],
  compression: FrameCompression = FRAME_DEFAULTS.compression): void {
  const frame = encodeFrame(texts, compression)
  db.prepare('INSERT INTO frames (segment_uuid, start_seq, end_seq, codec, payload) VALUES (?, ?, ?, ?, ?)')
    .run(segment, start, start + frame.count, frame.codec, frame.bytes)
}

/**
 * Read the stored frames of one Segment in sequence order.
 * @param db - open database connection.
 * @param segment - Segment identity.
 * @returns each frame's range, codec, and the JSON texts it decodes to.
 */
export function storedFrames(db: DatabaseSync, segment: string): { start: number; end: number; codec: number; texts: string[] }[] {
  return db.prepare('SELECT start_seq, end_seq, codec, payload FROM frames WHERE segment_uuid = ? ORDER BY start_seq').all(segment).map((row) => {
    const frame = storedFrame.parse(row)
    const bytes = frame.codec === FRAME_CODEC_ZSTD ? zstdDecompressSync(frame.payload) : Buffer.from(frame.payload)
    return { start: frame.start_seq, end: frame.end_seq, codec: frame.codec, texts: bytes.toString('utf8').split('\n') }
  })
}

/**
 * Decode every stored event of one Segment in sequence order.
 * @param db - open database connection.
 * @param segment - Segment identity.
 * @returns the stored event JSON values.
 */
export function storedEvents(db: DatabaseSync, segment: string): unknown[] {
  return storedFrames(db, segment).flatMap(frame => frame.texts.map((text): unknown => JSON.parse(text)))
}

/**
 * Populate a persisted shared prefix for Segment read and cut-selection tests.
 * @param logs - store containing the durable source.
 * @param source - source Session.
 * @param target - child fixture identity.
 * @param prefix - prefix selecting the shared length.
 */
export async function sharedHistory(logs: SqliteStore, source: SessionId, target: SessionId,
  prefix: readonly SessionEvent[]): Promise<void> {
  const snapshot = await logs.stat(source)
  if (snapshot === undefined) throw new Error('Missing source fixture')
  // Cached statements must use the connection owned by this store.
  const db = await logs['database']()
  {
    const stored = z.object({ header: z.string(), inherited_count: z.number(), base_seq: z.number(),
      tail_segment_uuid: z.string().transform(value => brandString<Parameters<SqliteStore['cut']>[1]['tail_segment_uuid']>(value)) })
      .parse(db.prepare('SELECT header, inherited_count, tail_segment_uuid, base_seq FROM traces JOIN segments ON segment_uuid = tail_segment_uuid WHERE trace_uuid = ?').get(source))
    const cut = logs.cut(db, { ...stored, event_count: z.number().parse(snapshot.eventCount) }, prefix.length)
    const segment = randomUUID()
    const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(prefix.length), time: 0, data: { inherited: true } }
    db.exec('BEGIN IMMEDIATE')
    try {
      const id = brandString<Parameters<SqliteStore['cut']>[1]['tail_segment_uuid']>(segment)
      logs['newSegment'](db, id, cut.parent, cut.end)
      db.prepare('INSERT INTO traces VALUES (?, ?, ?, ?)').run(target,
        JSON.stringify({ version: SESSION_FORMAT_VERSION, id: target, createdAt: 0, isSeeded: true,
          delegationDepth: 0 }), segment, prefix.length)
      insertFrame(db, segment, 0, [JSON.stringify(marker)])
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
}

/**
 * Report the backend that durably holds one Session from its routing record.
 * @param root - legacy root.
 * @param id - Session identity.
 * @returns `sqlite` when a routing record exists, otherwise `jsonl`.
 */
export async function routeOf(root: string, id: SessionId): Promise<'sqlite' | 'jsonl'> {
  const marker = join(root, '.segments', `${createHash('sha256').update(id).digest('hex')}.json`)
  return (await readdir(join(root, '.segments'))).includes(basename(marker)) ? 'sqlite' : 'jsonl'
}

/**
 * Count frame rows and Segment metadata queries issued by the store.
 * @returns live counters, restored when the test finishes.
 */
export function countSqliteReads(): { frameRows: () => number; segmentQueries: () => number } {
  let frameRows = 0, segmentQueries = 0
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
  const prepare = DatabaseSync.prototype.prepare
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql)
    if (sql.startsWith('SELECT s.*')) {
      const get = statement.get.bind(statement), all = statement.all.bind(statement)
      Object.defineProperty(statement, 'get', { value: (...args: Parameters<StatementSync['get']>) => {
        segmentQueries++
        return get(...args)
      } })
      Object.defineProperty(statement, 'all', { value: (...args: Parameters<StatementSync['all']>) => {
        segmentQueries++
        return all(...args)
      } })
    }
    if (sql.startsWith('SELECT start_seq, end_seq, codec, payload FROM frames')) {
      const all = statement.all.bind(statement)
      Object.defineProperty(statement, 'all', { value: (...args: Parameters<StatementSync['all']>) => {
        const rows = all(...args)
        frameRows += rows.length
        return rows
      } })
    }
    return statement
  })
  onTestFinished(() => { spy.mockRestore() })
  return { frameRows: () => frameRows, segmentQueries: () => segmentQueries }
}

/**
 * Read one imported root Segment directly from durable SQLite rows.
 * @param root - persistence root using the default database.
 * @param id - imported Session identity.
 * @returns logical current header and event records in sequence order.
 */
export function importedRows(root: string, id: SessionId): unknown[] {
  const db = new DatabaseSync(join(root, '.segments', 'sessions.sqlite'))
  try {
    const row = db.prepare('SELECT header, tail_segment_uuid FROM traces WHERE trace_uuid = ?').get(id)
    if (typeof row?.header !== 'string' || typeof row.tail_segment_uuid !== 'string') throw new Error('Missing imported Session')
    const rootSegment = db.prepare('SELECT parent_segment_uuid FROM segments WHERE segment_uuid = ?').get(row.tail_segment_uuid)
    if (rootSegment?.parent_segment_uuid !== null) throw new Error('Expected an imported root Segment')
    return [JSON.parse(row.header), ...storedEvents(db, row.tail_segment_uuid)]
  } finally { db.close() }
}

/**
 * Create a fork through the explicit persistence source.
 * @param logs - store holding the durable source.
 * @param source - parent Session identity.
 * @param target - child Session identity.
 * @param prefix - selected parent history.
 */
export async function forkTrace(logs: SqliteStore, source: SessionId, target: SessionId,
  prefix: readonly SessionEvent[]): Promise<void> {
  const endSeq = SessionLogOffset(prefix.length)
  const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(endSeq), time: 0, data: { inherited: true } }
  const writer = await logs.create({ version: SESSION_FORMAT_VERSION, id: target, createdAt: 0, isSeeded: true },
    { inheritedEventCount: endSeq, parentSource: { sessionId: source, endSeq, events: [...prefix, marker] } })
  await writer.close()
}
