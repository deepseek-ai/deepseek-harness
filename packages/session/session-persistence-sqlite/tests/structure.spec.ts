/** SQLite list ordering, indexed reads and atomic append failures for Segment persistence. @module */
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SCHEMA_VERSION } from '../src/schema.ts'
import { countSqliteReads, headSegment, sharedHistory, sqliteLogs, storedEvents, storedRows } from './fixtures/store.ts'
import type { SqliteStoreOptions } from '../src/sqlite.ts'

async function fixture(overrides: Partial<SqliteStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-persistence-')), path = join(root, 'sessions.sqlite')
  const logs = sqliteLogs(path, root, overrides)
  onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const id = SessionId('selected')
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }
  const event = (seq: number, text = `event ${seq}`): SessionEvent<'user/message'> => ({ type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq), time: 0,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) })
  return { root, logs, path, id, header, event }
}

it('selects a cut inside an earlier ancestor rather than sharing the later child suffix', async () => {
  const { logs, id, header, event } = await fixture()
  await using parent = await logs.create(header)
  const prefix = [event(0), event(1), event(2)]
  await parent.append(prefix)
  const childId = SessionId('later-child'), descendantId = SessionId('earlier-cut')
  await sharedHistory(logs, id, childId, prefix)
  await sharedHistory(logs, childId, descendantId, prefix.slice(0, 1))
  await using descendant = await logs.open(descendantId, 'read')
  expect((await descendant.read()).events).toEqual([
    prefix[0], { type: 'session/end-seed', seq: SessionSeq(1), time: 0, data: { inherited: true } },
  ])
})

it('forks bounded prefixes into private tails without copying historical event rows', async () => {
  const { logs, path, id, header, event } = await fixture()
  const reads = countSqliteReads()
  const source = await logs.create(header)
  const sourcePrefix = [event(0), event(1), event(2), event(3)]
  await source.append(sourcePrefix)
  const db = new DatabaseSync(path)
  try {
    const count = (table: 'sessions' | 'segments' | 'events') => z.object({ n: z.number() })
      .parse(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n
    const before = [count('sessions'), count('segments'), count('events')]
    const branchId = SessionId('branch')
    await sharedHistory(logs, id, branchId, sourcePrefix.slice(0, 2))
    expect([count('sessions'), count('segments'), count('events')]).toEqual(before.map(value => value + 1))
    const branch = await logs.open(branchId, 'write')
    expect(branch.inheritedEventCount).toBe(2)
    expect((await branch.read()).events.map(item => item.seq)).toEqual([0, 1, 2])
    await branch.append([event(3, 'branch-only')])
    await source.append([event(4, 'source-only')])
    expect(JSON.stringify((await branch.read()).events)).not.toContain('source-only')
    expect(JSON.stringify((await source.read()).events)).not.toContain('branch-only')
    const beforeForks = [count('sessions'), count('segments'), count('events')]
    let current = branchId
    let prefix: SessionEvent[] = (await branch.read()).events
    const beforeRows = reads.eventRows()
    for (let index = 0; index < 128; index++) {
      const next = SessionId(`descendant-${index}`)
      await sharedHistory(logs, current, next, prefix)
      prefix = [...prefix, { type: 'session/end-seed', seq: SessionSeq(prefix.length), time: 0, data: { inherited: true } }]
      current = next
    }
    expect([count('sessions'), count('segments'), count('events')]).toEqual(beforeForks.map(value => value + 128))
    expect(reads.eventRows() - beforeRows).toBe(0)
    const last = await logs.open(current, 'read')
    const beforeTail = reads.segmentQueries()
    expect((await last.read(131, 1)).events).toHaveLength(1)
    expect(reads.segmentQueries() - beforeTail).toBe(1)
    expect((await last.read()).events).toHaveLength(132)
    const warm = reads.segmentQueries()
    expect((await last.read(0, 1)).events).toHaveLength(1)
    expect(reads.segmentQueries() - warm).toBe(1)
    await last.close()
    const reopened = await logs.open(current, 'read'), cold = reads.segmentQueries()
    expect((await reopened.read(0, 1)).events).toHaveLength(1)
    expect(reads.segmentQueries() - cold).toBe(2)
  } finally { db.close() }
})

it('rolls back the whole appended batch and its cursor when a later event insert fails', async () => {
  const { logs, path, id, header, event } = await fixture()
  const handle = await logs.create(header)
  await handle.append([event(0)])
  const db = new DatabaseSync(path)
  try {
    const before = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id)
    db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON events WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END")
    await expect(handle.append([event(1), event(2)])).rejects.toThrow('fixture insert failure')
    expect(storedRows(db, headSegment(db, id)).map(row => row.seq)).toEqual([0])
    expect(db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id)).toEqual(before)
    await handle.flush()
    await handle.close()
    db.exec('DROP TRIGGER reject_fixture')
    const restored = await logs.open(id, 'write')
    await restored.append([event(1)])
    expect((await restored.read()).events).toHaveLength(2)
  } finally { db.close() }
})

