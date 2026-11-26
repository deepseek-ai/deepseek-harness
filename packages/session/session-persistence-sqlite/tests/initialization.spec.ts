/** Concurrent schema initialization and WAL publication. @module */
import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { persistenceFixture } from './fixtures/persistence.ts'

it('retries WAL activation after a competing initializer releases its lock', async () => {
  const fixture = await persistenceFixture()
  const backend = await fixture.mount('sqlite')
  await mkdir(join(fixture.root, '.segments'))
  const blocker = new DatabaseSync(join(fixture.root, '.segments', 'sessions.sqlite'))
  try {
    blocker.exec('BEGIN IMMEDIATE')
    let contention: unknown
    // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the intercepted connection as receiver.
    const execute = DatabaseSync.prototype.exec
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      try { execute.call(this, sql) }
      catch (error) {
        if (sql.includes('PRAGMA journal_mode = WAL') && contention === undefined) {
          contention = error
          execute.call(blocker, 'ROLLBACK')
        }
        throw error
      }
    })
    try {
      const header = meta('contended-initialization')
      const writer = await backend.persistence.create(header)
      await writer.append(oneTurnLog())
      await writer.close()
      expect(contention).toMatchObject({ errcode: 5 })
      await using reader = await backend.persistence.open(header.id, 'read')
      expect((await reader.read()).events).toEqual(oneTurnLog())
    } finally { spy.mockRestore() }
  } finally { blocker.close() }
})

it('reports a lock that outlasts the WAL activation wait budget instead of calling the file damaged', async () => {
  const fixture = await persistenceFixture()
  const backend = await fixture.mount('sqlite', 'none', 'report')
  const busy = Object.assign(new Error('database is locked'), { errcode: 5 })
  let attempts = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => attempts < 2 ? 0 : 5000)
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the intercepted connection as receiver.
  const execute = DatabaseSync.prototype.exec
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql.includes('PRAGMA journal_mode = WAL')) {
      attempts += 1
      throw busy
    }
    execute.call(this, sql)
  })
  try {
    await expect(backend.persistence.create(meta('busy-deadline')))
      .rejects.toMatchObject({ code: 'SESSION_STORAGE_LOCKED', cause: busy })
    expect(attempts).toBe(2)
  } finally { spy.mockRestore(); clock.mockRestore() }
  const writer = await backend.persistence.create(meta('after-contention'))
  await writer.append(oneTurnLog())
  await writer.close()
})

it.each([
  new Error('journal mode failed'),
  Object.assign(new Error('database table is locked'), { errcode: 6 }),
])('propagates WAL failures other than SQLite busy (%s)', async (failure) => {
  const fixture = await persistenceFixture()
  const backend = await fixture.mount('sqlite')
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the intercepted connection as receiver.
  const execute = DatabaseSync.prototype.exec
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql.includes('PRAGMA journal_mode = WAL')) throw failure
    execute.call(this, sql)
  })
  try { await expect(backend.persistence.create(meta('wal-failure'))).rejects.toBe(failure) }
  finally { spy.mockRestore() }
})

it('initializes the schema once when two providers create Sessions simultaneously', async () => {
  const fixture = await persistenceFixture()
  const first = await fixture.mount('sqlite')
  const second = await fixture.mount('sqlite')
  const writers = await Promise.all([
    first.persistence.create(meta('first-provider')),
    second.persistence.create(meta('second-provider')),
  ])
  await Promise.all(writers.map(writer => writer.append(oneTurnLog())))
  await Promise.all(writers.map(writer => writer.close()))
  expect((await first.persistence.list()).map(entry => entry.header.id).sort()).toEqual(['first-provider', 'second-provider'])
})

it('enables WAL before publishing the schema to a concurrent reader', async () => {
  const fixture = await persistenceFixture()
  const backend = await fixture.mount('sqlite')
  let snapshot: DatabaseSync | undefined
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its database receiver.
  const execute = DatabaseSync.prototype.exec
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    execute.call(this, sql)
    if (sql === 'COMMIT' && snapshot === undefined) {
      snapshot = new DatabaseSync(join(fixture.root, '.segments', 'sessions.sqlite'), { readOnly: true })
      execute.call(snapshot, 'BEGIN')
      expect(snapshot.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count).toBe(0)
    }
  })
  try {
    const header = meta('wal-reader')
    const writer = await backend.persistence.create(header)
    await writer.append(oneTurnLog())
    await writer.close()
    expect(snapshot).toBeDefined()
    expect(snapshot?.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count).toBe(0)
    expect((await backend.persistence.stat(header.id))?.eventCount).toBe(oneTurnLog().length)
  } finally {
    spy.mockRestore()
    snapshot?.close()
  }
})
