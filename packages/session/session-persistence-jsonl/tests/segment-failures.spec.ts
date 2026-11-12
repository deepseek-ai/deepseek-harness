/** Segment routing refusal, batching and failed-commit recovery. @module */
import { mkdir, mkdtemp, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionFormatUnsupportedError, SessionHandleClosedError,
  SessionPersistenceCorruptionError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import * as plugin from '../src/index.ts'
import { sessionDir } from '../src/format.ts'
import { SessionWriteLease } from '@deepseek-ai/dsh-session-persistence-sqlite/src/lease.ts'
import { TracePersistence } from '../src/persistence.ts'
import { SqliteLogs, SqliteTrace } from '@deepseek-ai/dsh-session-persistence-sqlite/src/sqlite.ts'
import { forkTrace, routeOf, sqliteLogs } from './fixtures/segments.ts'

/** An expected rejection: a typed error class, or the code and optional message of a coded error. */
type Refusal = { readonly code: string; readonly message?: string } | (new (...args: never[]) => Error)
async function expectRefusal(operation: Promise<unknown>, refusal: Refusal): Promise<void> {
  if (typeof refusal === 'function') await expect(operation).rejects.toBeInstanceOf(refusal)
  else await expect(operation).rejects.toMatchObject(refusal)
}
const header = (id = 'source'): SessionHeader => ({ version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false })
const event = (seq: number): SessionEvent => seq % 2 === 0
  ? { type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn: seq / 2 + 1 } }
  : { type: 'turn/end', seq: SessionSeq(seq), time: 0, data: { turn: (seq + 1) / 2, reason: { kind: 'completed' } } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-failures-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(plugin, { root, compression: 'none' })
  const storage = ctx.sessionPersistence
  if (!(storage instanceof TracePersistence)) throw new Error('Missing Segment operations')
  return { root, ctx, storage }
}
async function raw(publish: () => Promise<void> = async () => {}, count = 2, failedClose = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-buffer-')), path = join(root, 'events.sqlite')
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const report = vi.fn()
  const logs = sqliteLogs(path, root, { publish, maxBufferedEvents: count, report })
  onTestFinished(async () => {
    if (failedClose) await expect(logs.close()).rejects.toMatchObject({ message: 'SQLite disposal failed', errors: [expect.any(Error)] })
    else await logs.close()
  })
  return { logs, path, root, report }
}

it('preserves seeded history and SQLite storage across provider replacement', async () => {
  const { storage, root } = await fixture()
  const source = await storage.create(header())
  await source.append([event(0), event(1)])
  await source.close()
  expect(await routeOf(root, header().id)).toBe('sqlite')
  const child = SessionId('child')
  const createChild = async () => {
    const writer = await storage.create({ ...header('child'), isSeeded: true }, { inheritedEventCount: SessionLogOffset(1) })
    await writer.append([event(0), { type: 'session/end-seed', seq: SessionSeq(1), time: 0, data: { inherited: true } }])
    await writer.close()
  }
  await createChild()
  await expect(createChild()).rejects.toBeInstanceOf(SessionAlreadyExistsError)
  const other = new Context()
  onTestFinished(() => other.fiber.dispose())
  await other.plugin(plugin, { root, compression: 'none' })
  const reader = await other.sessionPersistence.open(child, 'read')
  expect((await reader.read()).events.map(item => item.seq)).toEqual([0, 1])
  await reader.close()
  const old = await other.sessionPersistence.create(header('legacy'))
  await old.flush(); await old.close()
  expect(await routeOf(root, SessionId('legacy'))).toBe('sqlite')
})

it.each([
  { fault: 'identity', open: { code: 'SESSION_STORAGE_IDENTITY' }, list: { code: 'SESSION_STORAGE_IDENTITY' } },
  { fault: 'missing-row', open: SessionPersistenceNotFoundError, list: { code: 'SESSION_STORAGE_MISSING' } },
  { fault: 'invalid-json', open: { code: 'SESSION_STORAGE_CORRUPT' }, list: { code: 'SESSION_STORAGE_CORRUPT' } },
] as const)('refuses $fault without creating a JSONL fallback', async ({ fault, open, list }) => {
  const { storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.flush(); await writer.close()
  const directory = join(root, '.segments')
  const route = (await readdir(directory)).find(name => name.endsWith('.json'))
  if (route === undefined) throw new Error('Missing route')
  const path = join(directory, route)
  if (fault === 'identity') {
    const value = z.object({ id: z.string(), database: z.string() }).parse(JSON.parse(await readFile(path, 'utf8')))
    await writeFile(path, JSON.stringify({ ...value, database: '/wrong.sqlite' }))
  } else if (fault === 'invalid-json') await writeFile(path, 'invalid')
  else {
    const db = new DatabaseSync(join(directory, 'sessions.sqlite'))
    try { db.prepare('DELETE FROM traces WHERE trace_uuid = ?').run('source') } finally { db.close() }
  }
  await expectRefusal(storage.open(header().id, 'write'), open)
  await expectRefusal(storage.list(), list)
  expect((await readdir(root, { recursive: true })).some(name => name.endsWith('.jsonl'))).toBe(false)
})

it('creates a SQLite Session when .segments has no routing records and the database is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-empty-routing-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.segments'))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(plugin, { root })
  const writer = await ctx.sessionPersistence.create(header('new-jsonl'))
  await writer.flush(); await writer.close()
  expect(await ctx.sessionPersistence.stat(header('new-jsonl').id)).toBeDefined()
})

