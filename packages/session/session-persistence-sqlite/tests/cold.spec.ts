/** Whole-Session archives, hot queries, and rehydration across storage instances. @module */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionFormatUnsupportedError, SessionPersistenceCorruptionError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { Config } from '../src/index.ts'
import { archiveRow, archiveSession, EVENT_CODEC_COLD, readArchive } from '../src/cold.ts'
import { SessionWriteLease } from '../src/lease.ts'
import { SqliteSessionPersistence } from '../src/persistence.ts'
import { APPLICATION_ID, SCHEMA_VERSION } from '../src/schema.ts'
import { SqlFiles } from '../src/sql.ts'
import { SqliteStore } from '../src/sqlite.ts'
import { databaseStorageBytes, runCompaction, vacuumStorage } from '../src/vacuum.ts'
import * as win32 from '../src/win32.ts'
import { forkSession, sqliteLogs } from './fixtures/store.ts'

const fsHooks = vi.hoisted(() => ({
  onOpen: undefined as ((target: string, flags?: string | number) => Promise<void> | void) | undefined,
  failRmOnce: false,
  spoofSecondBigintIno: false,
  throwNonErrorStatOnce: false,
  bigintCalls: 0,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (fsHooks.onOpen !== undefined) await fsHooks.onOpen(String(args[0]), args[1])
      return await actual.open(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fsHooks.failRmOnce && String(args[0]).endsWith('.jsonl.zst')) {
        fsHooks.failRmOnce = false
        throw new Error('rm blocked')
      }
      await actual.rm(...args)
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: ((target: Parameters<typeof actual.statSync>[0], opts?: Parameters<typeof actual.statSync>[1]) => {
      if (fsHooks.throwNonErrorStatOnce) {
        fsHooks.throwNonErrorStatOnce = false
        throw 'string-failure'
      }
      if (fsHooks.spoofSecondBigintIno && opts !== undefined && typeof opts === 'object' && 'bigint' in opts && opts.bigint) {
        fsHooks.bigintCalls += 1
        if (fsHooks.bigintCalls === 2) {
          fsHooks.spoofSecondBigintIno = false
          const bigintRes = actual.statSync(target, { bigint: true })
          bigintRes.ino = -1n
          return bigintRes
        }
      }
      return actual.statSync(target, opts as never)
    }) as typeof actual.statSync,
  }
})

afterEach(() => {
  fsHooks.onOpen = undefined
  fsHooks.failRmOnce = false
  fsHooks.spoofSecondBigintIno = false
  fsHooks.throwNonErrorStatOnce = false
  fsHooks.bigintCalls = 0
})

const id = SessionId('idle')
const day = 86_400_000
const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, delegationDepth: 0 }
const event: SessionEvent = { type: 'user/message', surfaceOp: 'append', seq: SessionSeq(0), time: 1,
  data: createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(16_384) }], source: { kind: 'user' } }) }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cold-tier-'))
  const path = join(root, 'sessions.sqlite'), directory = `${path}.cold`
  const seed = sqliteLogs(path, root), report = vi.fn<(error: unknown) => void>()
  const dbs = [seed]
  const inspect = new DatabaseSync(path)
  onTestFinished(async () => {
    try { await Promise.all(dbs.map(store => store.close())) }
    finally { if (inspect.isOpen) inspect.close(); await rm(root, { recursive: true, force: true }) }
  })
  const open = async (coldAfterDays?: number) => {
    const store = sqliteLogs(path, root, { reportArchive: report, ...coldAfterDays === undefined ? {} : { coldAfterDays } })
    dbs.push(store)
    await store.start()
    return store
  }
  const write = async (meta = header, history: readonly SessionEvent[] = [event]) => {
    const handle = await seed.create(meta)
    try { await handle.append(history); await handle.flush() } finally { await handle.close() }
  }
  await write()
  const count = () => inspect.prepare('SELECT count(*) AS count FROM cold_segments').get()?.count
  const archived = () => expect.poll(() => { expect(report.mock.calls).toEqual([]); return count() }).toBe(1)
  return { seed, open, write, inspect, directory, count, archived, report }
}

it('validates an optional idle period in whole days', () => {
  expect(Config({ root: '/unused' }).coldAfterDays).toBe(30)
  expect(Config({ root: '/unused', coldAfterDays: 0 }).coldAfterDays).toBe(0)
  expect(Config({ root: '/unused', coldAfterDays: 7 }).coldAfterDays).toBe(7)
  expect(() => Config({ root: '/unused', coldAfterDays: -1 })).toThrow()
})

it.each(['read', 'write'] as const)('stores one complete archive and rehydrates on a %s open after restart', async (access) => {
  const f = await fixture()
  const summary = f.inspect.prepare('SELECT * FROM session_summary')
  const before = summary.all()
  const cold = await f.open(7)
  await f.archived()
  expect(f.inspect.prepare('SELECT event_no, seq, codec, length(data) AS bytes FROM events').all())
    .toEqual([{ event_no: 1, seq: 0, codec: EVENT_CODEC_COLD, bytes: 0 }])
  expect(summary.all()).toEqual(before)
  expect((await cold.stat(id))?.eventCount).toBe(1)
  expect((await cold.scan()).entries.map(item => item.header.id)).toEqual([id])
  expect(f.count()).toBe(1)
  const names = await readdir(f.directory)
  expect(names).toEqual([expect.stringMatching(/\.jsonl\.zst$/u)])
  const path = join(f.directory, names.join(''))
  const [headerLine, eventLine, last] = zstdDecompressSync(await readFile(path)).toString('utf8').split('\n')
  expect(JSON.parse(headerLine ?? '')).toMatchObject({ version: SESSION_FORMAT_VERSION, id })
  expect(JSON.parse(eventLine ?? '')).toMatchObject(event)
  expect(last).toBe('')
  await cold.close()
  const restarted = await f.open()
  const handle = await restarted.open(id, access)
  try {
    expect(f.count()).toBe(0)
    expect((await handle.read()).events).toEqual([event])
    expect(await readdir(f.directory)).toEqual([])
    if (access === 'write') {
      const next: SessionEvent = { type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } }
      await handle.append([next]); await handle.flush()
      expect((await handle.read()).events).toEqual([event, next])
    }
  } finally { await handle.close() }
})

it('skips young Sessions and fork histories', async () => {
  const f = await fixture()
  const parent = SessionId('parent'), now = Date.now()
  await f.write({ ...header, id: parent })
  await forkSession(f.seed, parent, SessionId('child'), [event])
  await f.write({ ...header, id: SessionId('young'), createdAt: now - day }, [{ ...event, time: now - day }])
  await f.write({ ...header, id: SessionId('recent-event') }, [{ ...event, time: now - day }])
  await f.write({ ...header, id: SessionId('recent-open') })
  f.inspect.prepare('UPDATE sessions SET last_opened_at = ? WHERE session_id = ?').run(now, 'recent-open')
  await f.open(30)
  await f.archived()
  expect(f.inspect.prepare('SELECT session_id FROM sessions JOIN cold_segments ON head_segment_id = segment_id').all())
    .toEqual([{ session_id: id }])
})

