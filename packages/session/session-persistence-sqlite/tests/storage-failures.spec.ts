/** SQLite durable-data refusals, failed transactions, and ownership cleanup. @module */
import { mkdir, mkdtemp, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionFormatUnsupportedError, SessionHandleClosedError,
  SessionPersistenceCorruptionError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SessionWriteLease } from '../src/lease.ts'
import { SqliteSessionPersistence } from '../src/persistence.ts'
import * as plugin from '../src/index.ts'
import { forkSession, headSegment, insertEvent, routeOf, sharedHistory, sqliteLogs } from './fixtures/store.ts'
import { persistenceFixture } from './fixtures/persistence.ts'

/** A coded refusal or an error class from a durable read. */
type Refusal = { readonly code: string; readonly message?: string } | (new (...args: never[]) => Error)
async function expectRefusal(operation: Promise<unknown>, refusal: Refusal): Promise<void> {
  if (typeof refusal === 'function') await expect(operation).rejects.toBeInstanceOf(refusal)
  else await expect(operation).rejects.toMatchObject(refusal)
}
const header = (id = 'source'): SessionHeader => ({ version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false })
const event = (seq: number): SessionEvent => seq % 2 === 0
  ? { type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn: seq / 2 + 1 } }
  : { type: 'turn/end', seq: SessionSeq(seq), time: 0, data: { turn: (seq + 1) / 2, reason: { kind: 'completed' } } }
