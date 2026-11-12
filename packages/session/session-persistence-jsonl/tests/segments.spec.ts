/** Shared persistence invariants exercised through the shipped Segment rollout option. @module */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import * as persistence from '../src/index.ts'
import { generationLogPath } from '../src/format.ts'
import { SEGMENT_STORAGE_DEFAULTS } from '../src/trace/index.ts'
import { SCHEMA_VERSION, SqliteLogs } from '@deepseek-ai/dsh-session-persistence-sqlite/src/sqlite.ts'
import { runPersistenceContract } from '../../session-persistence/tests/contract.ts'
import { runLiveWritePathContract } from '../../session-persistence/tests/live-write-contract.ts'

runPersistenceContract('segments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segments-contract-'))
  const instance = async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(persistence, { root })
    return { persistence: ctx.sessionPersistence, dispose: async () => { await fiber.dispose() } }
  }
  const primary = await instance()
  return { ...primary, reopen: instance,
    dispose: async () => { try { await primary.dispose() } finally { await rm(root, { recursive: true, force: true }) } } }
})

runLiveWritePathContract('segments', SEGMENT_STORAGE_DEFAULTS.flushDelayMs, {
  failWrites: (_ctx, failure, sessionId) => {
    // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted store as receiver below.
    const original = SqliteLogs.prototype.append
    const append = vi.spyOn(SqliteLogs.prototype, 'append').mockImplementation(function (this: SqliteLogs, header, batch) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the contract injects non-Error rejections too.
      return sessionId === undefined || header.id === sessionId ? Promise.reject(failure) : original.call(this, header, batch)
    })
    return { calls: () => append.mock.calls.length, restore: () => { append.mockRestore() } }
  },
  backgroundFailure: id => ({ level: 'error', text: `Segment persistence failed for ${id}; durability checkpoint will reject` }),
  disposalFailure: id => ({ level: 'error', text: `SQLite handle close failed for ${id}` }),
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segments-live-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const mount = async (): Promise<Context> => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(persistence, { root, compression: 'none' })
    return ctx
  }
  return { ctx: await mount(), remount: mount }
})

it('creates the SQLite schema when the provider mounts with new Sessions enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-eager-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(persistence, { root })
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  try {
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION })
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name))
      .toEqual(expect.arrayContaining(['segments', 'traces', 'events']))
  } finally { db.close() }
})

it('creates SQLite events when segmentStorage is omitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-lazy-jsonl-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(persistence, { root, compression: 'none' })
  const session = ctx.sessions.create(SessionId('default-jsonl'))
  const writer = await ctx.sessionPersistence.create(session.header)
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.sessions.flush(session)
  await writer.close()
  await expect(stat(generationLogPath(root, session.header.cwd, session.id, session.header.version, 'none'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await stat(join(root, '.segments/sessions.sqlite'))).size).toBeGreaterThan(0)
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  try { expect((await reader.read()).events.map(event => event.type)).toEqual(['turn/start', 'turn/end']) }
  finally { await reader.close() }
})

it('restores SQLite events and continues creating SQLite Sessions after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-live-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const backend = await ctx.plugin(persistence, { root })
  const session = ctx.sessions.create(SessionId('live'))
  const writer = await ctx.sessionPersistence.create(session.header)
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.sessions.flush(session)
  await writer.close()
  await backend.dispose()
  await ctx.fiber.dispose()
  const restarted = new Context()
  const restored = await restarted.plugin(persistence, { root })
  try {
    const reader = await restarted.sessionPersistence.open(session.id, 'read')
    const events = (await reader.read()).events
    expect(events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
    await reader.close()
    const header = { ...session.header, id: SessionId('new-jsonl') }
    const jsonl = await restarted.sessionPersistence.create(header)
    try { await jsonl.append(events) } finally { await jsonl.close() }
    await expect(stat(generationLogPath(root, header.cwd, header.id, header.version, 'zstd'))).rejects.toMatchObject({ code: 'ENOENT' })
    const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
    try { expect(db.prepare('SELECT trace_uuid FROM traces WHERE trace_uuid = ?').get(header.id)).toMatchObject({ trace_uuid: header.id }) }
    finally { db.close() }
  } finally { await restored.dispose(); await restarted.fiber.dispose() }
})