it('reads from a previously opened remote reader without promoting the archive', async () => {
  const f = await fixture()
  const held = await f.seed.open(id, 'read')
  try {
    await f.open(7)
    await f.archived()
    expect((await held.read()).events).toEqual([event])
    expect(f.count()).toBe(1)
    const a = await f.open(), b = await f.open()
    const readers = await Promise.all([a.open(id, 'read'), b.open(id, 'read')])
    try {
      expect(await Promise.all(readers.map(reader => reader.read().then(result => result.events)))).toEqual([[event], [event]])
      expect(f.count()).toBe(0)
    } finally { await Promise.all(readers.map(reader => reader.close())) }
  } finally { await held.close() }
})

it('refuses a damaged cold archive and preserves the locator and the damaged file', async () => {
  const f = await fixture()
  const store = await f.open(30)
  await f.archived()
  const [name] = await readdir(f.directory)
  if (name === undefined) throw new Error('Expected one archive')
  const path = join(f.directory, name)
  await writeFile(path, 'damaged')
  await expect(store.open(id, 'read')).rejects.toThrow('cold archive cannot be read')
  await expect(store.open(id, 'write')).rejects.toThrow('cold archive cannot be read')
  expect(f.count()).toBe(1)
  expect(await readFile(path, 'utf8')).toBe('damaged')
})

it('leaves the original payload in SQLite when the eviction transaction is refused', async () => {
  const f = await fixture()
  f.inspect.exec(`CREATE TRIGGER refuse_archive BEFORE UPDATE ON events WHEN NEW.codec = 254
    BEGIN SELECT RAISE(ABORT, 'fixture refused eviction'); END`)
  const store = await f.open(7)
  await expect.poll(() => f.report.mock.calls.length).toBe(1)
  expect(f.count()).toBe(0)
  expect(await readdir(f.directory)).toEqual([])
  const reader = await store.open(id, 'read')
  try { expect((await reader.read()).events).toEqual([event]) } finally { await reader.close() }
})

it('preserves the archive if the SQL event envelope no longer matches', async () => {
  const f = await fixture()
  const store = await f.open(7)
  await f.archived()
  f.inspect.exec('DROP TRIGGER events_no_update; UPDATE events SET time = time + 1')
  await expect(store.open(id, 'read')).rejects.toThrow('Cold Segment is incomplete')
  expect(f.count()).toBe(1)
  expect(await readdir(f.directory)).toHaveLength(1)
})

it('lets a reader cancel while another opener holds the archive lease', async () => {
  const f = await fixture()
  const store = await f.open(7)
  await f.archived()
  const lease = await f.seed.acquireSessionLease(header)
  const awaiting = vi.spyOn(SessionWriteLease, 'acquire')
  try {
    const controller = new AbortController(), reason = new Error('cancel reader')
    const opening = store.open(id, 'read', controller.signal)
    const outcome = opening.catch((error: unknown) => error)
    await expect.poll(() => awaiting.mock.calls.length).toBeGreaterThan(0)
    controller.abort(reason)
    const error = await outcome
    expect(error === reason || (error instanceof Error && error.cause === reason)).toBe(true)
    expect(f.count()).toBe(1)
  } finally { awaiting.mockRestore(); await lease.release() }
})

it('does not evict a Session held by a writer in another store', async () => {
  const f = await fixture()
  const writer = await f.seed.open(id, 'write')
  try {
    const sentinel = SessionId('sentinel')
    await f.write({ ...header, id: sentinel })
    await f.open(30)
    await f.archived()
    expect(f.inspect.prepare('SELECT session_id FROM sessions JOIN cold_segments ON head_segment_id = segment_id').all())
      .toEqual([{ session_id: sentinel }])
    await writer.append([{ type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } }])
    await writer.flush()
    expect((await writer.read()).events).toHaveLength(2)
  } finally { await writer.close() }
})

function holdFirstArchiveRead() {
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the intercepted store as the receiver.
  const read = SqliteStore.prototype.read
  const paused = vi.spyOn(SqliteStore.prototype, 'read').mockImplementationOnce(async function (this: SqliteStore, ...args) {
    const stored = await read.apply(this, args)
    entered.resolve(undefined)
    await resume.promise
    return stored
  })
  onTestFinished(() => { resume.resolve(undefined); paused.mockRestore() })
  return { entered: entered.promise, resume: () => { resume.resolve(undefined) } }
}

it('discards an archive if a writer adds events after its snapshot was taken', async () => {
  const f = await fixture()
  const sentinel = SessionId('sentinel')
  await f.write({ ...header, id: sentinel })
  const paused = holdFirstArchiveRead()
  await f.open(7)
  await paused.entered
  const writer = await f.seed.open(id, 'write')
  try { await writer.append([{ type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } }]) }
  finally { await writer.close(); paused.resume() }
  await f.archived()
  expect(f.inspect.prepare('SELECT session_id FROM sessions JOIN cold_segments ON head_segment_id = segment_id').all())
    .toEqual([{ session_id: sentinel }])
  expect(await readdir(f.directory)).toHaveLength(1)
  expect((await f.seed.stat(id))?.eventCount).toBe(2)
})

it('disposal waits for in-flight archiving without releasing the inline payload', async () => {
  const f = await fixture()
  const paused = holdFirstArchiveRead()
  const store = await f.open(30)
  await paused.entered
  const closing = store.close()
  paused.resume()
  await closing
  expect(f.count()).toBe(0)
  expect(await readdir(f.directory)).toEqual([])
  expect((await f.seed.stat(id))?.eventCount).toBe(1)
})

it('compacts the SQLite file without restoring or rewriting its cold archive', async () => {
  const f = await fixture()
  const writer = await f.seed.open(id, 'write')
  const large: SessionEvent = { ...event, seq: SessionSeq(1), data: createUserMessage({
    content: [{ type: 'text', text: randomBytes(128_000).toString('base64') }], source: { kind: 'user' },
  }) }
  try { await writer.append([large]) } finally { await writer.close() }
  const store = await f.open(7)
  await f.archived()
  const [name] = await readdir(f.directory)
  if (name === undefined) throw new Error('Expected one archive')
  const path = join(f.directory, name), bytes = await readFile(path)
  const [result, joined] = await Promise.all([store.compactStorage(), store.compactStorage()])
  expect(joined).toEqual(result)
  expect(result.checkpointPending).toBe(false)
  expect(result.afterBytes).toBeLessThan(result.beforeBytes)
  expect(f.count()).toBe(1)
  expect(await readFile(path)).toEqual(bytes)
  const reader = await store.open(id, 'read')
  try { expect((await reader.read()).events).toEqual([event, large]) } finally { await reader.close() }
})

it('refuses compaction while a second connection holds the database write lock', async () => {
  const f = await fixture()
  f.inspect.exec('BEGIN IMMEDIATE')
  try {
    await expect(f.seed.compactStorage()).rejects.toMatchObject({ name: 'HarnessError', code: 'SESSION_STORAGE_LOCKED' })
  } finally { f.inspect.exec('ROLLBACK') }
  await expect(f.seed.compactStorage()).resolves.toMatchObject({ checkpointPending: false })
  expect((await f.seed.stat(id))?.eventCount).toBe(1)
})

it('leaves writes buffered until compaction completes, then commits them', async () => {
  const f = await fixture()
  const writer = await f.seed.open(id, 'write')
  try {
    const completed: string[] = []
    const compacting = f.seed.compactStorage().then(() => { completed.push('compaction') })
    const appending = writer.append([{ type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } }])
      .then(() => { completed.push('append') })
    await Promise.all([compacting, appending])
    expect(completed).toEqual(['compaction', 'append'])
    await writer.flush()
    expect((await writer.read()).events).toHaveLength(2)
  } finally { await writer.close() }
})

