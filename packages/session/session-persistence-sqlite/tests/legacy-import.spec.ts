import { describe, expect, it, vi, onTestFinished } from 'vitest'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '../../session-persistence-jsonl/src/format.ts'
import { SessionWriteLease } from '../src/lease.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { persistenceFixture } from './fixtures/persistence.ts'
import { storedEvents, storedFrames } from './fixtures/store.ts'

type Fixture = Awaited<ReturnType<typeof persistenceFixture>>

async function writeLegacy(fixture: Fixture, compression: JsonlCompression, header = meta('legacy', '/workspace'), events = oneTurnLog(), inheritedEventCount?: SessionLogOffset) {
  const backend = await fixture.mount('jsonl', compression)
  const writer = await backend.persistence.create(header, inheritedEventCount === undefined ? undefined : { inheritedEventCount })
  await writer.append(events)
  await writer.close()
  await backend.context.fiber.dispose()
  const path = generationLogPath(fixture.root, header.cwd, header.id, header.version, compression)
  return { header, events, path, bytes: await readFile(path) }
}

describe('JSONL import through the SQLite provider', () => {
  it('runs the released version migration before importing historical JSONL', async () => {
    const fixture = await persistenceFixture()
    const header = meta('released-v3', '/workspace')
    const bytes = Buffer.from([
      JSON.stringify({ type: 'session', ...header, version: 3, delegationDepth: 0 }),
      ...oneTurnLog().map(event => JSON.stringify(event)),
      '',
    ].join('\n'))
    const path = generationLogPath(fixture.root, header.cwd, header.id, 3, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    const jsonl = await fixture.mount('jsonl')
    const source = await jsonl.persistence.open(header.id, 'read')
    const expected = await source.read()
    const currentHeader = source.header
    await source.close()
    await jsonl.context.fiber.dispose()
    const sqlite = await fixture.mount('sqlite')
    const imported = await sqlite.persistence.open(header.id, 'read')
    expect(imported.header).toEqual(currentHeader)
    expect((await imported.read()).events).toEqual(expected.events)
    await imported.close()
    expect(await readFile(path)).toEqual(bytes)
    expect(await readdir(dirname(path))).toContain('session.v3.jsonl')
    expect(await readdir(dirname(path))).not.toContain('session.v4.jsonl')
  })

  it('imports the complete prefix of a torn JSONL tail without adding semantic repair events', async () => {
    const fixture = await persistenceFixture()
    const legacy = await writeLegacy(fixture, 'none', meta('torn-tail'), oneTurnLog().slice(0, 3))
    await appendFile(legacy.path, '{"type":"assistant/message"')
    const bytes = await readFile(legacy.path)
    const sqlite = await fixture.mount('sqlite')
    const reader = await sqlite.persistence.open(legacy.header.id, 'read')
    expect((await reader.read()).events).toEqual(legacy.events)
    await reader.close()
    expect(await readFile(legacy.path)).toEqual(bytes)
  })

  it.each(['none', 'zstd'] as const)('imports %s history into one root segment and preserves logical inheritance and source bytes', async (compression) => {
    const fixture = await persistenceFixture()
    const header: SessionHeader = { ...meta('seeded-legacy', '/workspace'), isSeeded: true, parentSession: meta('parent').id, delegationDepth: 0 }
    const original = oneTurnLog()
    const events: SessionEvent[] = [
      ...original.slice(0, 2),
      { type: 'session/end-seed', seq: SessionSeq(2), time: 2, data: { inherited: true } },
      ...original.slice(2).map(event => ({ ...event, seq: SessionSeq(event.seq + 1) })),
    ]
    const legacy = await writeLegacy(fixture, compression, header, events, SessionLogOffset(2))
    const { persistence } = await fixture.mount('sqlite', compression)
    expect((await persistence.stat(header.id))?.header).toEqual(header)
    expect((await persistence.list()).map(entry => entry.header.id)).toEqual([header.id])
    expect(await readdir(fixture.root)).not.toContain('.segments')
    const reader = await persistence.open(header.id, 'read')
    expect(reader.header).toEqual(header)
    expect(reader.inheritedEventCount).toBe(2)
    expect((await reader.read()).events).toEqual(events)
    await reader.close()
    expect(await readFile(legacy.path)).toEqual(legacy.bytes)
    expect((await persistence.list()).map(entry => entry.header.id)).toEqual([header.id])
    const db = new DatabaseSync(join(fixture.root, '.segments', 'sessions.sqlite'), { readOnly: true })
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM traces').get()?.count).toBe(1)
      expect(db.prepare('SELECT parent_segment_uuid, parent_end_seq, base_seq FROM segments').all()).toEqual([
        { parent_segment_uuid: null, parent_end_seq: null, base_seq: 0 },
      ])
      const segment = z.object({ segment_uuid: z.string() }).parse(db.prepare('SELECT segment_uuid FROM segments').get()).segment_uuid
      expect(storedFrames(db, segment).map(frame => [frame.start, frame.end])).toEqual([[0, events.length]])
      expect(storedEvents(db, segment)).toEqual(events)
    } finally { db.close() }
  })

  it('continues writing in SQLite after reopening and leaves the imported JSONL unchanged', async () => {
    const fixture = await persistenceFixture()
    const legacy = await writeLegacy(fixture, 'none')
    const first = await fixture.mount('sqlite')
    const writer = await first.persistence.open(legacy.header.id, 'write')
    const continuation: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(6), time: 10, data: { turn: 2 } },
      { type: 'turn/end', seq: SessionSeq(7), time: 11, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    await writer.append(continuation)
    await writer.close()
    await first.context.fiber.dispose()
    const reopened = await fixture.mount('sqlite')
    const reader = await reopened.persistence.open(legacy.header.id, 'read')
    expect((await reader.read()).events).toEqual([...legacy.events, ...continuation])
    await reader.close()
    expect(await readFile(legacy.path)).toEqual(legacy.bytes)
  })

  it('imports once when two readers open the same legacy Session simultaneously', async () => {
    const fixture = await persistenceFixture()
    const legacy = await writeLegacy(fixture, 'none')
    const { persistence } = await fixture.mount('sqlite')
    const prepare = vi.spyOn(JsonlSessionPersistence.prototype, 'prepare')
    onTestFinished(() => { prepare.mockRestore() })
    const readers = await Promise.all([
      persistence.open(legacy.header.id, 'read'),
      persistence.open(legacy.header.id, 'read'),
    ])
    expect(prepare).toHaveBeenCalledTimes(1)
    for (const reader of readers) {
      expect((await reader.read()).events).toEqual(legacy.events)
      await reader.close()
    }
  })

  it('allows another provider to read an imported Session while its writer retains ownership', async () => {
    const fixture = await persistenceFixture()
    const legacy = await writeLegacy(fixture, 'none')
    const first = await fixture.mount('sqlite')
    const second = await fixture.mount('sqlite')
    const writer = await first.persistence.open(legacy.header.id, 'write')
    const reader = await second.persistence.open(legacy.header.id, 'read')
    expect((await reader.read()).events).toEqual(legacy.events)
    await expect(second.persistence.open(legacy.header.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await reader.close()
    await writer.close()
    const next = await second.persistence.open(legacy.header.id, 'write')
    await next.close()
  })

  it('waits for the active JSONL writer before importing its final committed prefix', async () => {
    const fixture = await persistenceFixture()
    const jsonl = await fixture.mount('jsonl')
    const header = meta('active-legacy', '/workspace')
    const writer = await jsonl.persistence.create(header)
    await writer.append(oneTurnLog().slice(0, 3))
    const sqlite = await fixture.mount('sqlite')
    const attempted = Promise.withResolvers<undefined>()
    const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
    const spy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (...args) => {
      try { return await acquire(...args) } finally { attempted.resolve(undefined) }
    })
    onTestFinished(() => { spy.mockRestore() })
    const pending = sqlite.persistence.open(header.id, 'read')
    await attempted.promise
    await writer.append(oneTurnLog().slice(3))
    await writer.close()
    const reader = await pending
    expect((await reader.read()).events).toEqual(oneTurnLog())
    await reader.close()
  })

  it('cancels a read waiting for JSONL ownership and permits a later import', async () => {
    const fixture = await persistenceFixture()
    const jsonl = await fixture.mount('jsonl')
    const header = meta('cancel-import')
    const writer = await jsonl.persistence.create(header)
    await writer.append(oneTurnLog())
    const sqlite = await fixture.mount('sqlite')
    const attempted = Promise.withResolvers<undefined>()
    const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
    const spy = vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (...args) => {
      try { return await acquire(...args) } finally { attempted.resolve(undefined) }
    })
    onTestFinished(() => { spy.mockRestore() })
    const controller = new AbortController()
    const reason = new Error('cancelled import')
    const rejected = expect(sqlite.persistence.open(header.id, 'read', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', cause: reason })
    await attempted.promise
    controller.abort(reason)
    await rejected
    await writer.close()
    const reader = await sqlite.persistence.open(header.id, 'read')
    expect((await reader.read()).events).toEqual(oneTurnLog())
    await reader.close()
  })
})
