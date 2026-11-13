/** Legacy import ownership, preservation, and takeover failure recovery. @module */
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionSeq, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionAccess, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { SessionWriteLease } from '../src/lease.ts'
import { SqliteLogs, SqliteTrace } from '@deepseek-ai/dsh-session-persistence-sqlite/src/sqlite.ts'
import * as persistence from '../src/index.ts'
import type { JsonlBackend } from '@deepseek-ai/dsh-session-persistence-sqlite/src/migration.ts'
import { eventLines, generationLogPath, sessionDir, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'
import { oneTurnLog, meta } from '../../session-persistence/tests/contract.ts'

async function fixture(compression: 'none' | 'zstd' = 'none', seeded = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-legacy-open-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    vi.restoreAllMocks()
    try { for (const ctx of contexts.reverse()) await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const header = { ...meta('legacy', '/project'), isSeeded: seeded }
  const inherited = seeded ? SessionLogOffset(oneTurnLog().length) : SessionLogOffset(0)
  const events = seeded ? [...oneTurnLog(), { type: 'session/end-seed' as const, seq: SessionSeq(inherited), time: 100, data: { inherited: true as const } }] : oneTurnLog()
  const path = generationLogPath(root, header.cwd, header.id, SESSION_FORMAT_VERSION, compression)
  await mkdir(dirname(path), { recursive: true })
  const headerLine = JSON.stringify(toHeaderLine(header, inherited)) + '\n'
  const body = eventLines(events) + '\n'
  const bytes = compression === 'none' ? Buffer.from(headerLine + body) : Buffer.concat([
    await compressZstdFrame(Buffer.from(headerLine)), await compressZstdFrame(Buffer.from(body)),
  ])
  await writeFile(path, bytes)
  const mount = async () => {
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(persistence, { root, compression })
    return ctx
  }
  const ctx = await mount()
  const database = join(root, '.segments', 'sessions.sqlite')
  const inspect = () => new DatabaseSync(database)
  return { root, ctx, header, events, inherited, path, bytes, mount, database, inspect }
}

it.each(['none', 'zstd'] as const)('migrates a %s legacy read once, preserving inheritance and original bytes', async (compression) => {
  const b = await fixture(compression, true)
  expect((await b.ctx.sessionPersistence.stat(b.header.id))?.location?.kind).toBe('jsonl')
  expect((await b.ctx.sessionPersistence.list()).map(entry => entry.header.id)).toEqual([b.header.id])
  let db = b.inspect()
  try { expect(db.prepare('SELECT * FROM traces').all()).toEqual([]) } finally { db.close() }
  await using read = await b.ctx.sessionPersistence.open(b.header.id, 'read')
  expect(read.inheritedEventCount).toBe(b.inherited)
  expect((await read.read()).events).toEqual(b.events)
  expect(await readFile(b.path)).toEqual(b.bytes)
  db = b.inspect()
  try {
    expect(db.prepare('SELECT parent_segment_uuid, base_seq FROM segments').all()).toEqual([{ parent_segment_uuid: null, base_seq: 0 }])
    const traces = db.prepare('SELECT trace_uuid, header, tail_segment_uuid, inherited_count FROM traces').all()
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({ trace_uuid: b.header.id, inherited_count: b.inherited })
    if (typeof traces[0]?.header !== 'string') throw new Error('Missing imported Session header')
    expect(JSON.parse(traces[0].header)).toEqual({ ...b.header, delegationDepth: 0 })
    expect(db.prepare('SELECT segment_uuid FROM segments').get()).toMatchObject({ segment_uuid: traces[0].tail_segment_uuid })
  } finally { db.close() }
  await using again = await (await b.mount()).sessionPersistence.open(b.header.id, 'read')
  expect((await again.read()).events).toEqual(b.events)
  expect((await b.ctx.sessionPersistence.list()).map(entry => entry.header.id)).toEqual([b.header.id])
  expect((await b.ctx.sessionPersistence.stat(b.header.id))?.eventCount).toBe(b.events.length)
})

it('writes all subsequent events into SQLite and keeps the legacy file byte-identical', async () => {
  const b = await fixture()
  const writer = await b.ctx.sessionPersistence.open(b.header.id, 'write')
  await writer.append([{ type: 'turn/start', seq: SessionSeq(b.events.length), time: 100, data: { turn: 2 } }])
  await writer.flush(); await writer.close()
  expect(await readFile(b.path)).toEqual(b.bytes)
  await using read = await (await b.mount()).sessionPersistence.open(b.header.id, 'read')
  expect((await read.read()).events).toHaveLength(b.events.length + 1)
})

it('joins two simultaneous read opens on one provider and imports once', async () => {
  const b = await fixture()
  const imported = vi.spyOn(SqliteLogs.prototype, 'importLegacy')
  const [a, c] = await Promise.all([b.ctx.sessionPersistence.open(b.header.id, 'read'), b.ctx.sessionPersistence.open(b.header.id, 'read')])
  try {
    expect((await a.read()).events).toEqual(b.events)
    expect((await c.read()).events).toEqual(b.events)
    expect(imported).toHaveBeenCalledTimes(1)
  } finally { await a.close(); await c.close() }
})

it('hands migration ownership to the first writer and excludes a second writer while allowing readers', async () => {
  const b = await fixture()
  const openings = await Promise.allSettled([b.ctx.sessionPersistence.open(b.header.id, 'write'), b.ctx.sessionPersistence.open(b.header.id, 'write')])
  const writers: SessionHandle[] = []
  try {
    for (const result of openings) {
      if (result.status === 'fulfilled') writers.push(result.value)
      else expect(result.reason).toBeInstanceOf(SessionAlreadyOwnedError)
    }
    expect(writers).toHaveLength(1)
    await using read = await (await b.mount()).sessionPersistence.open(b.header.id, 'read')
    expect((await read.read()).events).toEqual(b.events)
  } finally { for (const writer of writers) await writer.close() }
  await using _resumed = await b.ctx.sessionPersistence.open(b.header.id, 'write')
})

it('waits for a legacy writer to release before importing for read', async () => {
  const b = await fixture()
  const lease = await SessionWriteLease.acquire(sessionDir(b.root, b.header.cwd, b.header.id), b.header.id)
  const contended = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- the spy calls the original with its explicit receiver.
  const acquire = SqliteLogs.prototype.acquireSessionLease
  vi.spyOn(SqliteLogs.prototype, 'acquireSessionLease').mockImplementation(async function (this: SqliteLogs, header) {
    try { return await acquire.call(this, header) }
    catch (error) { contended.resolve(undefined); throw error }
  })
  const pending = b.ctx.sessionPersistence.open(b.header.id, 'read')
  await contended.promise
  await lease.release()
  await using read = await pending
  expect((await read.read()).events).toEqual(b.events)
})

it('cancels a read waiting for legacy ownership without importing', async () => {
  const b = await fixture(), controller = new AbortController()
  const lease = await SessionWriteLease.acquire(sessionDir(b.root, b.header.cwd, b.header.id), b.header.id)
  const contended = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- the spy calls the original with its explicit receiver.
  const acquire = SqliteLogs.prototype.acquireSessionLease
  vi.spyOn(SqliteLogs.prototype, 'acquireSessionLease').mockImplementation(async function (this: SqliteLogs, header) {
    try { return await acquire.call(this, header) }
    catch (error) { contended.resolve(undefined); throw error }
  })
  const pending = b.ctx.sessionPersistence.open(b.header.id, 'read', { signal: controller.signal })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  try {
    await contended.promise
    controller.abort()
    await rejected
  } finally { await lease.release() }
  await using read = await b.ctx.sessionPersistence.open(b.header.id, 'read')
  expect((await read.read()).events).toEqual(b.events)
})

it('waits for another provider to import, then reads while its writer remains open', async () => {
  const b = await fixture(), other = await b.mount()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const legacy = Reflect.get(b.ctx.sessionPersistence, 'jsonl') as JsonlBackend
  const prepare = legacy.prepare.bind(legacy)
  const spy = vi.spyOn(legacy, 'prepare').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise
    return prepare(...args)
  })
  const opening = b.ctx.sessionPersistence.open(b.header.id, 'write')
  await entered.promise
  const pending = other.sessionPersistence.open(b.header.id, 'read')
  release.resolve(undefined)
  await using writer = await opening
  expect(writer.access).toBe('write')
  spy.mockRestore()
  await using again = await pending
  expect((await again.read()).events).toEqual(b.events)
})

