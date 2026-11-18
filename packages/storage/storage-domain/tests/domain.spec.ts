import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage, { StorageError, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnit, StorageBackend } from '@deepseek-ai/dsh-storage'
import { apply, defineDomain, descriptorOf, DomainFacility, domainTable } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { DomainChanged } from '../src/events.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const itemSchema = z.object({ label: z.string(), count: z.number().int() })
type Item = z.infer<typeof itemSchema>

const settingsSchema = z.object({ theme: z.string() })

const spec = defineDomain({
  name: 'demo',
  version: 1,
  global: { schema: settingsSchema, initial: { theme: 'plain' } },
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const bareSpec = defineDomain({
  name: 'bare',
  version: 1,
  tables: { rows: domainTable<string, Item>(itemSchema) },
})

/** Boot a context with the storage hub, one KV backend, and a facility over it. */
async function harness(options?: { pool?: MemoryMediaPool; config?: Partial<Config>; backend?: StorageBackend }) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = options?.backend ?? new MemoryStorageBackend(options?.pool)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {}, ...options?.config })
  ctx.storage.mount('domain', facility)
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  return { ctx, backend, facility, changes }
}

describe('defineDomain', () => {
  it('rejects invalid names and versions loudly', () => {
    expect(() => defineDomain({ name: 'Bad-Name', version: 1, tables: {} })).toThrow(/must match/)
    expect(() => defineDomain({ name: 'ok', version: 1.5, tables: {} })).toThrow(/non-negative integer/)
    expect(() => defineDomain({
      name: 'ok', version: 1, tables: { 'Bad Table': domainTable<string, Item>(itemSchema) },
    })).toThrow(/table name/)
  })

  it('rejects a global schema that accepts null (the never-written sentinel)', () => {
    expect(() => defineDomain({
      name: 'ok',
      version: 1,
      global: { schema: settingsSchema.nullable(), initial: null },
      tables: {},
    })).toThrow(/must not accept null/)
  })

  it('validates compatibleVersions entries and projects them onto the descriptor', () => {
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [1.5], tables: {} }))
      .toThrow(/compatibleVersions/)
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [2], tables: {} }))
      .toThrow(/below version/)
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [-1], tables: {} }))
      .toThrow(/compatibleVersions/)
    expect(descriptorOf(defineDomain({ name: 'ok', version: 2, compatibleVersions: [0, 1], tables: {} })))
      .toMatchObject({ compatibleVersions: [0, 1] })
    // An undeclared set is absent from the descriptor.
    expect(descriptorOf(spec)).not.toHaveProperty('compatibleVersions')
  })

  it('rejects an unknown invalidRecords policy', () => {
    expect(() => defineDomain({
      name: 'ok', version: 1, invalidRecords: 'zap' as 'backup-and-skip', tables: {},
    })).toThrow(/invalidRecords/)
  })

  it('rejects an invalid layout and projects the declared one onto the descriptor', () => {
    // A spec built from config can carry any value; the union type is
    // compile-time only, so the runtime boundary check must reject it.
    expect(() => defineDomain({ name: 'ok', version: 1, layout: 'every-record' as 'single', tables: {} }))
      .toThrow(/layout/)
    expect(descriptorOf(defineDomain({ name: 'per', version: 1, layout: 'per-record', tables: {} })))
      .toMatchObject({ name: 'per', layout: 'per-record' })
    // The default (single) layout is absent from the descriptor.
    expect(descriptorOf(spec)).not.toHaveProperty('layout')
  })
})

