/** Initialization retries, automatic rollbacks, and durable parent writes. @module */
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId, SessionSeq, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { sqliteLogs, forkTrace } from './fixtures/store.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-recovery-'))
  const path = join(root, 'sessions.sqlite')
  const logs = sqliteLogs(path, root)
  onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const header = (name: string): SessionHeader => ({ version: SESSION_FORMAT_VERSION, id: SessionId(name), createdAt: 0, isSeeded: false })
  const event = (seq: number): SessionEvent<'turn/start'> => ({ type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn: seq + 1 } })
  return { root, path, logs, header, event }
}

it('retries initialization after a database lock without reporting corruption or repeating the error on close', async () => {
  const { path, logs, header } = await fixture()
  const blocker = new DatabaseSync(path)
  try {
    blocker.exec('BEGIN IMMEDIATE')
    // Expire the busy budget without racing the test's own deadline.
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(5000)
    let failure: unknown
    try { failure = await logs.start().then(() => undefined, (error: unknown) => error) }
    finally { clock.mockRestore() }
    expect(failure).toMatchObject({ errcode: 5 })
    expect(failure).not.toBeInstanceOf(SessionPersistenceCorruptionError)
    blocker.exec('ROLLBACK')
    await logs.start()
    const writer = await logs.create(header('retry'))
    await writer.flush(); await writer.close()
    expect(await logs.stat(writer.id)).toMatchObject({ eventCount: 0 })
    await expect(logs.close()).resolves.toBeUndefined()
  } finally { blocker.close() }
})

it('releases fork creation ownership after a competing SQLite writer blocks its transaction', async () => {
  const { path, logs, header, event } = await fixture()
  const parent = await logs.create(header('parent'))
  await parent.append([event(0)]); await parent.close()
  const seed: SessionEvent[] = [event(0), { type: 'session/end-seed', seq: SessionSeq(1), time: 0, data: { inherited: true } }]
  const database = await logs['database']()
  database.exec('PRAGMA busy_timeout = 1')
  const childHeader = { ...header('child'), isSeeded: true }
  const options = { inheritedEventCount: SessionLogOffset(1),
    parentSource: { sessionId: parent.id, endSeq: SessionLogOffset(1), events: seed } }
  const blocker = new DatabaseSync(path)
  try {
    blocker.exec('BEGIN IMMEDIATE')
    await expect(logs.create(childHeader, options)).rejects.toMatchObject({ errcode: 5 })
    blocker.exec('ROLLBACK')
    expect(await logs.stat(childHeader.id)).toBeUndefined()
    const child = await logs.create(childHeader, options)
    try { expect((await child.read()).events).toEqual(seed) } finally { await child.close() }
  } finally { blocker.close() }
})

it('closes cleanly after invalid database initialization and retries when the file is replaced', async () => {
  const { path, logs } = await fixture()
  await writeFile(path, 'not a SQLite database')
  await expect(logs.start()).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  await rm(path)
  await logs.start()
  await expect(logs.close()).resolves.toBeUndefined()
})
it('retains retryable state after SQLite automatically rolls back an append', async () => {
  const { path, logs, header, event } = await fixture()
  const writer = await logs.create(header('source'))
  await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER auto_rollback BEFORE INSERT ON frames BEGIN SELECT RAISE(ROLLBACK, 'automatic rollback'); END")
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
  await forkTrace(logs, parent.id, SessionId('child'), prefix)
  const child = await logs.open(SessionId('child'), 'read')
  try {
    expect((await child.read()).events).toMatchObject([...prefix, { type: 'session/end-seed', seq: count }])
  } finally { await child.close() }
  const db = new DatabaseSync(path)
  try {
    expect(db.prepare('SELECT trace_uuid FROM traces WHERE trace_uuid = ?').get(parent.id)).toEqual({ trace_uuid: parent.id })
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
    // Random text stays large after frame compression, so the page cap below rejects the write.
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
  try { expect(db.prepare('SELECT count(*) AS count FROM frames').get()?.count).toBe(1) } finally { db.close() }
  await writer.close()
})
