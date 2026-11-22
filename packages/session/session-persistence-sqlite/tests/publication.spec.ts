/** Recovery of a committed SQLite Session whose routing record failed to publish. @module */
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { SqliteStore, SqliteSessionHandle } from '../src/sqlite.ts'
import { routeOf } from './fixtures/store.ts'
import { persistenceFixture } from './fixtures/persistence.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const faults = vi.hoisted(() => ({ routes: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const refused = () => Promise.reject(Object.assign(new Error('routing directory refused'), { code: 'EACCES' }))
  // Fail publication's routing-directory creation (POSIX) and its temporary record file (every platform).
  return { ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) =>
      faults.routes && basename(String(args[0])) === '.segments' ? refused() : actual.mkdir(...args),
    open: (...args: Parameters<typeof actual.open>) =>
      faults.routes && basename(String(args[0])).startsWith('.route-') ? refused() : actual.open(...args),
  }
})

const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('unpublished'), createdAt: 0, isSeeded: false }
const event = (seq: number): SessionEvent<'turn/start'> => ({ type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn: seq + 1 } })

it('serves a committed Session without its routing record to a fresh provider', async () => {
  const fixture = await persistenceFixture(), root = fixture.root
  const { context: first } = await fixture.mount('sqlite')
  const writer = await first.sessionPersistence.create(header)
  faults.routes = true
  try {
    const failure = await writer.append([event(0)]).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION', cause: { message: 'routing directory refused' } })
    await expect(writer.close()).rejects.toBe(failure)
  } finally { faults.routes = false }
  await first.fiber.dispose()
  expect(await routeOf(root, header.id)).toBe('jsonl')
  expect((await readdir(join(root, '.segments'))).filter(name => name.endsWith('.json'))).toEqual([])

  // The committed row selects SQLite without a routing record.
  const { context: fresh } = await fixture.mount('sqlite')
  expect(await fresh.sessionPersistence.stat(header.id)).toMatchObject({ header, eventCount: 1 })
  expect((await fresh.sessionPersistence.list()).map(entry => [entry.header.id, entry.eventCount])).toEqual([[header.id, 1]])
  const reopened = await fresh.sessionPersistence.open(header.id, 'write')
  try {
    expect((await reopened.read()).events).toEqual([event(0)])
    // The next commit publishes the missing routing record.
    await reopened.append([event(1)])
  } finally { await reopened.close() }
  expect(await routeOf(root, header.id)).toBe('sqlite')
  expect((await fresh.sessionPersistence.stat(header.id))?.eventCount).toBe(2)
  expect((await readdir(root, { recursive: true })).some(name => name.endsWith('.jsonl'))).toBe(false)
})

it('reports a live routing failure and retains its rejected durability checkpoint', async () => {
  const fixture = await persistenceFixture()
  const { context: ctx } = await fixture.mount('sqlite')
  const reported = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its store receiver.
  const reportFailure = SqliteStore.prototype.reportFailure
  const report = vi.spyOn(SqliteStore.prototype, 'reportFailure').mockImplementation(function (this: SqliteStore, id, error) {
    reportFailure.call(this, id, error)
    reported.resolve(undefined)
  })
  const writer = await ctx.sessionPersistence.create(header)
  if (!(writer instanceof SqliteSessionHandle)) throw new Error('Expected SQLite writer')
  faults.routes = true
  try {
    await writer.receive(event(0))
    await reported.promise
    await expect(writer.flush()).rejects.toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION' })
    await expect(writer.close()).rejects.toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION' })
    expect(report).toHaveBeenCalledOnce()
  } finally { faults.routes = false; report.mockRestore() }
})

it('reopens an empty committed Session after routing publication fails', async () => {
  const fixture = await persistenceFixture()
  const { persistence } = await fixture.mount('sqlite')
  const writer = await persistence.create(meta('empty-publication'))
  faults.routes = true
  try {
    await expect(writer.flush()).rejects.toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION' })
    await expect(writer.close()).rejects.toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION' })
  } finally { faults.routes = false }
  const fresh = await fixture.mount('sqlite')
  expect(await fresh.persistence.stat(writer.id)).toMatchObject({ eventCount: 0 })
  await using reader = await fresh.persistence.open(writer.id, 'read')
  expect((await reader.read()).events).toEqual([])
})

it('uses the committed import when routing publication fails after the import transaction', async () => {
  const fixture = await persistenceFixture()
  const legacy = await fixture.mount('jsonl')
  const header = meta('import-publication')
  const writer = await legacy.persistence.create(header)
  await writer.append(oneTurnLog())
  await writer.close()
  const { persistence } = await fixture.mount('sqlite')
  const initialization = await persistence.create(meta('initialize'))
  await initialization.close()
  faults.routes = true
  try {
    await expect(persistence.open(header.id, 'read')).rejects.toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION' })
  } finally { faults.routes = false }
  await using reader = await persistence.open(header.id, 'read')
  expect((await reader.read()).events).toEqual(oneTurnLog())
  expect((await persistence.list()).filter(entry => entry.header.id === header.id)).toHaveLength(1)
})
