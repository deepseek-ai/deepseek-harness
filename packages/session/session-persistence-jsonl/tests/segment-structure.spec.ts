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
import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { SCHEMA_VERSION } from '@deepseek-ai/dsh-session-persistence-sqlite/src/sqlite.ts'
import { countSqliteReads, forkTrace, sqliteLogs } from './fixtures/segments.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-persistence-')), path = join(root, 'sessions.sqlite')
  const logs = sqliteLogs(path, root)
  onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const id = SessionId('selected')
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }
  const event = (seq: number, text = `event ${seq}`): SessionEvent<'user/message'> => ({ type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq), time: 0,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) })
  return { root, logs, path, id, header, event }
}

it('serializes first-time schema creation across connections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-concurrent-init-'))
  const path = join(root, 'sessions.sqlite')
  const first = sqliteLogs(path, root)
  const second = sqliteLogs(path, root)
  onTestFinished(async () => {
    try { await first.close() } finally { try { await second.close() } finally { await rm(root, { recursive: true, force: true }) } }
  })
  await Promise.all([first.start(), second.start()])
  const db = new DatabaseSync(path)
  try {
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION })
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name))
      .toEqual(expect.arrayContaining(['segments', 'traces', 'events']))
  } finally { db.close() }
})

it('reads an indexed event list by trace_uuid while unrelated malformed lists remain unread', async () => {
  const { logs, path, id, header, event } = await fixture()
  const handle = await logs.create(header)
  await handle.append([event(0), event(1)])
  const db = new DatabaseSync(path)
  try {
    const trace = db.prepare('INSERT INTO traces VALUES (?, ?, ?, 0)')
    const insert = db.prepare('INSERT INTO events VALUES (?, 0, ?)')
    const segment = db.prepare('INSERT INTO segments VALUES (?, NULL, NULL, 0)')
    db.exec('BEGIN')
    for (let index = 0; index < 2048; index++) {
      const other = `other-${index}`
      segment.run(other)
      trace.run(other, JSON.stringify({ ...header, id: other }), other)
      insert.run(other, 'invalid unrelated event '.repeat(700))
    }
    db.exec('COMMIT')
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM events WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?) AND seq >= ? ORDER BY seq LIMIT ?')
      .all(id, 0, 100)
    expect(plan.map(row => row.detail).join(' ')).toContain('USING PRIMARY KEY')
    const reads = countSqliteReads()
    expect((await handle.read(1, 1)).events).toMatchObject([{ seq: 1 }])
    expect(reads.payloadRows()).toBe(1)
    const before = db.prepare('SELECT payload FROM events WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?) ORDER BY seq').all(id)
    await handle.append([event(2)])
    expect(db.prepare('SELECT payload FROM events WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?) AND seq < 2 ORDER BY seq').all(id)).toEqual(before)
    expect(() => db.prepare('UPDATE events SET payload = ? WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?)').run('rewritten', id)).toThrow('append-only')
    expect(() => db.prepare('DELETE FROM events WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?)').run(id)).toThrow('append-only')
    expect(reads.payloadRows()).toBe(1)
    expect((await logs.stat(id))?.eventCount).toBe(3)
  } finally { db.close() }
})