it('refuses new JSONL creation when routing records outlive a missing Segment database', async () => {
  const { ctx, storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.flush(); await writer.close()
  await ctx.fiber.dispose()
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(join(root, '.segments', `sessions.sqlite${suffix}`), { force: true })
  }
  const other = new Context()
  onTestFinished(() => other.fiber.dispose())
  await expect(other.plugin(plugin, { root })).rejects.toMatchObject({ code: 'SESSION_STORAGE_MISSING' })
  await expect(stat(join(root, '.segments', 'sessions.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readdir(root, { recursive: true })).some(name => name.endsWith('.jsonl'))).toBe(false)
})

it.each([
  { label: 'corrupt', stored: '{invalid', error: SessionPersistenceCorruptionError },
  { label: 'future-version', stored: JSON.stringify({ ...header(), version: SESSION_FORMAT_VERSION + 1 }), error: SessionFormatUnsupportedError },
])('omits a $label SQLite header from list while direct access still rejects', async ({ stored, error }) => {
  const { storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.append([event(0)]); await writer.close()
  const healthy = await storage.create(header('healthy')); await healthy.append([event(0)]); await healthy.close()
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  try {
    db.prepare('UPDATE traces SET header = ? WHERE trace_uuid = ?').run(stored, header().id)
  } finally { db.close() }
  await expect(storage.open(header().id, 'read')).rejects.toBeInstanceOf(error)
  await expect(storage.stat(header().id)).rejects.toBeInstanceOf(error)
  expect((await storage.list()).map(entry => entry.header.id)).toEqual([SessionId('healthy')])
})

it('rejects the listing when a stored SQLite header names another Session', async () => {
  const { storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.append([event(0)]); await writer.close()
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  try {
    db.prepare('UPDATE traces SET header = ? WHERE trace_uuid = ?').run(JSON.stringify(header('other')), header().id)
  } finally { db.close() }
  await expect(storage.list()).rejects.toThrow('identity mismatch')
})

it.each(['{}', '[]', 'null', '4', JSON.stringify({ version: 4.5 }), JSON.stringify({ version: SESSION_FORMAT_VERSION, id: 'source' })])(
  'classifies an invalid stored SQLite header %#',
  async (storedHeader) => {
    const { storage, root } = await fixture()
    const writer = await storage.create(header()); await writer.append([event(0)]); await writer.close()
    const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
    try {
      db.prepare('UPDATE traces SET header = ? WHERE trace_uuid = ?').run(storedHeader, header().id)
    } finally { db.close() }
    await expect(storage.open(header().id, 'read')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  },
)

it('classifies a non-database SQLite file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-corrupt-db-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'sessions.sqlite')
  await writeFile(path, 'not a database')
  const logs = sqliteLogs(path, root)
  onTestFinished(async () => { await logs.close().catch(() => undefined) })
  await expect(logs.stat(header().id)).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
})

it('fails on invalid selected event data while unrelated Session bodies remain readable', async () => {
  const { storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.append([event(0)]); await writer.close()
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  try {
    db.exec('DROP TRIGGER events_no_update')
    db.prepare('UPDATE events SET payload = ?').run('invalid')
  } finally { db.close() }
  await expect(storage.open(header().id, 'write')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  const replacement = await storage.create(header('healthy')); await replacement.flush(); await replacement.close()
  expect(await storage.stat(SessionId('healthy'))).toMatchObject({ eventCount: 0 })
})

it('refuses a fork create when its source row is missing', async () => {
  const { logs } = await raw()
  await expect(logs.create(header('child'), { inheritedEventCount: SessionLogOffset(0) }, { sourceId: SessionId('absent'), endSeq: 0 }))
    .rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
})

it('discards events from a read cancelled while the SQLite query runs', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)]); await writer.close()
  const reader = await logs.open(header().id, 'read')
  const controller = new AbortController()
  const read = logs.read.bind(logs)
  const spy = vi.spyOn(logs, 'read').mockImplementationOnce(async (...args) => {
    const events = await read(...args)
    controller.abort(new Error('cancelled during query'))
    return events
  })
  onTestFinished(() => { spy.mockRestore() })
  await expect(reader.read(0, undefined, { signal: controller.signal })).rejects.toThrow('cancelled during query')
  expect((await reader.read()).events.map(item => item.seq)).toEqual([0])
  await reader.close()
})

it('flushes at the count threshold and drains a following batch at close', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header())
  await writer.receive(event(0)); await writer.receive(event(1))
  await vi.waitFor(async () => { expect((await logs.stat(header().id))?.eventCount).toBe(2) })
  await writer.receive(event(2))
  await writer.close()
  expect((await logs.stat(header().id))?.eventCount).toBe(3)
})

it('keeps a fixed batching deadline and removes the timer on close', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header())
  vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers() })
  await writer.receive(event(0))
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(150)
  expect((await logs.stat(header().id))?.eventCount).toBeUndefined()
  await vi.advanceTimersByTimeAsync(50)
  await vi.waitFor(async () => { expect((await logs.stat(header().id))?.eventCount).toBe(1) })
  expect(vi.getTimerCount()).toBe(0)
  await writer.receive(event(1)); await writer.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('retains a rolled-back live batch and retries it in sequence at the next checkpoint', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
    await writer.receive(event(0))
    await expect(writer.flush()).rejects.toThrow('injected write failure')
    expect((await logs.stat(header().id))?.eventCount).toBe(0)
    db.exec('DROP TRIGGER fail_append')
    await writer.receive(event(1)); await writer.flush()
    expect((await writer.read()).events.map(item => item.seq)).toEqual([0, 1])
  } finally { db.close() }
  await writer.close()
})

