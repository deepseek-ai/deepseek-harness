/** Concurrent schema initialization and WAL publication. @module */
import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { persistenceFixture } from './fixtures/persistence.ts'

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
      expect(snapshot.prepare('SELECT COUNT(*) AS count FROM traces').get()?.count).toBe(0)
    }
  })
  try {
    const header = meta('wal-reader')
    const writer = await backend.persistence.create(header)
    await writer.append(oneTurnLog())
    await writer.close()
    expect(snapshot).toBeDefined()
    expect(snapshot?.prepare('SELECT COUNT(*) AS count FROM traces').get()?.count).toBe(0)
    expect((await backend.persistence.stat(header.id))?.eventCount).toBe(oneTurnLog().length)
  } finally {
    spy.mockRestore()
    snapshot?.close()
  }
})