async function fixture() {
  const fixture = await persistenceFixture()
  const { context: ctx, persistence: storage } = await fixture.mount('sqlite')
  if (!(storage instanceof SqliteSessionPersistence)) throw new Error('Missing SQLite provider')
  return { root: fixture.root, ctx, storage }
}
async function raw(publish: () => Promise<void> = async () => {}, failedClose = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-failures-')), path = join(root, 'events.sqlite')
  const report = vi.fn()
  const logs = sqliteLogs(path, root, { publish, report })
  onTestFinished(async () => {
    try {
      if (failedClose) await expect(logs.close()).rejects.toMatchObject({ message: 'SQLite disposal failed', errors: [expect.any(Error)] })
      else await logs.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  return { logs, path, root, report }
}

it('preserves seeded history and SQLite storage across provider replacement', async () => {
  const { storage, root } = await fixture()
  const source = await storage.create(header())
  await source.append([event(0), event(1)])
  await source.close()
  expect(await routeOf(root, header().id)).toBe('sqlite')
  const child = SessionId('child')
  const request = { sourceId: header().id, endSeq: SessionLogOffset(1) }
  const createChild = async () => {
    const writer = await storage.create({ ...header('child'), isSeeded: true }, { inheritedEventCount: request.endSeq,
      parentSource: { sessionId: request.sourceId, endSeq: request.endSeq,
        events: [event(0), { type: 'session/end-seed', seq: SessionSeq(1), time: 0, data: { inherited: true } }] } })
    await writer.close()
  }
  await createChild()
  await expect(createChild()).rejects.toBeInstanceOf(SessionAlreadyExistsError)
  const other = new Context()
  onTestFinished(() => other.fiber.dispose())
  await other.plugin(plugin, { root, compression: 'none' })
  const reader = await other.sessionPersistence.open(child, 'read')
  expect((await reader.read()).events.map(item => item.seq)).toEqual([0, 1])
  await reader.close()
  const old = await other.sessionPersistence.create(header('legacy'))
  await old.flush(); await old.close()
  expect(await routeOf(root, SessionId('legacy'))).toBe('sqlite')
})
it.each([
  { fault: 'identity', open: { code: 'SESSION_STORAGE_IDENTITY' }, list: { code: 'SESSION_STORAGE_IDENTITY' } },
  { fault: 'missing-row', open: SessionPersistenceNotFoundError, list: { code: 'SESSION_STORAGE_MISSING' } },
  { fault: 'invalid-json', open: { code: 'SESSION_STORAGE_CORRUPT' }, list: { code: 'SESSION_STORAGE_CORRUPT' } },
] as const)('refuses $fault without creating a JSONL fallback', async ({ fault, open, list }) => {
  const { storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.flush(); await writer.close()
  const directory = join(root, '.segments')
  const route = (await readdir(directory)).find(name => name.endsWith('.json'))
  if (route === undefined) throw new Error('Missing route')
  const path = join(directory, route)
  if (fault === 'identity') {
    const value = z.object({ id: z.string(), database: z.string() }).parse(JSON.parse(await readFile(path, 'utf8')))
    await writeFile(path, JSON.stringify({ ...value, database: '/wrong.sqlite' }))
  } else if (fault === 'invalid-json') await writeFile(path, 'invalid')
  else {
    const db = new DatabaseSync(join(directory, 'sessions.sqlite'))
    try { db.prepare('DELETE FROM sessions WHERE session_id = ?').run('source') } finally { db.close() }
  }
  await expectRefusal(storage.open(header().id, 'write'), open)
  if (fault === 'missing-row') await expectRefusal(storage.list(), list)
  else expect(await storage.list()).toHaveLength(1)
  expect((await readdir(root, { recursive: true })).some(name => name.endsWith('.jsonl'))).toBe(false)
})

it.each([
  { label: 'corrupt', stored: '{invalid', error: SessionPersistenceCorruptionError },
  { label: 'future-version', stored: JSON.stringify({ ...header(), version: SESSION_FORMAT_VERSION + 1 }), error: SessionFormatUnsupportedError },
])('omits a $label SQLite header from list while direct access still rejects', async ({ stored, error }) => {
  const { storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.append([event(0)]); await writer.close()
  const healthy = await storage.create(header('healthy')); await healthy.append([event(0)]); await healthy.close()
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  try {
    db.prepare('UPDATE sessions SET header = ? WHERE session_id = ?').run(stored, header().id)
  } finally { db.close() }
  await expect(storage.open(header().id, 'read')).rejects.toBeInstanceOf(error)
  await expect(storage.stat(header().id)).rejects.toBeInstanceOf(error)
  expect((await storage.list()).map(entry => entry.header.id)).toEqual([SessionId('healthy')])
})

it('rejects the listing when a stored SQLite header names another Session', async () => {
  const { storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.append([event(0)]); await writer.close()
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  try {
    db.prepare('UPDATE sessions SET header = ? WHERE session_id = ?').run(JSON.stringify(header('other')), header().id)
  } finally { db.close() }
  await expect(storage.list()).rejects.toThrow('identity mismatch')
})

it.each(['{}', '[]', 'null', '4', JSON.stringify({ version: 4.5 }), JSON.stringify({ version: SESSION_FORMAT_VERSION, id: 'source' })])(
  'classifies an invalid stored SQLite header %#',
  async (storedHeader) => {
    const { storage, root } = await fixture()
    const writer = await storage.create(header()); await writer.append([event(0)]); await writer.close()
    const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
    try {
      db.prepare('UPDATE sessions SET header = ? WHERE session_id = ?').run(storedHeader, header().id)
    } finally { db.close() }
    await expect(storage.open(header().id, 'read')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  },
)

it.each([
  ['replace', false],
  ['report', true],
] as const)('classifies a non-database SQLite file under %s recovery', async (recovery, refuses) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-corrupt-db-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'sessions.sqlite')
  await writeFile(path, 'not a database')
  const reportRecovery = vi.fn<(detail: string) => void>()
  const logs = sqliteLogs(path, root, { recovery, reportRecovery })
  onTestFinished(async () => { await logs.close().catch(() => undefined) })
  if (refuses) {
    await expect(logs.stat(header().id)).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    expect(reportRecovery).not.toHaveBeenCalled()
    return
  }
  // Replacing keeps the unreadable bytes and leaves a database every Session operation can use.
  await expect(logs.stat(header().id)).resolves.toBeUndefined()
  expect(reportRecovery).toHaveBeenCalledOnce()
  const [aside] = (await readdir(root)).filter(name => name.includes('.unreadable-'))
  expect(aside).toBeDefined()
  expect(await readFile(join(root, aside!), 'utf8')).toBe('not a database')
})

it('fails on invalid selected event data while unrelated Session bodies remain readable', async () => {
  const { storage, root } = await fixture()
  const writer = await storage.create(header()); await writer.append([event(0)]); await writer.close()
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  try {
    db.exec('DROP TRIGGER events_no_update')
    db.prepare('UPDATE events SET codec = 0, data = ?').run('invalid')
  } finally { db.close() }
  await expect(storage.open(header().id, 'write')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  const replacement = await storage.create(header('healthy')); await replacement.flush(); await replacement.close()
  expect(await storage.stat(SessionId('healthy'))).toMatchObject({ eventCount: 0 })
})

it('discards events from a read cancelled while the SQLite query runs', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)]); await writer.close()
  const reader = await logs.open(header().id, 'read')
  const controller = new AbortController()
  const read = logs.read.bind(logs)
  const spy = vi.spyOn(logs, 'read').mockImplementationOnce(async (...args) => {
    const events = await read(...args)
    controller.abort(new Error('cancelled during query'))
    return events
  })
  onTestFinished(() => { spy.mockRestore() })
  await expect(reader.read(0, undefined, { signal: controller.signal })).rejects.toThrow('cancelled during query')
  expect((await reader.read()).events.map(item => item.seq)).toEqual([0])
  await reader.close()
})

it('flushes at the count threshold and drains a following batch at close', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header())
  await writer.receive(event(0)); await writer.receive(event(1))
  await vi.waitFor(async () => { expect((await logs.stat(header().id))?.eventCount).toBe(2) })
  await writer.receive(event(2))
  await writer.close()
  expect((await logs.stat(header().id))?.eventCount).toBe(3)
})

