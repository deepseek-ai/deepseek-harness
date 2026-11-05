/**
 * Shared KV-backend conformance suite. Each backend's spec file calls
 * {@link runKvBackendContract} with a factory bound to its own medium; the
 * suite asserts every clause of the `src/backend.ts` contract so both
 * backends are held to identical semantics.
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { KvUnitDescriptor, StorageBackend } from '../src/backend.ts'

/** One conformance run: a fresh backend plus a way to reopen the same medium (crash simulation). */
export interface KvBackendContractHarness {
  /** The backend under test, freshly created over an empty medium. */
  backend: StorageBackend
  /** Open a NEW backend instance over the SAME medium, as after a process restart. */
  reopen(): Promise<StorageBackend>
}

const DESCRIPTOR: KvUnitDescriptor = {
  name: 'contract_unit',
  version: 3,
  tables: ['alpha', 'beta'],
  hasGlobal: true,
}

/**
 * Run the shared conformance suite against one backend implementation.
 * @param label - Suite label, e.g. `json` / `sqlite`.
 * @param create - Factory producing a fresh harness per test.
 */
export function runKvBackendContract(label: string, create: () => Promise<KvBackendContractHarness>) {
  describe(`kv backend contract: ${label}`, () => {
    it('opens a missing unit as empty and serves loadAll immediately', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      const snapshot = await unit.loadAll()
      expect(snapshot.tables).toEqual({ alpha: {}, beta: {} })
      expect(snapshot.global).toBeNull()
      await backend.close()
    })

    it('round-trips records and global durably across reopen', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k1', { n: 1 })
      await unit.putRecord('alpha', 'k2', { n: 2 })
      await unit.putRecord('beta', 'weird key / with:stuff', { ok: true })
      await unit.setGlobal({ counter: 7 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      const snapshot = await unit2.loadAll()
      expect(snapshot.tables['alpha']).toEqual({ k1: { n: 1 }, k2: { n: 2 } })
      expect(snapshot.tables['beta']).toEqual({ 'weird key / with:stuff': { ok: true } })
      expect(snapshot.global).toEqual({ counter: 7 })
      await reopened.close()
    })

    it('putRecord overwrites and deleteRecord is idempotent', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k', { v: 'old' })
      await unit.putRecord('alpha', 'k', { v: 'new' })
      await unit.deleteRecord('alpha', 'k')
      await unit.deleteRecord('alpha', 'k')
      await unit.deleteRecord('alpha', 'never-existed')
      const snapshot = await unit.loadAll()
      expect(snapshot.tables['alpha']).toEqual({})
      await backend.close()
    })

    it('deleteRecords removes the whole batch durably and is idempotent', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k1', { n: 1 })
      await unit.putRecord('alpha', 'k2', { n: 2 })
      await unit.putRecord('alpha', 'k3', { n: 3 })
      await unit.putRecord('beta', 'b1', { n: 4 })
      await unit.deleteRecords('alpha', ['k1', 'k3', 'missing', 'k1'])
      await unit.deleteRecords('alpha', [])
      expect((await unit.loadAll()).tables).toEqual({ alpha: { k2: { n: 2 } }, beta: { b1: { n: 4 } } })
      await harness.backend.close()

      const reopened = await harness.reopen()
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      expect((await unit2.loadAll()).tables).toEqual({ alpha: { k2: { n: 2 } }, beta: { b1: { n: 4 } } })
      await reopened.close()
    })

    it.each([2, 4])('rejects version %s on reopen without touching the data', async (version) => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k', { v: 1 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      await expect(reopened.kv!.open({ ...DESCRIPTOR, version })).rejects.toMatchObject({
        name: 'StorageError',
        code: 'version-mismatch',
      })
      // Original version still opens and still holds the data.
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      expect((await unit2.loadAll()).tables['alpha']).toEqual({ k: { v: 1 } })
      await reopened.close()
    })

    it('reads an accepted older version without changing its stamp or records', async () => {
      const harness = await create()
      const original = await harness.backend.kv!.open(DESCRIPTOR)
      await original.putRecord('alpha', 'k', { v: 1 })
      await original.setGlobal({ counter: 1 })
      await harness.backend.close()

      const current = { ...DESCRIPTOR, version: 4, compatibleVersions: [3] }
      const reader = await harness.reopen()
      const unit = await reader.kv!.open(current)
      expect(await unit.loadAll()).toEqual({ tables: { alpha: { k: { v: 1 } }, beta: {} }, global: { counter: 1 } })
      await reader.close()

      const unchanged = await harness.reopen()
      expect((await (await unchanged.kv!.open(DESCRIPTOR)).loadAll()).tables['alpha']).toEqual({ k: { v: 1 } })
      await unchanged.close()
    })

    it.each(['deleteRecord', 'deleteRecords', 'emptyBatch'] as const)('keeps the older stamp for a no-op %s', async (operation) => {
      const harness = await create()
      const original = await harness.backend.kv!.open(DESCRIPTOR)
      await original.putRecord('alpha', 'saved', { v: 1 })
      await harness.backend.close()

      const writer = await harness.reopen()
      const unit = await writer.kv!.open({ ...DESCRIPTOR, version: 4, compatibleVersions: [3] })
      if (operation === 'deleteRecord') await unit.deleteRecord('alpha', 'missing')
      else await unit.deleteRecords('alpha', operation === 'emptyBatch' ? [] : ['missing', 'missing'])
      await writer.close()

      const unchanged = await harness.reopen()
      expect((await (await unchanged.kv!.open(DESCRIPTOR)).loadAll()).tables['alpha'])
        .toEqual({ saved: { v: 1 } })
      await unchanged.close()
    })

    it('restores the open snapshot after serialization failure and retries on the same unit', async () => {
      const harness = await create()
      await (await harness.backend.kv!.open(DESCRIPTOR)).putRecord('alpha', 'saved', { v: 1 })
      await harness.backend.close()

      const current = { ...DESCRIPTOR, version: 4, compatibleVersions: [3] }
      const writer = await harness.reopen()
      const unit = await writer.kv!.open(current)
      await expect(unit.putRecord('alpha', 'broken', { toJSON: () => { throw new Error('serialization failed') } }))
        .rejects.toThrow('serialization failed')
      expect((await unit.loadAll()).tables['alpha']).toEqual({ saved: { v: 1 } })
      await unit.putRecord('alpha', 'retry', { v: 2 })
      await writer.close()

      const restarted = await harness.reopen()
      expect((await (await restarted.kv!.open(current)).loadAll()).tables['alpha'])
        .toEqual({ saved: { v: 1 }, retry: { v: 2 } })
      await restarted.close()
    })

    it.each(['putRecord', 'deleteRecord', 'deleteRecords', 'setGlobal'] as const)('%s commits the current stamp with its data', async (operation) => {
      const harness = await create()
      const original = await harness.backend.kv!.open(DESCRIPTOR)
      await original.putRecord('alpha', 'k', { v: 1 })
      await original.putRecord('beta', 'untouched', { saved: true })
      await original.setGlobal({ counter: 1 })
      const otherDescriptor = { ...DESCRIPTOR, name: 'other_unit' }
      await (await harness.backend.kv!.open(otherDescriptor)).putRecord('alpha', 'saved', { v: 1 })
      await harness.backend.close()

      const current = { ...DESCRIPTOR, version: 4, compatibleVersions: [3] }
      const writer = await harness.reopen()
      const unit = await writer.kv!.open(current)
      await expect(unit.putRecord('alpha', 'k', { toJSON: () => { throw new Error('serialization failed') } }))
        .rejects.toThrow('serialization failed')
      expect((await unit.loadAll()).tables['alpha']).toEqual({ k: { v: 1 } })
      await writer.close()
      const afterFailure = await harness.reopen()
      expect((await (await afterFailure.kv!.open(DESCRIPTOR)).loadAll()).tables['alpha']).toEqual({ k: { v: 1 } })
      await afterFailure.close()

      const retry = await harness.reopen()
      const writable = await retry.kv!.open(current)
      await writable.deleteRecord('alpha', 'missing')
      await writable.deleteRecords('alpha', [])
      if (operation === 'putRecord') await writable.putRecord('alpha', 'k', { v: 2 })
      else if (operation === 'deleteRecord') await writable.deleteRecord('alpha', 'k')
      else if (operation === 'deleteRecords') await writable.deleteRecords('alpha', ['k', 'missing', 'k'])
      else await writable.setGlobal({ counter: 2 })
      await retry.close()

      const restarted = await harness.reopen()
      await expect(restarted.kv!.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'version-mismatch' })
      const saved = await (await restarted.kv!.open(current)).loadAll()
      expect(saved.tables['beta']).toEqual({ untouched: { saved: true } })
      expect(saved.tables['alpha']).toEqual(
        operation === 'deleteRecord' || operation === 'deleteRecords' ? {} : { k: { v: operation === 'putRecord' ? 2 : 1 } },
      )
      expect(saved.global).toEqual({ counter: operation === 'setGlobal' ? 2 : 1 })
      expect((await (await restarted.kv!.open(otherDescriptor)).loadAll()).tables['alpha'])
        .toEqual({ saved: { v: 1 } })
      await restarted.close()
    })

    it.each([
      { name: 'v1 → v3', writeV2: false },
      { name: 'v1 → v2 → v3', writeV2: true },
    ])('reads historical values through $name', async ({ writeV2 }) => {
      const harness = await create()
      const v1 = { ...DESCRIPTOR, version: 1 }
      const v2 = { ...DESCRIPTOR, version: 2, compatibleVersions: [1] }
      const v3 = { ...DESCRIPTOR, compatibleVersions: writeV2 ? [2] : [1] }
      const original = await harness.backend.kv!.open(v1)
      await original.putRecord('alpha', 'untouched', { label: 'Keep' })
      await original.putRecord('alpha', 'edited', { label: 'Edit' })
      await harness.backend.close()

      if (writeV2) {
        const second = await harness.reopen()
        const middle = await second.kv!.open(v2)
        await middle.putRecord('alpha', 'edited', { title: 'Edit' })
        await second.close()
      }

      const third = await harness.reopen()
      const latest = await third.kv!.open(v3)
      expect((await latest.loadAll()).tables['alpha']).toEqual({
        untouched: { label: 'Keep' }, edited: writeV2 ? { title: 'Edit' } : { label: 'Edit' },
      })
      await latest.putRecord('alpha', 'edited', { title: 'Edit', addedInV3: true })
      await third.close()

      const restarted = await harness.reopen()
      await expect(restarted.kv!.open(v2)).rejects.toMatchObject({ code: 'version-mismatch' })
      expect((await (await restarted.kv!.open(v3)).loadAll()).tables['alpha']).toMatchObject({
        untouched: { label: 'Keep' }, edited: { addedInV3: true },
      })
      await restarted.close()
    })

    it('rejects operations after unit close, and close is idempotent', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.close()
      await unit.close()
      await expect(unit.putRecord('alpha', 'k', {})).rejects.toMatchObject({ code: 'closed' })
      await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
      await expect(unit.deleteRecords('alpha', ['k'])).rejects.toMatchObject({ code: 'closed' })
      await backend.close()
      await backend.close()
    })
  })
}