it.each(['append', 'flush'] as const)('refuses further writes when %s commits but routing publication fails', async (operation) => {
  let reject = true
  const { logs } = await raw(async () => { if (reject) throw new Error('publication unavailable') })
  const writer = await logs.create(header())
  const failure = await (operation === 'append' ? writer.append([event(0)]) : writer.flush()).then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION', cause: { message: 'publication unavailable' } })
  reject = false
  // The retained publication failure refuses later writes and is reported again at close.
  await expect(writer.append([event(operation === 'append' ? 1 : 0)])).rejects.toBe(failure)
  await expect(writer.close()).rejects.toBe(failure)
})

it('preserves complete Session metadata without exposing Segment identifiers', async () => {
  const { logs } = await raw()
  const meta: SessionHeader = { ...header(), cwd: tmpdir(), parentSession: SessionId('parent'), origin: 'subagent', delegationDepth: 2, agentPreset: 'test' }
  const writer = await logs.create(meta); await writer.flush(); await writer.close()
  const reader = await logs.open(meta.id, 'read')
  expect(reader.header).toEqual(meta)
  await reader[Symbol.asyncDispose]()
})

it.each([
  { fault: 'missing-segment', error: SessionPersistenceCorruptionError },
  { fault: 'missing-parent', error: { code: 'SESSION_STORAGE_CORRUPT', message: 'Trace references a missing segment' } },
  { fault: 'cycle', error: { code: 'SESSION_STORAGE_CORRUPT', message: 'Invalid Trace segment chain' } },
  { fault: 'missing-prefix', error: SessionPersistenceCorruptionError },
  { fault: 'offset', error: { code: 'SESSION_STORAGE_CORRUPT', message: 'Invalid segment offset' } },
  { fault: 'event-hole', error: { code: 'SESSION_STORAGE_CORRUPT', message: 'SQLite segment is incomplete' } },
  { fault: 'identity', error: { code: 'SESSION_STORAGE_CORRUPT', message: 'SQLite Trace identity mismatch' } },
] as const)(
  'refuses corrupted $fault instead of returning partial history', async ({ fault, error }) => {
    const { logs, path } = await raw()
    const source = await logs.create(header()); await source.append([event(0), event(1)]); await source.close()
    await forkTrace(logs, header().id, SessionId('child'), [event(0)])
    const reader = await logs.open(SessionId('child'), 'read')
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON; DROP TRIGGER segments_no_reparent; DROP TRIGGER events_no_delete;')
      const head = "(SELECT tail_segment_uuid FROM traces WHERE trace_uuid = 'child')"
      if (fault === 'missing-segment') db.exec(`DELETE FROM segments WHERE segment_uuid = ${head}`)
      if (fault === 'missing-parent') db.exec(`UPDATE segments SET parent_segment_uuid = 'absent' WHERE segment_uuid = ${head}`)
      if (fault === 'cycle') db.exec(`UPDATE segments SET parent_segment_uuid = segment_uuid, parent_end_seq = 0 WHERE segment_uuid = ${head}`)
      if (fault === 'missing-prefix') db.exec(`UPDATE segments SET parent_segment_uuid = NULL, parent_end_seq = NULL WHERE segment_uuid = ${head}`)
      if (fault === 'offset') db.exec(`UPDATE segments SET parent_end_seq = 0 WHERE segment_uuid = ${head}`)
      if (fault === 'event-hole') db.exec(`INSERT INTO events SELECT segment_uuid, 1, payload FROM events WHERE segment_uuid = ${head}; DELETE FROM events WHERE segment_uuid = ${head} AND seq = 0`)
      if (fault === 'identity') db.prepare("UPDATE traces SET header = ? WHERE trace_uuid = 'child'").run(JSON.stringify(header('other')))
      await expectRefusal(fault === 'identity' ? logs.open(SessionId('child'), 'read') : reader.read(), error)
    } finally { db.close(); await reader.close() }
  })