it('keeps a fixed batching deadline and removes the timer on close', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header())
  vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers() })
  await writer.receive(event(0))
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(150)
  expect((await logs.stat(header().id))?.eventCount).toBeUndefined()
  await vi.advanceTimersByTimeAsync(50)
  await vi.waitFor(async () => { expect((await logs.stat(header().id))?.eventCount).toBe(1) })
  expect(vi.getTimerCount()).toBe(0)
  await writer.receive(event(1)); await writer.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('retains a rolled-back live batch and retries it in sequence at the next checkpoint', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
    await writer.receive(event(0))
    await expect(writer.flush()).rejects.toThrow('injected write failure')
    expect((await logs.stat(header().id))?.eventCount).toBe(0)
    db.exec('DROP TRIGGER fail_append')
    await writer.receive(event(1)); await writer.flush()
    expect((await writer.read()).events.map(item => item.seq)).toEqual([0, 1])
  } finally { db.close() }
  await writer.close()
})

it.each(['append', 'flush'] as const)('refuses further writes when %s commits but routing publication fails', async (operation) => {
  let reject = true
  const { logs } = await raw(async () => { if (reject) throw new Error('publication unavailable') })
  const writer = await logs.create(header())
  const failure = await (operation === 'append' ? writer.append([event(0)]) : writer.flush()).then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION', cause: { message: 'publication unavailable' } })
  reject = false
  // The retained publication failure refuses later writes and is reported again at close.
  await expect(writer.append([event(operation === 'append' ? 1 : 0)])).rejects.toBe(failure)
  await expect(writer.close()).rejects.toBe(failure)
})

it.each([false, true])('retains a committed fork when routing publication fails (lease release also fails: %s)', async (cleanupFails) => {
  let rejectPublication = false
  const publicationError = new Error('routing record write failed')
  const releaseError = new Error('write-lock handle close failed')
  const { logs } = await raw(async () => { if (rejectPublication) throw publicationError })
  const source = await logs.create(header())
  await source.append([event(0), event(1)]); await source.close()
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted release is called on the acquired lease.
  const release = SessionWriteLease.prototype.release
  const releasing = vi.spyOn(SessionWriteLease.prototype, 'release')
  onTestFinished(() => { releasing.mockRestore() })
  if (cleanupFails) releasing.mockImplementationOnce(async function (this: SessionWriteLease) {
    await release.call(this)
    throw releaseError
  })
  rejectPublication = true
  const failure = await forkSession(logs, header().id, SessionId('child'), [event(0), event(1)])
    .then(() => undefined, (error: unknown) => error)
  const publicationRefusal = { code: 'SESSION_STORAGE_PUBLICATION', cause: publicationError }
  if (cleanupFails) {
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected fork and release failures')
    expect(failure.errors).toEqual([expect.objectContaining(publicationRefusal), releaseError])
  } else expect(failure).toMatchObject(publicationRefusal)
  rejectPublication = false
  releasing.mockRestore()
  expect((await logs.stat(SessionId('child')))?.eventCount).toBe(3)
  await expect(forkSession(logs, header().id, SessionId('child'), [event(0), event(1)]))
    .rejects.toBeInstanceOf(SessionAlreadyExistsError)
  const child = await logs.open(SessionId('child'), 'write')
  try {
    expect((await child.read()).events).toMatchObject([
      event(0), event(1), { type: 'session/end-seed', seq: 2, data: { inherited: true } },
    ])
    await child.append([{ type: 'session/title', seq: SessionSeq(3), time: 0,
      data: { title: 'continued child', messageSeqs: [], source: { kind: 'user' } } }])
  } finally { await child.close() }
  const parent = await logs.open(header().id, 'read')
  try { expect((await parent.read()).events).toEqual([event(0), event(1)]) } finally { await parent.close() }
})

it('preserves complete Session metadata without exposing Segment identifiers', async () => {
  const { logs } = await raw()
  const meta: SessionHeader = { ...header(), cwd: tmpdir(), parentSession: SessionId('parent'), origin: 'subagent', delegationDepth: 2, agentPreset: 'test' }
  const writer = await logs.create(meta); await writer.flush(); await writer.close()
  const reader = await logs.open(meta.id, 'read')
  expect(reader.header).toEqual(meta)
  await reader[Symbol.asyncDispose]()
})

it('reads persisted root history using its original header', async () => {
  const { logs } = await raw()
  const meta = header()
  const writer = await logs.create(meta)
  await writer.append([event(0), event(1)]); await writer.close()
  expect(await logs.read(meta, 0, 2)).toEqual([event(0), event(1)])
})

