/** Initialization retries, automatic rollbacks, and durable parent writes. @module */
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { sqliteLogs } from './fixtures/store.ts'

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
    const failure = await logs.start().then(() => undefined, (error: unknown) => error)
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

it('retries the same append after SQLITE_FULL automatically ends its transaction', async () => {
  const { logs, header } = await fixture()
  const writer = await logs.create(header('disk-full'))
  await writer.flush()
  const entry: SessionEvent<'user/message'> = {
    type: 'user/message', surfaceOp: 'append', seq: SessionSeq(0), time: 0,
    data: createUserMessage({ content: [{ type: 'text', text: 'large payload '.repeat(10_000) }], source: { kind: 'user' } }),
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