it('forks from the empty prefix and refuses an absent source or an existing target', async () => {
  const { logs } = await raw()
  const source = await logs.create(header()); await source.append([event(0)]); await source.close()
  await forkTrace(logs, header().id, SessionId('empty'), [])
  const child = await logs.open(SessionId('empty'), 'read')
  expect((await child.read()).events.map(item => item.type)).toEqual(['session/end-seed'])
  await child.close()
  await expect(forkTrace(logs, SessionId('absent'), SessionId('new'), [])).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  await expect(forkTrace(logs, header().id, SessionId('empty'), [])).rejects.toBeInstanceOf(SessionAlreadyExistsError)
})

it('rejects a second provider writer and permits it after the owning writer closes', async () => {
  const { logs, path, root } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const other = sqliteLogs(path, root)
  try {
    await expect(other.create(header())).rejects.toBeInstanceOf(SessionAlreadyExistsError)
    await expect(other.open(header().id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await writer.close()
    const next = await other.open(header().id, 'write'); await next.close()
  } finally { await other.close() }
})

it('releases admission claims when durable metadata disappears during write-lease acquisition', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const db = new DatabaseSync(path)
  try {
    db.prepare('DELETE FROM traces WHERE trace_uuid = ?').run(header().id)
    await expect(logs.open(header().id, 'write')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    expect(await logs.stat(header().id)).toBeUndefined()
  } finally { db.close() }
})

it('does not recreate a missing database while durable routing records remain', async () => {
  const { logs, root } = await raw()
  const directory = join(root, '.segments')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(directory)
  await writeFile(join(directory, 'retained.json'), '{}')
  await expect(logs.create(header())).rejects.toThrow('database is missing')
})

it('refuses an unrelated existing SQLite database without adding Session tables', async () => {
  const { logs, path } = await raw()
  const db = new DatabaseSync(path)
  try { db.exec('CREATE TABLE unrelated (id INTEGER)') } finally { db.close() }
  await expect(logs.create(header())).rejects.toMatchObject({ code: 'SESSION_STORAGE_FORMAT', message: 'Refusing an unrelated SQLite database' })
  await expect(logs.close()).resolves.toBeUndefined()
})

it('bounds every live batch while events continue arriving during an active commit', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const append = logs.append.bind(logs)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const batches: number[] = []
  const spy = vi.spyOn(logs, 'append').mockImplementationOnce(async (meta, batch) => { batches.push(batch.length); await gate; await append(meta, batch) })
  onTestFinished(() =>{  spy.mockRestore() })
  await writer.receive(event(0)); await writer.receive(event(1))
  for (let index = 2; index < 7; index++) await writer.receive(event(index))
  if (release === undefined) throw new Error('Missing commit gate')
  release()
  await writer.flush()
  expect((await writer.read()).events.map(item => item.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
  expect(spy.mock.calls.every(([, batch]) => batch.length <= 2)).toBe(true)
  expect(batches).toEqual([2])
  await writer.close()
})

it('preserves admitted live events when the drain before an explicit append fails', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'rollback'); END")
    await writer.receive(event(0))
    await expect(writer.append([event(1)])).rejects.toThrow('rollback')
    db.exec('DROP TRIGGER fail_append')
    await writer.flush()
    expect((await writer.read()).events.map(item => item.seq)).toEqual([0])
    await writer.append([event(1)])
  } finally { db.close(); await writer.close() }
})

it('drains admitted live events before writing an explicit batch', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  await writer.receive(event(0)); await writer.receive(event(1))
  await writer.append([event(2)])
  expect((await writer.read()).events.map(item => item.seq)).toEqual([0, 1, 2])
  await writer.close()
})

it('keeps admitted live events when an explicit append is aborted', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  await writer.receive(event(0))
  const controller = new AbortController(); controller.abort()
  await expect(writer.append([event(1)], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  await writer.flush()
  expect((await writer.read()).events.map(item => item.seq)).toEqual([0])
  await writer.append([event(1)])
  expect((await writer.read()).events.map(item => item.seq)).toEqual([0, 1])
  await writer.close()
})

it('reports background failure once, pauses the timer and retries through the explicit checkpoint', async () => {
  const { logs, path, report: warning } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers() })
  try {
    db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'background rollback'); END")
    await writer.receive(event(0)); await vi.advanceTimersByTimeAsync(200)
    expect(warning).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    db.exec('DROP TRIGGER fail_append')
    await writer.flush()
    expect((await writer.read()).events).toHaveLength(1)
  } finally { db.close(); await writer.close() }
})

it('marks live writes unusable after a commit whose routing publication failed', async () => {
  let reject = false
  const { logs } = await raw(async () => { if (reject) throw new Error('publication failed') })
  const writer = await logs.create(header()); await writer.flush()
  reject = true
  await writer.receive(event(0))
  const failure = await writer.flush().then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION', cause: { message: 'publication failed' } })
  await expect(writer.close()).rejects.toBe(failure)
})

