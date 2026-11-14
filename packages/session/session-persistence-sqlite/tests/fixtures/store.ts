/** SQLite store fixtures and observations of durable event rows. @module */
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SqliteLogs } from '../../src/sqlite.ts'
import type { SqliteLogsOptions } from '../../src/sqlite.ts'
import { SessionWriteLease } from '../../src/lease.ts'
import { sessionDir } from '../../src/paths.ts'

/**
 * Construct a store with the plugin defaults and no-op provider callbacks.
 * @param path - database path.
 * @param root - legacy root holding lock directories and routing records.
 * @param overrides - option replacements for the test.
 * @returns an unopened store.
 */
export function sqliteLogs(path: string, root: string, overrides: Partial<SqliteLogsOptions> = {}): SqliteLogs {
  return new SqliteLogs({ path, legacyRoot: root, busyTimeoutMs: 5000, flushDelayMs: 200, maxBufferedEvents: 256,
    acquireCreationLease: header => SessionWriteLease.acquire(sessionDir(root, header.cwd, header.id), header.id),
    publish: async () => {}, report: () => {}, ...overrides })
}

/**
 * Fork through the product path: reserve the source prefix, then append the constructor seed.
 * The prefix events stand in for the in-memory source log; only their seqs reach storage.
 * @param logs - store holding the source.
 * @param source - source Session.
 * @param target - new child Session.
 * @param prefix - inherited source events, contiguous from seq 0.
 */
export async function forkTrace(logs: SqliteLogs, source: SessionId, target: SessionId, prefix: readonly SessionEvent[]): Promise<void> {
  const endSeq = prefix.length
  const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(endSeq), time: 0, data: { inherited: true } }
  const writer = await logs.create({ version: SESSION_FORMAT_VERSION, id: target, createdAt: 0, isSeeded: true },
    { inheritedEventCount: SessionLogOffset(endSeq) }, { sourceId: source, endSeq })
  try { await writer.append([...prefix, marker]) } finally { await writer.close() }
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
    if (sql.startsWith('SELECT s.*')) segmentQueries++
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