it('forks bounded prefixes into private tails without copying historical event rows', async () => {
  const { logs, path, id, header, event } = await fixture()
  const source = await logs.create(header)
  await source.append([event(0), event(1), event(2), event(3)])
  const db = new DatabaseSync(path)
  try {
    const count = (table: 'traces' | 'segments' | 'events') => z.object({ n: z.number() })
      .parse(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n
    const before = [count('traces'), count('segments'), count('events')]
    const branchId = SessionId('branch')
    await forkTrace(logs, id, branchId, [event(0), event(1)])
    expect([count('traces'), count('segments'), count('events')]).toEqual(before.map(value => value + 1))
    const branch = await logs.open(branchId, 'write')
    expect(branch.inheritedEventCount).toBe(2)
    expect((await branch.read()).events.map(item => item.seq)).toEqual([0, 1, 2])
    await branch.append([event(3, 'branch-only')])
    await source.append([event(4, 'source-only')])
    expect(JSON.stringify((await branch.read()).events)).not.toContain('source-only')
    expect(JSON.stringify((await source.read()).events)).not.toContain('branch-only')
    const beforeForks = [count('traces'), count('segments'), count('events')]
    let current = branchId
    let prefix: SessionEvent[] = (await branch.read()).events
    const reads = countSqliteReads()
    for (let index = 0; index < 128; index++) {
      const next = SessionId(`descendant-${index}`)
      await forkTrace(logs, current, next, prefix)
      prefix = [...prefix, { type: 'session/end-seed', seq: SessionSeq(prefix.length), time: 0, data: { inherited: true } }]
      current = next
    }
    expect([count('traces'), count('segments'), count('events')]).toEqual(beforeForks.map(value => value + 128))
    expect(reads.payloadRows()).toBe(0)
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
    expect(() => { db.exec('UPDATE segment_ancestors SET end_seq = 0') }).toThrow('immutable')
    expect(() => { db.exec('DELETE FROM segment_ancestors') }).toThrow('immutable')
  } finally { db.close() }
})

it('rolls back the whole appended batch and its cursor when an insert fails', async () => {
  const { logs, path, id, header, event } = await fixture()
  const handle = await logs.create(header)
  await handle.append([event(0)])
  const db = new DatabaseSync(path)
  try {
    const before = db.prepare('SELECT * FROM traces WHERE trace_uuid = ?').get(id)
    db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON events WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END")
    await expect(handle.append([event(1), event(2)])).rejects.toThrow('fixture insert failure')
    expect(db.prepare('SELECT seq FROM events WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?) ORDER BY seq').all(id)).toMatchObject([{ seq: 0 }])
    expect(db.prepare('SELECT * FROM traces WHERE trace_uuid = ?').get(id)).toEqual(before)
    await handle.flush()
    await handle.close()
    db.exec('DROP TRIGGER reject_fixture')
    const restored = await logs.open(id, 'write')
    await restored.append([event(1)])
    expect((await restored.read()).events).toHaveLength(2)
  } finally { db.close() }
})

it('refuses an incompatible database version while retaining its schema and payloads', async () => {
  const { root, logs, path, header, id, event } = await fixture()
  const handle = await logs.create(header)
  await handle.append([event(0)])
  await handle.close()
  await logs.close()
  const db = new DatabaseSync(path)
  const before = db.prepare('SELECT payload FROM events').all()
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  db.close()
  const refused = sqliteLogs(path, root)
  await expect(refused.stat(id)).rejects.toMatchObject({ code: 'SESSION_STORAGE_FORMAT' })
  await expect(refused.close()).resolves.toBeUndefined()
  const inspect = new DatabaseSync(path)
  try {
    expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION + 1 })
    expect(inspect.prepare('SELECT payload FROM events').all()).toEqual(before)
  } finally { inspect.close() }
})

it('recovers append positions from the event index without updating Trace or Segment metadata', async () => {
  const { root, logs, path, id, header, event } = await fixture()
  const handle = await logs.create(header)
  await handle.flush()
  const db = new DatabaseSync(path)
  try {
    for (const table of ['traces', 'segments']) {
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
    onTestFinished(() => reopened.close())
    expect(await reopened.stat(id)).toEqual(first)
    const writer = await reopened.open(id, 'write')
    await writer.append([event(2)])
    expect((await writer.read()).events.map(item => item.seq)).toEqual([0, 1, 2])
    expect((await reopened.stat(id))?.eventCount).toBe(3)
    await writer.close()
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT seq FROM events WHERE segment_uuid = ? ORDER BY seq DESC LIMIT 1').all('unused')
    expect(plan.map(row => row.detail).join(' ')).toContain('SEARCH events USING PRIMARY KEY')
  } finally { db.close() }
})


it('stores logical JSON events and reads their source coordinates from an indexed suffix', async () => {
  const { root, logs, path, header, event } = await fixture()
  const ranged = { ...event(4), sourceEventSeqs: [SessionSeq(0), SessionSeq(1), SessionSeq(2)] }
  const batch = [event(0), event(1), event(2), event(3), ranged]
  const writer = await logs.create(header)
  await writer.append(batch)
  await writer.close()
  await logs.close()
  const db = new DatabaseSync(path)
  try {
    const row = z.object({ payload: z.string() }).parse(db.prepare('SELECT payload FROM events WHERE seq = 4').get())
    const physical = z.object({ sourceEventSeqs: z.unknown() }).loose().parse(JSON.parse(row.payload))
    expect(physical).toEqual(ranged)
    expect(physical.sourceEventSeqs).toEqual([0, 1, 2])
    const stored = z.object({ header: z.string() }).parse(db.prepare('SELECT header FROM traces').get())
    expect(JSON.parse(stored.header)).toEqual({ ...header, delegationDepth: 0 })
  } finally { db.close() }
  const reopened = sqliteLogs(path, root)
  onTestFinished(() => reopened.close())
  const reader = await reopened.open(header.id, 'read')
  try {
    expect((await reader.read(4, 1)).events).toEqual([ranged])
    expect((await reader.read()).events).toEqual(batch)
  } finally { await reader.close() }
})

it('reads existing logical SQLite headers and event arrays without rewriting them', async () => {
  const { root, logs, path, header, event } = await fixture()
  const writer = await logs.create(header)
  const original = { ...event(3), sourceEventSeqs: [SessionSeq(0), SessionSeq(1), SessionSeq(2)] }
  await writer.append([event(0), event(1), event(2), original])
  await writer.close()
  await logs.close()
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER events_no_update')
    db.prepare('UPDATE events SET payload = ? WHERE seq = 3').run(JSON.stringify(original))
    db.prepare('UPDATE traces SET header = ?').run(JSON.stringify(header))
  } finally { db.close() }
  const reopened = sqliteLogs(path, root)
  onTestFinished(() => reopened.close())
  const reader = await reopened.open(header.id, 'read')
  try {
    expect(reader.header).toEqual({ ...header, delegationDepth: 0 })
    expect((await reader.read(3, 1)).events).toEqual([original])
  } finally { await reader.close() }
})