it('refuses live events on a closed handle and keeps close idempotent', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.close()
  const failure = await writer.receive(event(0)).then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_FAILED' })
  expect(failure instanceof Error ? failure.cause : undefined).toBeInstanceOf(SessionHandleClosedError)
  await writer.close()
})

it('isolates an unknown transaction outcome and releases the writer when the database closes', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
  const exec = DatabaseSync.prototype.exec
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'COMMIT' || sql === 'ROLLBACK') throw new Error('transaction outcome unavailable')
    exec.call(this, sql)
  })
  try {
    const failure = await writer.append([event(0)]).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN', cause: { errors: [{ message: 'transaction outcome unavailable' }, { message: 'transaction outcome unavailable' }] } })
    // Every later operation of the store rejects with the same retained refusal.
    await expect(logs.stat(header().id)).rejects.toBe(failure)
    await expect(writer.append([event(0)])).rejects.toBe(failure)
  } finally { spy.mockRestore(); await writer.close() }
})

it('marks unknown when COMMIT fails even if ROLLBACK succeeds', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
  const exec = DatabaseSync.prototype.exec
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'COMMIT') throw new Error('commit outcome unavailable')
    exec.call(this, sql)
  })
  try {
    const failure = await writer.append([event(0)]).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN', cause: { message: 'commit outcome unavailable' } })
    await expect(logs.stat(header().id)).rejects.toBe(failure)
  } finally { spy.mockRestore(); await writer.close() }
})

it('aggregates drain and release failures on close', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER fail_close BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'drain failed'); END")
    await writer.receive(event(0))
    // oxlint-disable-next-line typescript/unbound-method -- Called with the lease instance as receiver.
    const original = SessionWriteLease.prototype.release
    SessionWriteLease.prototype.release = async function (this: SessionWriteLease) {
      await original.call(this)
      throw new Error('release failed')
    }
    try {
      const failure = await writer.close().then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      const messages = (failure as AggregateError).errors.map(String)
      expect(messages.some(message => message.includes('drain failed'))).toBe(true)
      expect(messages.some(message => message.includes('release failed'))).toBe(true)
    } finally { SessionWriteLease.prototype.release = original }
  } finally { db.close() }
})

it('marks unknown when an operation failure and its rollback both fail', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'operation failed'); END")
    // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
    const exec = DatabaseSync.prototype.exec
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'ROLLBACK') throw new Error('rollback unavailable')
      exec.call(this, sql)
    })
    try {
      await expect(writer.append([event(0)])).rejects.toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN',
        cause: { errors: [{ message: 'operation failed' }, { message: 'rollback unavailable' }] } })
    } finally { spy.mockRestore() }
  } finally { db.close() }
})

it('rejects new operations after provider close', async () => {
  const { logs } = await raw()
  await logs.close()
  await expect(logs.create(header())).rejects.toThrow('closing')
  await expect(logs.open(header().id, 'read')).rejects.toThrow('closing')
})

it('commits the first of two cross-provider pending creates and refuses the other', async () => {
  const { logs, path, root } = await raw()
  const writer = await logs.create(header())
  const other = sqliteLogs(path, root)
  try {
    const loser = await other.create(header())
    await writer.append([event(0)])
    await expect(loser.append([event(0)])).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await writer.close()
    await expect(loser.append([event(0)])).rejects.toBeInstanceOf(SessionAlreadyExistsError)
    await loser.close()
    expect((await other.stat(header().id))?.eventCount).toBe(1)
  } finally { await other.close(); await writer.close() }
})

it('leaves no session directory for a created Session closed before its first commit', async () => {
  const { logs, root } = await raw()
  const writer = await logs.create({ ...header(), cwd: join(root, 'project') })
  await writer.close()
  expect((await readdir(root)).filter(name => !name.endsWith('.sqlite') && !name.includes('.sqlite-'))).toEqual([])
})

it('forks an earlier ancestor prefix and rejects malformed ancestry during cut selection', async () => {
  const { logs, path } = await raw()
  const source = await logs.create(header()); await source.append([event(0), event(1), event(2)]); await source.close()
  await forkTrace(logs, header().id, SessionId('child'), [event(0), event(1)])
  await forkTrace(logs, SessionId('child'), SessionId('grandchild'), [event(0)])
  const grandchild = await logs.open(SessionId('grandchild'), 'read')
  expect((await grandchild.read()).events.map(item => item.seq)).toEqual([0, 1])
  await grandchild.close()
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER segments_no_reparent; PRAGMA ignore_check_constraints = ON')
    db.exec("UPDATE segments SET parent_end_seq = 0 WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = 'child')")
    await expect(forkTrace(logs, SessionId('child'), SessionId('invalid'), [event(0)])).rejects.toThrow('offset')
    db.exec("UPDATE segments SET parent_segment_uuid = segment_uuid WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = 'child')")
    await expect(forkTrace(logs, SessionId('child'), SessionId('invalid'), [event(0)])).rejects.toThrow('chain')
  } finally { db.close() }
})