it('disposal joins an accepted compaction and refuses later requests', async () => {
  const f = await fixture()
  const running = f.seed.compactStorage()
  const closing = f.seed.close()
  await expect(f.seed.compactStorage()).rejects.toMatchObject({ name: 'HarnessError', code: 'SESSION_STORAGE_CLOSED' })
  const [result] = await Promise.all([running, closing])
  expect(result.checkpointPending).toBe(false)
})

it('does not create an unopened database when compaction is requested', async () => {
  const f = await fixture()
  const path = `${f.seed.path}.unopened`
  const unused = sqliteLogs(path, dirname(path))
  try {
    await expect(unused.compactStorage()).rejects.toMatchObject({ name: 'HarnessError', code: 'SESSION_STORAGE_NOT_READY' })
    expect(await unused.hasDatabase()).toBe(false)
  } finally { await unused.close() }
})

it('archives and restores a seeded multi-chunk Session and forks from an archived parent', async () => {
  const f = await fixture()
  const seededId = SessionId('seeded-long')
  const seededHeader: SessionHeader = { ...header, id: seededId, isSeeded: true }
  const longHistory: SessionEvent[] = [
    event,
    { type: 'session/end-seed', seq: SessionSeq(1), time: 1, data: { inherited: true } },
    ...Array.from({ length: 256 }, (_, index): SessionEvent => index % 2 === 0
      ? { type: 'turn/start', seq: SessionSeq(index + 2), time: 2 + index, data: { turn: index / 2 + 1 } }
      : { type: 'turn/end', seq: SessionSeq(index + 2), time: 2 + index, data: { turn: (index + 1) / 2, reason: { kind: 'completed' } } }),
  ]
  const handle = await f.seed.create(seededHeader, { inheritedEventCount: SessionLogOffset(1) })
  try { await handle.append(longHistory); await handle.flush() } finally { await handle.close() }
  const store = await f.open(7)
  await expect.poll(() => f.count()).toBe(2)

  // Forking at cut 0 needs no parent events; forking a positive prefix warms and pins the parent Segment.
  await forkSession(store, id, SessionId('zero-cut-child'), [])
  await expect(forkSession(store, SessionId('absent-parent'), SessionId('absent-child'), [event]))
    .rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  expect(f.count()).toBe(2)
  await forkSession(store, seededId, SessionId('fork-from-cold'), longHistory.slice(0, 4))
  expect(f.count()).toBe(1)
  const childReader = await store.open(SessionId('fork-from-cold'), 'read')
  try {
    expect((await childReader.read()).events).toHaveLength(5)
  } finally { await childReader.close() }
})

it('retries fork creation when another opener archives the parent before the fork commits', async () => {
  const f = await fixture()
  const store = await f.open()
  const coldStore = sqliteLogs(f.seed.path, dirname(f.seed.path), { reportArchive: f.report, coldAfterDays: 7 })
  onTestFinished(() => coldStore.close())
  await coldStore.start()
  await f.archived()
  await coldStore.close()
  const saved = archiveRow.parse(f.inspect.prepare('SELECT * FROM cold_segments').get())
  const archiveBytes = await readFile(join(f.directory, `${saved.archive}.jsonl.zst`))
  // Warm once so parent starts hot, then re-archive it right before createFork's first BEGIN IMMEDIATE!
  const initialWarm = await store.open(id, 'read')
  await initialWarm.close()
  let rearchivedOnce = false
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its database receiver.
  const exec = DatabaseSync.prototype.exec
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sqlText) {
    if (!rearchivedOnce && sqlText === 'BEGIN IMMEDIATE') {
      rearchivedOnce = true
      f.inspect.prepare('INSERT INTO cold_segments VALUES (?, ?, ?, ?)').run(saved.segment_id, saved.archive, saved.sha256, saved.bytes)
      f.inspect.prepare('UPDATE events SET codec = 254, data = X\'\' WHERE segment_id = ?').run(saved.segment_id)
    }
    exec.call(this, sqlText)
  })
  try {
    await writeFile(join(f.directory, `${saved.archive}.jsonl.zst`), archiveBytes)
    await forkSession(store, id, SessionId('retried-fork'), [event])
    expect(f.count()).toBe(0)
  } finally { spy.mockRestore() }
})

it('pages candidate batches larger than 32 Sessions and reports candidate scan failures', async () => {
  const f = await fixture()
  for (let idx = 0; idx < 33; idx++) {
    await f.write({ ...header, id: SessionId(`batch-${String(idx)}`) })
  }
  await f.open(7)
  await expect.poll(() => f.count()).toBe(34)

  // Stage an unexpected outer scheduleArchive failure on a fresh store by dropping cold_segments.
  const brokenRoot = await mkdtemp(join(tmpdir(), 'dsh-cold-broken-'))
  onTestFinished(() => rm(brokenRoot, { recursive: true, force: true }))
  const brokenPath = join(brokenRoot, 'sessions.sqlite')
  const setup = sqliteLogs(brokenPath, brokenRoot)
  await setup.start()
  await setup.close()
  const db = new DatabaseSync(brokenPath)
  db.exec('DROP TRIGGER events_no_update; DROP TABLE cold_segments')
  db.close()
  const reportArchive = vi.fn<(error: unknown) => void>()
  // Bypass schema table check by dropping cold_segments after start, before the archive pass runs.
  const freshRoot = await mkdtemp(join(tmpdir(), 'dsh-cold-drop-'))
  onTestFinished(() => rm(freshRoot, { recursive: true, force: true }))
  const freshPath = join(freshRoot, 'sessions.sqlite')
  const runner = sqliteLogs(freshPath, freshRoot, { coldAfterDays: 7, reportArchive })
  onTestFinished(() => runner.close())
  await runner.start()
  const killer = new DatabaseSync(freshPath)
  killer.exec('DROP TRIGGER events_no_update; DROP TABLE cold_segments')
  killer.close()
  // Trigger another store whose setImmediate pass sees the missing cold_segments table on candidates query.
  const runner2 = sqliteLogs(freshPath, freshRoot, { coldAfterDays: 7, reportArchive })
  onTestFinished(() => runner2.close())
  // Re-create cold_segments briefly for prepareSchema, then drop before setImmediate fires.
  const patchDb = new DatabaseSync(freshPath)
  patchDb.exec('CREATE TABLE cold_segments (segment_id INTEGER PRIMARY KEY, archive TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL)')
  const started = runner2.start()
  await started
  patchDb.exec('DROP TABLE cold_segments')
  patchDb.close()
  await expect.poll(() => reportArchive.mock.calls.length).toBeGreaterThan(0)
})

