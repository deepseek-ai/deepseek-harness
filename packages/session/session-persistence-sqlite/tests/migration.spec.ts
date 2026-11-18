/** Import sequencing and cleanup preserve ownership after failure. @module */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { SqliteSessionPersistence } from '../src/persistence.ts'
import { SessionAlreadyOwnedError, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { SqliteStore } from '../src/sqlite.ts'
import { LegacySessionMigration } from '../src/migration.ts'
import type { JsonlBackend } from '../src/migration.ts'
import { FRAME_DEFAULTS } from './fixtures/store.ts'

const id = SessionId('migration')
const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sqlite-import-sequence-'))
  const sqlite = new SqliteStore({ path: join(root, 'sessions.sqlite'), legacyRoot: root, ...FRAME_DEFAULTS,
    acquireCreationLease: async () => ({ release: async () => {} }), publish: async () => {}, report: () => {} })
  const jsonl: JsonlBackend = {
    hasStoredJsonl: async () => true, list: async () => [],
    stat: async () => ({ header, revision: SessionPersistenceRevision('legacy'), eventCount: 0 }),
    prepare: async () => ({ header, inheritedEventCount: SessionLogOffset(0), events: [],
      commit: async publish => publish({ header, inheritedEventCount: SessionLogOffset(0), events: [] }) }),
  }
  const selected = vi.fn(async () => false)
  const migration = new LegacySessionMigration(jsonl, sqlite, selected, async () => {})
  onTestFinished(async () => { await migration.close(); await sqlite.close(); await rm(root, { recursive: true, force: true }) })
  return { sqlite, jsonl, selected, migration }
}

it('rejects admission after close', async () => {
  const { migration } = await fixture()
  await migration.close()
  await expect(migration.open(id, 'read')).rejects.toMatchObject({ code: 'SESSION_STORAGE_CLOSED' })
})

it('lets a queued open succeed after the preceding caller fails', async () => {
  const { migration, jsonl } = await fixture()
  vi.spyOn(jsonl, 'stat').mockRejectedValueOnce(new Error('metadata failed'))
  const first = migration.open(id, 'read')
  const next = migration.open(id, 'read')
  await expect(first).rejects.toThrow('metadata failed')
  const reader = await next
  await reader.close()
})

it('rejects legacy preparation without readable metadata', async () => {
  const { migration, jsonl } = await fixture()
  vi.spyOn(jsonl, 'stat').mockResolvedValue(undefined)
  await expect(migration.open(id, 'read')).rejects.toMatchObject({ code: 'SESSION_STORAGE_CORRUPT' })
})

it.each(['read', 'write'] as const)('reports non-contention lease failure for %s', async (access) => {
  const { sqlite, migration } = await fixture()
  vi.spyOn(sqlite, 'acquireSessionLease').mockRejectedValue(new Error('lease denied'))
  await expect(migration.open(id, access)).rejects.toThrow('lease denied')
})

it('reuses a commit that wins while metadata is read', async () => {
  const { sqlite, migration, selected } = await fixture()
  await sqlite.importLegacy(header, SessionLogOffset(0), [])
  selected.mockResolvedValueOnce(false).mockResolvedValue(true)
  const handle = await migration.open(id, 'read')
  await handle.close()
})

it('publishes a commit that wins while the artifact lease is acquired', async () => {
  const { sqlite, migration, selected } = await fixture()
  await sqlite.importLegacy(header, SessionLogOffset(0), [])
  selected.mockResolvedValueOnce(false).mockResolvedValue(true)
  const handle = await migration.open(id, 'write')
  await handle.close()
})

it('preserves import and lease cleanup failures together', async () => {
  const { sqlite, jsonl, migration } = await fixture()
  vi.spyOn(sqlite, 'acquireSessionLease').mockResolvedValue({ release: async () => { throw new Error('release failed') } })
  vi.spyOn(jsonl, 'prepare').mockRejectedValue(new Error('decode failed'))
  await expect(migration.open(id, 'read')).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error)] })
})

it('closes the opened reader when artifact release fails', async () => {
  const { sqlite, migration } = await fixture()
  vi.spyOn(sqlite, 'acquireSessionLease').mockResolvedValue({ release: async () => { throw new Error('release failed') } })
  await expect(migration.open(id, 'read')).rejects.toThrow('release failed')
})

it('waits for a competing import and stops the wait on disposal', async () => {
  const { sqlite, migration } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  vi.spyOn(sqlite, 'acquireSessionLease').mockImplementation(async () => {
    entered.resolve(undefined)
    throw new SessionAlreadyOwnedError(id)
  })
  const opening = migration.open(id, 'read')
  await entered.promise
  const closing = migration.close()
  await expect(opening).rejects.toThrow()
  await closing
})

it('republishes routing when a competing importer commits under lease acquisition', async () => {
  const { jsonl } = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'sqlite-routing-import-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const provider = new SqliteSessionPersistence(ctx, ctx, { root }, jsonl)
  // oxlint-disable-next-line typescript/unbound-method -- Called with the native store receiver below.
  const acquire = SqliteStore.prototype.acquireSessionLease
  const fault = vi.spyOn(SqliteStore.prototype, 'acquireSessionLease').mockImplementationOnce(async function (this: SqliteStore, metadata) {
    await this.importLegacy(metadata, SessionLogOffset(0), [])
    return acquire.call(this, metadata)
  })
  try {
    const handle = await provider.open(id, 'read')
    await handle.close()
    expect(await provider.stat(id)).toMatchObject({ header })
  } finally { fault.mockRestore() }
})

it('opens a concurrent SQLite commit when queued legacy metadata no longer exists', async () => {
  const { sqlite, jsonl, selected, migration } = await fixture()
  await sqlite.importLegacy(header, SessionLogOffset(0), [])
  vi.spyOn(jsonl, 'stat').mockResolvedValue(undefined)
  selected.mockResolvedValue(true)
  const reader = await migration.open(id, 'read')
  await reader.close()
})