it('drains follow-up events automatically when they arrive during a timer commit', async () => {
  const { logs } = await raw(async () => {}, 10)
  const writer = await logs.create(header()); await writer.flush()
  vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers() })
  const append = logs.append.bind(logs)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const spy = vi.spyOn(logs, 'append').mockImplementationOnce(async (...args) => { await gate; await append(...args) })
  onTestFinished(() =>{  spy.mockRestore() })
  await writer.receive(event(0)); await vi.advanceTimersByTimeAsync(200)
  await writer.receive(event(1))
  if (release === undefined) throw new Error('Missing gate')
  release(); await writer.drainLive()
  await vi.advanceTimersByTimeAsync(200)
  await writer.drainLive()
  expect((await logs.stat(header().id))?.eventCount).toBe(2)
  await writer.close()
})

it('retains live events and reports a count-triggered background rejection', async () => {
  const { logs, report: warning } = await raw(async () => {}, 1)
  const writer = await logs.create(header()); await writer.flush()
  const spy = vi.spyOn(logs, 'append').mockRejectedValueOnce(new Error('background write refused'))
  onTestFinished(() => { spy.mockRestore() })
  await writer.receive(event(0))
  await expect(writer.drainLive()).rejects.toThrow('background write refused')
  expect(warning).toHaveBeenCalledOnce()
  await writer.flush(); await writer.close()
})

it('aggregates failed writer barriers and disposal failures without losing their cause', async () => {
  const { logs, path } = await raw(async () => {}, 256, true)
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'persistent failure'); END")
    await writer.receive(event(0))
    await expect(logs.flush()).rejects.toMatchObject({ message: 'SQLite flush failed', errors: [expect.any(Error)] })
    await expect(logs.close()).rejects.toMatchObject({ message: 'SQLite disposal failed', errors: [expect.any(Error)] })
  } finally { db.close() }
})

it('joins an already closing writer during a provider flush', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)])
  const append = logs.append.bind(logs), gate = Promise.withResolvers<undefined>()
  const spy = vi.spyOn(logs, 'append').mockImplementationOnce(async (...args) => { await gate.promise; await append(...args) })
  onTestFinished(() => { gate.resolve(undefined); spy.mockRestore() })
  await writer.receive(event(1))
  const closing = writer.close()
  let flushed = false
  const flush = logs.flush().then(() => { flushed = true })
  await new Promise(resolve => setImmediate(resolve))
  // The provider barrier joins the closing writer's held drain instead of resolving around it.
  expect(flushed).toBe(false)
  gate.resolve(undefined)
  await flush
  expect((await logs.stat(header().id))?.eventCount).toBe(2)
  await closing
})

it('materializes pending metadata through listing and releases abandoned creates', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header())
  expect((await logs.scan()).entries).toHaveLength(1)
  const pendingReader = await logs.open(header().id, 'read')
  expect((await pendingReader.read()).events).toEqual([])
  await pendingReader.close(); await writer.close()
  expect((await logs.scan()).entries).toEqual([])
})

it('refuses a missing parent Session row before appending and preserves the committed payloads', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)])
  const db = new DatabaseSync(path)
  try {
    db.prepare('DELETE FROM traces WHERE trace_uuid = ?').run(header().id)
    await expect(writer.read()).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    await expect(writer.append([event(1)])).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  } finally { db.close(); await writer.close() }
})

it('lists without a missing-Session refusal while another Session publishes during the scan', async () => {
  const { storage } = await fixture()
  const existing = await storage.create(header('existing')); await existing.flush(); await existing.close()
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted store as receiver below.
  const scan = SqliteLogs.prototype.scan
  const spy = vi.spyOn(SqliteLogs.prototype, 'scan').mockImplementationOnce(async function (this: SqliteLogs, ...args) {
    const result = await scan.apply(this, args)
    const late = await storage.create(header('late')); await late.flush(); await late.close()
    return result
  })
  onTestFinished(() => { spy.mockRestore() })
  expect((await storage.list()).map(entry => entry.header.id)).toEqual([SessionId('existing')])
  expect((await storage.list()).map(entry => entry.header.id).sort()).toEqual([SessionId('existing'), SessionId('late')])
})

it('waits for a durability barrier instead of retrying each count-triggered batch after a failure', async () => {
  const { logs, path, report } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  onTestFinished(() => { db.close() })
  db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'down'); END")
  const append = vi.spyOn(logs, 'append')
  onTestFinished(() => { append.mockRestore() })
  await writer.receive(event(0)); await writer.receive(event(1))
  await vi.waitFor(() => { expect(report).toHaveBeenCalledOnce() })
  for (let seq = 2; seq < 12; seq++) await writer.receive(event(seq))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(append).toHaveBeenCalledOnce()
  expect(report).toHaveBeenCalledOnce()
  db.exec('DROP TRIGGER fail_append')
  await writer.flush()
  expect((await logs.stat(header().id))?.eventCount).toBe(12)
  await writer.close()
})