it('skips in-store active handles and aborts duplicate or modified evictions cleanly', async () => {
  const f = await fixture()
  const second = SessionId('second'), third = SessionId('third')
  await f.write({ ...header, id: second })
  await f.write({ ...header, id: third }, [
    event,
    { type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } },
  ])

  // 1. Hold a handle on the same store before archiving starts, and open another mid-snapshot.
  let thirdGate: PromiseWithResolvers<undefined> | undefined
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the intercepted store as the receiver.
  const origRead = SqliteStore.prototype.read
  const readSpy = vi.spyOn(SqliteStore.prototype, 'read')
  const pausedSecond = Promise.withResolvers<undefined>(), resumeSecond = Promise.withResolvers<undefined>()
  const pausedThird = Promise.withResolvers<undefined>(), resumeThird = Promise.withResolvers<undefined>()
  readSpy.mockImplementation(async function (this: SqliteStore, targetHeader, ...rest) {
    const stored = await origRead.call(this, targetHeader, ...rest)
    if (targetHeader.id === second) {
      pausedSecond.resolve(undefined)
      await resumeSecond.promise
    } else if (targetHeader.id === third && thirdGate === undefined) {
      thirdGate = pausedThird
      pausedThird.resolve(undefined)
      await resumeThird.promise
    }
    return stored
  })
  const store = sqliteLogs(f.seed.path, dirname(f.seed.path), { reportArchive: f.report, coldAfterDays: 7 })
  onTestFinished(() => store.close())
  await store.start()
  // Open preHeld before setImmediate fires, and reset last_opened_at so cold/candidates returns id while preHeld is open.
  const preHeld = await store.open(id, 'read')
  f.inspect.exec("UPDATE sessions SET last_opened_at = 0 WHERE session_id = 'idle'")
  const midHeldPromise = pausedSecond.promise.then(() => store.open(second, 'read'))
  try {
    await pausedSecond.promise
    const midHeld = await midHeldPromise
    try {
      resumeSecond.resolve(undefined)
      await pausedThird.promise
      // Corrupt third's first event row AFTER archiveHistory read it, so cold/record passes and cold/evict updates 1 != 2 rows.
      f.inspect.exec("DROP TRIGGER events_no_delete; DELETE FROM events WHERE seq = 0 AND segment_id = (SELECT head_segment_id FROM sessions WHERE session_id = 'third')")
      // A Segment holding a `codec = 255` set-aside row is excluded by SQL without warning.
      const setAsideId = SessionId('set-aside-unreadable')
      await f.write({ ...header, id: setAsideId }, [event])
      f.inspect.exec("DROP TRIGGER IF EXISTS events_no_update; UPDATE events SET codec = 255, type = 'storage/unreadable', data = X'' WHERE segment_id = (SELECT head_segment_id FROM sessions WHERE session_id = 'set-aside-unreadable')")
      resumeThird.resolve(undefined)
      await expect.poll(() => f.report.mock.calls.length).toBe(1)
      expect(f.report.mock.calls[0]?.[0]).toMatchObject({ code: 'SESSION_STORAGE_CORRUPT' })
      expect(f.count()).toBe(0)
    } finally { await midHeld.close() }
  } finally {
    resumeSecond.resolve(undefined)
    resumeThird.resolve(undefined)
    readSpy.mockRestore()
    await preHeld.close()
  }

  // 2. Concurrent archiver already archived a multi-chunk Session before chunk 2 is read.
  const multiId = SessionId('multi-race')
  const many: SessionEvent[] = Array.from({ length: 260 }, (_, idx): SessionEvent => idx % 2 === 0
    ? { type: 'turn/start', seq: SessionSeq(idx), time: 1, data: { turn: idx / 2 + 1 } }
    : { type: 'turn/end', seq: SessionSeq(idx), time: 1, data: { turn: (idx + 1) / 2, reason: { kind: 'completed' } } })
  await f.write({ ...header, id: multiId }, many)
  const f2Root = await mkdtemp(join(tmpdir(), 'dsh-cold-dup-'))
  onTestFinished(() => rm(f2Root, { recursive: true, force: true }))
  const f2Path = join(f2Root, 'sessions.sqlite')
  const s0 = sqliteLogs(f2Path, f2Root)
  onTestFinished(() => s0.close())
  const w = await s0.create({ ...header, id: multiId })
  await w.append(many); await w.flush(); await w.close()
  const chunkGate = holdFirstArchiveRead()
  const archiverA = sqliteLogs(f2Path, f2Root, { coldAfterDays: 7, reportArchive: () => {} })
  onTestFinished(() => archiverA.close())
  await archiverA.start()
  await chunkGate.entered
  const archiverB = sqliteLogs(f2Path, f2Root, { coldAfterDays: 7, reportArchive: () => {} })
  onTestFinished(() => archiverB.close())
  await archiverB.start()
  const checkDb = new DatabaseSync(f2Path)
  onTestFinished(() => { checkDb.close() })
  await expect.poll(() => checkDb.prepare('SELECT count(*) AS count FROM cold_segments').get()?.count).toBe(1)
  chunkGate.resume()
  // Two event-loop turns let archiverA resume past its chunk boundary, observe coldRow, and finish archiveCandidate.
  await nextTurn()
  await nextTurn()
  await archiverA.close()
  expect(checkDb.prepare('SELECT count(*) AS count FROM cold_segments').get()?.count).toBe(1)
})

it('handles cold.ts size caps, short streams, platform branches, and strict format validation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cold-unit-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const signal = new AbortController().signal

  // Short stream (< eventCount) returns undefined.
  async function* emptyStream(): AsyncGenerator<SessionEvent> {}
  expect(await archiveSession(dir, header, SessionLogOffset(0), emptyStream(), 1, signal)).toBeUndefined()

  // Oversized stream (> 256 MiB) returns undefined without writing files.
  const megabyte = 'x'.repeat(1024 * 1024)
  async function* hugeStream(): AsyncGenerator<SessionEvent> {
    for (let idx = 0; idx < 257; idx++) {
      yield { type: 'user/message', surfaceOp: 'append', seq: SessionSeq(idx), time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: megabyte }], source: { kind: 'user' } }) }
    }
  }
  expect(await archiveSession(dir, header, SessionLogOffset(0), hugeStream(), 257, signal)).toBeUndefined()
  expect(await readdir(dir)).toEqual([])

  // Windows publication branch & post-publish error cleanup.
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const publishSpy = vi.spyOn(win32, 'publishNewFileWin32').mockImplementation(async (src, dest) => {
    const { rename } = await import('node:fs/promises')
    await rename(src, dest)
  })
  try {
    async function* oneEvent(): AsyncGenerator<SessionEvent> { yield event }
    const winArchive = await archiveSession(dir, header, SessionLogOffset(0), oneEvent(), 1, signal)
    expect(winArchive).toBeDefined()
    expect((await readArchive(dir, winArchive!)).events).toEqual([event])

    publishSpy.mockRejectedValueOnce(new Error('win32 publish failed'))
    await expect(archiveSession(dir, header, SessionLogOffset(0), oneEvent(), 1, signal)).rejects.toThrow('win32 publish failed')
  } finally {
    publishSpy.mockRestore()
    platform.mockRestore()
  }

  // Cleanup of destination when directory open/sync fails after link on POSIX.
  if (process.platform !== 'win32') {
    fsHooks.onOpen = (target, flags) => {
      if (target === dir && flags === 'r') throw new Error('dir sync open failed')
    }
    try {
      async function* oneEvent(): AsyncGenerator<SessionEvent> { yield event }
      await expect(archiveSession(dir, header, SessionLogOffset(0), oneEvent(), 1, signal)).rejects.toThrow('dir sync open failed')
      expect((await readdir(dir)).filter(n => n.endsWith('.tmp'))).toEqual([])
    } finally { fsHooks.onOpen = undefined }
  }

  // Strict readArchive refusals: incomplete log, future format version, retired row, unknown event, invalid V4 marker.
  const writeRawArchive = async (rawText: string) => {
    const name = randomUUID()
    const compressed = zstdCompressSync(Buffer.from(rawText, 'utf8'))
    await writeFile(join(dir, `${name}.jsonl.zst`), compressed)
    return { archive: name, sha256: createHash('sha256').update(compressed).digest('hex'), bytes: compressed.length }
  }

  const noNewline = await writeRawArchive(JSON.stringify(header))
  await expect(readArchive(dir, noNewline)).rejects.toThrow('not a complete JSONL log')

  const emptyArchive = await writeRawArchive('')
  await expect(readArchive(dir, emptyArchive)).rejects.toThrow('not a complete JSONL log')

  const futureHeader = await writeRawArchive(`${JSON.stringify({ ...header, version: 99 })}\n`)
  await expect(readArchive(dir, futureHeader)).rejects.toBeInstanceOf(SessionFormatUnsupportedError)

  const retiredRow = await writeRawArchive(`${JSON.stringify(header)}\n${JSON.stringify({ type: 'tool/code-dispatch', seq: 0, time: 1, data: {} })}\n`)
  await expect(readArchive(dir, retiredRow)).rejects.toBeInstanceOf(SessionFormatUnsupportedError)

  const badEnvelope = await writeRawArchive(`${JSON.stringify(header)}\n${JSON.stringify({ bad: true })}\n`)
  await expect(readArchive(dir, badEnvelope)).rejects.toThrow()

  const unknownRequired = await writeRawArchive(`${JSON.stringify(header)}\n${JSON.stringify({ type: 'future/required', seq: 0, time: 1, data: {} })}\n`)
  await expect(readArchive(dir, unknownRequired)).rejects.toBeInstanceOf(SessionFormatUnsupportedError)

  const badRelationship = await writeRawArchive(`${JSON.stringify(header)}\n${JSON.stringify({ type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } })}\n`)
  await expect(readArchive(dir, badRelationship)).rejects.toThrow('unseeded')
})

