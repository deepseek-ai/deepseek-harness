/** SQLite store fixtures and observations of durable event rows. @module */
import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SqliteStore } from '../../src/sqlite.ts'
import type { SqliteStoreOptions } from '../../src/sqlite.ts'
import { SessionWriteLease } from '../../src/lease.ts'
import { sessionDir } from '../../src/paths.ts'

/**
 * Construct a store with the plugin defaults and no-op provider callbacks.
 * @param path - database path.
 * @param root - legacy root holding lock directories and routing records.
 * @param overrides - option replacements for the test.
 * @returns an unopened store.
 */
export function sqliteLogs(path: string, root: string, overrides: Partial<SqliteStoreOptions> = {}): SqliteStore {
  return new SqliteStore({ path, legacyRoot: root,
    acquireCreationLease: header => SessionWriteLease.acquire(sessionDir(root, header.cwd, header.id), header.id),
    publish: async () => {}, report: () => {}, ...overrides })
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
      db.prepare('INSERT INTO events VALUES (?, 0, ?)').run(segment, JSON.stringify(marker))
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
 * Count event payload rows and Segment metadata queries issued by the store.
 * @returns live counters, restored when the test finishes.
 */
export function countSqliteReads(): { payloadRows: () => number; segmentQueries: () => number } {
  let payloadRows = 0, segmentQueries = 0
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
    if (sql === 'SELECT payload FROM events WHERE segment_uuid = ? AND seq >= ? AND seq < ? ORDER BY seq') {
      const all = statement.all.bind(statement)
      Object.defineProperty(statement, 'all', { value: (...args: Parameters<StatementSync['all']>) => {
        const rows = all(...args)
        payloadRows += rows.length
        return rows
      } })
    }
    return statement
  })
  onTestFinished(() => { spy.mockRestore() })
  return { payloadRows: () => payloadRows, segmentQueries: () => segmentQueries }
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
    return [JSON.parse(row.header), ...db.prepare('SELECT payload FROM events WHERE segment_uuid = ? ORDER BY seq')
      .all(row.tail_segment_uuid).map((event) => {
        if (typeof event.payload !== 'string') throw new Error('Invalid event payload')
        const value: unknown = JSON.parse(event.payload)
        return value
      })]
  } finally { db.close() }
}