it('logs a background live-write failure through the provider logger', async () => {
  const { ctx, storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.flush()
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  onTestFinished(() => { db.close() })
  db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'background down'); END")
  const error = vi.spyOn(Object.getPrototypeOf(ctx.logger) as { error: (...args: unknown[]) => void }, 'error').mockImplementation(() => {})
  onTestFinished(() => { error.mockRestore() })
  if (!(writer instanceof SqliteTrace)) throw new Error('Expected a SQLite handle')
  await writer.receive(event(0)); await writer.receive(event(1))
  await vi.waitFor(() => { expect(error).toHaveBeenCalledWith(expect.stringContaining('background down')) })
  db.exec('DROP TRIGGER fail_append')
  await writer.flush(); await writer.close()
})

it('reports listener failures and joins successful consumer teardown through the owning scope', async () => {
  const { logs } = await raw()
  const { SessionStore } = await import('@deepseek-ai/dsh-session')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  logs.install(ctx)
  const session = ctx.sessions.create(header().id)
  const writer = await logs.create(session.header)
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const receive = vi.spyOn(writer, 'receive').mockRejectedValueOnce(new Error('event admission refused'))
  const close = vi.spyOn(writer, 'close').mockRejectedValueOnce(new Error('close refused'))
  onTestFinished(() => { error.mockRestore(); receive.mockRestore(); close.mockRestore() })
  ctx.emit('session/event', session, event(0))
  ctx.emit('session/disposed', session)
  await vi.waitFor(() => { expect(error).toHaveBeenCalledTimes(2) })
  expect(error.mock.calls.map(([message]) => String(message)).sort()).toEqual([
    'SQLite handle close failed for source: Error: close refused',
    'SQLite persistence failed for source: Error: event admission refused',
  ])
  close.mockRestore(); receive.mockRestore()
  await writer.close()
  await ctx.fiber.dispose()
})

it('keeps a created Session pending when its first-commit lease fails for an I/O reason', async () => {
  const { logs } = await raw()
  const spy = vi.spyOn(SessionWriteLease, 'acquire').mockRejectedValueOnce(new Error('lock path denied'))
  try {
    const writer = await logs.create(header())
    await expect(writer.append([event(0)])).rejects.toThrow('lock path denied')
    expect((await logs.stat(header().id))?.eventCount).toBeUndefined()
    await writer.append([event(0)])
    expect((await logs.stat(header().id))?.eventCount).toBe(1)
    await writer.close()
  } finally { spy.mockRestore() }
})

it('releases admission leases when close wins a pending writer open', async () => {
  const { logs, path, root } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  const spy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementationOnce(async (...args) => {
    await logs.close()
    return acquire(...args)
  })
  try { await expect(logs.open(header().id, 'write')).rejects.toThrow('closing') }
  finally { spy.mockRestore() }
  const other = sqliteLogs(path, root)
  try { const writer = await other.open(header().id, 'write'); await writer.close() } finally { await other.close() }
})

it('releases admission leases when the selected row disappears during open', async () => {
  const { logs, path, root } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  const spy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementationOnce(async (...args) => {
    const db = new DatabaseSync(path)
    try { db.prepare('DELETE FROM traces WHERE trace_uuid = ?').run(header().id) } finally { db.close() }
    return acquire(...args)
  })
  try {
    await expect(logs.open(header().id, 'write')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  } finally { spy.mockRestore() }
  // The kernel lock is per open file description, so a leaked lease refuses this same-process acquire.
  const lease = await SessionWriteLease.acquire(sessionDir(root, undefined, header().id), header().id)
  await lease.release()
  const recreated = await logs.create(header())
  await recreated.flush(); await recreated.close()
})

it('refuses opening a missing database without creating it', async () => {
  const { logs, path } = await raw()
  await expect(logs.open(header().id, 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a stale append position after the durable tail grows', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)])
  const db = new DatabaseSync(path)
  try {
    db.prepare('INSERT INTO events SELECT segment_uuid, 1, ? FROM segments').run(JSON.stringify(event(1)))
    await expect(writer.append([event(1)])).rejects.toThrow('append seq mismatch for "source": expected 2 at index 0, got 1')
  } finally { db.close(); await writer.close() }
})

it('rolls back materialization when a database trigger removes its new metadata', async () => {
  const { logs, path } = await raw()
  const committed = await logs.create(header()); await committed.flush(); await committed.close()
  const writer = await logs.create(header('pending'))
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TRIGGER remove_new_trace AFTER INSERT ON traces BEGIN DELETE FROM traces WHERE trace_uuid = NEW.trace_uuid; END')
    await expect(writer.flush()).rejects.toMatchObject({ code: 'SESSION_STORAGE_CORRUPT', message: 'Committed Session metadata is unavailable' })
    db.exec('DROP TRIGGER remove_new_trace')
    await writer.flush()
  } finally { db.close(); await writer.close() }
})

it('refuses fork if the source disappears while acquiring its write lease', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  const spy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementationOnce(async (...args) => {
    const db = new DatabaseSync(path)
    try { db.prepare('DELETE FROM traces WHERE trace_uuid = ?').run(header().id) } finally { db.close() }
    return acquire(...args)
  })
  try {
    await expect(forkTrace(logs, header().id, SessionId('child'), [])).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  } finally { spy.mockRestore() }
})

it('rejects a corrupt stored header identity during stat', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const db = new DatabaseSync(path)
  try { db.prepare('UPDATE traces SET header = ?').run(JSON.stringify(header('different'))) } finally { db.close() }
  await expect(logs.stat(header().id)).rejects.toThrow('identity mismatch')
})