it.each([
  { fault: 'missing-segment', error: SessionPersistenceCorruptionError },
  { fault: 'missing-parent', error: { code: 'SESSION_STORAGE_CORRUPT', message: 'Session references a missing segment' } },
  { fault: 'cycle', error: { code: 'SESSION_STORAGE_CORRUPT', message: 'Invalid Session segment chain' } },
  { fault: 'missing-prefix', error: SessionPersistenceCorruptionError },
  { fault: 'offset', error: { code: 'SESSION_STORAGE_CORRUPT', message: 'Invalid Session segment chain' } },
  { fault: 'event-hole', error: { code: 'SESSION_STORAGE_CORRUPT', message: 'SQLite segment is incomplete' } },
  { fault: 'identity', error: { code: 'SESSION_STORAGE_CORRUPT', message: 'SQLite Session identity mismatch' } },
] as const)(
  'refuses corrupted $fault instead of returning partial history', async ({ fault, error }) => {
    const { logs, path } = await raw()
    const source = await logs.create(header()); await source.append([event(0), event(1)]); await source.close()
    await sharedHistory(logs, header().id, SessionId('child'), [event(0)])
    const reader = await logs.open(SessionId('child'), 'read')
    const db = new DatabaseSync(path)
    try {
      db.exec(`PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON; DROP TRIGGER segments_no_reparent;
        DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;`)
      const head = "(SELECT head_segment_id FROM sessions WHERE session_id = 'child')"
      if (fault === 'missing-segment') db.exec(`DELETE FROM segments WHERE segment_id = ${head}`)
      if (fault === 'missing-parent') db.exec(`UPDATE segments SET parent_id = 999 WHERE segment_id = ${head}`)
      if (fault === 'cycle') db.exec(`UPDATE segments SET parent_id = segment_id WHERE segment_id = ${head}`)
      if (fault === 'missing-prefix') db.exec(`UPDATE segments SET parent_id = NULL WHERE segment_id = ${head}`)
      // The child and its marker move past the two events its parent holds.
      if (fault === 'offset') db.exec(`UPDATE segments SET base_seq = 3 WHERE segment_id = ${head}; UPDATE events SET seq = 3 WHERE segment_id = ${head}`)
      if (fault === 'event-hole') db.exec(`UPDATE events SET seq = 2 WHERE segment_id = ${head}`)
      if (fault === 'identity') db.prepare("UPDATE sessions SET header = ? WHERE session_id = 'child'").run(JSON.stringify(header('other')))
      await expectRefusal(fault === 'identity' ? logs.open(SessionId('child'), 'read') : reader.read(), error)
    } finally { db.close(); await reader.close() }
  })

it('forks zero shared events from an existing source and refuses an existing target', async () => {
  const { logs } = await raw()
  const source = await logs.create(header()); await source.append([event(0)]); await source.close()
  await forkSession(logs, header().id, SessionId('empty'), [])
  const child = await logs.open(SessionId('empty'), 'read')
  expect((await child.read()).events.map(item => item.type)).toEqual(['session/end-seed'])
  await child.close()
  await expect(forkSession(logs, SessionId('absent'), SessionId('new'), [])).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  await expect(forkSession(logs, header().id, SessionId('empty'), [])).rejects.toBeInstanceOf(SessionAlreadyExistsError)
})

it('refuses a fork when another creator commits the child after its initial metadata read', async () => {
  const { logs, path, root } = await raw()
  const parent = await logs.create(header())
  await parent.append([event(0), event(1)]); await parent.close()
  const other = sqliteLogs(path, root)
  onTestFinished(() => other.close())
  const observed = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  onTestFinished(() => { proceed.resolve(undefined) })
  const stat = logs.stat.bind(logs)
  const observing = vi.spyOn(logs, 'stat').mockImplementationOnce(async (...args) => {
    const result = await stat(...args)
    observed.resolve(undefined)
    await proceed.promise
    return result
  })
  const options = { inheritedEventCount: SessionLogOffset(2), parentSource: {
    sessionId: parent.id, endSeq: SessionLogOffset(2),
    events: [event(0), event(1), { type: 'session/end-seed', seq: SessionSeq(2), time: 0, data: { inherited: true } } satisfies SessionEvent],
  } }
  const creation = logs.create({ ...header('child'), isSeeded: true }, options)
  const settled = creation.then(() => undefined, (error: unknown) => error)
  try {
    await observed.promise
    const winner = await other.create({ ...header('child'), isSeeded: true }, options)
    await winner.close()
    proceed.resolve(undefined)
    expect(await settled).toBeInstanceOf(SessionAlreadyExistsError)
    const child = await logs.open(SessionId('child'), 'write')
    try { expect((await child.read()).events).toHaveLength(3) } finally { await child.close() }
  } finally {
    proceed.resolve(undefined)
    await settled
    observing.mockRestore()
  }
})

