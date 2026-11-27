/** Schema creation, refusal of other databases, Segment paths, and the per-Session views. @module */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { ZodError } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { DerivedTables } from '../src/derive.ts'
import { cold } from '../src/migrations/cold.ts'
import { frames } from '../src/migrations/frames.ts'
import { MIGRATIONS, prepareSchema } from '../src/migrations/index.ts'
import type { Migration, MigrationOptions } from '../src/migrations/types.ts'
import { SqliteSessionPersistence } from '../src/persistence.ts'
import { EVENT_CODEC_JSON, EVENT_CODEC_ZSTD } from '../src/row.ts'
import { APPLICATION_ID, SCHEMA_VERSION } from '../src/schema.ts'
import { SQL_FILES, SqlFiles } from '../src/sql.ts'
import type { SqliteStoreOptions } from '../src/sqlite.ts'
import { DERIVATIONS, forkSession, headSegment, sqliteLogs, storedRows } from './fixtures/store.ts'

const UNBOUNDED = Number.MAX_SAFE_INTEGER
const header = (id: string, extra: Partial<SessionHeader> = {}): SessionHeader =>
  ({ version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false, ...extra })
const event = (seq: number): SessionEvent => seq % 2 === 0
  ? { type: 'turn/start', seq: SessionSeq(seq), time: 10 + seq, data: { turn: seq / 2 + 1 } }
  : { type: 'turn/end', seq: SessionSeq(seq), time: 10 + seq, data: { turn: (seq + 1) / 2, reason: { kind: 'completed' } } }
const events = (count: number): SessionEvent[] => Array.from({ length: count }, (_, seq) => event(seq))

/** The version 1 triggers that refuse frame changes, recreated after a fixture has damaged its stored frames. */
const FRAME_SEAL = `CREATE TRIGGER frames_no_update BEFORE UPDATE ON frames BEGIN SELECT RAISE(ABORT, 'frames are append-only'); END;
CREATE TRIGGER frames_no_delete BEFORE DELETE ON frames BEGIN SELECT RAISE(ABORT, 'frames are append-only'); END;`
const sql = new SqlFiles()

const user = (seq: number, text: string, extra: Partial<SessionEvent<'user/message'>> = {}): SessionEvent<'user/message'> => ({
  type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq), time: 10 + seq,
  data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), ...extra })
const turn = (seq: number, type: 'turn/start' | 'turn/end', number: number): SessionEvent => type === 'turn/start'
  ? { type, seq: SessionSeq(seq), time: 10 + seq, data: { turn: number } }
  : { type, seq: SessionSeq(seq), time: 10 + seq, data: { turn: number, reason: { kind: 'completed' } } }
const marker = (seq: number): SessionEvent<'session/end-seed'> => ({ type: 'session/end-seed', seq: SessionSeq(seq), time: 10 + seq, data: { inherited: true } })
const callId = brandString<ToolCallId>('call-0')
/** The Sessions of the version 1 fixture: a root, its fork at 3, that fork's fork at 4, and a separate tool log. */
const framed = {
  root: [event(0), event(1), user(2, 'large '.repeat(400)), turn(3, 'turn/start', 2), turn(4, 'turn/end', 2)],
  child: [marker(3), user(4, 'child only', { sourceEventSeqs: [SessionSeq(2)], ignorable: true })],
  grand: [marker(4)],
  tools: [
    { type: 'tool/call', seq: SessionSeq(0), time: 100, data: { turn: 1, step: 0, callId, name: 'read_file', arguments: '{}' } },
    { type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [SessionSeq(0)], seq: SessionSeq(1), time: 130,
      data: { turn: 1, step: 0, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'done' }], isError: false }) } },
    { type: 'assistant/message', surfaceOp: 'append', seq: SessionSeq(2), time: 140, data: { turn: 1, step: 0, stream: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'deepseek', model: 'deepseek-chat' } }) } },
  ],
} as const satisfies Record<string, readonly SessionEvent[]>
const framedHeaders = {
  root: header('root', { cwd: tmpdir(), delegationDepth: 0 }),
  child: header('child', { isSeeded: true, delegationDepth: 0 }),
  grand: header('grand', { isSeeded: true, delegationDepth: 0 }),
  tools: header('tools', { delegationDepth: 0 }),
}

/**
 * Store a version 1 database from the schema its release created. Frame ranges and `parent_end_seq` are
 * Segment-local; each event's JSON carries its Session sequence. `damage` changes stored rows with the
 * triggers that refuse frame changes lifted, as a fault outside SQLite would.
 */
function writeFrameLayout(db: DatabaseSync, damage?: (db: DatabaseSync) => void): void {
  db.exec(sql.text('schema/v1'))
  const segment = db.prepare('INSERT INTO segments VALUES (?, ?, ?, ?)')
  const trace = db.prepare('INSERT INTO traces VALUES (?, ?, ?, ?)')
  const frame = (uuid: string, start: number, batch: readonly SessionEvent[], compressed: boolean) => {
    const text = Buffer.from(batch.map(entry => JSON.stringify(entry)).join('\n'), 'utf8')
    db.prepare('INSERT INTO frames VALUES (?, ?, ?, ?, ?)').run(uuid, start, start + batch.length, compressed ? 1 : 0, compressed ? zstdCompressSync(text) : text)
  }
  segment.run('seg-root', null, null, 0)
  segment.run('seg-child', 'seg-root', 3, 3)
  segment.run('seg-grand', 'seg-child', 1, 4)
  segment.run('seg-tools', null, null, 0)
  // A later trace row holds an earlier Segment, so Session order and Segment order differ.
  trace.run('tools', JSON.stringify(framedHeaders.tools), 'seg-tools', 0)
  trace.run('grand', JSON.stringify(framedHeaders.grand), 'seg-grand', 4)
  trace.run('child', JSON.stringify(framedHeaders.child), 'seg-child', 3)
  trace.run('root', JSON.stringify(framedHeaders.root), 'seg-root', 0)
  frame('seg-root', 0, framed.root.slice(0, 3), true)
  frame('seg-root', 3, framed.root.slice(3), false)
  frame('seg-child', 0, framed.child, false)
  frame('seg-grand', 0, framed.grand, true)
  frame('seg-tools', 0, framed.tools, true)
  if (damage === undefined) return
  db.exec('DROP TRIGGER frames_no_update; DROP TRIGGER frames_no_delete')
  damage(db)
  db.exec(FRAME_SEAL)
}

