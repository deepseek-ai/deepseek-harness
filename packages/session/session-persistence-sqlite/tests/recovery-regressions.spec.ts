/** Initialization retries, automatic rollbacks, and durable parent writes. @module */
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { sqliteLogs, forkSession } from './fixtures/store.ts'
import { persistenceFixture } from './fixtures/persistence.ts'

async function fixture(recovery?: 'replace' | 'report') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-recovery-'))
  const path = join(root, 'sessions.sqlite')
  const logs = sqliteLogs(path, root, recovery === undefined ? {} : { recovery })
  onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const header = (name: string): SessionHeader => ({ version: SESSION_FORMAT_VERSION, id: SessionId(name), createdAt: 0, isSeeded: false })
  const event = (seq: number): SessionEvent<'turn/start'> => ({ type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn: seq + 1 } })
  return { root, path, logs, header, event }
}

it('reports a lock as locked, never as corruption, and refuses nothing on close', async () => {
  const { path, logs, header } = await fixture('report')
  const blocker = new DatabaseSync(path)
  try {
    blocker.exec('BEGIN IMMEDIATE')
    // Expire the busy budget without racing the test's own deadline.
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(5000)
    let failure: unknown
    try { failure = await logs.start().then(() => undefined, (error: unknown) => error) }
    finally { clock.mockRestore() }
    expect(failure).toMatchObject({ code: 'SESSION_STORAGE_LOCKED', cause: { errcode: 5 } })
    expect(failure).not.toBeInstanceOf(SessionPersistenceCorruptionError)
    blocker.exec('ROLLBACK')
    await logs.start()
    const writer = await logs.create(header('retry'))
    await writer.flush(); await writer.close()
    expect(await logs.stat(writer.id)).toMatchObject({ eventCount: 0 })
    await expect(logs.close()).resolves.toBeUndefined()
  } finally { blocker.close() }
})

it('reports a live writer instead of replacing its database, on every platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-locked-')), path = join(root, 'sessions.sqlite')
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const reportRecovery = vi.fn<(detail: string) => void>()
  const logs = sqliteLogs(path, root, { reportRecovery })
  onTestFinished(async () => { await logs.close().catch(() => undefined) })
  const blocker = new DatabaseSync(path)
  let failure: unknown
  try {
    blocker.exec('BEGIN IMMEDIATE')
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(5000)
    try { await logs.start() } catch (error: unknown) { failure = error } finally { clock.mockRestore() }
  } finally { blocker.close() }
  // A lock is a live writer, not damage: SQLite releases its locks when a process exits, so replacing the file would
  // leave that writer appending to bytes no Session reads. Every platform reports the lock and keeps the database.
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_LOCKED' })
  expect(reportRecovery).not.toHaveBeenCalled()
  expect((await readdir(root)).some(name => name.includes('.unreadable-'))).toBe(false)
  expect((await stat(path)).isFile()).toBe(true)
})

it('retains retryable state after SQLite automatically rolls back an append', async () => {
  const { path, logs, header, event } = await fixture()
  const writer = await logs.create(header('source'))
  await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER auto_rollback BEFORE INSERT ON events BEGIN SELECT RAISE(ROLLBACK, 'automatic rollback'); END")
    await expect(writer.append([event(0)])).rejects.toThrow('automatic rollback')
    expect((await logs.stat(writer.id))?.eventCount).toBe(0)
    db.exec('DROP TRIGGER auto_rollback')
    await writer.append([event(0)])
    expect((await writer.read()).events).toEqual([event(0)])
    await writer.close()
  } finally { db.close() }
})

it('closes after an initialization failure even when it has no database connection to release', async () => {
  const { logs } = await fixture()
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its database receiver.
  const exec = DatabaseSync.prototype.exec
  const denied = Object.assign(new Error('opening denied'), { errcode: 14 })
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'BEGIN IMMEDIATE') throw denied
    exec.call(this, sql)
  })
  try { await expect(logs.start()).rejects.toBe(denied) } finally { fault.mockRestore() }
  await expect(logs.close()).resolves.toBeUndefined()
})

it.each([0, 1] as const)('forks a live parent with %i events after its durability checkpoint', async (count) => {
  const { path, logs, header, event } = await fixture()
  const parent = await logs.create(header('parent'))
  const prefix = count === 0 ? [] : [event(0)]
  for (const entry of prefix) await parent.receive(entry)
  await parent.flush()
  await forkSession(logs, parent.id, SessionId('child'), prefix)
  const child = await logs.open(SessionId('child'), 'read')
  try {
    expect((await child.read()).events).toMatchObject([...prefix, { type: 'session/end-seed', seq: count }])
  } finally { await child.close() }
  const db = new DatabaseSync(path)
  try {
    expect(db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(parent.id)).toEqual({ session_id: parent.id })
  } finally { db.close() }
  expect((await parent.read()).events).toEqual(prefix)
  await parent.close()
})

