/** SQLite durable-data refusals, failed transactions, and ownership cleanup. @module */
import { mkdir, mkdtemp, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError, SessionFormatUnsupportedError, SessionHandleClosedError,
  SessionPersistenceCorruptionError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SessionWriteLease } from '../src/lease.ts'
import { SqliteSessionPersistence } from '../src/persistence.ts'
import { sharedHistory, sqliteLogs } from './fixtures/store.ts'
import { persistenceFixture } from './fixtures/persistence.ts'

/** A coded refusal or an error class from a durable read. */
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
  const fixture = await persistenceFixture()
  const { context: ctx, persistence: storage } = await fixture.mount('sqlite')
  if (!(storage instanceof SqliteSessionPersistence)) throw new Error('Missing SQLite provider')
  return { root: fixture.root, ctx, storage }
}
async function raw(publish: () => Promise<void> = async () => {}, failedClose = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-failures-')), path = join(root, 'events.sqlite')
  const report = vi.fn()
  const logs = sqliteLogs(path, root, { publish, report })
  onTestFinished(async () => {
    try {
      if (failedClose) await expect(logs.close()).rejects.toMatchObject({ message: 'SQLite disposal failed', errors: [expect.any(Error)] })
      else await logs.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  return { logs, path, root, report }
}

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
  if (fault === 'missing-row') await expectRefusal(storage.list(), list)
  else expect(await storage.list()).toHaveLength(1)
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
    await sharedHistory(logs, header().id, SessionId('child'), [event(0)])
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

it('aggregates failed writer barriers and disposal failures without losing their cause', async () => {
  const { logs, path } = await raw(async () => {}, true)
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

it('refuses importing a legacy identity already committed in SQLite', async () => {
  const { logs } = await raw()
  await logs.importLegacy(header(), SessionLogOffset(0), [])
  await expect(logs.importLegacy(header(), SessionLogOffset(0), [])).rejects.toBeInstanceOf(SessionAlreadyExistsError)
})

it('keeps an absent materialization a no-op', async () => {
  const { logs } = await raw()
  await logs.materialize(header())
})

it('aggregates write-open validation and ownership cleanup failures', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const { SessionWriteLease } = await import('../src/lease.ts')
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the lease receiver below.
  const release = SessionWriteLease.prototype.release
  const fault = vi.spyOn(SessionWriteLease.prototype, 'release').mockImplementation(async function (this: SessionWriteLease) {
    await release.call(this)
    throw new Error('release failed')
  })
  const read = vi.spyOn(logs, 'read').mockRejectedValue(new Error('history failed'))
  try { await expect(logs.open(header().id, 'write')).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error)] }) }
  finally { fault.mockRestore(); read.mockRestore() }
})

it('aggregates creation refusal and shared ownership rollback failure', async () => {
  const { logs } = await raw()
  const { SessionWriteLease } = await import('../src/lease.ts')
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  let calls = 0
  const fault = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, id) => {
    if (++calls === 2) throw new Error('artifact refused')
    const lease = await acquire(dir, id)
    const release = lease.release.bind(lease)
    lease.release = async () => { await release(); throw new Error('rollback failed') }
    return lease
  })
  const writer = await logs.create(header())
  try { await expect(writer.flush()).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error)] }) }
  finally { fault.mockRestore(); await writer.close() }
})

it.each([1, 2])('reports %i owned lease release failures', async (failures) => {
  const { logs } = await raw()
  const { SessionWriteLease } = await import('../src/lease.ts')
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  let acquired = 0
  const fault = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, id) => {
    const lease = await acquire(dir, id)
    const release = lease.release.bind(lease)
    if (++acquired <= failures) lease.release = async () => { await release(); throw new Error('release failed') }
    return lease
  })
  const writer = await logs.create(header())
  try {
    await writer.flush()
    await expect(writer.close()).rejects.toThrow(failures === 1 ? 'release failed' : 'SQLite write ownership release failed')
  } finally { fault.mockRestore() }
})

it('refuses initializing a missing database when Session routing records remain', async () => {
  const { logs, root, path } = await raw()
  await mkdir(join(root, '.segments'))
  await writeFile(join(root, '.segments/source.json'), JSON.stringify({ id: 'source', database: path }))
  await expect(logs.start()).rejects.toMatchObject({ code: 'SESSION_STORAGE_MISSING' })
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('leaves an unrelated unversioned SQLite database intact', async () => {
  const { logs, path } = await raw()
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE unrelated (value TEXT)')
    await expect(logs.start()).rejects.toMatchObject({ code: 'SESSION_STORAGE_FORMAT' })
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([{ name: 'unrelated' }])
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 0 })
  } finally { db.close() }
})

