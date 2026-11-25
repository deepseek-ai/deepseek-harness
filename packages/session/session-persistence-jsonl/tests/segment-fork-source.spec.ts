/** Explicit fork source sharing, JSONL copying, and creation ownership. @module */
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId, SessionSeq, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import * as plugin from '../src/index.ts'
import * as sqlitePersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import { eventLines, generationLogPath, toHeaderLine } from '../src/format.ts'
import { JsonlSessionHandle, type JsonlHandleStorage } from '../src/storage.ts'

const parentId = SessionId('parent'), childId = SessionId('child')
const header = (id: typeof parentId, isSeeded = false): SessionHeader => ({ version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded })
const first: SessionEvent<'turn/start'> = { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }
const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(1), time: 0, data: { inherited: true } }
const options = { inheritedEventCount: SessionLogOffset(1), parentSource: { sessionId: parentId,
  endSeq: SessionLogOffset(1), events: [first, marker] } }
async function fixture(storage: 'sqlite' | 'jsonl' = 'sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fork-event-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(storage === 'sqlite' ? sqlitePersistence : plugin, { root, compression: 'none' })
  const writer = await ctx.sessionPersistence.create(header(parentId)); await writer.append([first]); await writer.close()
  return { ctx, root, storage: ctx.sessionPersistence }
}

async function closingParent() {
  const { storage } = await fixture('jsonl')
  const id = SessionId('closing-parent')
  const writer = await storage.create(header(id)) as JsonlSessionHandle
  const backend = storage as typeof storage & JsonlHandleStorage
  const persist = backend.persistBatch.bind(backend)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const waiting = Promise.withResolvers<undefined>()
  let failure: Error | undefined
  const storing = vi.spyOn(backend, 'persistBatch').mockImplementation(async (...args) => {
    if (args[0].id === id) {
      entered.resolve(undefined)
      await release.promise
      if (failure !== undefined) throw failure
    }
    await persist(...args)
  })
  const completed: SessionEvent<'turn/end'> = {
    type: 'turn/end', seq: SessionSeq(1), time: 0, data: { turn: 1, reason: { kind: 'completed' } },
  }
  writer.enqueueLive(first, () => {})
  writer.enqueueLive(completed, () => {})
  const closing = writer.close()
  const closed = closing.then(() => undefined, (error: unknown) => error)
  onTestFinished(async () => {
    release.resolve(undefined)
    await closed
    storing.mockRestore()
  })
  await entered.promise
  expect(writer.closeCompletion).toBe(closing)
  const observed = vi.spyOn(writer, 'closeCompletion', 'get').mockImplementation(() => {
    waiting.resolve(undefined)
    return closing
  })
  onTestFinished(() => { observed.mockRestore() })
  return { storage, id, closing, closed, release, waiting, storing, observedCount: () => observed.mock.calls.length,
    fail: (error: Error) => { failure = error },
    events: [first, completed],
    options: { inheritedEventCount: SessionLogOffset(2), parentSource: { sessionId: id,
      endSeq: SessionLogOffset(2), events: [first, completed, { ...marker, seq: SessionSeq(2) }] } },
  }
}

it('reads a closing JSONL parent only after its final drain', async () => {
  const f = await closingParent()
  const operation = f.storage.open(f.id, 'read').then(async (reader) => {
    try { return (await reader.read()).events } finally { await reader.close() }
  })
  const outcome = operation.then(events => ({ status: 'fulfilled', events }),
    (error: unknown) => ({ status: 'rejected', error }))
  try {
    const stage = await Promise.race([f.waiting.promise.then(() => 'waiting'), outcome.then(() => 'completed')])
    expect(stage).toBe('waiting')
    f.release.resolve(undefined)
    await f.closing
    expect(await operation).toEqual(f.events)
  } finally {
    f.release.resolve(undefined)
    await outcome
  }
})

it('copies a JSONL fork from the supplied history without waiting for the closing parent', async () => {
  const f = await closingParent()
  const child = await f.storage.create(header(childId, true), f.options)
  await child.close()
  expect(f.observedCount()).toBe(0)
  const reader = await f.storage.open(childId, 'read')
  try { expect((await reader.read()).events).toEqual(f.options.parentSource.events) } finally { await reader.close() }
  f.release.resolve(undefined)
  await f.closing
})

it('leaves no JSONL child when creation is cancelled before its first write', async () => {
  const { storage } = await fixture('jsonl')
  const abort = new AbortController()
  const reason = new Error('fork cancelled')
  abort.abort(reason)
  await expect(storage.create(header(childId, true), { ...options, signal: abort.signal })).rejects.toBe(reason)
  expect(await storage.stat(childId)).toBeUndefined()
  const child = await storage.create(header(childId, true), options)
  await child.close()
})

it.each(['sqlite', 'jsonl'] as const)('refuses competing child creation and retains the committed fork after close (%s)', async (backend) => {
  const { storage } = await fixture(backend)
  const attempts = await Promise.allSettled([
    storage.create(header(childId, true), options), storage.create(header(childId, true), options),
  ])
  expect(attempts.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  const firstChild = attempts.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])[0]!
  await expect(storage.create(header(childId, true), options)).rejects.toThrow('already exists')
  expect((await firstChild.read()).events).toEqual([first, marker])
  await firstChild.close()
  await expect(storage.create(header(childId, true), options)).rejects.toThrow('already exists')
  const reader = await storage.open(childId, 'read')
  try { expect((await reader.read()).events).toEqual([first, marker]) } finally { await reader.close() }
})