it('retries the same append after SQLITE_FULL automatically ends its transaction', async () => {
  const { logs, header } = await fixture()
  const writer = await logs.create(header('disk-full'))
  await writer.flush()
  const entry: SessionEvent<'user/message'> = {
    type: 'user/message', surfaceOp: 'append', seq: SessionSeq(0), time: 0,
    // Random text stays large after compression, so the page cap below rejects the write.
    data: createUserMessage({ content: [{ type: 'text', text: randomBytes(256 * 1024).toString('base64') }], source: { kind: 'user' } }),
  }
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its database receiver.
  const exec = DatabaseSync.prototype.exec
  let connection: DatabaseSync | undefined
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'BEGIN IMMEDIATE' && connection === undefined) {
      // oxlint-disable-next-line typescript/no-this-alias -- Retain the native connection to remove its page limit after failure.
      connection = this
      const pages = this.prepare('PRAGMA page_count').get()?.page_count
      if (typeof pages !== 'number') throw new Error('Expected a page count')
      exec.call(this, `PRAGMA max_page_count = ${pages}`)
    }
    exec.call(this, sql)
  })
  try {
    await expect(writer.append([entry])).rejects.toMatchObject({ errcode: 13 })
    expect(connection?.isTransaction).toBe(false)
  } finally {
    fault.mockRestore()
    connection?.exec('PRAGMA max_page_count = 2147483646')
  }
  expect((await logs.stat(writer.id))?.eventCount).toBe(0)
  await writer.append([entry])
  expect((await writer.read()).events).toEqual([entry])
  await writer.close()
})

it('joins an initialization that rejects while disposal is already waiting', async () => {
  const { logs } = await fixture()
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its database receiver.
  const exec = DatabaseSync.prototype.exec
  const denied = new Error('initialization interrupted')
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'BEGIN IMMEDIATE') throw denied
    exec.call(this, sql)
  })
  try {
    const opening = logs.start()
    const closing = logs.close()
    await expect(opening).rejects.toBe(denied)
    await expect(closing).resolves.toBeUndefined()
  } finally { fault.mockRestore() }
})

it('retains unknown outcome when COMMIT ended the transaction before reporting failure', async () => {
  const { path, logs, header, event } = await fixture()
  const writer = await logs.create(header('commit-ended'))
  await writer.flush()
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its database receiver.
  const exec = DatabaseSync.prototype.exec
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    exec.call(this, sql)
    if (sql === 'COMMIT') throw new Error('commit outcome unavailable')
  })
  try {
    await expect(writer.append([event(0)])).rejects.toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN' })
  } finally { fault.mockRestore() }
  await expect(logs.stat(writer.id)).rejects.toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN' })
  const db = new DatabaseSync(path)
  try { expect(db.prepare('SELECT count(*) AS count FROM events').get()?.count).toBe(1) } finally { db.close() }
  await writer.close()
})

it.each([
  ['the connection pragmas', 'PRAGMA foreign_keys = ON'],
  ['a schema statement inside the open transaction', 'CREATE TABLE IF NOT EXISTS derivations'],
] as const)('reports a lock raised by %s as locked, never as damage', async (_where, marker) => {
  const { logs } = await fixture('report')
  const busy = Object.assign(new Error('database is locked'), { errcode: 5 })
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the intercepted member as receiver.
  const prepare = DatabaseSync.prototype.prepare
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the intercepted member as receiver.
  const exec = DatabaseSync.prototype.exec
  const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql.includes(marker)) throw busy
    exec.call(this, sql)
  })
  const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql.includes(marker)) throw busy
    return prepare.call(this, sql)
  })
  try {
    await expect(logs.start()).rejects.toMatchObject({ code: 'SESSION_STORAGE_LOCKED', cause: busy })
  } finally { execSpy.mockRestore(); prepareSpy.mockRestore() }
})
it('moves the routing records with a damaged database, so listing Sessions works after recovery', async () => {
  const { root, mount } = await persistenceFixture()
  const first = await mount('sqlite')
  // `create` on the provider commits the Session and publishes its routing record under `.segments`.
  const writer = await first.persistence.create({ version: SESSION_FORMAT_VERSION, id: SessionId('routed'), createdAt: 0, isSeeded: false })
  await writer.append([{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }])
  await writer.close()
  const segmentDirectory = join(root, '.segments')
  expect((await readdir(segmentDirectory)).some(name => name.endsWith('.json'))).toBe(true)
  await first.context.fiber.dispose()
  // Damage the database file, as an interrupted write or a failing disk does.
  await writeFile(join(segmentDirectory, 'sessions.sqlite'), 'not a SQLite database')
  const second = await mount('sqlite')
  // A record left behind names a Session no row holds, and every later `list()` would refuse. The record moves aside with
  // the bytes it names, so the recovered store lists again and the moved files still hold its Sessions.
  await expect(second.persistence.list()).resolves.toEqual([])
  expect((await readdir(segmentDirectory)).some(name => name.endsWith('.json'))).toBe(false)
})