it('handles warming races, touch errors, archive removal errors, unsupported cold logs, and setAside recovery', async () => {
  const f = await fixture()
  const other = SessionId('other')
  await f.write({ ...header, id: other })

  // Touch error handling: SQLITE_BUSY is reported, non-busy error rejects, and closing skips touch.
  const touchStore = await f.open(7)
  await expect.poll(() => f.count()).toBe(2)

  // Archive metadata mismatch when cold_segments points to another Session's archive.
  const rows = f.inspect.prepare('SELECT segment_id, archive, sha256, bytes FROM cold_segments ORDER BY segment_id').all().map(r => archiveRow.parse(r))
  const firstRow = rows[0]!, secondRow = rows[1]!
  f.inspect.prepare('DELETE FROM cold_segments WHERE segment_id = ?').run(secondRow.segment_id)
  f.inspect.prepare('UPDATE cold_segments SET archive = ?, sha256 = ?, bytes = ? WHERE segment_id = ?')
    .run(secondRow.archive, secondRow.sha256, secondRow.bytes, firstRow.segment_id)
  await expect(touchStore.open(id, 'read')).rejects.toThrow('does not match its SQLite metadata')
  // Restore valid cold_segments rows.
  f.inspect.prepare('UPDATE cold_segments SET archive = ?, sha256 = ?, bytes = ? WHERE segment_id = ?')
    .run(firstRow.archive, firstRow.sha256, firstRow.bytes, firstRow.segment_id)
  f.inspect.prepare('INSERT INTO cold_segments VALUES (?, ?, ?, ?)').run(secondRow.segment_id, secondRow.archive, secondRow.sha256, secondRow.bytes)

  // Unsupported format error in cold archive propagates as SessionFormatUnsupportedError, not corruption.
  const unsupportedCompressed = zstdCompressSync(Buffer.from(`${JSON.stringify({ ...header, id: other, version: 99 })}\n`))
  await writeFile(join(f.directory, `${secondRow.archive}.jsonl.zst`), unsupportedCompressed)
  f.inspect.prepare('UPDATE cold_segments SET sha256 = ?, bytes = ? WHERE segment_id = ?')
    .run(createHash('sha256').update(unsupportedCompressed).digest('hex'), unsupportedCompressed.length, secondRow.segment_id)
  const ac = new AbortController()
  await expect(touchStore.open(other, 'read', ac.signal)).rejects.toBeInstanceOf(SessionFormatUnsupportedError)

  // Concurrent in-process warming: read + read (one aborts, one succeeds) + write joining warming!
  const abortOne = new AbortController()
  const keepSignal = new AbortController()
  const warmGate = await f.seed.acquireSessionLease(header)
  const warmLeaseSpy = vi.spyOn(SessionWriteLease, 'acquire')
  try {
    // Start an un-signalled opener FIRST so waiters counts un-signalled callers too; aborting abortOne must not abort unsignalled!
    const unsignalled = touchStore.open(id, 'read')
    const r1 = touchStore.open(id, 'read', abortOne.signal)
    const r2 = touchStore.open(id, 'read', keepSignal.signal)
    const w1 = touchStore.open(id, 'write')
    await expect.poll(() => warmLeaseSpy.mock.calls.length).toBeGreaterThan(0)
    abortOne.abort(new Error('abort-one-waiter'))
    await expect(r1).rejects.toThrow('abort-one-waiter')
    await warmGate.release()
    const [unsignalledHandle, readHandle, writeHandle] = await Promise.all([unsignalled, r2, w1])
    expect((await unsignalledHandle.read()).events).toEqual([event])
    expect((await readHandle.read()).events).toEqual([event])
    expect((await writeHandle.read()).events).toEqual([event])
    await unsignalledHandle.close()
    await readHandle.close()
    await writeHandle.close()
  } finally {
    warmLeaseSpy.mockRestore()
    await warmGate.release()
  }

  // Hot Session touch: SQLITE_BUSY reports via reportArchive; non-busy trigger rejects.
  const freshTouchStore = await f.open(7)
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its database receiver.
  const origPrepare = DatabaseSync.prototype.prepare
  const busyPrepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sqlText) {
    const stmt = origPrepare.call(this, sqlText)
    if (sqlText.includes('SET last_opened_at')) {
      vi.spyOn(stmt, 'run').mockImplementation(() => {
        throw Object.assign(new Error('busy touch'), { errcode: 5 })
      })
    }
    return stmt
  })
  try {
    const hotReader = await freshTouchStore.open(id, 'read')
    await hotReader.close()
    expect(f.report).toHaveBeenCalled()
  } finally { busyPrepare.mockRestore() }

  f.inspect.exec('UPDATE sessions SET last_opened_at = 0')
  f.inspect.exec("CREATE TRIGGER refuse_touch BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'touch blocked'); END")
  await expect(touchStore.open(id, 'read')).rejects.toThrow('touch blocked')
  f.inspect.exec('DROP TRIGGER refuse_touch')

  // Touch skipped when store closes while waiting for compaction.
  const touchWaitStore = await f.open(7)
  f.inspect.exec('UPDATE sessions SET last_opened_at = 0')
  const compRun = touchWaitStore.compactStorage()
  const pendingOpen = touchWaitStore.open(id, 'read').catch((err: unknown) => err)
  await nextTurn()
  const closePromise = touchWaitStore.close()
  await Promise.all([compRun, closePromise, pendingOpen])
})