describe('DomainFacility.open', () => {
  it('opens, reads back stored records, and rejects a second open of the same name', async () => {
    const { facility } = await harness()
    const domain = await facility.open(spec)
    await domain.table('items').put('a', { label: 'first', count: 1 })
    await expect(facility.open(spec)).rejects.toMatchObject({ name: 'DomainError', code: 'already-open' })
    expect(domain.table('items').get('a')).toEqual({ label: 'first', count: 1 })
  })

  it('routes per domain name and fails loud on an unregistered route target', async () => {
    const { facility } = await harness({ config: { routes: { demo: 'nonexistent' } } })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'backend-not-found',
    })
    // The failed open releases the name for a later attempt.
    const { facility: healthy } = await harness()
    await expect(healthy.open(spec)).resolves.toBeDefined()
  })

  it('rejects a backend without the kv facet', async () => {
    const { ctx, facility } = await harness({ config: { backend: 'nokv' } })
    ctx.storage.backend.register('nokv', { close: async () => {} })
    await expect(facility.open(spec)).rejects.toMatchObject({ code: 'facet-unsupported' })
  })

  it('falls back to the default backend when no route table is configured', async () => {
    // A second, unmounted facility whose config omits `routes` entirely
    // (exactOptionalPropertyTypes forbids an explicit undefined).
    const { ctx } = await harness()
    const routeless = new DomainFacility(ctx, { backend: 'memory' })
    await expect(routeless.open(bareSpec)).resolves.toBeDefined()
  })

  it('treats a table key the backend omitted from loadAll as empty', async () => {
    // A sparse backend: loadAll omits declared table keys entirely instead of
    // returning them as empty objects.
    const { ctx, facility } = await harness({ config: { backend: 'sparse' } })
    ctx.storage.backend.register('sparse', {
      kv: {
        open: async () => ({
          loadAll: async () => ({ tables: {}, global: null }),
          putRecord: async () => {},
          deleteRecord: async () => {},
          deleteRecords: async () => {},
          setGlobal: async () => {},
          close: async () => {},
        }),
      },
      close: async () => {},
    })
    const domain = await facility.open(bareSpec)
    expect(domain.table('rows').size).toBe(0)
  })

  it('rejects stored records that fail their schema, naming table and key', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      await (await facility.open(spec)).table('items').put('bad', { label: 'x', count: 2 })
    }
    pool.media.get('demo')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
  })

  it('keeps the rejecting default under backup-and-skip when the backend cannot move documents', async () => {
    // The memory backend has no backupRecord, so the declared policy cannot
    // apply and the open falls back to failing loud.
    const salvageSpec = defineDomain({
      name: 'salvage',
      version: 1,
      invalidRecords: 'backup-and-skip',
      tables: { items: domainTable<string, Item>(itemSchema) },
    })
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      await (await facility.open(salvageSpec)).table('items').put('bad', { label: 'x', count: 2 })
    }
    pool.media.get('salvage')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    const { facility } = await harness({ pool })
    await expect(facility.open(salvageSpec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
  })

  it('rejects a stored global that fails its schema with the global marker', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('demo', 1)
    pool.media.set('demo', { tables: new Map(), global: { theme: 42 } })
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: '', key: '' },
    })
  })

  it('passes through a backend version mismatch', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('demo', 7)
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })
  })
})

describe('plugin apply', () => {
  it('uses only the default backend when routes are omitted', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    const disposeBackend = ctx.provide(storageBackendServiceKey('memory'), backend)

    const fiber = await ctx.plugin({
      name: 'storage-domain-routeless-test',
      inject: ['storage'],
      apply: (domainCtx: Context) => apply(domainCtx, { backend: 'memory' }),
    })
    await vi.waitFor(() => { expect(ctx.storageDomain).toBeInstanceOf(DomainFacility) })

    disposeBackend()
    await vi.waitFor(() => { expect(ctx.get('storageDomain')).toBeUndefined() })
    await fiber.dispose()
  })

  it('waits for routed backends, then mounts one lifecycle-bound service and form', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const DomainPlugin = await import('../src/index.ts')
    const fiber = await ctx.plugin(DomainPlugin, { backend: 'memory' })
    expect(ctx.get('storageDomain')).toBeUndefined()
    expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)

    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    const disposeBackend = ctx.provide(storageBackendServiceKey('memory'), backend)
    await vi.waitFor(() => { expect(ctx.storageDomain).toBeInstanceOf(DomainFacility) })
    expect(ctx.storage.domain).toBe(ctx.storageDomain)

    disposeBackend()
    await vi.waitFor(() => {
      expect(ctx.get('storageDomain')).toBeUndefined()
      expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)
    })
    await fiber.dispose()
  })
})

describe('table and snapshot reads', () => {
  it('serves entries, keys, and size as stable snapshots; unknown table names throw', async () => {
    const { facility } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    expect(table.size).toBe(2)
    expect([...table.keys()].sort()).toEqual(['a', 'b'])
    expect(new Map(table.entries()).get('a')).toEqual({ label: 'x', count: 1 })
    expect(() => domain.table('nope' as never)).toThrow(/declares no table/)
  })
})

