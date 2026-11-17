/** Provider-wide SQLite transaction failures across cached handles and durability barriers. @module */
import { LiveWriteBuffer } from '../src/buffer.ts'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import * as persistence from '../src/index.ts'
import { SqliteSessionHandle } from '../src/sqlite.ts'
import { sqliteLogs } from './fixtures/store.ts'
import { SessionWriteLease } from '../src/lease.ts'
import { sessionDir } from '../src/paths.ts'

it.each(['commit', 'rollback'] as const)('isolates every SQLite handle after an unknown %s result and still releases them', async (operation) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-unknown-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(SessionStore)
  await ctx.plugin(persistence, { root, compression: 'none' })
  const session = ctx.sessions.create(SessionId('unknown'))
  const source = await ctx.sessionPersistence.create(session.header)
  await source.flush()
  const cached = ctx.sessions.create(SessionId('cached'))
  const first = await ctx.sessionPersistence.create(cached.header)
  cached.append('turn/start', { turn: 1 })
  await ctx.sessions.flush(cached)
  await first.close()
  const primed = await ctx.sessionPersistence.open(cached.id, 'write')
  if (!(primed instanceof SqliteSessionHandle)) throw new Error('Expected a SQLite handle')
  const pendingId = SessionId('pending')
  const pending = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: pendingId, createdAt: 0, isSeeded: false })
  const pendingReader = await ctx.sessionPersistence.open(pendingId, 'read')
  if (operation === 'rollback') {
    const db = new DatabaseSync(join(root, '.segments', 'sessions.sqlite'))
    try { db.exec("CREATE TRIGGER refuse_append BEFORE INSERT ON frames BEGIN SELECT RAISE(ABORT, 'append refused'); END") }
    finally { db.close() }
  }
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
  const exec = DatabaseSync.prototype.exec
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === operation.toUpperCase()) throw new Error(`${operation} result unavailable`)
    exec.call(this, sql)
  })
  const event = { type: 'turn/start' as const, seq: SessionSeq(0), time: 0, data: { turn: 1 } }
  let failure: unknown
  try { failure = await source.append([event]).then(() => undefined, (error: unknown) => error) }
  finally { fault.mockRestore() }
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN' })
  await expect(source.append([])).rejects.toBe(failure)
  await expect(primed.read()).rejects.toBe(failure)
  await expect(pendingReader.read()).rejects.toBe(failure)
  await expect(primed.receive({ type: 'turn/end', seq: SessionSeq(1), time: 0, data: { turn: 1, reason: { kind: 'completed' } } })).rejects.toBe(failure)
  await expect(source.flush()).rejects.toBe(failure)
  await expect(ctx.sessions.flush(session)).rejects.toBe(failure)
  await expect(ctx.sessionPersistence.flush()).rejects.toBe(failure)
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  try {
    cached.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(error).toHaveBeenCalledOnce() })
    expect(String(error.mock.calls[0]?.[0])).toContain('SQLite transaction outcome is unknown')
    const buffer: unknown = Reflect.get(primed, 'buffer')
    if (!(buffer instanceof LiveWriteBuffer)) throw new Error('Missing live buffer')
    expect(buffer.length).toBe(0)
  } finally { error.mockRestore() }
  await source.close(); await primed.close(); await pendingReader.close(); await pending.close()
  await expect(ctx.sessionPersistence.flush()).rejects.toBe(failure)
})

it('rejects a created writer whose first lease completes after another Session makes the store unusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-lease-unknown-'))
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const logs = sqliteLogs(join(root, 'sessions.sqlite'), root, { acquireCreationLease: async (header) => {
    if (header.id === SessionId('waiting')) { entered.resolve(undefined); await release.promise }
    return SessionWriteLease.acquire(sessionDir(root, header.cwd, header.id), header.id)
  } })
  onTestFinished(async () => {
    release.resolve(undefined)
    try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) }
  })
  const header = (id: string): SessionHeader => ({ version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false })
  const first = await logs.create(header('first')), waiting = await logs.create(header('waiting'))
  await first.flush()
  const event = { type: 'turn/start' as const, seq: SessionSeq(0), time: 0, data: { turn: 1 } }
  const blocked = waiting.append([event]).then(() => undefined, (error: unknown) => error)
  await entered.promise
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
  const exec = DatabaseSync.prototype.exec
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'COMMIT') throw new Error('commit result unavailable')
    exec.call(this, sql)
  })
  let failure: unknown
  try { failure = await first.append([event]).then(() => undefined, (error: unknown) => error) }
  finally { fault.mockRestore(); release.resolve(undefined) }
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN' })
  expect(await blocked).toBe(failure)
  await first.close(); await waiting.close()
  const lease = await SessionWriteLease.acquire(sessionDir(root, undefined, waiting.id), waiting.id)
  await lease.release()
})

it('refuses a queued second Session before its transaction begins and rejects flush after all writers close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-queued-unknown-'))
  const path = join(root, 'sessions.sqlite'), logs = sqliteLogs(path, root)
  onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const header = (id: string): SessionHeader => ({ version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false })
  const first = await logs.create(header('first')), second = await logs.create(header('second'))
  await first.flush(); await second.flush()
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
  const exec = DatabaseSync.prototype.exec
  let failed = false, laterTransactions = 0
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (failed && sql.startsWith('BEGIN ')) laterTransactions++
    if (sql === 'COMMIT' && !failed) { failed = true; throw new Error('commit result unavailable') }
    exec.call(this, sql)
  })
  const event = { type: 'turn/start' as const, seq: SessionSeq(0), time: 0, data: { turn: 1 } }
  let one: unknown, two: unknown
  try {
    const writes = [first.append([event]), second.append([event])]
    ;[one, two] = await Promise.all(writes.map(async writing => writing.then(() => undefined, (error: unknown) => error)))
  } finally { fault.mockRestore() }
  expect(one).toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN' })
  expect(two).toBe(one)
  expect(laterTransactions).toBe(0)
  const db = new DatabaseSync(path)
  try { expect(db.prepare('SELECT payload FROM frames').all()).toEqual([]) } finally { db.close() }
  await first.close(); await second.close()
  await expect(logs.flush()).rejects.toBe(one)
})