it('rejects a second provider writer and permits it after the owning writer closes', async () => {
  const { logs, path, root } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const other = sqliteLogs(path, root)
  try {
    await expect(other.create(header())).rejects.toBeInstanceOf(SessionAlreadyExistsError)
    await expect(other.open(header().id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await writer.close()
    const next = await other.open(header().id, 'write'); await next.close()
  } finally { await other.close() }
})

it('releases admission claims when durable metadata disappears during write-lease acquisition', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const db = new DatabaseSync(path)
  try {
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(header().id)
    await expect(logs.open(header().id, 'write')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    expect(await logs.stat(header().id)).toBeUndefined()
  } finally { db.close() }
})

it('recreates a missing database while durable routing records remain', async () => {
  const { logs, root, path } = await raw()
  const directory = join(root, '.segments')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(directory)
  await writeFile(join(directory, 'retained.json'), '{}')
  const writer = await logs.create(header())
  await writer.append([event(0)]); await writer.close()
  // The orphaned record is not repaired: its Session is gone, and only a backup can restore it.
  expect((await readdir(directory)).includes('retained.json')).toBe(true)
  expect(await stat(path)).toBeDefined()
})

it('refuses an unrelated existing SQLite database without adding Session tables', async () => {
  const { logs, path } = await raw()
  const db = new DatabaseSync(path)
  try { db.exec('CREATE TABLE unrelated (id INTEGER)') } finally { db.close() }
  await expect(logs.create(header())).rejects.toMatchObject({ code: 'SESSION_STORAGE_FORMAT', message: `SQLite persistence database "${path}" is not a Session database; it is left unchanged` })
  await expect(logs.close()).resolves.toBeUndefined()
})

it('preserves admitted live events when the drain before an explicit append fails', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'rollback'); END")
    await writer.receive(event(0))
    await expect(writer.append([event(1)])).rejects.toThrow('rollback')
    db.exec('DROP TRIGGER fail_append')
    await writer.flush()
    expect((await writer.read()).events.map(item => item.seq)).toEqual([0])
    await writer.append([event(1)])
  } finally { db.close(); await writer.close() }
})

it('drains admitted live events before writing an explicit batch', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  await writer.receive(event(0)); await writer.receive(event(1))
  await writer.append([event(2)])
  expect((await writer.read()).events.map(item => item.seq)).toEqual([0, 1, 2])
  await writer.close()
})

it('keeps admitted live events when an explicit append is aborted', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  await writer.receive(event(0))
  const controller = new AbortController(); controller.abort()
  await expect(writer.append([event(1)], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  await writer.flush()
  expect((await writer.read()).events.map(item => item.seq)).toEqual([0])
  await writer.append([event(1)])
  expect((await writer.read()).events.map(item => item.seq)).toEqual([0, 1])
  await writer.close()
})

it('reports background failure once, pauses the timer and retries through the explicit checkpoint', async () => {
  const { logs, path, report: warning } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  const reported = Promise.withResolvers<undefined>()
  warning.mockImplementation(() => { reported.resolve(undefined) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); onTestFinished(() => { vi.useRealTimers() })
  try {
    db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'background rollback'); END")
    await writer.receive(event(0)); await vi.advanceTimersByTimeAsync(200)
    await reported.promise
    expect(warning).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    db.exec('DROP TRIGGER fail_append')
    await writer.flush()
    expect((await writer.read()).events).toHaveLength(1)
  } finally { db.close(); await writer.close() }
})

it('marks live writes unusable after a commit whose routing publication failed', async () => {
  let reject = false
  const { logs } = await raw(async () => { if (reject) throw new Error('publication failed') })
  const writer = await logs.create(header()); await writer.flush()
  reject = true
  await writer.receive(event(0))
  const failure = await writer.flush().then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION', cause: { message: 'publication failed' } })
  await expect(writer.close()).rejects.toBe(failure)
})
it('refuses live events on a closed handle and keeps close idempotent', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.close()
  const failure = await writer.receive(event(0)).then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_FAILED' })
  expect(failure instanceof Error ? failure.cause : undefined).toBeInstanceOf(SessionHandleClosedError)
  await writer.close()
})

it('isolates an unknown transaction outcome and releases the writer when the database closes', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
  const exec = DatabaseSync.prototype.exec
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'COMMIT' || sql === 'ROLLBACK') throw new Error('transaction outcome unavailable')
    exec.call(this, sql)
  })
  try {
    const failure = await writer.append([event(0)]).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN', cause: { errors: [{ message: 'transaction outcome unavailable' }, { message: 'transaction outcome unavailable' }] } })
    // Every later operation of the store rejects with the same retained refusal.
    await expect(logs.stat(header().id)).rejects.toBe(failure)
    await expect(writer.append([event(0)])).rejects.toBe(failure)
  } finally { spy.mockRestore(); await writer.close() }
})

it('marks unknown when COMMIT fails even if ROLLBACK succeeds', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
  const exec = DatabaseSync.prototype.exec
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'COMMIT') throw new Error('commit outcome unavailable')
    exec.call(this, sql)
  })
  try {
    const failure = await writer.append([event(0)]).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN', cause: { message: 'commit outcome unavailable' } })
    await expect(logs.stat(header().id)).rejects.toBe(failure)
  } finally { spy.mockRestore(); await writer.close() }
})

it('aggregates drain and release failures on close', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER fail_close BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'drain failed'); END")
    await writer.receive(event(0))
    // oxlint-disable-next-line typescript/unbound-method -- Called with the lease instance as receiver.
    const original = SessionWriteLease.prototype.release
    SessionWriteLease.prototype.release = async function (this: SessionWriteLease) {
      await original.call(this)
      throw new Error('release failed')
    }
    try {
      const failure = await writer.close().then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      const messages = (failure as AggregateError).errors.map(String)
      expect(messages.some(message => message.includes('drain failed'))).toBe(true)
      expect(messages.some(message => message.includes('release failed'))).toBe(true)
    } finally { SessionWriteLease.prototype.release = original }
  } finally { db.close() }
})