describe('KvTable writes', () => {
  it('serializes concurrent updates on one key without losing increments', async () => {
    const { facility } = await harness()
    const table = (await facility.open(spec)).table('items')
    await table.put('counter', { label: 'c', count: 0 })
    await Promise.all(Array.from({ length: 50 }, () =>
      table.update('counter', current => ({ ...current, count: current.count + 1 }))))
    expect(table.get('counter')).toEqual({ label: 'c', count: 50 })
  })

  it('update rejects a missing key; delete reports prior existence', async () => {
    const { facility } = await harness()
    const table = (await facility.open(spec)).table('items')
    await expect(table.update('ghost', v => v)).rejects.toMatchObject({ code: 'missing-key' })
    await table.put('a', { label: 'x', count: 1 })
    await expect(table.delete('a')).resolves.toBe(true)
    await expect(table.delete('a')).resolves.toBe(false)
  })

  it('deleteMany removes the existing keys in one write slot and reports the count', async () => {
    const { facility, changes } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    await table.put('c', { label: 'z', count: 3 })
    const seen = changes.length
    await expect(table.deleteMany(['a', 'c', 'missing', 'a'])).resolves.toBe(2)
    expect([...table.entries()]).toEqual([['b', { label: 'y', count: 2 }]])
    expect(changes.slice(seen)).toEqual([
      { domain: 'demo', table: 'items', key: 'a', operation: 'deleted' },
      { domain: 'demo', table: 'items', key: 'c', operation: 'deleted' },
    ])
    // A batch without existing keys is a no-op: no backend write and no event.
    await expect(table.deleteMany(['ghost'])).resolves.toBe(0)
    expect(changes).toHaveLength(seen + 2)
  })

  it('applies the whole batch to memory before announcing it', async () => {
    const { ctx, facility } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    const observed: string[][] = []
    ctx.on('domain/changed', () => { observed.push([...table.keys()].sort()) })
    await table.deleteMany(['a', 'b'])
    // Every listener run sees the committed batch state, not a prefix of it.
    expect(observed).toEqual([[], []])
  })

  it('calls the backend batch primitive exactly once per deleteMany', async () => {
    const inner = new MemoryStorageBackend()
    let batches = 0
    let singles = 0
    const counting: StorageBackend = {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const kv = inner.kv
          if (kv === undefined) throw new Error('memory backend is missing its kv facet')
          const unit = await kv.open(descriptor)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: async (table, key) => {
              singles += 1
              return unit.deleteRecord(table, key)
            },
            deleteRecords: async (table, keys) => {
              batches += 1
              return unit.deleteRecords(table, keys)
            },
            setGlobal: value => unit.setGlobal(value),
            close: () => unit.close(),
          }
        },
      },
    }
    const { facility } = await harness({ backend: counting })
    const table = (await facility.open(spec)).table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    await expect(table.deleteMany(['a', 'b', 'missing'])).resolves.toBe(2)
    expect(batches).toBe(1)
    expect(singles).toBe(0)
  })

  it('emits domain/changed per durable write, in order, with tombstones and global marker', async () => {
    const { facility, changes } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.update('a', current => ({ ...current, count: 2 }))
    await table.delete('a')
    await table.delete('a') // no event: already absent
    await domain.global.set({ theme: 'dark' })
    expect(changes).toEqual([
      { domain: 'demo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 1 } },
      { domain: 'demo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 2 } },
      { domain: 'demo', table: 'items', key: 'a', operation: 'deleted' },
      { domain: 'demo', table: '', key: '', operation: 'put', value: { theme: 'dark' } },
    ])
  })
})

describe('durability failure', () => {
  it('leaves memory untouched and emits nothing when the backend rejects a write', async () => {
    const pool = new MemoryMediaPool()
    const { facility, changes } = await harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    const seen = changes.length

    pool.failNextWrites = 3
    await expect(table.put('a', { label: 'x', count: 99 })).rejects.toThrow(/injected/)
    await expect(table.update('a', c => ({ ...c, count: c.count + 1 }))).rejects.toThrow(/injected/)
    await expect(table.delete('a')).rejects.toThrow(/injected/)

    // Reads still serve the pre-failure record; no events leaked.
    expect(table.get('a')).toEqual({ label: 'x', count: 1 })
    expect(pool.media.get('demo')!.tables.get('items')!.get('a')).toEqual({ label: 'x', count: 1 })
    expect(changes).toHaveLength(seen)

    // The chain survives rejections: the next write lands cleanly with no residue.
    await table.update('a', c => ({ ...c, count: c.count + 1 }))
    expect(table.get('a')).toEqual({ label: 'x', count: 2 })
  })

  it('leaves every record in place when a batch delete fails durability', async () => {
    const pool = new MemoryMediaPool()
    const { facility, changes } = await harness({ pool })
    const table = (await facility.open(spec)).table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    const seen = changes.length

    pool.failNextWrites = 1
    await expect(table.deleteMany(['a', 'b'])).rejects.toThrow(/injected/)

    expect([...table.entries()]).toEqual([
      ['a', { label: 'x', count: 1 }],
      ['b', { label: 'y', count: 2 }],
    ])
    expect(pool.media.get('demo')!.tables.get('items')!.get('b')).toEqual({ label: 'y', count: 2 })
    expect(changes).toHaveLength(seen)

    // The write chain keeps serving after a rejected batch.
    await table.put('c', { label: 'z', count: 3 })
    expect(table.get('c')).toEqual({ label: 'z', count: 3 })
  })

  it('quarantines the domain after a batch reports unknown-state', async () => {
    const inner = new MemoryStorageBackend()
    const poisoned: StorageBackend = {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const kv = inner.kv
          if (kv === undefined) throw new Error('memory backend is missing its kv facet')
          const unit: KvUnit = await kv.open(descriptor)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: (table, key) => unit.deleteRecord(table, key),
            deleteRecords: () => Promise.reject(new StorageError('unknown-state', 'unknown-state injected by the test')),
            setGlobal: value => unit.setGlobal(value),
            close: () => unit.close(),
          }
        },
      },
    }
    const { facility } = await harness({ backend: poisoned })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })

    // A later job queued before the failure surfaces is rejected too.
    const failing = table.deleteMany(['a'])
    const queued = table.put('b', { label: 'y', count: 2 })
    await expect(failing).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(queued).rejects.toMatchObject({ code: 'unknown-state' })
    // Synchronous reads and later chain jobs see the quarantined domain.
    expect(() => table.get('a')).toThrow(/unknown-state/)
    expect(() => [...table.keys()]).toThrow(/unknown-state/)
    expect(() => table.size).toThrow(/unknown-state/)
    await expect(table.deleteMany(['missing'])).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(table.put('c', { label: 'z', count: 3 })).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(domain.global.set({ theme: 'dark' })).rejects.toMatchObject({ code: 'unknown-state' })
    expect(() => domain.global.get()).toThrow(/unknown-state/)
    // Releasing the domain stays possible.
    await expect(domain.close()).resolves.toBeUndefined()
  })

  it('keeps serving initial when the first global set fails durability', async () => {
    const pool = new MemoryMediaPool()
    const { facility } = await harness({ pool })
    const domain = await facility.open(spec)
    pool.failNextWrites = 1
    await expect(domain.global.set({ theme: 'dark' })).rejects.toThrow(/injected/)
    expect(domain.global.get()).toEqual({ theme: 'plain' })
    expect(pool.media.get('demo')!.global).toBeNull()
  })
})