it.each(['read', 'write'] as const)('cancels a %s import before commit, releasing ownership for a later open', async (access: SessionAccess) => {
  const b = await fixture(), controller = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const legacy = Reflect.get(b.ctx.sessionPersistence, 'jsonl') as JsonlBackend
  const prepare = legacy.prepare.bind(legacy)
  vi.spyOn(legacy, 'prepare').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise
    return prepare(...args)
  })
  const pending = b.ctx.sessionPersistence.open(b.header.id, access, { signal: controller.signal })
  const refused = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await entered.promise; controller.abort(); release.resolve(undefined); await refused
  const db = b.inspect()
  try { expect(db.prepare('SELECT * FROM traces').all()).toEqual([]) } finally { db.close() }
  await using _readAgain = await (await b.mount()).sessionPersistence.open(b.header.id, 'write')
})

it('rolls back a failed event insert and permits a complete retry', async () => {
  const b = await fixture()
  let db = b.inspect()
  try { db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON events WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'fixture import failed'); END") } finally { db.close() }
  await expect(b.ctx.sessionPersistence.open(b.header.id, 'read')).rejects.toThrow('fixture import failed')
  db = b.inspect()
  try {
    expect(db.prepare('SELECT * FROM traces').all()).toEqual([])
    expect(db.prepare('SELECT * FROM segments').all()).toEqual([])
    db.exec('DROP TRIGGER fail_import')
  } finally { db.close() }
  await using retry = await b.ctx.sessionPersistence.open(b.header.id, 'write')
  expect((await retry.read()).events).toEqual(b.events)
})

