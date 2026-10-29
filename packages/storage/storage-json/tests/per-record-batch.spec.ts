import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { JsonStorageBackend } from '../src/index.ts'

/** Rename hook installed by a case; returning true means the case handled the call. */
const gates = vi.hoisted(() => ({
  renameOverride: null as ((from: string, to: string) => Promise<boolean>) | null,
  syncOverride: null as ((path: string) => Promise<boolean>) | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ): Promise<void> => {
      const override = gates.renameOverride
      if (override !== null && await override(String(from), String(to))) return
      await actual.rename(from, to)
    },
  }
})

vi.mock('../src/atomic.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/atomic.ts')>()
  return {
    ...actual,
    fsyncDirectory: async (path: string): Promise<void> => {
      const override = gates.syncOverride
      if (override !== null && await override(path)) return
      await actual.fsyncDirectory(path)
    },
  }
})

const DESCRIPTOR = { name: 'batch', version: 1, layout: 'per-record' as const, tables: ['t'], hasGlobal: true }

const roots: string[] = []
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-per-record-batch-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  gates.renameOverride = null
  gates.syncOverride = null
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['deleteRecord', 'deleteRecords'] as const)('restores documents after a directory-sync failure in %s, then retries', async (operation) => {
  const root = await freshRoot()
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  const unit = await backend.kv.open(DESCRIPTOR)
  await unit.putRecord('t', 'a', { v: 1 })
  await unit.putRecord('t', 'b', { v: 2 })
  const path = join(root, 'batch', 't', 'a.json')
  const before = await readFile(path, 'utf8')
  const failure = new Error('directory sync failed')
  let syncs = 0
  gates.syncOverride = async () => {
    if (syncs++ === 0) throw failure
    return false
  }
  const remove = () => operation === 'deleteRecord'
    ? unit.deleteRecord('t', 'a')
    : unit.deleteRecords('t', ['a', 'b'])

  await expect(remove()).rejects.toBe(failure)
  expect(syncs).toBe(2)
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(await unit.loadAll()).toEqual({ tables: { t: { a: { v: 1 }, b: { v: 2 } } }, global: null })
  await remove()
  expect(await unit.loadAll()).toEqual({ tables: { t: operation === 'deleteRecord' ? { b: { v: 2 } } : {} }, global: null })
})

it('quarantines a deletion whose restored directory cannot be synced', async () => {
  const root = await freshRoot()
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  const unit = await backend.kv.open(DESCRIPTOR)
  await unit.putRecord('t', 'a', { v: 1 })
  const failure = new Error('directory sync denied')
  gates.syncOverride = () => Promise.reject(failure)
  await expect(unit.deleteRecords('t', ['a'])).rejects.toMatchObject({
    code: 'unknown-state',
    cause: { errors: [failure, failure] },
  })
  await expect(unit.loadAll()).rejects.toMatchObject({ code: 'unknown-state' })
  await expect(unit.deleteRecords('t', [])).rejects.toMatchObject({ code: 'unknown-state' })
  await unit.close()
  await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
})

it('does not sync or create directories for empty and missing-key deletions', async () => {
  const root = await freshRoot()
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  const unit = await backend.kv.open(DESCRIPTOR)
  gates.syncOverride = () => Promise.reject(new Error('unexpected directory sync'))
  await unit.deleteRecords('t', [])
  await unit.deleteRecords('t', ['missing', 'missing'])
  await unit.deleteRecord('t', 'missing')
  expect(await readdir(root)).toEqual([])
})

it('leaves a failed first staging operation unapplied without syncing', async () => {
  const root = await freshRoot()
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  const unit = await backend.kv.open(DESCRIPTOR)
  await unit.putRecord('t', 'a', { v: 1 })
  const failure = new Error('staging denied')
  gates.renameOverride = () => Promise.reject(failure)
  gates.syncOverride = () => Promise.reject(new Error('unexpected directory sync'))
  await expect(unit.deleteRecords('t', ['a'])).rejects.toBe(failure)
  expect(await unit.loadAll()).toEqual({ tables: { t: { a: { v: 1 } } }, global: null })
})

it('leaves an unmaterialized tree eligible for bootstrap after serialization fails', async () => {
  const root = await freshRoot()
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  const unit = await backend.kv.open(DESCRIPTOR)
  await expect(unit.putRecord('t', 'broken', { toJSON: () => { throw new Error('serialization failed') } }))
    .rejects.toThrow('serialization failed')
  expect(await readdir(root)).toEqual([])
  await writeFile(join(root, 'batch.json'), JSON.stringify({
    unit: { name: 'batch', version: 1 }, global: null, tables: { t: { saved: { v: 1 } } },
  }))
  expect((await unit.loadAll()).tables['t']).toEqual({ saved: { v: 1 } })
})