it('refuses retired V4 tool rows before committing a SQLite batch', async () => {
  const { logs, path, header, event } = await fixture()
  const writer = await logs.create(header)
  await writer.append([event(0)])
  // The durable write boundary must reject a retired payload despite its typed caller.
  const malformed = z.custom<SessionEvent>().parse({ type: 'tool/result', seq: 1, time: 0,
    data: { message: { role: 'user' } } })
  await expect(writer.append([malformed])).rejects.toThrow(/first-class message/)
  await writer.close()
  const db = new DatabaseSync(path, { readOnly: true })
  try { expect(db.prepare('SELECT count(*) AS n FROM events').get()).toMatchObject({ n: 1 }) }
  finally { db.close() }
})

it.each([{ seq: -1 }, { seq: 0.5 }, { seq: '0' }, { time: 0.5 }, { unexpected: true }])(
  'refuses malformed durable envelope %j before returning events', async (fields) => {
    const { logs, path, header, event } = await fixture()
    const writer = await logs.create(header)
    await writer.append([event(0)])
    await writer.close()
    const db = new DatabaseSync(path)
    try {
      db.exec('DROP TRIGGER events_no_update')
      db.prepare('UPDATE events SET payload = ?').run(JSON.stringify({ ...event(0), ...fields }))
    } finally { db.close() }
    const reader = await logs.open(header.id, 'read')
    try { await expect(reader.read()).rejects.toBeInstanceOf(SessionPersistenceCorruptionError) }
    finally { await reader.close() }
  },
)

it.each([null, 1, new Uint8Array([1, 2])])('refuses non-text payload %j in a corrupted SQLite table', async (payload) => {
  const { logs, path, header, event } = await fixture()
  const writer = await logs.create(header)
  await writer.append([event(0)])
  await writer.close()
  const db = new DatabaseSync(path)
  try {
    const head = db.prepare('SELECT tail_segment_uuid FROM traces').get()?.['tail_segment_uuid']
    if (typeof head !== 'string') throw new Error('fixture trace has no segment')
    db.exec('DROP TABLE events; CREATE TABLE events (segment_uuid TEXT, seq INTEGER, payload ANY) STRICT')
    db.prepare('INSERT INTO events VALUES (?, 0, ?)').run(head, payload)
  } finally { db.close() }
  const reader = await logs.open(header.id, 'read')
  try { await expect(reader.read()).rejects.toBeInstanceOf(SessionPersistenceCorruptionError) }
  finally { await reader.close() }
})


it('classifies retired V4 SQLite rows as unsupported when reading durable input', async () => {
  const { logs, path, header, event } = await fixture()
  const writer = await logs.create(header)
  await writer.append([event(0)])
  await writer.close()
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER events_no_update')
    db.prepare('UPDATE events SET payload = ?').run(JSON.stringify({ type: 'tool/code-dispatch', seq: 0, time: 0, data: {} }))
  } finally { db.close() }
  const reader = await logs.open(header.id, 'read')
  try { await expect(reader.read()).rejects.toBeInstanceOf(SessionFormatUnsupportedError) }
  finally { await reader.close() }
})

it('rejects malformed indexed predecessor metadata before returning an inherited event slice', async () => {
  const { logs, path, id, header, event } = await fixture()
  const writer = await logs.create(header)
  const prefix = [event(0)]
  await writer.append(prefix)
  await writer.close()
  const child = SessionId('invalid-ancestor')
  await forkTrace(logs, id, child, prefix)
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER segments_no_reparent; PRAGMA ignore_check_constraints = ON')
    db.exec('UPDATE segments SET parent_end_seq = -1 WHERE parent_segment_uuid IS NULL')
    const reader = await logs.open(child, 'read')
    await expect(reader.read(0, 1)).rejects.toThrow('predecessor metadata is invalid')
    await reader.close()
  } finally { db.close() }
})