it('marks unknown when an operation, its savepoint rollback, and its transaction rollback fail', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'operation failed'); END")
    // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted database as receiver below.
    const exec = DatabaseSync.prototype.exec
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'ROLLBACK TO batch; RELEASE batch') throw new Error('savepoint rollback unavailable')
      if (sql === 'ROLLBACK') throw new Error('rollback unavailable')
      exec.call(this, sql)
    })
    try {
      await expect(writer.append([event(0)])).rejects.toMatchObject({ code: 'SESSION_STORAGE_UNKNOWN',
        cause: { errors: [{ errors: [{ message: 'operation failed' }, { message: 'savepoint rollback unavailable' }] }, { message: 'rollback unavailable' }] } })
    } finally { spy.mockRestore() }
  } finally { db.close() }
})

it('aggregates failed writer barriers and disposal failures without losing their cause', async () => {
  const { logs, path } = await raw(async () => {}, true)
  const writer = await logs.create(header()); await writer.flush()
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'persistent failure'); END")
    await writer.receive(event(0))
    await expect(logs.flush()).rejects.toMatchObject({ message: 'SQLite flush failed', errors: [expect.any(Error)] })
    await expect(logs.close()).rejects.toMatchObject({ message: 'SQLite disposal failed', errors: [expect.any(Error)] })
  } finally { db.close() }
})

it('reports a failure to refresh planner statistics on close without hiding the close', async () => {
  // `failedClose` hands this test the only close, so the fixture teardown does not race it.
  const { logs } = await raw(async () => {}, true)
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  // The refresh runs on the store's own connection, which no fixture handle exposes, so intercept by statement text.
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the intercepted connection as receiver.
  const execute = DatabaseSync.prototype.exec
  let armed = false
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (armed && sql.includes('PRAGMA optimize')) throw new Error('statistics refresh failed')
    execute.call(this, sql)
  })
  armed = true
  try {
    const failure = await logs.close().then(() => undefined, (error: unknown) => error)
    // The refresh failure joins the disposal aggregate instead of escaping it, so a caller still sees one report.
    expect(failure).toMatchObject({ name: 'AggregateError', message: 'SQLite disposal failed' })
    expect((failure as AggregateError).errors.map(String)).toEqual(['Error: statistics refresh failed'])
  } finally { fault.mockRestore() }
})

it('joins an already closing writer during a provider flush', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)])
  const append = logs.append.bind(logs), gate = Promise.withResolvers<undefined>()
  const spy = vi.spyOn(logs, 'append').mockImplementationOnce(async (...args) => { await gate.promise; await append(...args) })
  onTestFinished(() => { gate.resolve(undefined); spy.mockRestore() })
  await writer.receive(event(1))
  const closing = writer.close()
  let flushed = false
  const flush = logs.flush().then(() => { flushed = true })
  await new Promise(resolve => setImmediate(resolve))
  // The provider barrier joins the closing writer's held drain instead of resolving around it.
  expect(flushed).toBe(false)
  gate.resolve(undefined)
  await flush
  expect((await logs.stat(header().id))?.eventCount).toBe(2)
  await closing
})

it('materializes pending metadata through listing and releases abandoned creates', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header())
  expect((await logs.scan()).entries).toHaveLength(1)
  const pendingReader = await logs.open(header().id, 'read')
  expect((await pendingReader.read()).events).toEqual([])
  await pendingReader.close(); await writer.close()
  expect((await logs.scan()).entries).toEqual([])
})

it('refuses a missing parent Session row before appending and preserves the committed payloads', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)])
  const db = new DatabaseSync(path)
  try {
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(header().id)
    await expect(writer.read()).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    await expect(writer.append([event(1)])).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  } finally { db.close(); await writer.close() }
})

it('reports listener failures and joins successful consumer teardown through the owning scope', async () => {
  const { logs } = await raw()
  const { SessionStore } = await import('@deepseek-ai/dsh-session')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  logs.install(ctx)
  const session = ctx.sessions.create(header().id)
  const writer = await logs.create(session.header)
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const receive = vi.spyOn(writer, 'receive').mockRejectedValueOnce(new Error('event admission refused'))
  const close = vi.spyOn(writer, 'close').mockRejectedValueOnce(new Error('close refused'))
  onTestFinished(() => { error.mockRestore(); receive.mockRestore(); close.mockRestore() })
  ctx.emit('session/event', session, event(0))
  ctx.emit('session/disposed', session)
  await vi.waitFor(() => { expect(error).toHaveBeenCalledTimes(2) })
  expect(error.mock.calls.map(([message]) => String(message)).sort()).toEqual([
    'SQLite handle close failed for source: Error: close refused',
    'SQLite persistence failed for source: Error: event admission refused',
  ])
  close.mockRestore(); receive.mockRestore()
  await writer.close()
  await ctx.fiber.dispose()
})