async function fixture(overrides: Partial<SqliteStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-schema-')), path = join(root, 'sessions.sqlite')
  const logs = sqliteLogs(path, root, overrides)
  const inspect = new DatabaseSync(path)
  onTestFinished(async () => {
    inspect.close()
    try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) }
  })
  const rows = (sql: string) => inspect.prepare(sql).all().map(row => ({ ...row }))
  // SQLite's own objects are excluded: `sqlite_stat1` holds the planner statistics, not a Session object.
  const objects = (type: 'table' | 'view' | 'trigger') => rows(`SELECT name FROM sqlite_schema WHERE type = '${type}'
    AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(row => row.name)
  /** Everything a refused open must leave as it found it. */
  const contents = () => ({
    schema: rows('SELECT type, name, sql FROM sqlite_schema ORDER BY name'),
    version: inspect.prepare('PRAGMA user_version').get(),
    application: inspect.prepare('PRAGMA application_id').get(),
    data: objects('table').map(name => rows(`SELECT * FROM "${String(name)}"`)),
  })
  return { root, path, logs, inspect, rows, objects, contents }
}

/** The whole message of a refusal to open the database at `path`. */
const refusal = (path: string, reason: string): string => `SQLite persistence database "${path}" ${reason}; it is left unchanged`
/** Settle a rejection into its error, failing when the operation succeeds. */
async function rejection(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(() => { throw new Error('expected a rejection') }, (error: unknown) => error)
}

describe('schema creation', () => {
  it('creates the current schema in an empty database', async () => {
    const { logs, inspect, objects } = await fixture()
    await logs.start()
    expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(inspect.prepare('PRAGMA application_id').get()).toEqual({ application_id: APPLICATION_ID })
    expect(objects('table')).toEqual(['cold_segments', 'compactions', 'derivations', 'events', 'llm_calls', 'segment_paths', 'segments', 'sessions', 'tool_calls', 'tool_results'])
    expect(objects('trigger')).toEqual(['events_no_delete', 'events_no_update', 'paths_no_delete', 'paths_no_update', 'segments_index_paths', 'segments_no_reparent'])
    expect(objects('view')).toEqual(expect.arrayContaining(['session_events', 'session_segments', 'session_summary']))
  })

  it('creates a new database with the page size that limits padding around large values', async () => {
    // The fixture's inspection handle opens the file first, which would fix the page size before the store sees it, so
    // read the database the store itself created.
    const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-page-')), path = join(root, 'sessions.sqlite')
    const logs = sqliteLogs(path, root)
    onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
    await logs.start()
    const created = new DatabaseSync(path)
    onTestFinished(() => { created.close() })
    // 16 KiB pages hold more of a large `data` value before its tail pads a page, and WAL keeps that setting.
    expect(created.prepare('PRAGMA page_size').get()).toEqual({ page_size: 16384 })
    expect(created.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
  })

  it('keeps planner statistics that match the stored rows after a Session is written', async () => {
    const { logs, path, rows } = await fixture()
    await logs.start()
    const writer = await logs.create(header('statistics'))
    for (let seq = 0; seq < 200; seq++) {
      await writer.append([{ type: 'tool/call', seq: SessionSeq(seq), time: seq,
        data: { turn: 1, step: 0, callId: brandString<ToolCallId>(`call-${seq}`), name: 'read_file', arguments: '{}' } }])
    }
    await writer.flush(); await writer.close()
    // Opening analyzed an empty database, so only the close-time refresh can describe the rows this process wrote.
    await logs.close()
    const reopened = new DatabaseSync(path)
    onTestFinished(() => { reopened.close() })
    const statistics = new Map(reopened.prepare('SELECT tbl, stat FROM sqlite_stat1').all().map(row => [String(row.tbl), String(row.stat)]))
    expect(statistics.get('events')).toMatch(/^200\b/u)
    expect(statistics.get('tool_calls')).toMatch(/^200\b/u)
    expect(rows('SELECT count(*) AS calls FROM tool_calls')).toEqual([{ calls: 200 }])
  })

  it('accepts its own database again without changing the schema', async () => {
    const { root, path, logs, contents } = await fixture()
    const writer = await logs.create(header('kept')); await writer.append(events(2)); await writer.close()
    await logs.close()
    const before = contents()
    const reopened = sqliteLogs(path, root)
    onTestFinished(async () => { await reopened.close() })
    expect((await reopened.stat(SessionId('kept')))?.eventCount).toBe(2)
    expect(contents()).toEqual(before)
  })
})

describe('schema refusal', () => {
  it.each([
    ['an unrelated database', 'is not a Session database',
      (db: DatabaseSync) => { db.exec('CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES (\'kept\')') }],
    ['a foreign application id', 'belongs to another application',
      (db: DatabaseSync) => { db.exec(`CREATE TABLE notes (body TEXT); PRAGMA application_id = 1; PRAGMA user_version = ${SCHEMA_VERSION}`) }],
    ['an application id without a version', 'has schema version 0, which this build cannot upgrade',
      (db: DatabaseSync) => { db.exec(`PRAGMA application_id = ${APPLICATION_ID}`) }],
    ['a version without an application id', 'belongs to another application',
      (db: DatabaseSync) => { db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`) }],
  ] as const)('refuses %s, leaves it intact, and judges it again at the next attempt', async (_label, reason, populate) => {
    const reportUpgrade = vi.fn<(from: number, to: number) => void>()
    const { path, logs, inspect, contents } = await fixture({ reportUpgrade })
    populate(inspect)
    const before = contents()
    const first = await rejection(logs.start())
    expect(first).toBeInstanceOf(HarnessError)
    expect(first).toMatchObject({ code: 'SESSION_STORAGE_FORMAT', message: refusal(path, reason) })
    const second = await rejection(logs.stat(SessionId('absent')))
    expect(second).toMatchObject({ code: 'SESSION_STORAGE_FORMAT', message: refusal(path, reason) })
    // A refusal is not retained: the second attempt read the database again.
    expect(second).not.toBe(first)
    expect(reportUpgrade).not.toHaveBeenCalled()
    expect(contents()).toEqual(before)
  })

  it.each([
    ['a newer version', `has schema version ${SCHEMA_VERSION + 1}, newer than version ${SCHEMA_VERSION} of this build; open it with the release that wrote it`,
      (db: DatabaseSync) => { db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`) }],
    ['a current version missing a table', `has schema version ${SCHEMA_VERSION} without its tables`,
      (db: DatabaseSync) => { db.exec('DROP TABLE segment_paths') }],
  ] as const)('refuses its own database with %s and leaves it intact', async (_label, reason, damage) => {
    const { root, path, logs, inspect, contents } = await fixture()
    const writer = await logs.create(header('kept')); await writer.append(events(2)); await writer.close()
    await logs.close()
    damage(inspect)
    const before = contents()
    const refused = sqliteLogs(path, root)
    onTestFinished(() => refused.close())
    await expect(refused.start()).rejects.toMatchObject({ code: 'SESSION_STORAGE_FORMAT', message: refusal(path, reason) })
    expect(contents()).toEqual(before)
  })

  it('opens a database once the content that refused it is gone', async () => {
    const { logs, inspect } = await fixture()
    inspect.exec('CREATE TABLE notes (body TEXT)')
    await expect(logs.start()).rejects.toMatchObject({ code: 'SESSION_STORAGE_FORMAT' })
    inspect.exec('DROP TABLE notes')
    await logs.start()
    expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
  })
})

describe('segment paths', () => {
  async function family() {
    const context = await fixture()
    const { logs, inspect } = context
    const root = await logs.create(header('root')); await root.append(events(4)); await root.close()
    // Each fork stores its inherited marker at the cut, so the child's base is 3 and the grandchild's is 4.
    await forkSession(logs, SessionId('root'), SessionId('child'), events(3))
    await forkSession(logs, SessionId('child'), SessionId('grandchild'), events(4))
    await forkSession(logs, SessionId('child'), SessionId('early'), events(1))
    const segment = (id: string) => headSegment(inspect, SessionId(id))
    const paths = (id: string) => context.rows(`SELECT member_id, end_seq FROM segment_paths WHERE segment_id = ${segment(id)} ORDER BY end_seq DESC`)
    return { ...context, segment, paths }
  }

  it('gives a root Segment exactly its own unbounded path row', async () => {
    const { segment, paths } = await family()
    expect(paths('root')).toEqual([{ member_id: segment('root'), end_seq: UNBOUNDED }])
  })

  it('gives a grandchild itself, its parent and its grandparent, each up to the cut that follows it', async () => {
    const { segment, paths, rows } = await family()
    expect(paths('child')).toEqual([{ member_id: segment('child'), end_seq: UNBOUNDED }, { member_id: segment('root'), end_seq: 3 }])
    expect(paths('grandchild')).toEqual([
      { member_id: segment('grandchild'), end_seq: UNBOUNDED }, { member_id: segment('child'), end_seq: 4 }, { member_id: segment('root'), end_seq: 3 },
    ])
    expect(rows(`SELECT parent_id, base_seq FROM segments WHERE segment_id = ${segment('grandchild')}`)).toEqual([{ parent_id: segment('child'), base_seq: 4 }])
  })

  it('attaches a fork cut inside an earlier ancestor to that ancestor alone', async () => {
    const { segment, paths } = await family()
    expect(paths('early')).toEqual([{ member_id: segment('early'), end_seq: UNBOUNDED }, { member_id: segment('root'), end_seq: 1 }])
  })

  it('refuses to change a Segment or its paths', async () => {
    const { inspect } = await family()
    const denied = 'segment ancestry is immutable'
    expect(() => { inspect.exec('UPDATE segments SET base_seq = 9') }).toThrow(denied)
    expect(() => { inspect.exec('UPDATE segment_paths SET end_seq = 0') }).toThrow(denied)
    expect(() => { inspect.exec('DELETE FROM segment_paths') }).toThrow(denied)
  })

  it('lists the events of each Session through its path in one join', async () => {
    const { logs, rows } = await family()
    const seqs = (id: string) => rows(`SELECT seq, type FROM session_events WHERE session_id = '${id}' ORDER BY seq`).map(row => `${String(row.seq)}:${String(row.type)}`)
    expect(seqs('root')).toEqual(['0:turn/start', '1:turn/end', '2:turn/start', '3:turn/end'])
    expect(seqs('child')).toEqual(['0:turn/start', '1:turn/end', '2:turn/start', '3:session/end-seed'])
    expect(seqs('grandchild')).toEqual(['0:turn/start', '1:turn/end', '2:turn/start', '3:session/end-seed', '4:session/end-seed'])
    expect(seqs('early')).toEqual(['0:turn/start', '1:session/end-seed'])
    for (const id of ['root', 'child', 'grandchild', 'early']) {
      const reader = await logs.open(SessionId(id), 'read')
      try { expect((await reader.read()).events.map(entry => `${entry.seq}:${entry.type}`)).toEqual(seqs(id)) } finally { await reader.close() }
    }
  })
})

describe('session summary', () => {
  it('reports header members, the event count and the last event time of each Session', async () => {
    const { logs, rows } = await fixture()
    const described = header('described', { createdAt: 5, cwd: tmpdir(), parentSession: SessionId('origin'), origin: 'subagent', agentPreset: 'reviewer' })
    const writer = await logs.create(described); await writer.append(events(3)); await writer.close()
    const empty = await logs.create(header('empty')); await empty.flush(); await empty.close()
    await forkSession(logs, SessionId('described'), SessionId('fork'), events(2))
    expect(rows('SELECT * FROM session_summary ORDER BY session_id')).toEqual([
      { session_id: 'described', created_at: 5, cwd: tmpdir(), parent_session: 'origin', origin: 'subagent', agent_preset: 'reviewer',
        inherited_count: 0, event_count: 3, last_event_time: 12 },
      { session_id: 'empty', created_at: 0, cwd: null, parent_session: null, origin: null, agent_preset: null,
        inherited_count: 0, event_count: 0, last_event_time: null },
      { session_id: 'fork', created_at: 0, cwd: null, parent_session: null, origin: null, agent_preset: null,
        inherited_count: 2, event_count: 3, last_event_time: 0 },
    ])
    for (const entry of (await logs.scan()).entries) {
      expect(rows(`SELECT event_count FROM session_summary WHERE session_id = '${entry.header.id}'`)).toEqual([{ event_count: entry.eventCount }])
    }
  })
})

/** What the Zstandard decoder of this Node.js reports for bytes that are not a frame. */
const ZSTD_FAILURE = /unknown frame descriptor/i

/** Settle a failed open into its upgrade failure, checking the code and the whole message. */
async function upgradeFailure(operation: Promise<unknown>, path: string): Promise<HarnessError> {
  const failure = await rejection(operation)
  if (!(failure instanceof HarnessError)) throw new Error('expected an upgrade failure', { cause: failure })
  expect(failure.code).toBe('SESSION_STORAGE_UPGRADE')
  expect(failure.message).toBe(`Upgrading SQLite persistence database "${path}" from schema version 1 to 2 failed; `
    + 'it is left unchanged. Restore a backup, or open it with the release that wrote it')
  return failure
}

describe('frame layout conversion', () => {
  const sessions = ['root', 'child', 'grand'] as const
  const shared = framed.root.slice(0, 3)
  const history = { root: framed.root, child: [...shared, ...framed.child], grand: [...shared, framed.child[0], ...framed.grand] }

  it('converts a version 1 database in place and reads every Session back identically', async () => {
    const { logs, inspect, objects, rows } = await fixture()
    writeFrameLayout(inspect)
    await logs.start()
    expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(objects('table')).toEqual(['cold_segments', 'compactions', 'derivations', 'events', 'llm_calls', 'segment_paths', 'segments', 'sessions', 'tool_calls', 'tool_results'])
    expect(objects('trigger')).toEqual(['events_no_delete', 'events_no_update', 'paths_no_delete', 'paths_no_update', 'segments_index_paths', 'segments_no_reparent'])
    expect(rows('SELECT session_id, inherited_count FROM sessions ORDER BY session_key')).toEqual([
      { session_id: 'tools', inherited_count: 0 }, { session_id: 'grand', inherited_count: 4 },
      { session_id: 'child', inherited_count: 3 }, { session_id: 'root', inherited_count: 0 },
    ])
    for (const name of sessions) {
      expect(await logs.stat(SessionId(name))).toMatchObject({ header: framedHeaders[name], eventCount: 5, formatStatus: 'current' })
      const reader = await logs.open(SessionId(name), 'read')
      try {
        expect(reader.header).toEqual(framedHeaders[name])
        expect(reader.inheritedEventCount).toBe(name === 'root' ? 0 : name === 'child' ? 3 : 4)
        expect((await reader.read()).events).toEqual(history[name])
        expect((await reader.read(2, 2)).events).toEqual(history[name].slice(2, 4))
      } finally { await reader.close() }
    }
    expect(rows("SELECT seq, type, time, surface_op, source_seqs, ignorable FROM session_events WHERE session_id = 'tools' ORDER BY seq")).toEqual([
      { seq: 0, type: 'tool/call', time: 100, surface_op: null, source_seqs: null, ignorable: null },
      { seq: 1, type: 'tool/result', time: 130, surface_op: 'append', source_seqs: '[0]', ignorable: null },
      { seq: 2, type: 'assistant/message', time: 140, surface_op: 'append', source_seqs: null, ignorable: null },
    ])
    expect(storedRows(inspect, headSegment(inspect, SessionId('tools'))).map(row => row.event)).toEqual(framed.tools)
  })

  it('carries Segment identities and ancestry into Segment paths with Session sequences', async () => {
    const { logs, inspect, rows } = await fixture()
    writeFrameLayout(inspect)
    await logs.start()
    const segment = (uuid: string) => Number(inspect.prepare('SELECT segment_id FROM segments WHERE segment_uuid = ?').get(uuid)?.segment_id)
    expect(rows('SELECT s.segment_uuid, p.segment_uuid AS parent, s.base_seq FROM segments s LEFT JOIN segments p ON p.segment_id = s.parent_id ORDER BY s.segment_uuid')).toEqual([
      { segment_uuid: 'seg-child', parent: 'seg-root', base_seq: 3 }, { segment_uuid: 'seg-grand', parent: 'seg-child', base_seq: 4 },
      { segment_uuid: 'seg-root', parent: null, base_seq: 0 }, { segment_uuid: 'seg-tools', parent: null, base_seq: 0 },
    ])
    const paths = (uuid: string) => rows(`SELECT member_id, end_seq FROM segment_paths WHERE segment_id = ${segment(uuid)} ORDER BY end_seq DESC`)
    expect(paths('seg-root')).toEqual([{ member_id: segment('seg-root'), end_seq: UNBOUNDED }])
    expect(paths('seg-child')).toEqual([{ member_id: segment('seg-child'), end_seq: UNBOUNDED }, { member_id: segment('seg-root'), end_seq: 3 }])
    expect(paths('seg-grand')).toEqual([
      { member_id: segment('seg-grand'), end_seq: UNBOUNDED }, { member_id: segment('seg-child'), end_seq: 4 }, { member_id: segment('seg-root'), end_seq: 3 },
    ])
    expect(headSegment(inspect, SessionId('grand'))).toBe(segment('seg-grand'))
    expect(storedRows(inspect, segment('seg-child')).map(row => row.seq)).toEqual([3, 4])
  })

  it('encodes converted rows under the compression of the opening store', async () => {
    const compressed = await fixture()
    writeFrameLayout(compressed.inspect)
    await compressed.logs.start()
    const codecs = (db: DatabaseSync) => storedRows(db, headSegment(db, SessionId('root'))).map(row => row.codec)
    expect(codecs(compressed.inspect)).toEqual([EVENT_CODEC_JSON, EVENT_CODEC_JSON, EVENT_CODEC_ZSTD, EVENT_CODEC_JSON, EVENT_CODEC_JSON])
    const plain = await fixture({ compression: 'none' })
    writeFrameLayout(plain.inspect)
    await plain.logs.start()
    expect(codecs(plain.inspect)).toEqual(Array.from({ length: 5 }, () => EVENT_CODEC_JSON))
  })

  it('fills the derived tables from the converted events after opening', async () => {
    const { logs, inspect, rows } = await fixture()
    writeFrameLayout(inspect)
    await logs.start()
    await vi.waitFor(() => {
      expect(inspect.prepare('SELECT count(*) AS behind FROM derivations WHERE cursor IS NOT NULL').get()).toEqual({ behind: 0 })
    })
    expect(rows("SELECT seq, tool, result_seq, is_error, duration_ms FROM session_tools WHERE session_id = 'tools'"))
      .toEqual([{ seq: 0, tool: 'read_file', result_seq: 1, is_error: 0, duration_ms: 30 }])
    expect(rows('SELECT session_id, seq, provider, model, input_tokens, output_tokens FROM session_llm_calls'))
      .toEqual([{ session_id: 'tools', seq: 2, provider: 'deepseek', model: 'deepseek-chat', input_tokens: 10, output_tokens: 5 }])
  })

  it('continues a converted Session and forks it', async () => {
    const { logs, inspect } = await fixture()
    writeFrameLayout(inspect)
    const appended = user(5, 'after conversion')
    const writer = await logs.open(SessionId('child'), 'write')
    await writer.append([appended]); await writer.close()
    await forkSession(logs, SessionId('child'), SessionId('later'), [...history.child, appended])
    const reader = await logs.open(SessionId('later'), 'read')
    const seed: SessionEvent = { ...marker(6), time: 0 }
    try { expect((await reader.read()).events).toEqual([...history.child, appended, seed]) } finally { await reader.close() }
  })

  it('carries an event of a type this build does not know through the upgrade and judges it when its Session is read', async () => {
    const reportUpgrade = vi.fn<(from: number, to: number) => void>()
    const { logs, inspect, rows } = await fixture({ reportUpgrade })
    const retired = { type: 'retired/kind', seq: 4, time: 14, data: { kept: true } }
    writeFrameLayout(inspect, (db) => {
      db.prepare("UPDATE frames SET codec = 0, payload = ? WHERE segment_uuid = 'seg-grand'").run(Buffer.from(JSON.stringify(retired)))
    })
    await logs.start()
    expect(reportUpgrade.mock.calls).toEqual([[1, 2], [2, 3]])
    expect(rows("SELECT seq, time, data FROM events WHERE type = 'retired/kind'")).toEqual([{ seq: 4, time: 14, data: '{"kept":true}' }])
    const reader = await logs.open(SessionId('root'), 'read')
    try { expect((await reader.read()).events).toEqual(history.root) } finally { await reader.close() }
    const refused = await logs.open(SessionId('grand'), 'read')
    try { await expect(refused.read()).rejects.toThrow() } finally { await refused.close() }
  })

  it('logs the upgrade through the provider before Sessions open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-schema-provider-'))
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
    onTestFinished(() => { info.mockRestore() })
    await mkdir(join(root, '.segments'))
    const seeded = new DatabaseSync(join(root, '.segments', 'sessions.sqlite'))
    try { writeFrameLayout(seeded) } finally { seeded.close() }
    const persistence = new SqliteSessionPersistence(ctx, ctx, { root }, {
      hasStoredJsonl: async () => false, list: async () => [], stat: async () => undefined,
      prepare: async () => { throw new Error('no legacy history') },
    })
    await persistence.start()
    expect(info.mock.calls.map(([message]) => String(message)))
      .toEqual(['Upgrading the Session database from schema version 1 to 2; Sessions open when it finishes',
        'Upgrading the Session database from schema version 2 to 3; Sessions open when it finishes'])
    expect((await persistence.stat(SessionId('root')))?.eventCount).toBe(framed.root.length)
  })

  it.each([
    ['a frame holding fewer events than its recorded range', RangeError, /^SQLite frame at 3 holds 2 of its 3 recorded events$/, 'frame at 3 of Segment seg-root',
      (db: DatabaseSync) => { db.exec("UPDATE frames SET end_seq = 6 WHERE segment_uuid = 'seg-root' AND start_seq = 3") }],
    ['an event whose sequence differs from its position', RangeError, /^SQLite frame event 7 is out of sequence$/, 'frame at 4 of Segment seg-grand',
      (db: DatabaseSync) => { db.prepare("UPDATE frames SET codec = 0, payload = ? WHERE segment_uuid = 'seg-grand'").run(Buffer.from(JSON.stringify(marker(7)))) }],
    ['a compressed frame whose bytes are damaged', Error, ZSTD_FAILURE, 'frame at 4 of Segment seg-grand',
      (db: DatabaseSync) => { db.prepare("UPDATE frames SET payload = ? WHERE segment_uuid = 'seg-grand'").run(Buffer.from('damaged')) }],
    ['a frame line that is not JSON', SyntaxError, /JSON/, 'frame at 4 of Segment seg-grand',
      (db: DatabaseSync) => { db.prepare("UPDATE frames SET codec = 0, payload = ? WHERE segment_uuid = 'seg-grand'").run(Buffer.from('{"type":')) }],
    ['a frame line that is not an event', ZodError, /"seq"/, 'frame at 4 of Segment seg-grand',
      (db: DatabaseSync) => { db.prepare("UPDATE frames SET codec = 0, payload = ? WHERE segment_uuid = 'seg-grand'").run(Buffer.from('{"type":"session/end-seed"}')) }],
    ['an event with an envelope member no event row holds', ZodError, /unrecognized_keys[^]*"origin"/, 'frame at 4 of Segment seg-grand',
      (db: DatabaseSync) => { db.prepare("UPDATE frames SET codec = 0, payload = ? WHERE segment_uuid = 'seg-grand'").run(Buffer.from(JSON.stringify({ ...marker(4), origin: 'elsewhere' }))) }],
  ] as const)('sets aside %s, keeps its bytes, and upgrades every other Session', async (_label, kind, message, detail, damage) => {
    const reportSetAside = vi.fn<(detail: string, error: unknown) => void>()
    const { logs, inspect, rows } = await fixture({ reportSetAside })
    writeFrameLayout(inspect, damage)
    const [segment = '', start = ''] = [/Segment (\S+)$/.exec(detail)?.[1], /^frame at (\d+)/.exec(detail)?.[1]]
    const kept = inspect.prepare(`SELECT f.segment_uuid, f.start_seq, f.end_seq, f.codec, f.payload FROM frames f JOIN segments s USING (segment_uuid)
      WHERE f.segment_uuid = ? AND s.base_seq + f.start_seq = ?`).all(segment, Number(start)).map(row => ({ ...row }))
    expect(kept).toHaveLength(1)
    await logs.start()
    expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(reportSetAside).toHaveBeenCalledOnce()
    const [reported, failure] = reportSetAside.mock.calls[0] ?? []
    expect(reported).toBe(detail)
    if (!(failure instanceof kind)) throw new Error('expected the error that made the frame unreadable', { cause: failure })
    expect(failure.message).toMatch(message)
    expect(rows('SELECT segment_uuid, start_seq, end_seq, codec, payload FROM frames_set_aside')).toEqual(kept)
    // The tool Session shares nothing with the damaged Segments.
    const healthy = await logs.open(SessionId('tools'), 'read')
    try { expect((await healthy.read(0, 2)).events).toEqual(framed.tools.slice(0, 2)) } finally { await healthy.close() }
  })

  it.each([
    // The frame layout failed at the frame's first sequence with the corruption error; every sequence of a frame that
    // cannot be split stands in, so the same read fails at the same place with the same error class.
    ['first', 0, 'stored event at index 0 is invalid'],
    ['last', 3, 'stored event at index 3 is invalid'],
  ] as const)('keeps the event count of a Session whose %s frame is set aside and refuses reads and writes that reach it', async (_which, start, message) => {
    const { logs, inspect, rows } = await fixture()
    writeFrameLayout(inspect, (db) => { db.prepare("UPDATE frames SET payload = ? WHERE segment_uuid = 'seg-root' AND start_seq = ?").run(Buffer.from('damaged'), start) })
    await logs.start()
    expect((await logs.stat(SessionId('root')))?.eventCount).toBe(framed.root.length)
    // A frame that cannot be split at all stands in for every sequence of its range, so the count and the read
    // failure stay where they were before the upgrade.
    const recorded = start === 0 ? framed.root.slice(0, 3).length : framed.root.slice(3).length
    expect(rows("SELECT count(*) AS stand_ins FROM events WHERE type = 'storage/unreadable' AND codec = 255"))
      .toEqual([{ stand_ins: recorded }])
    const damaged = await logs.open(SessionId('root'), 'read')
    try { await expect(damaged.read()).rejects.toThrow(message) } finally { await damaged.close() }
    await expect(logs.open(SessionId('root'), 'write')).rejects.toThrow()
    const apart = await logs.open(SessionId('tools'), 'read')
    try { expect((await apart.read(0, 2)).events).toEqual(framed.tools.slice(0, 2)) } finally { await apart.close() }
  })

  it('carries over the readable prefix of a frame recorded longer than its lines', async () => {
    const reportSetAside = vi.fn<(detail: string, error: unknown) => void>()
    const { logs, inspect, rows } = await fixture({ reportSetAside })
    const readable = framed.root.slice(3)
    // The frame layout served this prefix to a read that stopped inside it, so only the missing tail may stand in.
    writeFrameLayout(inspect, (db) => {
      db.prepare("UPDATE frames SET codec = 0, end_seq = 8, payload = ? WHERE segment_uuid = 'seg-root' AND start_seq = 3")
        .run(Buffer.from(readable.map(entry => JSON.stringify(entry)).join('\n')))
    })
    await logs.start()
    expect(reportSetAside.mock.calls.map(([detail]) => detail)).toEqual(['frame at 3 of Segment seg-root'])
    expect(rows('SELECT count(*) AS kept FROM frames_set_aside')).toEqual([{ kept: 1 }])
    const reader = await logs.open(SessionId('root'), 'read')
    try {
      // A read that stops inside the readable lines succeeds, which is what the frame layout served.
      expect((await reader.read(0, 5)).events).toEqual(framed.root)
      // The recorded range runs past the readable lines, so the sequences without one stand in.
      await expect(reader.read()).rejects.toThrow(/stored event at index 5 is invalid/u)
    } finally { await reader.close() }
  })

  it('drops the lines of a frame recorded shorter than its lines, as the frame layout never read them', async () => {
    const reportSetAside = vi.fn<(detail: string, error: unknown) => void>()
    const { logs, inspect, rows } = await fixture({ reportSetAside })
    writeFrameLayout(inspect, (db) => {
      db.prepare("UPDATE frames SET codec = 0, end_seq = 2, payload = ? WHERE segment_uuid = 'seg-root' AND start_seq = 0")
        .run(Buffer.from(framed.root.slice(0, 3).map(entry => JSON.stringify(entry)).join('\n')))
    })
    await logs.start()
    // No sequence of the stored range is unreadable, so nothing is set aside and no row stands in.
    expect(reportSetAside).not.toHaveBeenCalled()
    expect(rows("SELECT count(*) AS stand_ins FROM events WHERE type = 'storage/unreadable'")).toEqual([{ stand_ins: 0 }])
    const reader = await logs.open(SessionId('root'), 'read')
    try { expect((await reader.read(0, 2)).events).toEqual(framed.root.slice(0, 2)) } finally { await reader.close() }
  })

  it('keeps a real event time in the row that stands in for an unreadable event', async () => {
    const { logs, inspect } = await fixture()
    writeFrameLayout(inspect, (db) => {
      const lines = framed.root.slice(0, 3).map(entry => JSON.stringify(entry))
      db.prepare("UPDATE frames SET codec = 0, payload = ? WHERE segment_uuid = 'seg-root' AND start_seq = 0")
        .run(Buffer.from([lines[0], '{bad', lines[2]].join('\n')))
    })
    await logs.start()
    // The nearest readable event supplies the time, so a Session's last event time stays a real instant.
    expect(inspect.prepare("SELECT time FROM events WHERE seq = 1 AND type = 'storage/unreadable'").get())
      .toEqual({ time: framed.root[0].time })
  })

  it('upgrades a version 1 database whose frame-merge build dropped a trigger and the trace index', async () => {
    const { logs, inspect, rows } = await fixture()
    writeFrameLayout(inspect)
    // The reverted merge build dropped these two objects on every open and did not create them again.
    inspect.exec('DROP TRIGGER frames_no_delete; DROP INDEX exclusive_trace_head')
    await logs.start()
    expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(rows("SELECT count(*) AS events FROM events WHERE segment_id = (SELECT segment_id FROM segments WHERE segment_uuid = 'seg-root')"))
      .toEqual([{ events: framed.root.length }])
  })

  it('refuses a version 1 Segment that does not start where its parent ends', async () => {
    const { logs, inspect } = await fixture()
    writeFrameLayout(inspect)
    // The frame layout refused such a child when the Session was read; the upgrade must not invent a history for it.
    inspect.exec("DROP TRIGGER segments_no_reparent; UPDATE segments SET base_seq = 4 WHERE segment_uuid = 'seg-child'")
    await expect(logs.start()).rejects.toMatchObject({
      code: 'SESSION_STORAGE_UPGRADE',
      cause: { message: /Segment "seg-child" starts at 4, not at its parent's end 3/u },
    })
    expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
  })

  it('refuses a version 1 Segment whose named parent is not stored', async () => {
    const { logs, inspect } = await fixture()
    writeFrameLayout(inspect)
    inspect.exec('DROP TRIGGER segments_no_reparent')
    inspect.exec('PRAGMA foreign_keys = OFF')
    inspect.exec("UPDATE segments SET parent_segment_uuid = 'absent' WHERE segment_uuid = 'seg-grand'")
    await expect(logs.start()).rejects.toMatchObject({
      code: 'SESSION_STORAGE_UPGRADE',
      cause: { message: /Segment "seg-grand" names parent "absent", which is not stored/u },
    })
  })

  it('sets aside a version 1 frame whose Segment row is absent', async () => {
    const reportSetAside = vi.fn<(detail: string, error: unknown) => void>()
    const { logs, inspect, rows } = await fixture({ reportSetAside })
    writeFrameLayout(inspect)
    // Only a file written with foreign keys off holds such a frame; node:sqlite enforces them by default.
    inspect.exec('PRAGMA foreign_keys = OFF')
    inspect.prepare("INSERT INTO frames VALUES ('ghost', 0, 1, 0, ?)").run(Buffer.from(JSON.stringify(marker(0))))
    await logs.start()
    expect(reportSetAside.mock.calls.map(([detail]) => detail)).toEqual(['frame at 0 of Segment ghost'])
    expect(rows('SELECT segment_uuid, start_seq FROM frames_set_aside')).toEqual([{ segment_uuid: 'ghost', start_seq: 0 }])
  })

  it('carries over the readable events of a frame in which other events are damaged, so reads that avoid those still succeed', async () => {
    const reportSetAside = vi.fn<(detail: string, error: unknown) => void>()
    const { logs, inspect, rows } = await fixture({ reportSetAside })
    const lines = framed.root.slice(0, 3).map(entry => JSON.stringify(entry))
    writeFrameLayout(inspect, (db) => {
      db.prepare("UPDATE frames SET codec = 0, payload = ? WHERE segment_uuid = 'seg-root' AND start_seq = 0")
        .run(Buffer.from([lines[0], '{"type":', JSON.stringify(marker(9))].join('\n')))
    })
    await logs.start()
    expect(reportSetAside.mock.calls.map(([detail]) => detail)).toEqual(['frame at 0 of Segment seg-root'])
    expect(rows(`SELECT group_concat(seq) AS stand_ins FROM (SELECT seq FROM events WHERE type = 'storage/unreadable'
      AND segment_id = (SELECT segment_id FROM segments WHERE segment_uuid = 'seg-root') ORDER BY seq)`)).toEqual([{ stand_ins: '1,2' }])
    expect(rows("SELECT count(*) AS stored FROM events WHERE segment_id = (SELECT segment_id FROM segments WHERE segment_uuid = 'seg-root')"))
      .toEqual([{ stored: framed.root.length }])
    expect(rows('SELECT count(*) AS kept FROM frames_set_aside')).toEqual([{ kept: 1 }])
    const reader = await logs.open(SessionId('root'), 'read')
    try {
      expect((await reader.read(0, 1)).events).toEqual(framed.root.slice(0, 1))
      expect((await reader.read(3, 2)).events).toEqual(framed.root.slice(3))
      await expect(reader.read()).rejects.toThrow(/stored event at index 1 is invalid/)
    } finally { await reader.close() }
  })

  it('refuses a Session whose only frame is set aside instead of reading it as empty', async () => {
    const { logs, inspect } = await fixture()
    writeFrameLayout(inspect, (db) => { db.prepare("UPDATE frames SET payload = ? WHERE segment_uuid = 'seg-grand'").run(Buffer.from('damaged')) })
    await logs.start()
    expect((await logs.stat(SessionId('grand')))?.eventCount).toBe(history.grand.length)
    const reader = await logs.open(SessionId('grand'), 'read')
    try { await expect(reader.read()).rejects.toThrow(/stored event at index 4 is invalid/) } finally { await reader.close() }
    const child = await logs.open(SessionId('child'), 'read')
    try { expect((await child.read()).events).toEqual(history.child) } finally { await child.close() }
  })

  it.each([
    ['is not JSON', '{"version":4,"id":"chi'],
    ['holds a creation time that is not an integer', JSON.stringify({ ...framedHeaders.child, createdAt: 'yesterday' })],
  ])('upgrades a database in which one header %s and omits only that Session from the list', async (_label, stored) => {
    const { logs, inspect, rows } = await fixture()
    writeFrameLayout(inspect, (db) => { db.prepare("UPDATE traces SET header = ? WHERE trace_uuid = 'child'").run(stored) })
    await logs.start()
    expect(rows("SELECT header, created_at, cwd FROM sessions WHERE session_id = 'child'")).toEqual([{ header: stored, created_at: null, cwd: null }])
    const listed = await logs.scan()
    expect(listed.entries.map(entry => entry.header.id).toSorted()).toEqual(['grand', 'root', 'tools'])
    expect([...listed.omitted]).toEqual(['child'])
    await expect(logs.stat(SessionId('child'))).rejects.toThrow()
    const reader = await logs.open(SessionId('root'), 'read')
    try { expect((await reader.read()).events).toEqual(history.root) } finally { await reader.close() }
  })

  it('keeps the failure of an open that fails after an upgrade step ran, so the step does not run again', async () => {
    const reportUpgrade = vi.fn<(from: number, to: number) => void>()
    const refused = new Error('derived tables refused')
    const install = vi.spyOn(DerivedTables.prototype, 'install').mockImplementationOnce(() => { throw refused })
    onTestFinished(() => { install.mockRestore() })
    const { logs, inspect, contents } = await fixture({ reportUpgrade })
    writeFrameLayout(inspect)
    const before = contents()
    await expect(logs.start()).rejects.toBe(refused)
    await expect(logs.stat(SessionId('root'))).rejects.toBe(refused)
    expect(reportUpgrade.mock.calls).toEqual([[1, 2], [2, 3]])
    expect(contents()).toEqual(before)
  })

  it('creates no set-aside table when every frame is readable', async () => {
    const { logs, inspect, objects } = await fixture()
    writeFrameLayout(inspect)
    await logs.start()
    expect(objects('table')).not.toContain('frames_set_aside')
  })

  it('logs each set-aside frame through the provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-schema-set-aside-'))
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
    onTestFinished(() => { vi.restoreAllMocks() })
    await mkdir(join(root, '.segments'))
    const seeded = new DatabaseSync(join(root, '.segments', 'sessions.sqlite'))
    try {
      writeFrameLayout(seeded, (db) => { db.exec("UPDATE frames SET end_seq = 6 WHERE segment_uuid = 'seg-root' AND start_seq = 3") })
    } finally { seeded.close() }
    const persistence = new SqliteSessionPersistence(ctx, ctx, { root }, {
      hasStoredJsonl: async () => false, list: async () => [], stat: async () => undefined,
      prepare: async () => { throw new Error('no legacy history') },
    })
    await persistence.start()
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      'The Session database upgrade set aside the frame at 3 of Segment seg-root, which holds data that cannot be read; '
      + 'reads that reach it are refused: RangeError: SQLite frame at 3 holds 2 of its 3 recorded events',
    ])
  })

  it('aborts on a version 1 database without the frame tables and leaves it unchanged', async () => {
    const reportUpgrade = vi.fn<(from: number, to: number) => void>()
    const { path, logs, inspect, contents } = await fixture({ reportUpgrade })
    inspect.exec(`CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('kept'); PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1`)
    const before = contents()
    const failure = await upgradeFailure(logs.start(), path)
    expect(failure.cause).toEqual(new Error('schema version 1 is stored without the tables of the frame layout'))
    expect(await rejection(logs.start())).toBe(failure)
    expect(reportUpgrade.mock.calls).toEqual([[1, 2]])
    expect(contents()).toEqual(before)
  })

  it('runs the upgrade again in a store constructed after the failed one', async () => {
    const reportUpgrade = vi.fn<(from: number, to: number) => void>()
    const { root, path, logs, inspect } = await fixture({ reportUpgrade })
    inspect.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1; CREATE TABLE notes (body TEXT)`)
    await upgradeFailure(logs.start(), path)
    await logs.close()
    inspect.exec('DROP TABLE notes')
    writeFrameLayout(inspect)
    const restarted = sqliteLogs(path, root, { reportUpgrade })
    onTestFinished(() => restarted.close())
    expect((await restarted.stat(SessionId('root')))?.eventCount).toBe(framed.root.length)
    expect(reportUpgrade.mock.calls).toEqual([[1, 2], [1, 2], [2, 3]])
  })
})

