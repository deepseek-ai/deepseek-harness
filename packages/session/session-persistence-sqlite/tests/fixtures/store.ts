/** SQLite store fixtures and observations of durable event rows. @module */
import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SqliteStore } from '../../src/sqlite.ts'
import type { SqliteStoreOptions } from '../../src/sqlite.ts'
import { builtinDerivations } from '../../src/derivations.ts'
import { SqlFiles } from '../../src/sql.ts'
import type { SqlFile } from '../../src/sql.ts'
import { decodeRow, encodeRow, eventRow } from '../../src/row.ts'
import type { EventCompression } from '../../src/row.ts'
import { SessionWriteLease } from '../../src/lease.ts'
import { sessionDir } from '../../src/paths.ts'

/** The built-in derivations, as the plugin passes them to its store. */
const SQL = new SqlFiles()
export const DERIVATIONS = builtinDerivations(SQL)

/** Plugin defaults for the row encoding and derived tables of a directly constructed store. */
export const STORE_DEFAULTS = { compression: 'zstd', sql: SQL, derivations: DERIVATIONS } as const satisfies Partial<SqliteStoreOptions>

/**
 * Construct a store with the plugin defaults and no-op provider callbacks.
 * @param path - database path.
 * @param root - legacy root holding lock directories and routing records.
 * @param overrides - option replacements for the test.
 * @returns an unopened store.
 */
export function sqliteLogs(path: string, root: string, overrides: Partial<SqliteStoreOptions> = {}): SqliteStore {
  return new SqliteStore({ path, legacyRoot: root, ...STORE_DEFAULTS,
    acquireCreationLease: header => SessionWriteLease.acquire(sessionDir(root, header.cwd, header.id), header.id),
    publish: async () => {}, report: () => {}, reportUpgrade: () => {}, reportSetAside: () => {},
    reportDerivation: () => {}, reportRecovery: () => {}, reportArchive: () => {},
    ...overrides })
}

/**
 * Resolve the head Segment of one stored Session.
 * @param db - open database connection.
 * @param id - Session identity.
 * @returns the Segment row id.
 */
export function headSegment(db: DatabaseSync, id: SessionId): number {
  return z.object({ head_segment_id: z.number() })
    .parse(db.prepare('SELECT head_segment_id FROM sessions WHERE session_id = ?').get(id)).head_segment_id
}

/**
 * Store one event row through the fixture's own connection, without derived rows.
 * @param db - open database connection.
 * @param segment - Segment holding the event.
 * @param event - event to store at its own Session sequence.
 * @param compression - physical encoding; the plugin default unless a test selects otherwise.
 */
export function insertEvent(db: DatabaseSync, segment: number, event: SessionEvent,
  compression: EventCompression = STORE_DEFAULTS.compression): void {
  const row = encodeRow(event, compression)
  db.prepare(`INSERT INTO events (segment_id, seq, type, time, surface_op, source_seqs, ignorable, codec, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(segment, row.seq, row.type, row.time, row.surface_op, row.source_seqs, row.ignorable, row.codec, row.data)
}

/**
 * Read the stored event rows of one Segment in sequence order.
 * @param db - open database connection.
 * @param segment - Segment row id.
 * @returns each row's Session sequence, codec, and the event JSON value it decodes to.
 */
export function storedRows(db: DatabaseSync, segment: number): { seq: number; codec: number; event: unknown }[] {
  return db.prepare(`SELECT seq, type, time, surface_op, source_seqs, ignorable, codec, data FROM events
    WHERE segment_id = ? ORDER BY seq`).all(segment).map((raw) => {
    const row = eventRow.parse(raw)
    return { seq: row.seq, codec: row.codec, event: decodeRow(row) }
  })
}

/**
 * Decode every stored event of one Segment in sequence order.
 * @param db - open database connection.
 * @param segment - Segment row id.
 * @returns the stored event JSON values.
 */
export function storedEvents(db: DatabaseSync, segment: number): unknown[] {
  return storedRows(db, segment).map(row => row.event)
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
  const stored = z.object({ header: z.string(), inherited_count: z.number(), base_seq: z.number(), head_segment_id: z.number(),
    head_segment_uuid: z.string().transform(value => brandString<Parameters<SqliteStore['cut']>[1]['head_segment_uuid']>(value)) })
    .parse(db.prepare(`SELECT header, inherited_count, head_segment_id, segment_uuid AS head_segment_uuid, base_seq
      FROM sessions JOIN segments ON segment_id = head_segment_id WHERE session_id = ?`).get(source))
  const cut = logs.cut(db, { ...stored, event_count: z.number().parse(snapshot.eventCount) }, prefix.length)
  const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(prefix.length), time: 0, data: { inherited: true } }
  db.exec('BEGIN IMMEDIATE')
  try {
    const segment = logs['newSegment'](db, brandString<Parameters<SqliteStore['cut']>[1]['head_segment_uuid']>(randomUUID()), cut.parent, cut.end)
    db.prepare('INSERT INTO sessions (session_id, header, head_segment_id, inherited_count) VALUES (?, ?, ?, ?)').run(target,
      JSON.stringify({ version: SESSION_FORMAT_VERSION, id: target, createdAt: 0, isSeeded: true,
        delegationDepth: 0 }), segment, prefix.length)
    insertEvent(db, segment, marker)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
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
 * Count event rows and Segment metadata queries issued by the store.
 * @returns live counters, restored when the test finishes.
 */
export function countSqliteReads(): { eventRows: () => number; segmentQueries: () => number } {
  let eventRows = 0, segmentQueries = 0
  const files = new SqlFiles()
  const segmentFiles: readonly SqlFile[] = ['store/segment-by-id', 'store/segment-ancestors', 'store/fork-attachment']
  const segmentTexts = new Set(segmentFiles.map(file => files.text(file)))
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
  const prepare = DatabaseSync.prototype.prepare
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql)
    if (segmentTexts.has(sql)) {
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
    if (sql === files.text('store/events-in-range')) {
      const all = statement.all.bind(statement)
      Object.defineProperty(statement, 'all', { value: (...args: Parameters<StatementSync['all']>) => {
        const rows = all(...args)
        eventRows += rows.length
        return rows
      } })
    }
    return statement
  })
  onTestFinished(() => { spy.mockRestore() })
  return { eventRows: () => eventRows, segmentQueries: () => segmentQueries }
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
    const row = z.object({ header: z.string(), head_segment_id: z.number(), parent_id: z.number().nullable() })
      .parse(db.prepare(`SELECT header, head_segment_id, parent_id FROM sessions
        JOIN segments ON segment_id = head_segment_id WHERE session_id = ?`).get(id))
    if (row.parent_id !== null) throw new Error('Expected an imported root Segment')
    return [JSON.parse(row.header), ...storedEvents(db, row.head_segment_id)]
  } finally { db.close() }
}

/**
 * Create a fork through the explicit persistence source.
 * @param logs - store holding the durable source.
 * @param source - parent Session identity.
 * @param target - child Session identity.
 * @param prefix - selected parent history.
 */
export async function forkSession(logs: SqliteStore, source: SessionId, target: SessionId,
  prefix: readonly SessionEvent[]): Promise<void> {
  const endSeq = SessionLogOffset(prefix.length)
  const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(endSeq), time: 0, data: { inherited: true } }
  const writer = await logs.create({ version: SESSION_FORMAT_VERSION, id: target, createdAt: 0, isSeeded: true },
    { inheritedEventCount: endSeq, parentSource: { sessionId: source, endSeq, events: [...prefix, marker] } })
  await writer.close()
}
