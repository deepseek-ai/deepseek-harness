/** Pending creation and durable Session listing share one identity and header policy. @module */
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import * as persistence from '../src/index.ts'
import { SqliteStore } from '../src/sqlite.ts'

it('public list emits an identity once when first materialization completes after pending capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-list-once-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(persistence, { root, compression: 'none' })
  const id = SessionId('public-list-once')
  const writer = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
  let writing: Promise<void> | undefined
  const materialize = () => writing ??= writer.append([{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }])
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted store as receiver below.
  const scan = SqliteStore.prototype.scan
  const spy = vi.spyOn(SqliteStore.prototype, 'scan').mockImplementationOnce(async function (this: SqliteStore, ...args) {
    Object.defineProperty(this, 'exists', { configurable: true, value: async () => { await materialize(); return true } })
    try { return await scan.call(this, ...args) }
    finally { Reflect.deleteProperty(this, 'exists') }
  })
  const restore = () => { spy.mockRestore() }
  onTestFinished(() => { restore() })
  const listed = await ctx.sessionPersistence.list()
  await writing
  restore()
  await writer.close()
  expect(listed.map(entry => entry.header.id)).toEqual([id])
})

it.each(['corrupt', 'unsupported'] as const)('omits %s headers whose first commit landed after the pending listing snapshot', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-list-omitted-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(persistence, { root, compression: 'none' })
  const id = SessionId('omitted')
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }
  const writer = await ctx.sessionPersistence.create(header)
  let writing: Promise<void> | undefined
  const materialize = () => writing ??= (async () => {
    await writer.append([{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }])
    const db = new DatabaseSync(join(root, '.segments', 'sessions.sqlite'))
    try {
      db.prepare('UPDATE sessions SET header = ? WHERE session_id = ?')
        .run(kind === 'corrupt' ? '{invalid' : JSON.stringify({ ...header, version: SESSION_FORMAT_VERSION + 1 }), id)
    } finally { db.close() }
  })()
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted store as receiver below.
  const scan = SqliteStore.prototype.scan
  const spy = vi.spyOn(SqliteStore.prototype, 'scan').mockImplementationOnce(async function (this: SqliteStore, ...args) {
    Object.defineProperty(this, 'exists', { configurable: true, value: async () => {
      await materialize()
      return true
    } })
    try { return await scan.call(this, ...args) }
    finally { Reflect.deleteProperty(this, 'exists') }
  })
  onTestFinished(() => { spy.mockRestore() })
  await expect(ctx.sessionPersistence.list()).resolves.toEqual([])
  spy.mockRestore()
  await writer.close()
  await expect(ctx.sessionPersistence.list()).resolves.toEqual([])
  await expect(ctx.sessionPersistence.stat(id)).rejects.toBeInstanceOf(kind === 'corrupt'
    ? SessionPersistenceCorruptionError : SessionFormatUnsupportedError)
})

it('lists 201 durable SQLite sessions with one metadata query and no event payload reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-list-query-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(persistence, { root, compression: 'none' })
  const ids = Array.from({ length: 201 }, (_, index) => SessionId(`session-${String(index).padStart(3, '0')}`))
  const writer = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: SessionId('session-000'), createdAt: 0, isSeeded: false })
  try { await writer.append([{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }]) }
  finally { await writer.close() }
  // Populate unrelated durable rows in one fixture transaction; listing must not decode their payloads.
  const db = new DatabaseSync(join(root, '.segments', 'sessions.sqlite'))
  try {
    db.exec('BEGIN IMMEDIATE')
    const segment = db.prepare('INSERT INTO segments (segment_uuid, parent_id, base_seq) VALUES (?, NULL, 0)')
    const session = db.prepare('INSERT INTO sessions (session_id, header, head_segment_id, inherited_count) VALUES (?, ?, ?, 0)')
    const event = db.prepare("INSERT INTO events (segment_id, seq, type, time, codec, data) VALUES (?, 0, 'turn/start', 0, 0, ?)")
    for (const id of ids.slice(1)) {
      const head = segment.run(`fixture-${id}`).lastInsertRowid
      session.run(id, JSON.stringify({ version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }), head)
      event.run(head, 'invalid data must remain unread')
    }
    db.exec('COMMIT')
  } finally { db.close() }
  const queries: string[] = []
  // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted database below.
  const prepare = DatabaseSync.prototype.prepare
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
    queries.push(sql)
    return prepare.call(this, sql)
  })
  onTestFinished(() => { spy.mockRestore() })
  const entries = await ctx.sessionPersistence.list()
  spy.mockRestore()
  expect(entries.map(entry => entry.header.id)).toEqual(ids)
  expect(entries.every(entry => entry.eventCount === 1)).toBe(true)
  expect(queries).toHaveLength(1)
  expect(queries[0]).not.toMatch(/\bdata\b/i)
})