it.each(['deleteRecord', 'deleteRecords'] as const)('keeps an emptied tree authoritative after %s, including reopen', async (operation) => {
  const root = await freshRoot()
  const legacyPath = join(root, 'batch.json')
  const legacy = JSON.stringify({ unit: { name: 'batch', version: 0 }, global: null, tables: { t: { a: { v: 1 }, b: { v: 2 } } } })
  await writeFile(legacyPath, legacy)
  const descriptor = { ...DESCRIPTOR, compatibleVersions: [0] }
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  const unit = await backend.kv.open(descriptor)
  expect((await unit.loadAll()).tables['t']).toEqual({ a: { v: 1 }, b: { v: 2 } })
  if (operation === 'deleteRecord') {
    await unit.deleteRecord('t', 'a')
    await unit.deleteRecord('t', 'b')
  } else {
    await unit.deleteRecords('t', ['a', 'b'])
  }
  expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
  await backend.close()
  const reopened = new JsonStorageBackend(root)
  onTestFinished(() => reopened.close())
  expect(await (await reopened.kv.open(descriptor)).loadAll()).toEqual({ tables: { t: {} }, global: null })
  expect(await readFile(legacyPath, 'utf8')).toBe(legacy)
})

/** A filesystem denial the batch must treat as an inability to restore. */
function denied(): NodeJS.ErrnoException {
  return Object.assign(new Error('denied'), { code: 'EACCES' })
}

it('waits for the whole batch before close releases the unit', async () => {
  const root = await freshRoot()
  const backend: JsonStorageBackend = new JsonStorageBackend(root)
  const unit = await backend.kv.open(DESCRIPTOR)
  await unit.putRecord('t', 'a', { v: 1 })
  await unit.putRecord('t', 'b', { v: 2 })
  // An empty batch is a settled no-op that never touches the medium.
  await expect(unit.deleteRecords('t', [])).resolves.toBeUndefined()

  const firstEntered = Promise.withResolvers<undefined>()
  const firstRelease = Promise.withResolvers<undefined>()
  const secondEntered = Promise.withResolvers<undefined>()
  const secondRelease = Promise.withResolvers<undefined>()
  gates.renameOverride = async (_from, to) => {
    const name = basename(to)
    if (name === 'a.json.deleting') {
      firstEntered.resolve(undefined)
      await firstRelease.promise
    }
    if (name === 'b.json.deleting') {
      secondEntered.resolve(undefined)
      await secondRelease.promise
    }
    return false
  }

  const batch = unit.deleteRecords('t', ['a', 'b'])
  await firstEntered.promise
  let closed = false
  const closing = unit.close().then(() => { closed = true })
  // Start close while the first document is still staged, then let the batch
  // reach its second document. Per-rename tracking would let close() return
  // here because the second rename was not registered before the snapshot.
  firstRelease.resolve(undefined)
  try {
    await secondEntered.promise
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(closed).toBe(false)
  } finally {
    // Release the blocked batch even when the assertion fails, so teardown
    // never waits on an abandoned rename.
    secondRelease.resolve(undefined)
  }
  await batch
  await closing
  expect(closed).toBe(true)

  // The batch finished before release, so the reopened unit sees no records.
  const reopened = await backend.kv.open(DESCRIPTOR)
  expect(await reopened.loadAll()).toEqual({ tables: { t: {} }, global: null })
  await backend.close()
})

it('rejects with unknown-state when a failed batch cannot restore its staged documents', async () => {
  const root = await freshRoot()
  const backend: JsonStorageBackend = new JsonStorageBackend(root)
  const unit = await backend.kv.open(DESCRIPTOR)
  await unit.putRecord('t', 'a', { v: 1 })
  await unit.putRecord('t', 'b', { v: 2 })

  gates.renameOverride = async (from, to) => {
    // The second document cannot be staged, and the first cannot be restored.
    if (basename(to) === 'b.json.deleting') throw denied()
    if (basename(from) === 'a.json.deleting') throw denied()
    return false
  }

  await expect(unit.deleteRecords('t', ['a', 'b'])).rejects.toMatchObject({
    name: 'StorageError',
    code: 'unknown-state',
  })
  // The unit reports the unknown state instead of claiming the batch is unapplied.
  await expect(unit.loadAll()).rejects.toMatchObject({ code: 'unknown-state' })
  await expect(unit.putRecord('t', 'c', { v: 3 })).rejects.toMatchObject({ code: 'unknown-state' })
  await expect(unit.deleteRecord('t', 'a')).rejects.toMatchObject({ code: 'unknown-state' })
  await expect(unit.setGlobal({ g: 1 })).rejects.toMatchObject({ code: 'unknown-state' })
  const backup = unit.backupRecord?.bind(unit)
  if (backup === undefined) throw new Error('per-record unit must expose backupRecord')
  await expect(backup('t', 'b')).rejects.toMatchObject({ code: 'unknown-state' })
  // Releasing the handle stays possible.
  await unit.close()
  // A reopened unit reads the partial tree: the staged document is unreadable
  // residue and the second record is still present.
  const reopened = await backend.kv.open(DESCRIPTOR)
  expect(await reopened.loadAll()).toEqual({ tables: { t: { b: { v: 2 } } }, global: null })
  await reopened.close()
  await backend.close()
})