it('reports an absent Session in an existing database', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  await expect(logs.open(SessionId('absent'), 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
})

it('refuses a non-text payload in a damaged durable event table', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)]); await writer.close()
  const db = new DatabaseSync(path)
  try {
    const head = db.prepare('SELECT tail_segment_uuid FROM traces').get()?.['tail_segment_uuid']
    if (typeof head !== 'string') throw new Error('Missing Session segment')
    db.exec('DROP TABLE events; CREATE TABLE events (segment_uuid TEXT, seq INTEGER, payload ANY) STRICT')
    db.prepare('INSERT INTO events VALUES (?, 0, ?)').run(head, null)
  } finally { db.close() }
  const reader = await logs.open(header().id, 'read')
  try { await expect(reader.read()).rejects.toBeInstanceOf(SessionPersistenceCorruptionError) }
  finally { await reader.close() }
})

it('classifies retired V4 events as unsupported when reading durable rows', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)]); await writer.close()
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER events_no_update')
    db.prepare('UPDATE events SET payload = ?').run(JSON.stringify({ type: 'tool/code-dispatch', seq: 0, time: 0, data: {} }))
  } finally { db.close() }
  const reader = await logs.open(header().id, 'read')
  try { await expect(reader.read()).rejects.toBeInstanceOf(SessionFormatUnsupportedError) }
  finally { await reader.close() }
})

it('refuses invalid indexed predecessor metadata before returning inherited events', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0), event(1)]); await writer.close()
  await sharedHistory(logs, header().id, SessionId('child'), [event(0), event(1)])
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER segments_no_reparent; PRAGMA ignore_check_constraints = ON')
    db.exec('UPDATE segments SET parent_end_seq = -1 WHERE parent_segment_uuid IS NULL')
  } finally { db.close() }
  await expect(sharedHistory(logs, SessionId('child'), SessionId('bad-cut'), [event(0)])).rejects.toThrow('predecessor metadata is invalid')
  const reader = await logs.open(SessionId('child'), 'read')
  try { await expect(reader.read(0, 1)).rejects.toThrow('predecessor metadata is invalid') }
  finally { await reader.close() }
})

it('forks an earlier ancestor prefix and refuses invalid ancestry during cut selection', async () => {
  const { logs, path } = await raw()
  const source = await logs.create(header()); await source.append([event(0), event(1), event(2)]); await source.close()
  await sharedHistory(logs, header().id, SessionId('child'), [event(0), event(1)])
  await sharedHistory(logs, SessionId('child'), SessionId('grandchild'), [event(0)])
  const grandchild = await logs.open(SessionId('grandchild'), 'read')
  try { expect((await grandchild.read()).events.map(item => item.seq)).toEqual([0, 1]) }
  finally { await grandchild.close() }
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER ancestors_no_update; DROP TRIGGER ancestors_no_delete')
    db.exec("UPDATE segment_ancestors SET end_seq = 0 WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = 'child')")
    await expect(sharedHistory(logs, SessionId('child'), SessionId('invalid'), [event(0)])).rejects.toThrow('offset')
    db.exec("DELETE FROM segment_ancestors WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = 'child')")
    await expect(sharedHistory(logs, SessionId('child'), SessionId('invalid'), [event(0)])).rejects.toThrow('chain')
  } finally { db.close() }
})

it('ignores events from a Session without a persistence writer', async () => {
  const { ctx, storage } = await fixture()
  const session = ctx.sessions.create(header().id)
  session.append('turn/start', { turn: 1 })
  await storage.flush()
  expect(await storage.stat(session.id)).toBeUndefined()
})

it('reports a database close failure after draining and releasing the writer', async () => {
  const { logs } = await raw(async () => {}, true)
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const failure = Object.assign(new Error('database close failed'), { code: 'EIO' })
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the intercepted database receiver.
  const close = DatabaseSync.prototype.close
  const fault = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementationOnce(function (this: DatabaseSync) {
    close.call(this)
    throw failure
  })
  try { await expect(logs.close()).rejects.toMatchObject({ message: 'SQLite disposal failed', errors: [failure] }) }
  finally { fault.mockRestore() }
})