it('refuses opening a missing database without creating it', async () => {
  const { logs, path } = await raw()
  await expect(logs.open(header().id, 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a stale append position after the durable tail grows', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)])
  const db = new DatabaseSync(path)
  try {
    insertEvent(db, headSegment(db, header().id), event(1))
    await expect(writer.append([event(1)])).rejects.toThrow('append seq mismatch for "source": expected 2 at index 0, got 1')
  } finally { db.close(); await writer.close() }
})

it('rolls back materialization when a database trigger removes its new metadata', async () => {
  const { logs, path } = await raw()
  const committed = await logs.create(header()); await committed.flush(); await committed.close()
  const writer = await logs.create(header('pending'))
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TRIGGER remove_new_session AFTER INSERT ON sessions BEGIN DELETE FROM sessions WHERE session_id = NEW.session_id; END')
    await expect(writer.flush()).rejects.toMatchObject({ code: 'SESSION_STORAGE_CORRUPT', message: 'Committed Session metadata is unavailable' })
    db.exec('DROP TRIGGER remove_new_session')
    await writer.flush()
  } finally { db.close(); await writer.close() }
})

it('rejects a corrupt stored header identity during stat', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const db = new DatabaseSync(path)
  try { db.prepare('UPDATE sessions SET header = ?').run(JSON.stringify(header('different'))) } finally { db.close() }
  await expect(logs.stat(header().id)).rejects.toThrow('identity mismatch')
})

it('includes pending creates beside materialized metadata and tolerates a pending entry disappearing', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const pending = await logs.create(header('pending'))
  expect((await logs.scan()).entries).toHaveLength(2)
  const stat = logs.stat.bind(logs)
  const spy = vi.spyOn(logs, 'stat').mockImplementation(async id => id === SessionId('pending') ? undefined : stat(id))
  expect((await logs.scan()).entries).toHaveLength(1)
  spy.mockRestore(); await pending.close()
})

it('rejects queued work after a preceding commit failed to publish its routing record', async () => {
  const { logs } = await raw(async () => { throw new Error('publish unavailable') })
  const writer = await logs.create(header())
  const first = writer.append([event(0)]), queued = writer.append([event(1)])
  const failure = await first.then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION', cause: { message: 'publish unavailable' } })
  await expect(queued).rejects.toBe(failure)
  await expect(writer.close()).rejects.toBe(failure)
})

it('refuses importing a legacy identity already committed in SQLite', async () => {
  const { logs } = await raw()
  await logs.importLegacy(header(), SessionLogOffset(0), [])
  await expect(logs.importLegacy(header(), SessionLogOffset(0), [])).rejects.toBeInstanceOf(SessionAlreadyExistsError)
})

it('keeps an absent materialization a no-op', async () => {
  const { logs } = await raw()
  await logs.materialize(header())
})

it('aggregates write-open validation and ownership cleanup failures', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const { SessionWriteLease } = await import('../src/lease.ts')
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the lease receiver below.
  const release = SessionWriteLease.prototype.release
  const fault = vi.spyOn(SessionWriteLease.prototype, 'release').mockImplementation(async function (this: SessionWriteLease) {
    await release.call(this)
    throw new Error('release failed')
  })
  const read = vi.spyOn(logs, 'read').mockRejectedValue(new Error('history failed'))
  try { await expect(logs.open(header().id, 'write')).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error)] }) }
  finally { fault.mockRestore(); read.mockRestore() }
})

it('aggregates creation refusal and shared ownership rollback failure', async () => {
  const { logs } = await raw()
  const { SessionWriteLease } = await import('../src/lease.ts')
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  let calls = 0
  const fault = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, id) => {
    if (++calls === 2) throw new Error('artifact refused')
    const lease = await acquire(dir, id)
    const release = lease.release.bind(lease)
    lease.release = async () => { await release(); throw new Error('rollback failed') }
    return lease
  })
  const writer = await logs.create(header())
  try { await expect(writer.flush()).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error)] }) }
  finally { fault.mockRestore(); await writer.close() }
})

it.each([1, 2])('reports %i owned lease release failures', async (failures) => {
  const { logs } = await raw()
  const { SessionWriteLease } = await import('../src/lease.ts')
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  let acquired = 0
  const fault = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, id) => {
    const lease = await acquire(dir, id)
    const release = lease.release.bind(lease)
    if (++acquired <= failures) lease.release = async () => { await release(); throw new Error('release failed') }
    return lease
  })
  const writer = await logs.create(header())
  try {
    await writer.flush()
    await expect(writer.close()).rejects.toThrow(failures === 1 ? 'release failed' : 'SQLite write ownership release failed')
  } finally { fault.mockRestore() }
})