describe('upgrade steps', () => {
  function database(version: number): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    onTestFinished(() => { db.close() })
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${version}`)
    return db
  }
  const stored = (db: DatabaseSync) => db.prepare('PRAGMA user_version').get()?.user_version
  const options: MigrationOptions = { path: '/stored/sessions.sqlite', compression: 'zstd', sql, onStep: () => {}, onSetAside: () => {} }
  /** A step that records the version it found and, as the last one, creates the current tables. */
  const step = (from: number, seen: number[]): Migration => ({ from, to: from + 1, apply(db) {
    seen.push(Number(stored(db)))
    if (from + 1 === SCHEMA_VERSION) db.exec(sql.text('schema/v3'))
  } })
  /** Every schema object with its columns, without SQLite's own objects. */
  const layout = (db: DatabaseSync) => db.prepare(`SELECT m.type, m.name, (SELECT group_concat(c.name, ' ') FROM pragma_table_xinfo(m.name) c) AS columns
    FROM sqlite_schema m WHERE m.name NOT LIKE 'sqlite_%' ORDER BY m.type, m.name`).all().map(row => [row.type, row.name, row.columns])

  it('declares one step per version up to the current one', () => {
    expect(MIGRATIONS.map(migration => [migration.from, migration.to]))
      .toEqual(Array.from({ length: SCHEMA_VERSION - 1 }, (_, index) => [index + 1, index + 2]))
  })

  it('creates exactly the version 3 objects and columns, derived tables aside', () => {
    const fresh = new DatabaseSync(':memory:')
    onTestFinished(() => { fresh.close() })
    prepareSchema(fresh, options)
    expect(layout(fresh)).toEqual([
      ['index', 'events_by_type', null],
      ['index', 'segments_by_parent', null],
      ['table', 'cold_segments', 'segment_id archive sha256 bytes'],
      ['table', 'events', 'event_no segment_id seq type time surface_op source_seqs ignorable codec data'],
      ['table', 'segment_paths', 'segment_id member_id end_seq'],
      ['table', 'segments', 'segment_id segment_uuid parent_id base_seq'],
      ['table', 'sessions', 'session_key session_id header head_segment_id inherited_count created_at cwd parent_session origin agent_preset last_opened_at'],
      ['trigger', 'events_no_delete', null],
      ['trigger', 'events_no_update', null],
      ['trigger', 'paths_no_delete', null],
      ['trigger', 'paths_no_update', null],
      ['trigger', 'segments_index_paths', null],
      ['trigger', 'segments_no_reparent', null],
      ['view', 'segment_extents', 'segment_id segment_uuid parent_id base_seq event_count'],
      ['view', 'session_events', 'session_id seq type time surface_op source_seqs ignorable codec data segment_id event_no'],
      ['view', 'session_heads', 'session_id header head_segment_id head_segment_uuid inherited_count base_seq event_count'],
      ['view', 'session_segments', 'session_id segment_id end_seq'],
      ['view', 'session_summary', 'session_id created_at cwd parent_session origin agent_preset inherited_count event_count last_event_time'],
    ])
  })

  it('leaves a version 1 database with the schema a new database has', () => {
    const upgraded = new DatabaseSync(':memory:'), fresh = new DatabaseSync(':memory:')
    onTestFinished(() => { upgraded.close(); fresh.close() })
    writeFrameLayout(upgraded)
    prepareSchema(upgraded, options)
    prepareSchema(fresh, options)
    const schema = (db: DatabaseSync) => db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all().map(row => ({
      ...row,
      sql: typeof row.sql === 'string' ? row.sql.replace('\n, ', ',\n  ').replace('DEFAULT 0) STRICT', 'DEFAULT 0\n) STRICT') : row.sql,
    }))
    expect(schema(upgraded)).toEqual(schema(fresh))
    expect(schema(fresh).length).toBeGreaterThan(0)
    for (const db of [upgraded, fresh]) {
      expect(stored(db)).toBe(SCHEMA_VERSION)
      expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: APPLICATION_ID })
    }
  })

  it('runs the version 1 to 2 step from its own statement files and the version 2 schema file alone', () => {
    const db = new DatabaseSync(':memory:'), files = new SqlFiles()
    onTestFinished(() => { db.close() })
    writeFrameLayout(db, (damaged) => { damaged.prepare("UPDATE frames SET payload = ? WHERE segment_uuid = 'seg-grand'").run(Buffer.from('damaged')) })
    const read = vi.spyOn(files, 'text')
    frames.apply(db, { ...options, sql: files })
    const names = read.mock.calls.map(([name]) => name)
    expect(names).toContain('schema/v2')
    expect(names.filter(name => name !== 'schema/v2' && !name.startsWith('upgrade/1-to-2/'))).toEqual([])
    // The damaged frame makes the step run every one of its statements.
    expect(new Set(names)).toEqual(new Set(['schema/v2', ...SQL_FILES.filter(name => name.startsWith('upgrade/1-to-2/'))]))
  })

  it('upgrades a populated version 2 database with derived views from its own statement files and refuses missing tables', () => {
    const db = new DatabaseSync(':memory:'), fresh = new DatabaseSync(':memory:'), files = new SqlFiles()
    onTestFinished(() => { db.close(); fresh.close() })
    db.exec(`${sql.text('schema/v2')}; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 2`)
    const derived = new DerivedTables(DERIVATIONS, () => {}, sql)
    derived.install(db, false)
    db.prepare('INSERT INTO segments (segment_uuid, parent_id, base_seq) VALUES (?, ?, ?)').run('seg-v2', null, 0)
    db.prepare('INSERT INTO sessions (session_id, header, head_segment_id, inherited_count) VALUES (?, ?, ?, ?)')
      .run('v2-session', JSON.stringify(header('v2-session')), 1, 0)
    db.prepare('INSERT INTO tool_calls (segment_id, seq, time, tool, turn, step) VALUES (?, ?, ?, ?, ?, ?)')
      .run(1, 0, 10, 'bash', 1, 1)
    const read = vi.spyOn(files, 'text')
    cold.apply(db, { ...options, sql: files })
    const names = read.mock.calls.map(([name]) => name)
    expect(new Set(names)).toEqual(new Set(SQL_FILES.filter(name => name.startsWith('upgrade/2-to-3/'))))
    prepareSchema(fresh, options)
    derived.install(fresh, false)
    const schema = (target: DatabaseSync) => target.prepare('SELECT type, name, sql FROM sqlite_schema WHERE name != \'sqlite_stat1\' ORDER BY type, name').all().map(row => ({
      ...row,
      sql: typeof row.sql === 'string' ? row.sql.replace('\n, ', ',\n  ').replace('DEFAULT 0) STRICT', 'DEFAULT 0\n) STRICT') : row.sql,
    }))
    expect(schema(db)).toEqual(schema(fresh))
    expect(db.prepare('SELECT session_id, last_opened_at FROM sessions').all().map(row => ({ ...row })))
      .toEqual([{ session_id: 'v2-session', last_opened_at: 0 }])
    expect(db.prepare('SELECT session_id, tool FROM session_tools').all().map(row => ({ ...row })))
      .toEqual([{ session_id: 'v2-session', tool: 'bash' }])
    expect(db.prepare('SELECT * FROM session_llm_calls').all()).toEqual([])

    const incomplete = database(2)
    incomplete.exec('CREATE TABLE notes (body TEXT)')
    expect(() => { cold.apply(incomplete, options) }).toThrow('schema version 2 is stored without the event-row tables')
  })

  it('applies each step from the stored version in order and stamps the version it reaches', () => {
    const db = database(0), seen: number[] = []
    prepareSchema(db, options, [step(1, seen), step(0, seen), step(2, seen)])
    expect(seen).toEqual([0, 1, 2])
    expect(stored(db)).toBe(SCHEMA_VERSION)
  })

  it('tells the owner each step before it runs', () => {
    const db = database(0), order: string[] = []
    const noted = (from: number): Migration => ({ ...step(from, []), apply(target) { order.push(`apply ${from}`); step(from, []).apply(target, options) } })
    prepareSchema(db, { ...options, onStep: (running) => { order.push(`notice ${running.from} to ${running.to}`) } }, [noted(0), noted(1), noted(2)])
    expect(order).toEqual(['notice 0 to 1', 'apply 0', 'notice 1 to 2', 'apply 1', 'notice 2 to 3', 'apply 2'])
  })

  it('skips the steps below the stored version and runs none at the current version', () => {
    const db = database(1), seen: number[] = []
    prepareSchema(db, options, [step(0, seen), step(1, seen), step(2, seen)])
    expect(seen).toEqual([1, 2])
    prepareSchema(db, options, [step(0, seen), step(1, seen), step(2, seen)])
    expect(seen).toEqual([1, 2])
  })

  it('refuses a version that no step reads', () => {
    const db = database(1), seen: number[] = []
    expect(() => { prepareSchema(db, options, [step(0, seen)]) }).toThrow(expect.objectContaining({ code: 'SESSION_STORAGE_FORMAT',
      message: refusal(options.path, 'has schema version 1, which this build cannot upgrade') }))
    expect(seen).toEqual([])
    expect(stored(db)).toBe(1)
  })

  it('refuses steps that reach the current version without its tables', () => {
    const db = database(2)
    expect(() => { prepareSchema(db, options, [{ from: 2, to: 3, apply() {} }]) }).toThrow(expect.objectContaining({ code: 'SESSION_STORAGE_FORMAT',
      message: refusal(options.path, 'has schema version 3 without its tables') }))
  })

  it('wraps the error of a step that throws and leaves the stored version to the caller\'s rollback', () => {
    const db = database(0), seen: number[] = [], refused = new Error('step refused')
    const onStep = vi.fn<MigrationOptions['onStep']>()
    db.exec('BEGIN IMMEDIATE')
    let failure: unknown
    try { prepareSchema(db, { ...options, onStep }, [step(0, seen), { from: 1, to: 2, apply() { throw refused } }, step(2, seen)]) }
    catch (error: unknown) { failure = error }
    db.exec('ROLLBACK')
    expect(failure).toBeInstanceOf(HarnessError)
    expect(failure).toMatchObject({ code: 'SESSION_STORAGE_UPGRADE', cause: refused,
      message: 'Upgrading SQLite persistence database "/stored/sessions.sqlite" from schema version 1 to 2 failed; '
        + 'it is left unchanged. Restore a backup, or open it with the release that wrote it' })
    expect(onStep.mock.calls.map(([running]) => running.from)).toEqual([0, 1])
    expect(seen).toEqual([0])
    expect(stored(db)).toBe(0)
  })
})
