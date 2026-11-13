/** Recovery of a committed SQLite Session whose routing record failed to publish. @module */
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { routeOf } from './fixtures/segments.ts'

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

async function mount(root: string) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(plugin, { root, compression: 'none' })
  return ctx
}

it('serves a committed Session without its routing record to a fresh provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-publication-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  onTestFinished(() => { faults.routes = false })
  const first = await mount(root)
  const writer = await first.sessionPersistence.create(header)
  faults.routes = true
  const failure = await writer.append([event(0)]).then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION', cause: { message: 'routing directory refused' } })
  await expect(writer.close()).rejects.toBe(failure)
  faults.routes = false
  await first.fiber.dispose()
  expect(await routeOf(root, header.id)).toBe('jsonl')
  expect((await readdir(join(root, '.segments'))).filter(name => name.endsWith('.json'))).toEqual([])

  // The committed row selects SQLite without a routing record.
  const fresh = await mount(root)
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-live-publication-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  onTestFinished(() => { faults.routes = false })
  const ctx = await mount(root)
  const { SqliteLogs } = await import('@deepseek-ai/dsh-session-persistence-sqlite/src/sqlite.ts')
  const report = vi.spyOn(SqliteLogs.prototype, 'reportFailure')
  const writer = await ctx.sessionPersistence.create(header)
  const { SqliteTrace } = await import('@deepseek-ai/dsh-session-persistence-sqlite/src/sqlite.ts')
  if (!(writer instanceof SqliteTrace)) throw new Error('Expected SQLite writer')
  faults.routes = true
  await writer.receive(event(0))
  await vi.waitFor(() => { expect(report).toHaveBeenCalled() })
  await expect(writer.flush()).rejects.toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION' })
  await expect(writer.close()).rejects.toMatchObject({ code: 'SESSION_STORAGE_PUBLICATION' })
  expect(report).toHaveBeenCalled()
  faults.routes = false
  report.mockRestore()
})