describe('global singleton', () => {
  it('serves initial before first set without materializing, then persists the first set', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      const domain = await facility.open(spec)
      expect(domain.global.get()).toEqual({ theme: 'plain' })
      expect(pool.media.get('demo')!.global).toBeNull() // initial never touches the medium
      await domain.global.set({ theme: 'dark' })
      expect(pool.media.get('demo')!.global).toEqual({ theme: 'dark' })
    }
    const { facility } = await harness({ pool })
    expect((await facility.open(spec)).global.get()).toEqual({ theme: 'dark' })
  })

  it('throws on access when the spec declares no global', async () => {
    const { facility } = await harness()
    const domain = await facility.open(bareSpec)
    expect(() => (domain as { global: unknown }).global).toThrow(/declares no global/)
  })
})

describe('close and lifecycle', () => {
  it('close drains queued writes, then rejects reads and writes, and frees the name', async () => {
    const pool = new MemoryMediaPool()
    const { facility } = await harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    const pending = Promise.all([
      table.put('a', { label: 'x', count: 1 }),
      table.put('b', { label: 'y', count: 2 }),
    ])
    await Promise.all([domain.close(), domain.close()]) // idempotent
    await pending // queued before close → still landed
    // Durability is the drain contract: both queued writes reached the medium.
    expect([...pool.media.get('demo')!.tables.get('items')!.keys()].sort()).toEqual(['a', 'b'])
    await expect(table.put('c', { label: 'z', count: 3 })).rejects.toMatchObject({ code: 'closed' })
    expect(() => table.get('a')).toThrow(/closed/)
    // The name is free again: reopening sees the drained state.
    const reopened = await facility.open(spec)
    expect([...reopened.table('items').keys()].sort()).toEqual(['a', 'b'])
  })

  it('facility unmount closes domains the consumer never closed', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)
    const DomainPlugin = await import('../src/index.ts')
    const fiber = await ctx.plugin(DomainPlugin, { backend: 'memory' })
    const domain = await ctx.storageDomain.open(bareSpec)
    const table = domain.table('rows')
    await table.put('a', { label: 'x', count: 1 })
    await fiber.dispose()
    await expect(table.put('b', { label: 'y', count: 2 })).rejects.toMatchObject({ code: 'closed' })
    expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)
  })

  it('contains a throwing domain/changed listener without rejecting the committed write', async () => {
    const pool = new MemoryMediaPool()
    const { ctx, facility, changes } = await harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    ctx.on('domain/changed', () => {
      throw new Error('hostile observer')
    })
    await expect(table.put('a', { label: 'x', count: 1 })).resolves.toBeUndefined()
    // Commit survived intact on both planes, and well-behaved listeners
    // (registered before the thrower) still observed the event.
    expect(table.get('a')).toEqual({ label: 'x', count: 1 })
    expect(pool.media.get('demo')!.tables.get('items')!.get('a')).toEqual({ label: 'x', count: 1 })
    expect(changes).toHaveLength(1)
    // The chain is unpoisoned: subsequent writes proceed normally.
    await expect(table.delete('a')).resolves.toBe(true)
  })
})
