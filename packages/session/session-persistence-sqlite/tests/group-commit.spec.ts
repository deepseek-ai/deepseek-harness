/** Concurrent checkpoint commits, batch isolation, and provider-wide transaction failures. @module */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SqliteStoreOptions } from '../src/sqlite.ts'
import { sqliteLogs } from './fixtures/store.ts'

const event = (seq: number): SessionEvent => seq % 2 === 0
  ? { type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn: seq / 2 + 1 } }
  : { type: 'turn/end', seq: SessionSeq(seq), time: 0, data: { turn: (seq + 1) / 2, reason: { kind: 'completed' } } }
const batch = (count: number) => Array.from({ length: count }, (_, index) => event(index + 1))

async function fixture(count: number, overrides: Partial<SqliteStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-group-commit-'))
  const logs = sqliteLogs(join(root, 'sessions.sqlite'), root, overrides)
  onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const headers: SessionHeader[] = Array.from({ length: count }, (_, index) => ({
    version: SESSION_FORMAT_VERSION, id: SessionId(`writer-${index}`), createdAt: 0, isSeeded: false,
  }))
  const writers = await Promise.all(headers.map(header => logs.create(header)))
  await Promise.all(writers.map(writer => writer.append([event(0)])))
  const db = await logs['database']()
  const exec = db.exec.bind(db)
  const sql = vi.spyOn(db, 'exec')
  onTestFinished(() => { sql.mockRestore() })
  const commits = () => sql.mock.calls.filter(([statement]) => statement === 'COMMIT').length
  return { logs, headers, writers, db, exec, sql, commits }
}

it('shares one commit per round across sixteen live checkpoint writers and preserves each history', async () => {
  const { writers, commits, sql } = await fixture(16)
  for (let seq = 1; seq <= 8; seq++) {
    await Promise.all(writers.map(writer => writer.receive(event(seq))))
    await Promise.all(writers.map(writer => writer.flush()))
    expect(commits()).toBe(seq)
  }
  sql.mockRestore()
  for (const writer of writers) expect((await writer.read()).events).toEqual(Array.from({ length: 9 }, (_, seq) => event(seq)))
})

it('commits each sequential single-writer checkpoint separately', async () => {
  const { writers: [writer], commits, sql } = await fixture(1)
  if (writer === undefined) throw new Error('Missing writer')
  for (let seq = 1; seq <= 3; seq++) {
    await writer.receive(event(seq)); await writer.flush()
    expect(commits()).toBe(seq)
  }
  sql.mockRestore()
  expect((await writer.read()).events).toEqual([event(0), ...batch(3)])
})

it('restarts the drain for a batch queued after the preceding drain has finished its groups', async () => {
  const { logs, writers, sql } = await fixture(2)
  const [first, second] = writers
  if (first === undefined || second === undefined) throw new Error('Missing writers')
  const ended = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const drain = logs['drainCommits'].bind(logs)
  logs['drainCommits'] = async (db: DatabaseSync) => {
    await drain(db)
    ended.resolve(undefined)
    await release.promise
  }
  onTestFinished(() => { release.resolve(undefined); logs['drainCommits'] = drain })
  try {
    await first.append([event(1)])
    await ended.promise
    const queued = second.append([event(1)])
    await vi.waitFor(() => { expect(logs['commitQueue']).toHaveLength(1) })
    release.resolve(undefined)
    await queued
  } finally { release.resolve(undefined); logs['drainCommits'] = drain }
  sql.mockRestore()
  for (const writer of writers) expect((await writer.read()).events).toEqual([event(0), event(1)])
})

it.each([[512, 512, 1], [1025, 1]])('splits event-capped groups without splitting an admitted batch: %j', async (...sizes) => {
  const { writers, commits, sql } = await fixture(sizes.length, { frameEvents: 2048 })
  await Promise.all(writers.map((writer, index) => writer.append(batch(sizes[index] ?? 0))))
  expect(commits()).toBe(2)
  sql.mockRestore()
  for (const [index, writer] of writers.entries()) expect((await writer.read()).events).toEqual([event(0), ...batch(sizes[index] ?? 0)])
})

it('rejects a noncontiguous batch while committing its peer and allows a corrected retry', async () => {
  const { writers, commits, sql } = await fixture(2)
  const [invalid, valid] = writers
  if (invalid === undefined || valid === undefined) throw new Error('Missing writers')
  const results = await Promise.allSettled([invalid.append([event(2)]), valid.append([event(1)])])
  expect(results).toMatchObject([{ status: 'rejected' }, { status: 'fulfilled' }])
  expect(commits()).toBe(1)
  sql.mockRestore()
  expect((await invalid.read()).events).toEqual([event(0)])
  expect((await valid.read()).events).toEqual([event(0), event(1)])
  await invalid.append([event(1)])
  expect((await invalid.read()).events).toEqual([event(0), event(1)])
})