it('includes pending creates beside materialized metadata and tolerates a pending entry disappearing', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const pending = await logs.create(header('pending'))
  expect((await logs.scan()).entries).toHaveLength(2)
  const stat = logs.stat.bind(logs)
  const spy = vi.spyOn(logs, 'stat').mockImplementation(async id => id === SessionId('pending') ? undefined : stat(id))
  expect((await logs.scan()).entries).toHaveLength(1)
  spy.mockRestore(); await pending.close()
})

it('rejects queued work after a preceding commit failed to publish its routing record', async () => {
  const { logs } = await raw(async () => { throw new Error('publish unavailable') })
  const writer = await logs.create(header())
  const first = writer.append([event(0)]), queued = writer.append([event(1)])
  const failure = await first.then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION', cause: { message: 'publish unavailable' } })
  await expect(queued).rejects.toBe(failure)
  await expect(writer.close()).rejects.toBe(failure)
})

it('drains the remainder of a bounded batch during close', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const append = logs.append.bind(logs)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const spy = vi.spyOn(logs, 'append').mockImplementationOnce(async (...args) => { await gate; await append(...args) })
  await writer.receive(event(0)); await writer.receive(event(1)); await writer.receive(event(2))
  const closing = writer.close()
  if (release === undefined) throw new Error('Missing gate')
  release(); await closing
  spy.mockRestore()
  expect((await logs.stat(header().id))?.eventCount).toBe(3)
})

it('drains the due follow-up after an active commit and reports its rejection', async () => {
  const { logs, report: warning } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers() })
  const append = logs.append.bind(logs)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const spy = vi.spyOn(logs, 'append')
    .mockImplementationOnce(async (...args) => { await gate; await append(...args) })
    .mockRejectedValueOnce(new Error('follow-up failed'))
  onTestFinished(() => { spy.mockRestore() })
  await writer.receive(event(0)); await writer.receive(event(1)); await writer.receive(event(2))
  await vi.advanceTimersByTimeAsync(200)
  if (release === undefined) throw new Error('Missing commit gate')
  release(); await expect(writer.drainLive()).rejects.toThrow('follow-up failed')
  expect(warning).toHaveBeenCalled()
  await writer.flush(); await writer.close()
})

it('does not append an unpublished create into a Session another directory writer already materialized', async () => {
  const { logs, path, root } = await raw()
  const first = await logs.create({ ...header(), cwd: join(root, 'project-a') })
  const other = sqliteLogs(path, root)
  try {
    const winner = await other.create({ ...header(), cwd: join(root, 'project-b') })
    await winner.flush()
    await expect(first.append([event(0)])).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await winner.close()
    await expect(first.append([event(0)])).rejects.toBeInstanceOf(SessionAlreadyExistsError)
    await first.close()
    expect(await logs.stat(header().id)).toMatchObject({ header: { cwd: join(root, 'project-b') }, eventCount: 0 })
    await winner.close()
  } finally { await first.close(); await other.close() }
})

it('rejects already-cancelled create, open, stat and list on SQLite-backed storage without side effects', async () => {
  const { storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.append([event(0)]); await writer.close()
  const controller = new AbortController(); controller.abort()
  const signal = controller.signal
  const aborted = { name: 'AbortError' }
  await expect(storage.create(header('cancelled'), { signal })).rejects.toMatchObject(aborted)
  await expect(storage.open(header().id, 'write', { signal })).rejects.toMatchObject(aborted)
  await expect(storage.open(header().id, 'read', { signal })).rejects.toMatchObject(aborted)
  await expect(storage.stat(header().id, { signal })).rejects.toMatchObject(aborted)
  await expect(storage.list({ signal })).rejects.toMatchObject(aborted)
  // The cancelled write open left no lease, and the cancelled create reserved nothing.
  const lease = await SessionWriteLease.acquire(sessionDir(root, undefined, header().id), header().id)
  await lease.release()
  expect(await storage.stat(header('cancelled').id)).toBeUndefined()
  expect((await storage.list()).map(entry => entry.header.id)).toEqual([header().id])
})
