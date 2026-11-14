/** Cancellation and disposal while SQLite opens an existing Session. @module */
import { expect, it, vi } from 'vitest'
import { SessionWriteLease } from '../src/lease.ts'
import { SqliteStore } from '../src/sqlite.ts'
import { sessionDir } from '../src/paths.ts'
import { persistenceFixture } from './fixtures/persistence.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

it('releases both write leases when cancellation arrives after acquisition', async () => {
  const fixture = await persistenceFixture()
  const { persistence } = await fixture.mount('sqlite')
  const header = meta('cancel-write-open')
  const writer = await persistence.create(header)
  await writer.append(oneTurnLog())
  await writer.close()
  const controller = new AbortController(), reason = new Error('cancel write open')
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  const spy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, id) => {
    const lease = await acquire(dir, id)
    if (dir === sessionDir(fixture.root, header.cwd, header.id)) controller.abort(reason)
    return lease
  })
  try {
    await expect(persistence.open(header.id, 'write', { signal: controller.signal })).rejects.toBe(reason)
  } finally { spy.mockRestore() }
  const next = await fixture.mount('sqlite')
  await using reopened = await next.persistence.open(header.id, 'write')
  expect((await reopened.read()).events).toEqual(oneTurnLog())
})

it('returns no history when cancellation arrives during the write-open restore read', async () => {
  const fixture = await persistenceFixture()
  const { persistence } = await fixture.mount('sqlite')
  const header = meta('cancel-restore-read')
  const writer = await persistence.create(header)
  await writer.append(oneTurnLog())
  await writer.close()
  const controller = new AbortController(), reason = new Error('cancel restore read')
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its store receiver.
  const read = SqliteStore.prototype.read
  const spy = vi.spyOn(SqliteStore.prototype, 'read').mockImplementationOnce(async function (this: SqliteStore, ...args) {
    const events = await read.call(this, ...args)
    controller.abort(reason)
    return events
  })
  try {
    await expect(persistence.open(header.id, 'write', { signal: controller.signal })).rejects.toBe(reason)
  } finally { spy.mockRestore() }
  await using reopened = await persistence.open(header.id, 'write')
  expect((await reopened.read()).events).toEqual(oneTurnLog())
})

it('releases acquired leases when the provider closes before admitting the write handle', async () => {
  const fixture = await persistenceFixture()
  const { persistence, context } = await fixture.mount('sqlite')
  const header = meta('dispose-write-open')
  const writer = await persistence.create(header)
  await writer.append(oneTurnLog())
  await writer.close()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  const spy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, id) => {
    const lease = await acquire(dir, id)
    if (dir === sessionDir(fixture.root, header.cwd, header.id)) {
      entered.resolve(undefined)
      await release.promise
    }
    return lease
  })
  const rejected = expect(persistence.open(header.id, 'write')).rejects.toMatchObject({ code: 'SESSION_STORAGE_CLOSED' })
  try {
    await entered.promise
    await context.fiber.dispose()
  } finally { release.resolve(undefined); spy.mockRestore() }
  await rejected
  const next = await fixture.mount('sqlite')
  await using reopened = await next.persistence.open(header.id, 'write')
  expect((await reopened.read()).events).toEqual(oneTurnLog())
})