it('shares an imported JSONL parent through its SQLite root segment', async () => {
  const { root, storage } = await fixture()
  const id = SessionId('legacy')
  const parentHeader = header(id)
  const path = generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, 'none')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(toHeaderLine(parentHeader)) + '\n' + eventLines([first]) + '\n')
  const parent = await storage.open(id, 'read')
  await parent.close()
  const child = await storage.create(header(childId, true), { ...options, parentSource: { ...options.parentSource, sessionId: id } })
  await child.close()
  expect((await storage.stat(childId))?.eventCount).toBe(2)
  const db = new DatabaseSync(join(root, '.segments/sessions.sqlite'))
  try {
    expect(db.prepare('SELECT base_seq FROM segments WHERE segment_id = (SELECT head_segment_id FROM sessions WHERE session_id = ?)').get(childId)).toEqual({ base_seq: 1 })
  } finally { db.close() }
})

it.each(['sqlite', 'jsonl'] as const)('forks an empty parent after its durability checkpoint (%s)', async (backend) => {
  const { storage } = await fixture(backend)
  const pendingId = SessionId('pending')
  const parent = await storage.create(header(pendingId))
  await parent.flush(); await parent.close()
  const child = await storage.create(header(childId, true), {
    inheritedEventCount: SessionLogOffset(0), parentSource: { sessionId: pendingId, endSeq: SessionLogOffset(0),
      events: [{ ...marker, seq: SessionSeq(0) }] },
  })
  await child.close()
  const reader = await storage.open(childId, 'read')
  expect((await reader.read()).events).toEqual([{ ...marker, seq: SessionSeq(0) }])
  await reader.close()
})

it.each(['sqlite', 'jsonl'] as const)('materializes an empty child from a zero-length parent prefix (%s)', async (backend) => {
  const { storage } = await fixture(backend)
  const child = await storage.create(header(childId), {
    parentSource: { sessionId: parentId, endSeq: SessionLogOffset(0), events: [] },
  })
  await child.close()
  const reader = await storage.open(childId, 'read')
  try { expect((await reader.read()).events).toEqual([]) } finally { await reader.close() }
})

it('refuses an absent parent even for an empty prefix and releases child ownership (sqlite)', async () => {
  const { storage } = await fixture('sqlite')
  await expect(storage.create(header(childId, true), {
    inheritedEventCount: SessionLogOffset(0), parentSource: {
      sessionId: SessionId('absent'), endSeq: SessionLogOffset(0), events: [{ ...marker, seq: SessionSeq(0) }],
    },
  })).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  expect(await storage.stat(childId)).toBeUndefined()
  const child = await storage.create(header(childId, true), options)
  await child.close()
  const reader = await storage.open(childId, 'read')
  try { expect((await reader.read()).events).toEqual([first, marker]) } finally { await reader.close() }
})

it('copies a JSONL fork without consulting the parent artifact', async () => {
  const { storage } = await fixture('jsonl')
  const completed: SessionEvent<'turn/end'> = {
    type: 'turn/end', seq: SessionSeq(1), time: 0, data: { turn: 1, reason: { kind: 'completed' } },
  }
  // The stored parent holds one event and the named parent of the second child does not exist at all.
  const beyond = await storage.create(header(childId, true), {
    inheritedEventCount: SessionLogOffset(2), parentSource: { sessionId: parentId,
      endSeq: SessionLogOffset(2), events: [first, completed, { ...marker, seq: SessionSeq(2) }] },
  })
  await beyond.close()
  const absentId = SessionId('child-of-absent')
  const absent = await storage.create(header(absentId, true), {
    inheritedEventCount: SessionLogOffset(1), parentSource: { sessionId: SessionId('absent'), endSeq: SessionLogOffset(1), events: [first, marker] },
  })
  await absent.close()
  for (const [id, events] of [[childId, [first, completed, { ...marker, seq: SessionSeq(2) }]], [absentId, [first, marker]]] as const) {
    const reader = await storage.open(id, 'read')
    try { expect((await reader.read()).events).toEqual(events) } finally { await reader.close() }
  }
})

it('releases JSONL child ownership when initial materialization fails', async () => {
  const { storage } = await fixture('jsonl')
  const failure = new Error('initial JSONL write failed')
  const persist = vi.spyOn(JsonlSessionHandle.prototype, 'append').mockRejectedValueOnce(failure)
  onTestFinished(() => { persist.mockRestore() })
  await expect(storage.create(header(childId, true), options)).rejects.toBe(failure)
  expect(await storage.stat(childId)).toBeUndefined()
  const child = await storage.create(header(childId, true), options)
  await child.close()
  const reader = await storage.open(childId, 'read')
  try { expect((await reader.read()).events).toEqual([first, marker]) } finally { await reader.close() }
})

it('retains both JSONL creation and handle-close failures', async () => {
  const { storage } = await fixture('jsonl')
  const failure = new Error('initial JSONL write failed')
  const closeFailure = new Error('write lock release failed')
  const persist = vi.spyOn(JsonlSessionHandle.prototype, 'append').mockRejectedValueOnce(failure)
  const closing = vi.spyOn(JsonlSessionHandle.prototype, 'close').mockImplementationOnce(async function (this: JsonlSessionHandle) {
    closing.mockRestore()
    await this.close()
    throw closeFailure
  })
  onTestFinished(() => { persist.mockRestore(); closing.mockRestore() })
  await expect(storage.create(header(childId, true), options)).rejects.toMatchObject({ errors: [failure, closeFailure] })
  expect(await storage.stat(childId)).toBeUndefined()
  const child = await storage.create(header(childId, true), options)
  await child.close()
})