it('refuses an incompatible database version while retaining its schema and event rows', async () => {
  const { root, logs, path, header, id, event } = await fixture()
  const handle = await logs.create(header)
  await handle.append([event(0)])
  await handle.close()
  await logs.close()
  const db = new DatabaseSync(path)
  const before = db.prepare('SELECT * FROM events').all()
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  db.close()
  const refused = sqliteLogs(path, root)
  await expect(refused.stat(id)).rejects.toMatchObject({ code: 'SESSION_STORAGE_FORMAT' })
  await expect(refused.close()).resolves.toBeUndefined()
  const inspect = new DatabaseSync(path)
  try {
    expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION + 1 })
    expect(inspect.prepare('SELECT * FROM events').all()).toEqual(before)
  } finally { inspect.close() }
})

it('recovers append positions from the event index without updating Session or Segment metadata', async () => {
  const { root, logs, path, id, header, event } = await fixture()
  const handle = await logs.create(header)
  await handle.flush()
  const db = new DatabaseSync(path)
  try {
    for (const table of ['sessions', 'segments']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)
      expect(columns).not.toContain('next_seq')
      expect(columns).not.toContain('revision')
      db.exec(`CREATE TRIGGER reject_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'metadata update'); END`)
    }
    const empty = await logs.stat(id)
    await handle.append([event(0), event(1)])
    const first = await logs.stat(id)
    expect(first?.eventCount).toBe(2)
    expect(first?.revision).not.toBe(empty?.revision)
    await handle.close()
    await logs.close()
    const reopened = sqliteLogs(path, root)
    try {
      expect(await reopened.stat(id)).toEqual(first)
      await using writer = await reopened.open(id, 'write')
      await writer.append([event(2)])
      expect((await writer.read()).events.map(item => item.seq)).toEqual([0, 1, 2])
      expect((await reopened.stat(id))?.eventCount).toBe(3)
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT seq + 1 FROM events WHERE segment_id = ? ORDER BY seq DESC LIMIT 1').all(0)
      expect(plan.map(row => row.detail).join(' ')).toMatch(/SEARCH events USING (COVERING )?INDEX sqlite_autoindex_events_1/)
    } finally { await reopened.close() }
  } finally { db.close() }
})

it('stores logical JSON events in rows and reads their source coordinates from an indexed suffix', async () => {
  const { root, logs, path, header, event } = await fixture()
  const ranged = { ...event(4), sourceEventSeqs: [SessionSeq(0), SessionSeq(1), SessionSeq(2)] }
  const batch = [event(0), event(1), event(2), event(3), ranged]
  const writer = await logs.create(header)
  await writer.append(batch)
  await writer.close()
  await logs.close()
  const db = new DatabaseSync(path)
  try {
    const physical = z.object({ sourceEventSeqs: z.unknown() }).loose().parse(storedEvents(db, headSegment(db, header.id))[4])
    expect(physical).toEqual(ranged)
    expect(physical.sourceEventSeqs).toEqual([0, 1, 2])
    const stored = z.object({ header: z.string() }).parse(db.prepare('SELECT header FROM sessions').get())
    expect(JSON.parse(stored.header)).toEqual({ ...header, delegationDepth: 0 })
  } finally { db.close() }
  const reopened = sqliteLogs(path, root)
  try {
    await using reader = await reopened.open(header.id, 'read')
    expect((await reader.read(4, 1)).events).toEqual([ranged])
    expect((await reader.read()).events).toEqual(batch)
  } finally { await reopened.close() }
})

it('reads an empty inherited prefix from its independent child Segment', async () => {
  const { logs, id, header } = await fixture()
  const writer = await logs.create(header)
  await writer.flush()
  await sharedHistory(logs, id, SessionId('empty-child'), [])
  const child = await logs.open(SessionId('empty-child'), 'read')
  try { expect((await child.read()).events).toMatchObject([{ type: 'session/end-seed', seq: 0 }]) }
  finally { await child.close(); await writer.close() }
})

it('reads long histories across row decode groups and restores headers without an explicit delegation depth', async () => {
  const { logs, header, event } = await fixture()
  const events = Array.from({ length: 2050 }, (_, seq) => event(seq))
  const writer = await logs.create(header)
  await writer.append(events)
  expect(await logs.read(header, 0, events.length)).toEqual(events)
  await writer.close()
})