it('covers warm lease timeout, non-contention lease error, SQLITE_BUSY, concurrent warm races, held reader fallbacks, and setAside(.cold)', async () => {
  const f = await fixture()
  const held = await f.seed.open(id, 'read')
  onTestFinished(() => held.close())
  const store = await f.open(7)
  await f.archived()

  // 1. Held reader when cold_segments row is missing vs damaged archive vs concurrent restore removing archive.
  const savedRow = archiveRow.parse(f.inspect.prepare('SELECT * FROM cold_segments').get())
  f.inspect.exec('DELETE FROM cold_segments')
  await expect(held.read()).rejects.toMatchObject({ code: 'SESSION_STORAGE_CORRUPT' })
  f.inspect.prepare('INSERT INTO cold_segments VALUES (?, ?, ?, ?)').run(savedRow.segment_id, savedRow.archive, savedRow.sha256, savedRow.bytes)

  const archivePath = join(f.directory, `${savedRow.archive}.jsonl.zst`)
  const goodBytes = await readFile(archivePath)
  await writeFile(archivePath, 'corrupt-bytes')
  await expect(held.read()).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  await writeFile(archivePath, goodBytes)

  // Simulate archive vanishing right before held.read() opens it because a concurrent open() restored inline rows.
  await rm(archivePath, { force: true })
  const openerDone = (async () => {
    await writeFile(archivePath, goodBytes)
    const r = await store.open(id, 'read')
    await r.close()
  })()
  await openerDone
  // Re-stage cold state once more to test the exact retry branch in read() where readArchive fails and coldRow changed.
  const fRace = await fixture()
  const raceHeld = await fRace.seed.open(id, 'read')
  onTestFinished(() => raceHeld.close())
  const raceStore = await fRace.open(7)
  await fRace.archived()
  let interceptedOnce = false
  fsHooks.onOpen = async (target) => {
    if (!interceptedOnce && target.endsWith('.jsonl.zst')) {
      interceptedOnce = true
      const warmHandle = await raceStore.open(id, 'read')
      await warmHandle.close()
    }
  }
  try {
    expect((await raceHeld.read()).events).toEqual([event])
  } finally { fsHooks.onOpen = undefined }

  // 2. Lease timeout, non-SessionAlreadyOwnedError, SQLITE_BUSY during warm, removeArchive failure, and concurrent warm races.
  const fWarm = await fixture()
  const warmStoreA = await fWarm.open(7)
  const warmStoreB = await fWarm.open()
  await fWarm.archived()

  // Non-contention error from SessionWriteLease.acquire
  const acquireSpy = vi.spyOn(SessionWriteLease, 'acquire').mockRejectedValueOnce(Object.assign(new Error('eacces'), { code: 'EACCES' }))
  await expect(warmStoreB.open(id, 'read')).rejects.toThrow('eacces')
  acquireSpy.mockRestore()

  // Lease timeout (> BUSY_TIMEOUT_MS)
  const heldLease = await fWarm.seed.acquireSessionLease(header)
  const realNow = Date.now
  let tick = realNow()
  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => { tick += 6_000; return tick })
  try {
    await expect(warmStoreB.open(id, 'read')).rejects.toMatchObject({ name: 'HarnessError', code: 'SESSION_STORAGE_LOCKED' })
  } finally {
    nowSpy.mockRestore()
    await heldLease.release()
  }

  // SQLITE_BUSY during warm's commit maps to lockOutcome (SESSION_STORAGE_LOCKED)
  fWarm.inspect.exec('BEGIN IMMEDIATE')
  // Mock connection timeout or throw SQLITE_BUSY once on BEGIN IMMEDIATE in warmStoreB
  fWarm.inspect.exec('ROLLBACK')
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its database receiver.
  const realExec = DatabaseSync.prototype.exec
  const busyExec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => {
    throw Object.assign(new Error('database is locked'), { errcode: 5 })
  })
  try {
    await expect(warmStoreB.open(id, 'read')).rejects.toMatchObject({ name: 'HarnessError', code: 'SESSION_STORAGE_LOCKED' })
  } finally { busyExec.mockRestore() }

  // Race 1: Store A already restored while Store B waited for acquireWriteLease (lease === undefined branch in warm).
  let restoredWhileWaiting = false
  const origAcquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  const raceLeaseSpy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, targetId) => {
    if (!restoredWhileWaiting) {
      restoredWhileWaiting = true
      raceLeaseSpy.mockRestore()
      const r = await warmStoreA.open(id, 'read')
      await r.close()
      throw new SessionAlreadyOwnedError(targetId)
    }
    return await origAcquire(dir, targetId)
  })
  try {
    const bHandle = await warmStoreB.open(id, 'read')
    expect((await bHandle.read()).events).toEqual([event])
    await bHandle.close()
  } finally { raceLeaseSpy.mockRestore() }

  // Race 2: Archive restored between acquireWriteLease and commit (coldRow !== locator.archive inside commit), plus removeArchive error.
  const fCommitRace = await fixture()
  await fCommitRace.open(7)
  const crB = await fCommitRace.open()
  await fCommitRace.archived()
  let clearBeforeCommit = true
  const commitExecSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sqlText) {
    if (clearBeforeCommit && sqlText === 'BEGIN IMMEDIATE') {
      clearBeforeCommit = false
      fCommitRace.inspect.exec('DELETE FROM cold_segments')
    }
    realExec.call(this, sqlText)
  })
  try {
    const h = await crB.open(id, 'read')
    await h.close()
  } finally { commitExecSpy.mockRestore() }

  // removeArchive error reporting when unlinking a restored archive fails.
  const fRm = await fixture()
  const rmStore = await fRm.open(7)
  await fRm.archived()
  fsHooks.failRmOnce = true
  const hRm = await rmStore.open(id, 'read')
  await hRm.close()
  expect(fRm.report).toHaveBeenCalled()

  // Closing while warming is in flight awaits warming entry in close(), and setAside moves .cold directory aside!
  const fCloseWarm = await fixture()
  const cwStore = await fCloseWarm.open(7)
  await fCloseWarm.archived()
  const holdLease = await fCloseWarm.seed.acquireSessionLease(header)
  const leaseSpy = vi.spyOn(SessionWriteLease, 'acquire')
  try {
    const warmingOpen = cwStore.open(id, 'read').catch((err: unknown) => err)
    await expect.poll(() => leaseSpy.mock.calls.length).toBeGreaterThan(0)
    await cwStore.close()
    await warmingOpen
  } finally { leaseSpy.mockRestore(); await holdLease.release() }

  // Damage database while .cold directory exists -> recovery='replace' moves .cold to .unreadable-<stamp>.cold.
  await fCloseWarm.seed.close()
  fCloseWarm.inspect.close()
  await writeFile(fCloseWarm.seed.path, 'damaged-sqlite-header')
  const recovered = sqliteLogs(fCloseWarm.seed.path, dirname(fCloseWarm.seed.path))
  onTestFinished(() => recovered.close())
  await recovered.start()
  const entries = await readdir(dirname(fCloseWarm.seed.path))
  expect(entries.some(name => name.endsWith('.cold') && name.includes('.unreadable-'))).toBe(true)

  // 3. Replace surface_op with non-canonical key order round-trips, corrupt cold_segments row maps to corruption,
  //    concurrent archive removal in warm() succeeds, and write-open re-reads when another writer appended before admit().
  const fBot = await fixture()
  const replaceId = SessionId('replace-surface')
  const replaceOp = { startSeq: SessionSeq(0), endSeq: SessionSeq(0), op: 'replace' as const }
  const replaceEvents: SessionEvent[] = [
    event,
    {
      type: 'user/message',
      surfaceOp: replaceOp,
      sourceEventSeqs: [SessionSeq(0)],
      seq: SessionSeq(1),
      time: 2,
      data: createUserMessage({ content: [{ type: 'text', text: 'replaced' }], source: { kind: 'user' } }),
    },
  ]
  await fBot.write({ ...header, id: replaceId }, replaceEvents)
  const botCold = await fBot.open(7)
  await expect.poll(() => fBot.count()).toBe(2)
  const repReader = await botCold.open(replaceId, 'read')
  expect((await repReader.read()).events).toHaveLength(2)
  await repReader.close()

  // Corrupt cold_segments row throws SessionPersistenceCorruptionError.
  const origArchiveRow = archiveRow.parse(fBot.inspect.prepare('SELECT * FROM cold_segments').get())
  fBot.inspect.prepare('UPDATE cold_segments SET archive = ? WHERE segment_id = ?').run('not-a-uuid', origArchiveRow.segment_id)
  await expect(botCold.open(id, 'read')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  fBot.inspect.prepare('UPDATE cold_segments SET archive = ? WHERE segment_id = ?').run(origArchiveRow.archive, origArchiveRow.segment_id)

  // Concurrent warm() unlinking the archive before Store B reads it, PLUS appending a new event before Store B admits write!
  const botB = await fBot.open()
  let racedWarm = false
  fsHooks.onOpen = async (target) => {
    if (!racedWarm && target.endsWith(`${origArchiveRow.archive}.jsonl.zst`)) {
      racedWarm = true
      fsHooks.onOpen = undefined
      const winner = await botCold.open(id, 'write')
      await winner.append([{ type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } }])
      await winner.flush()
      await winner.close()
    }
  }
  try {
    const bWrite = await botB.open(id, 'write')
    expect((await bWrite.read()).events).toHaveLength(2)
    await bWrite.close()
  } finally { fsHooks.onOpen = undefined }

  // Also cover primed length mismatch when ensureWarm returned 1 event and another store appended before admit()!
  const fPrime = await fixture()
  const primeA = await fPrime.open(7)
  const primeB = await fPrime.open()
  await fPrime.archived()
  let appendedBeforeAdmit = false
  const origAcquirePrime = SessionWriteLease.acquire.bind(SessionWriteLease)
  const admitSpy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, targetId) => {
    // First 2 calls are primeB's warm() (shared + artifact); 3rd call is primeB's admit()!
    if (!appendedBeforeAdmit && admitSpy.mock.calls.length === 3) {
      appendedBeforeAdmit = true
      admitSpy.mockRestore()
      const writerA = await primeA.open(id, 'write')
      await writerA.append([{ type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } }])
      await writerA.flush()
      await writerA.close()
    }
    return await origAcquirePrime(dir, targetId)
  })
  try {
    const writerB = await primeB.open(id, 'write')
    expect((await writerB.read()).events).toHaveLength(2)
    await writerB.close()
  } finally { admitSpy.mockRestore() }

  // f1: Last waiter aborting removes the aborted entry from `warming` immediately so a new open starts fresh!
  const fReopenAfterAbort = await fixture()
  const abortOpenStore = await fReopenAfterAbort.open(7)
  await fReopenAfterAbort.archived()
  const firstOpenEntered = Promise.withResolvers<undefined>(), releaseFirstArchiveOpen = Promise.withResolvers<undefined>()
  let blockFirstArchiveOpen = true
  fsHooks.onOpen = async (target) => {
    if (blockFirstArchiveOpen && target.endsWith('.jsonl.zst')) {
      blockFirstArchiveOpen = false
      firstOpenEntered.resolve(undefined)
      await releaseFirstArchiveOpen.promise
    }
  }
  try {
    const cancelPreview = new AbortController()
    const cancelledOpen = abortOpenStore.open(id, 'read', cancelPreview.signal)
    await firstOpenEntered.promise
    cancelPreview.abort(new Error('preview-cancelled'))
    await expect(cancelledOpen).rejects.toThrow('preview-cancelled')
    // Start a fresh un-signalled open while the aborted warm() is still unwinding inside readArchive!
    const freshOpen = abortOpenStore.open(id, 'read')
    releaseFirstArchiveOpen.resolve(undefined)
    const freshHandle = await freshOpen
    expect((await freshHandle.read()).events).toEqual([event])
    await freshHandle.close()
  } finally {
    releaseFirstArchiveOpen.resolve(undefined)
    fsHooks.onOpen = undefined
  }

  // f2 & f5: Write open racing with another store archiving the Session (both between ensureWarm and admit, and during lease hold)!
  const fWriteArchRace = await fixture()
  const openerStore = await fWriteArchRace.open()
  let archivedDuringAdmit = false
  const origAcquireRace = SessionWriteLease.acquire.bind(SessionWriteLease)
  const archAdmitSpy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, targetId) => {
    if (!archivedDuringAdmit) {
      archivedDuringAdmit = true
      archAdmitSpy.mockRestore()
      const archStore = await fWriteArchRace.open(7)
      await fWriteArchRace.archived()
      await archStore.close()
    }
    return await origAcquireRace(dir, targetId)
  })
  try {
    const raceWriter = await openerStore.open(id, 'write')
    expect(fWriteArchRace.count()).toBe(0)
    const nextTurnEvent: SessionEvent = { type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } }
    await raceWriter.append([nextTurnEvent])
    await raceWriter.flush()
    await raceWriter.close()
    const verifyReader = await openerStore.open(id, 'read')
    expect((await verifyReader.read()).events).toEqual([event, nextTurnEvent])
    await verifyReader.close()
  } finally { archAdmitSpy.mockRestore() }

  // Also cover transient SessionAlreadyOwnedError during admit() when an archiver briefly holds the Session lease!
  const fTransientLease = await fixture()
  const transientOpener = await fTransientLease.open()
  const briefLease = await fTransientLease.seed.acquireSessionLease(header)
  let releasedBrief = false
  const origAcquireTransient = SessionWriteLease.acquire.bind(SessionWriteLease)
  const transientSpy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, targetId) => {
    try { return await origAcquireTransient(dir, targetId) }
    catch (err: unknown) {
      if (!releasedBrief) {
        releasedBrief = true
        await briefLease.release()
      }
      throw err
    }
  })
  try {
    const recoveredWriter = await transientOpener.open(id, 'write')
    expect((await recoveredWriter.read()).events).toEqual([event])
    await recoveredWriter.close()
  } finally {
    transientSpy.mockRestore()
    await briefLease.release()
  }
})

