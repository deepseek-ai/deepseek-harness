import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonStorageBackend } from '../src/index.ts'

/** Rename hook installed by a case; returning true means the case handled the call. */
const gates = vi.hoisted(() => ({
  renameOverride: null as ((from: string, to: string) => Promise<boolean>) | null,
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

const DESCRIPTOR = { name: 'batch', version: 1, layout: 'per-record' as const, tables: ['t'], hasGlobal: true }

const roots: string[] = []
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-per-record-batch-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  gates.renameOverride = null
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
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