it('rolls back only a refused live batch and retries its retained event at a later checkpoint', async () => {
  const { writers, db, commits, sql } = await fixture(3)
  db.exec("CREATE TRIGGER refuse_batch BEFORE INSERT ON frames WHEN NEW.segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = 'writer-1') BEGIN SELECT RAISE(ABORT, 'batch refused'); END")
  await Promise.all(writers.map(writer => writer.receive(event(1))))
  const results = await Promise.allSettled(writers.map(writer => writer.flush()))
  expect(results).toMatchObject([{ status: 'fulfilled' }, { status: 'rejected', reason: { message: 'batch refused' } }, { status: 'fulfilled' }])
  expect(commits()).toBe(1)
  sql.mockRestore()
  expect(db.prepare('SELECT SUM(end_seq - start_seq) AS count FROM frames').get()).toMatchObject({ count: 5 })
  db.exec('DROP TRIGGER refuse_batch')
  await Promise.all(writers.map(writer => writer.flush()))
  for (const writer of writers) expect((await writer.read()).events).toEqual([event(0), event(1)])
})

it('rejects the whole group after SQLite rolls back its transaction and retries every retained live batch', async () => {
  const { writers, db, commits, sql } = await fixture(3)
  db.exec("CREATE TRIGGER abort_group BEFORE INSERT ON frames WHEN NEW.segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = 'writer-1') BEGIN SELECT RAISE(ROLLBACK, 'transaction ended'); END")
  await Promise.all(writers.map(writer => writer.receive(event(1))))
  const results = await Promise.allSettled(writers.map(writer => writer.flush()))
  expect(results).toMatchObject(writers.map(() => ({ status: 'rejected', reason: { message: 'transaction ended' } })))
  expect(commits()).toBe(0)
  sql.mockRestore()
  expect(db.prepare('SELECT SUM(end_seq - start_seq) AS count FROM frames').get()).toMatchObject({ count: 3 })
  db.exec('DROP TRIGGER abort_group')
  await Promise.all(writers.map(writer => writer.flush()))
  for (const writer of writers) expect((await writer.read()).events).toEqual([event(0), event(1)])
})

it('rejects every batch after a savepoint rollback fails and keeps the store usable after transaction rollback', async () => {
  const { writers, db, exec, sql } = await fixture(2)
  db.exec("CREATE TRIGGER refuse_batch BEFORE INSERT ON frames WHEN NEW.segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = 'writer-1') BEGIN SELECT RAISE(ABORT, 'batch refused'); END")
  sql.mockImplementation((statement) => {
    if (statement === 'ROLLBACK TO batch; RELEASE batch') throw new Error('savepoint rollback refused')
    exec(statement)
  })
  const results = await Promise.allSettled(writers.map(writer => writer.append([event(1)])))
  expect(results).toMatchObject(writers.map(() => ({ status: 'rejected', reason: {
    errors: [{ message: 'batch refused' }, { message: 'savepoint rollback refused' }],
  } })))
  sql.mockRestore()
  expect(db.prepare('SELECT SUM(end_seq - start_seq) AS count FROM frames').get()).toMatchObject({ count: 2 })
  db.exec('DROP TRIGGER refuse_batch')
  await Promise.all(writers.map(writer => writer.append([event(1)])))
  for (const writer of writers) expect((await writer.read()).events).toEqual([event(0), event(1)])
})

it('refuses the failed group and the next queued group with one unknown-outcome error before another transaction starts', async () => {
  const { writers, logs, headers, exec, sql, db } = await fixture(3, { frameEvents: 2048 })
  let failed = false
  sql.mockImplementation((statement) => {
    if (failed && typeof statement === 'string' && statement.startsWith('BEGIN ')) throw new Error('Started a transaction after an unknown outcome')
    if (statement === 'COMMIT') { failed = true; throw new Error('commit result unavailable') }
    exec(statement)
  })
  const results = await Promise.allSettled(writers.map((writer, index) => writer.append(batch(index === 2 ? 1 : 512))))
  const first = results[0]
  if (first?.status !== 'rejected') throw new Error('Expected commit refusal')
  expect(first.reason).toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN' })
  for (const result of results) {
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') expect(result.reason).toBe(first.reason)
  }
  sql.mockRestore()
  expect(db.prepare('SELECT SUM(end_seq - start_seq) AS count FROM frames').get()).toMatchObject({ count: 3 })
  for (const header of headers) await expect(logs.stat(header.id)).rejects.toBe(first.reason)
  for (const writer of writers) await expect(writer.flush()).rejects.toBe(first.reason)
})

it('publishes only committed batches and lets peers finish while one publication is pending or fails', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  let hold = false
  const { writers, headers, logs, commits, sql } = await fixture(2, { publish: async (id) => {
    if (hold && id === SessionId('writer-0')) { entered.resolve(undefined); await release.promise; throw new Error('publication refused') }
  } })
  hold = true
  const writes = writers.map(writer => writer.append([event(1)]).then(() => undefined, (error: unknown) => error))
  await entered.promise
  expect(commits()).toBe(1)
  expect(await writes[1]).toBeUndefined()
  sql.mockRestore()
  for (const header of headers) expect((await logs.stat(header.id))?.eventCount).toBe(2)
  release.resolve(undefined)
  const failure = await writes[0]
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION' })
  const unpublished = writers[0]
  if (unpublished === undefined) throw new Error('Missing unpublished writer')
  await expect(unpublished.close()).rejects.toBe(failure)
  hold = false
  const peer = writers[1]
  if (peer === undefined) throw new Error('Missing peer')
  await peer.append([event(2)])
  expect((await peer.read()).events).toEqual([event(0), event(1), event(2)])
})