it('prefers a committed import over stale JSONL after routing publication fails', async () => {
  const b = await fixture()
  const provider = b.ctx.sessionPersistence
  Object.defineProperty(provider, 'publish', { configurable: true, value: async () => { throw new Error('fixture publication failed') } })
  try { await expect(provider.open(b.header.id, 'read')).rejects.toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION' }) }
  finally { Reflect.deleteProperty(provider, 'publish') }
  await using resumed = await (await b.mount()).sessionPersistence.open(b.header.id, 'write')
  expect((await resumed.read()).events).toEqual(b.events)
  await resumed.append([{ type: 'turn/start', seq: SessionSeq(b.events.length), time: 100, data: { turn: 2 } }])
  expect(await readFile(b.path)).toEqual(b.bytes)
})

it.each(['missing database', 'missing row', 'corrupt database'] as const)('refuses stale fallback after takeover with %s', async (fault) => {
  const b = await fixture()
  await (await b.ctx.sessionPersistence.open(b.header.id, 'read')).close()
  await b.ctx.fiber.dispose()
  if (fault === 'missing database') await rm(b.database)
  else if (fault === 'corrupt database') await writeFile(b.database, 'not sqlite')
  else {
    const db = b.inspect()
    try { db.prepare('DELETE FROM traces WHERE trace_uuid = ?').run(b.header.id) } finally { db.close() }
  }
  if (fault === 'missing row') {
    const fresh = await b.mount()
    await expect(fresh.sessionPersistence.open(b.header.id, 'read')).rejects.toThrow()
    await expect(fresh.sessionPersistence.list()).rejects.toMatchObject({ code: 'SESSION_STORAGE_MISSING' })
  } else await expect(b.mount()).rejects.toThrow()
  expect(await readFile(b.path)).toEqual(b.bytes)
})

it('waits for an admitted import before provider teardown closes SQLite', async () => {
  const b = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const legacy = Reflect.get(b.ctx.sessionPersistence, 'jsonl') as JsonlBackend
  const prepare = legacy.prepare.bind(legacy)
  vi.spyOn(legacy, 'prepare').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise
    return prepare(...args)
  })
  const opening = b.ctx.sessionPersistence.open(b.header.id, 'read')
  await entered.promise
  const closed = vi.spyOn(SqliteLogs.prototype, 'close')
  const disposal = b.ctx.fiber.dispose()
  expect(closed).not.toHaveBeenCalled()
  release.resolve(undefined)
  const handle = await opening
  await disposal
  await expect(handle.read()).rejects.toThrow('closed handle')
  const fresh = await b.mount()
  await using restored = await fresh.sessionPersistence.open(b.header.id, 'read')
  expect((await restored.read()).events).toEqual(b.events)
})

it('imports only complete events from a torn raw tail without adding recovery markers', async () => {
  const b = await fixture()
  await writeFile(b.path, Buffer.concat([b.bytes, Buffer.from('{"type":"turn/start"')]))
  const original = await readFile(b.path)
  await using restored = await b.ctx.sessionPersistence.open(b.header.id, 'read')
  expect((await restored.read()).events).toEqual(b.events)
  expect(await readFile(b.path)).toEqual(original)
})

it('creates SQLite Sessions by default without writing JSONL artifacts', async () => {
  const b = await fixture()
  const header = meta('fresh', '/fresh')
  await using writer = await b.ctx.sessionPersistence.create(header)
  await writer.append(oneTurnLog()); await writer.flush()
  expect((await readdir(sessionDir(b.root, header.cwd, header.id))).some(name => name.endsWith('.jsonl'))).toBe(false)
  const db = b.inspect()
  try { expect(db.prepare('SELECT trace_uuid FROM traces WHERE trace_uuid = ?').get(header.id)).toMatchObject({ trace_uuid: header.id }) } finally { db.close() }
})

it('closes an unreturned read handle when releasing migration ownership fails', async () => {
  const b = await fixture(), failure = new Error('fixture lease release failed')
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the store receiver below.
  const acquire = SqliteLogs.prototype.acquireSessionLease
  vi.spyOn(SqliteLogs.prototype, 'acquireSessionLease').mockImplementationOnce(async function (this: SqliteLogs, header) {
    const lease = await acquire.call(this, header)
    return { async release() { await lease.release(); throw failure } }
  })
  const closed = vi.spyOn(SqliteTrace.prototype, 'close')
  await expect(b.ctx.sessionPersistence.open(b.header.id, 'read')).rejects.toBe(failure)
  expect(closed).toHaveBeenCalledOnce()
  await using writer = await b.ctx.sessionPersistence.open(b.header.id, 'write')
  expect((await writer.read()).events).toEqual(b.events)
})