it('refuses initializing a missing database under report recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-report-')), path = join(root, 'events.sqlite')
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const logs = sqliteLogs(path, root, { recovery: 'report' })
  onTestFinished(async () => { await logs.close().catch(() => undefined) })
  await mkdir(join(root, '.segments'))
  await writeFile(join(root, '.segments/source.json'), JSON.stringify({ id: 'source', database: path }))
  await expect(logs.start()).rejects.toMatchObject({ code: 'SESSION_STORAGE_MISSING' })
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('leaves an unrelated unversioned SQLite database intact', async () => {
  const { logs, path } = await raw()
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE unrelated (value TEXT)')
    await expect(logs.start()).rejects.toMatchObject({ code: 'SESSION_STORAGE_FORMAT' })
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([{ name: 'unrelated' }])
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 0 })
  } finally { db.close() }
})

it('reports an absent Session in an existing database', async () => {
  const { logs } = await raw()
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  await expect(logs.open(SessionId('absent'), 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
})

it('refuses a stored value that is neither text nor bytes in a damaged event row', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)]); await writer.close()
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA ignore_check_constraints = ON; DROP TRIGGER events_no_update')
    db.prepare('UPDATE events SET data = 7').run()
  } finally { db.close() }
  const reader = await logs.open(header().id, 'read')
  try {
    const failure = await reader.read().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionPersistenceCorruptionError)
    if (!(failure instanceof Error)) throw new Error('expected a corruption refusal')
    expect(failure.message).toContain('stored SQLite event row is invalid')
  } finally { await reader.close() }
})

it('classifies retired V4 events as unsupported when reading durable rows', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0)]); await writer.close()
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER events_no_update')
    db.prepare("UPDATE events SET type = 'tool/code-dispatch', codec = 0, data = '{}'").run()
  } finally { db.close() }
  const reader = await logs.open(header().id, 'read')
  try { await expect(reader.read()).rejects.toBeInstanceOf(SessionFormatUnsupportedError) }
  finally { await reader.close() }
})

it('refuses invalid indexed predecessor metadata before returning inherited events', async () => {
  const { logs, path } = await raw()
  const writer = await logs.create(header()); await writer.append([event(0), event(1)]); await writer.close()
  await sharedHistory(logs, header().id, SessionId('child'), [event(0), event(1)])
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER segments_no_reparent; PRAGMA ignore_check_constraints = ON')
    db.exec('UPDATE segments SET base_seq = -1 WHERE parent_id IS NULL')
  } finally { db.close() }
  await expect(sharedHistory(logs, SessionId('child'), SessionId('bad-cut'), [event(0)])).rejects.toThrow('predecessor metadata is invalid')
  const reader = await logs.open(SessionId('child'), 'read')
  try { await expect(reader.read(0, 1)).rejects.toThrow('predecessor metadata is invalid') }
  finally { await reader.close() }
})

it('forks an earlier ancestor prefix and refuses invalid ancestry during cut selection', async () => {
  const { logs, path } = await raw()
  const source = await logs.create(header()); await source.append([event(0), event(1), event(2)]); await source.close()
  await sharedHistory(logs, header().id, SessionId('child'), [event(0), event(1)])
  await sharedHistory(logs, SessionId('child'), SessionId('grandchild'), [event(0)])
  const grandchild = await logs.open(SessionId('grandchild'), 'read')
  try { expect((await grandchild.read()).events.map(item => item.seq)).toEqual([0, 1]) }
  finally { await grandchild.close() }
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER paths_no_update; DROP TRIGGER paths_no_delete')
    const ancestors = "segment_id = (SELECT head_segment_id FROM sessions WHERE session_id = 'child') AND member_id != segment_id"
    db.exec(`UPDATE segment_paths SET end_seq = 0 WHERE ${ancestors}`)
    await expect(sharedHistory(logs, SessionId('child'), SessionId('invalid'), [event(0)])).rejects.toThrow('offset')
    db.exec(`DELETE FROM segment_paths WHERE ${ancestors}`)
    await expect(sharedHistory(logs, SessionId('child'), SessionId('invalid'), [event(0)])).rejects.toThrow('chain')
  } finally { db.close() }
})

it('ignores events from a Session without a persistence writer', async () => {
  const { ctx, storage } = await fixture()
  const session = ctx.sessions.create(header().id)
  session.append('turn/start', { turn: 1 })
  await storage.flush()
  expect(await storage.stat(session.id)).toBeUndefined()
})

it('reports a database close failure after draining and releasing the writer', async () => {
  const { logs } = await raw(async () => {}, true)
  const writer = await logs.create(header()); await writer.flush(); await writer.close()
  const failure = Object.assign(new Error('database close failed'), { code: 'EIO' })
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the intercepted database receiver.
  const close = DatabaseSync.prototype.close
  const fault = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementationOnce(function (this: DatabaseSync) {
    close.call(this)
    throw failure
  })
  try { await expect(logs.close()).rejects.toMatchObject({ message: 'SQLite disposal failed', errors: [failure] }) }
  finally { fault.mockRestore() }
})