it('covers SqliteSessionPersistence default 30-day archiving, warning logs, and compactStorage()', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cold-provider-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })

  const persistence = new SqliteSessionPersistence(ctx, ctx, { root, coldAfterDays: 0 }, {
    hasStoredJsonl: async () => false, list: async () => [], stat: async () => undefined,
    prepare: async () => { throw new Error('no legacy history') },
  })
  await persistence.start()
  const w = await persistence.create(header)
  await w.append([event]); await w.flush(); await w.close()

  const dbPath = join(root, '.segments', 'sessions.sqlite')
  const db = new DatabaseSync(dbPath)
  onTestFinished(() => { db.close() })
  db.exec("CREATE TRIGGER block_evict BEFORE UPDATE ON events WHEN NEW.codec = 254 BEGIN SELECT RAISE(ABORT, 'evict blocked'); END")

  // Omit coldAfterDays (default 30) so scheduleArchive hits the trigger and logs via owner.logger.warn.
  const ctx2 = new Context()
  onTestFinished(() => ctx2.fiber.dispose())
  const warn2 = vi.spyOn(ctx2.logger, 'warn').mockImplementation(() => {})
  const persistence2 = new SqliteSessionPersistence(ctx2, ctx2, { root }, {
    hasStoredJsonl: async () => false, list: async () => [], stat: async () => undefined,
    prepare: async () => { throw new Error('no legacy history') },
  })
  await persistence2.start()
  await expect.poll(() => warn2.mock.calls.some(([msg]) => String(msg).includes('SQLite Session archive maintenance failed'))).toBe(true)
  db.exec('DROP TRIGGER block_evict')
  const compacted = await persistence2.compactStorage()
  expect(compacted.checkpointPending).toBe(false)
})

it('covers compaction busy rollbacks and vacuum worker validation branches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cold-vacuum-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))

  // Failed compaction with concurrent queued write and store.close() covers waitForCompaction & close .catch handlers!
  const fBusy = await fixture()
  const busyWriter = await fBusy.seed.open(id, 'write')
  fBusy.inspect.exec('BEGIN IMMEDIATE')
  const failingCompaction = fBusy.seed.compactStorage()
  void failingCompaction.catch(() => { fBusy.inspect.exec('ROLLBACK') })
  const queuedAppend = busyWriter.append([{ type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } }])
  await expect(failingCompaction).rejects.toMatchObject({ code: 'SESSION_STORAGE_LOCKED' })
  await queuedAppend
  await busyWriter.flush()
  await busyWriter.close()

  fBusy.inspect.exec('BEGIN IMMEDIATE')
  const failingDuringClose = fBusy.seed.compactStorage()
  void failingDuringClose.catch(() => { fBusy.inspect.exec('ROLLBACK') })
  const closingBusy = fBusy.seed.close()
  await expect(failingDuringClose).rejects.toMatchObject({ code: 'SESSION_STORAGE_LOCKED' })
  await closingBusy

  // Direct unit coverage of databaseStorageBytes, runCompaction, and vacuumStorage worker failure branches.
  const sql = new SqlFiles()
  const standalonePath = join(root, 'standalone.sqlite')
  const standalone = new DatabaseSync(standalonePath)
  standalone.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; CREATE TABLE t (x INT)`)
  standalone.close()
  // Journal mode is DELETE (no -wal file exists), exercising the ?? 0 branch in databaseStorageBytes.
  expect(databaseStorageBytes(standalonePath)).toBeGreaterThan(0)
  expect(runCompaction(null).status).toBe('failed')
  expect(runCompaction({ path: standalonePath, appId: 0, version: SCHEMA_VERSION, vacuum: 'VACUUM;', checkpoint: 'SELECT 0 AS busy;' }))
    .toEqual({ status: 'failed', message: 'Error: Database identity changed before compaction' })
  expect(runCompaction({ path: standalonePath, appId: APPLICATION_ID, version: 0, vacuum: 'VACUUM;', checkpoint: 'SELECT 0 AS busy;' }))
    .toEqual({ status: 'failed', message: 'Error: Database identity changed before compaction' })
  expect(runCompaction({ path: standalonePath, appId: APPLICATION_ID, version: SCHEMA_VERSION, vacuum: 'VACUUM;', checkpoint: 'SELECT 1 AS busy;' }))
    .toEqual({ status: 'locked' })
  expect(runCompaction({ path: standalonePath, appId: APPLICATION_ID, version: SCHEMA_VERSION, vacuum: 'VACUUM;', checkpoint: 'SELECT 0 AS busy;' }))
    .toMatchObject({ status: 'done', checkpointPending: false })

  // Post-VACUUM checkpointPending: true & dev/ino change & SQLITE_BUSY errcode & non-Error throw.
  fsHooks.spoofSecondBigintIno = true
  expect(runCompaction({ path: standalonePath, appId: APPLICATION_ID, version: SCHEMA_VERSION, vacuum: 'VACUUM;', checkpoint: 'SELECT 0 AS busy;' }))
    .toEqual({ status: 'failed', message: 'Error: Database identity changed before compaction' })

  // Checkpoint busy only on second call -> checkpointPending: true
  expect(runCompaction({
    path: standalonePath, appId: APPLICATION_ID, version: SCHEMA_VERSION,
    vacuum: 'CREATE TEMP TABLE vac_done (x INT);',
    checkpoint: "SELECT count(*) AS busy FROM sqlite_temp_master WHERE name = 'vac_done';",
  })).toMatchObject({ status: 'done', checkpointPending: true })

  // SQLITE_BUSY errcode vs non-Error throw in runCompaction catch
  const lockHolder = new DatabaseSync(standalonePath)
  lockHolder.exec('BEGIN EXCLUSIVE')
  try {
    expect(runCompaction({ path: standalonePath, appId: APPLICATION_ID, version: SCHEMA_VERSION, vacuum: 'VACUUM;', checkpoint: 'SELECT 0 AS busy;' }))
      .toEqual({ status: 'locked' })
  } finally { lockHolder.close() }

  fsHooks.throwNonErrorStatOnce = true
  expect(runCompaction({ path: standalonePath, appId: APPLICATION_ID, version: SCHEMA_VERSION, vacuum: 'VACUUM;', checkpoint: 'SELECT 0 AS busy;' }))
    .toEqual({ status: 'failed', message: 'string-failure' })

  // vacuumStorage worker { status: 'failed' } and worker crash / non-zero exit branches
  await expect(vacuumStorage(join(root, 'missing-file.sqlite'), sql)).rejects.toMatchObject({
    name: 'HarnessError', code: 'SESSION_STORAGE_COMPACTION_FAILED',
  })

  // Simulate a worker emitting an error and exiting non-zero, and exiting non-zero without an error event.
  // oxlint-disable-next-line typescript/unbound-method -- Mocking EventEmitter.once on Worker prototype for two calls.
  const origOnce = Worker.prototype.once
  const crashError = new Error('worker crashed')
  let mode: 'error' | 'exit-only' = 'error'
  const workerOnceSpy = vi.spyOn(Worker.prototype, 'once').mockImplementation(function (this: Worker, eventName: string | symbol, listener: (...args: unknown[]) => void) {
    if (eventName === 'error' && mode === 'error') queueMicrotask(() => { listener(crashError) })
    if (eventName === 'exit') queueMicrotask(() => { void this.terminate(); listener(1) })
    return this
  })
  try {
    await expect(vacuumStorage(standalonePath, sql)).rejects.toMatchObject({
      name: 'HarnessError', code: 'SESSION_STORAGE_COMPACTION_FAILED', cause: crashError,
    })
    mode = 'exit-only'
    await expect(vacuumStorage(standalonePath, sql)).rejects.toMatchObject({
      name: 'HarnessError', code: 'SESSION_STORAGE_COMPACTION_FAILED',
    })
  } finally {
    workerOnceSpy.mockRestore()
    void origOnce
  }
})
