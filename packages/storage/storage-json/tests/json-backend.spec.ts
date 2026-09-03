import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { runKvBackendContract } from '../../storage/tests/contract.ts'
import { Config, JsonStorageBackend, apply } from '../src/index.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-json-'))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

runKvBackendContract('json', async () => {
  const root = await freshRoot()
  return {
    backend: new JsonStorageBackend(root),
    reopen: async () => new JsonStorageBackend(root),
  }
})

describe('json backend specifics', () => {
  const descriptor = { name: 'shape', version: 1, tables: ['t'], hasGlobal: true }

  it('publishes a human-readable pretty-printed file', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { hello: 'world' })
    const text = await readFile(join(root, 'shape.json'), 'utf8')
    expect(text).toBe(`${JSON.stringify(
      { unit: { name: 'shape', version: 1 }, global: null, tables: { t: { k: { hello: 'world' } } } },
      null,
      2,
    )}\n`)
    await backend.close()
  })

  it('defers materialization until the first write', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.kv.open(descriptor)
    await expect(readFile(join(root, 'shape.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await backend.close()
  })

  it('rejects a malformed medium', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'shape.json'), 'not json at all', 'utf8')
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects a foreign unit header', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({ unit: { name: 'other', version: 1 }, global: null, tables: {} }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects double-open of one unit as a plain caller error', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.kv.open(descriptor)
    await expect(backend.kv.open(descriptor)).rejects.toThrow(/already open/)
    await backend.close()
  })

  it('rolls back memory when a publish fails', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { v: 'committed' })
    await unit.setGlobal({ g: 'committed' })
    const path = join(root, 'shape.json')
    const backup = join(root, 'shape.committed.json')
    // A directory at the publish target rejects atomic replacement on every host.
    await rename(path, backup)
    await mkdir(path)
    await expect(unit.putRecord('t', 'k', { v: 'rejected' })).rejects.toThrow()
    await expect(unit.putRecord('t', 'k2', { v: 'also rejected' })).rejects.toThrow()
    await expect(unit.deleteRecord('t', 'k')).rejects.toThrow()
    await expect(unit.setGlobal({ g: 'rejected' })).rejects.toThrow()
    await rm(path, { recursive: true })
    await rename(backup, path)
    const snapshot = await unit.loadAll()
    expect(snapshot.tables['t']).toEqual({ k: { v: 'committed' } })
    expect(snapshot.global).toEqual({ g: 'committed' })
    // The next successful publish must not carry rejected writes to disk.
    await unit.putRecord('t', 'k3', { v: 'later' })
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('rejected')
    await backend.close()
  })

  it('rejects undeclared table and global access as caller errors', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open({ name: 'shape', version: 1, tables: ['t'], hasGlobal: false })
    await expect(unit.putRecord('undeclared', 'k', {})).rejects.toThrow(/does not declare table/)
    await expect(unit.setGlobal({})).rejects.toThrow(/does not declare a global slot/)
    await backend.close()
  })

  it('rejects invalid unit and table names', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open({ ...descriptor, name: 'Bad-Name' })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await expect(backend.kv.open({ ...descriptor, tables: ['ok', 'not ok'] })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await backend.close()
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'closed' })
  })

  it('opens a file missing a declared table as that table empty', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'contract_unit.json'),
      JSON.stringify({ unit: { name: 'contract_unit', version: 3 }, global: null, tables: { alpha: { k: 1 } } }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open({ name: 'contract_unit', version: 3, tables: ['alpha', 'beta'], hasGlobal: true })
    const snapshot = await unit.loadAll()
    expect(snapshot.tables['alpha']).toEqual({ k: 1 })
    expect(snapshot.tables['beta']).toEqual({})
    await backend.close()
  })

  it('propagates non-ENOENT read failures', async () => {
    const root = await freshRoot()
    const { mkdir } = await import('node:fs/promises')
    // A directory where the unit file should be: readFile fails with EISDIR.
    await mkdir(join(root, 'shape.json'))
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'EISDIR' })
    await backend.close()
  })

  it('rejects malformed table shapes and foreign versions distinctly', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({ unit: { name: 'shape', version: 1 }, global: null, tables: { t: ['not', 'an', 'object'] } }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })

    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({ unit: { name: 'shape', version: 9 }, global: null, tables: {} }),
      'utf8',
    )
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'version-mismatch' })

    await writeFile(join(root, 'shape.json'), JSON.stringify({ unit: { name: 'shape', version: 1 }, global: null }), 'utf8')
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })

    await writeFile(join(root, 'shape.json'), JSON.stringify('just a string'), 'utf8')
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('registers on the hub via apply and closes on dispose', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(Storage)
    const fiber = await ctx.plugin({ apply, Config, inject: ['storage'] }, { root })
    const backend = ctx.storage.backend.get('json')
    expect(ctx.get(storageBackendServiceKey('json'))).toBe(backend)
    const unit = await backend.kv!.open(descriptor)
    await unit.putRecord('t', 'k', { v: 1 })
    await fiber.dispose()
    expect(() => ctx.storage.backend.get('json')).toThrow()
    expect(ctx.get(storageBackendServiceKey('json'))).toBeUndefined()
    await expect(unit.putRecord('t', 'x', {})).rejects.toMatchObject({ code: 'closed' })
  })

  it('close drains in-flight writes and blocks in-flight opens', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const bigWrite = unit.putRecord('t', 'big', { blob: 'x'.repeat(4 * 1024 * 1024) })
    await unit.close()
    await expect(bigWrite).resolves.toBeUndefined()
    const onDisk = JSON.parse(await readFile(join(root, 'shape.json'), 'utf8')) as {
      tables: Record<string, Record<string, unknown>>
    }
    expect(onDisk.tables['t']?.['big']).toBeDefined()

    const backend2 = new JsonStorageBackend(root)
    const opening = backend2.kv.open(descriptor)
    const closing = backend2.close()
    await expect(opening.then(u => u.putRecord('t', 'x', {}))).rejects.toMatchObject({ code: 'closed' })
    await closing
  })
})

describe('per-record layout', () => {
  const descriptor = { name: 'recs', version: 2, layout: 'per-record' as const, tables: ['t'], hasGlobal: true }
  const recordPath = (root: string, key: string): string => join(root, 'recs', 't', `${key}.json`)

  it('stores one version-stamped document per record and defers materialization', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    // Missing directory = empty unit; nothing materialized on the medium yet.
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await unit.putRecord('t', 'k1', { v: 1 })
    await unit.putRecord('t', 'k2', { v: 2 })
    await unit.setGlobal('G')
    expect(await readFile(recordPath(root, 'k1'), 'utf8'))
      .toBe(`${JSON.stringify({ version: 2, record: { v: 1 } }, null, 2)}\n`)
    expect((await readdir(join(root, 'recs', 't'))).sort()).toEqual(['k1.json', 'k2.json'])
    expect(JSON.parse(await readFile(join(root, 'recs', 'global.json'), 'utf8')))
      .toEqual({ version: 2, record: 'G' })
    expect(await unit.loadAll()).toEqual({ tables: { t: { k1: { v: 1 }, k2: { v: 2 } } }, global: 'G' })
    await backend.close()
  })

  it('overwrites and deletes one document at a time and persists across reopen', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { v: 1 })
    await unit.putRecord('t', 'k', { v: 2 }) // overwrite the same document
    await unit.deleteRecord('t', 'missing') // idempotent no-op
    await unit.close()
    const unit2 = await backend.kv.open(descriptor)
    expect(await unit2.loadAll()).toEqual({ tables: { t: { k: { v: 2 } } }, global: null })
    await unit2.deleteRecord('t', 'k')
    expect(await unit2.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await backend.close()
  })

  it('rejects unsafe keys and undeclared tables, and enforces the closed guard', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await expect(unit.putRecord('t', 'a/b', {})).rejects.toThrow(/not path-safe/)
    await expect(unit.deleteRecord('t', '..')).rejects.toThrow(/not path-safe/)
    await expect(unit.putRecord('bogus', 'k', {})).rejects.toThrow(/does not declare table/)
    await unit.close()
    await expect(unit.putRecord('t', 'k', {})).rejects.toMatchObject({ code: 'closed' })
    await expect(unit.deleteRecord('t', 'k')).rejects.toMatchObject({ code: 'closed' })
    await expect(unit.setGlobal('x')).rejects.toMatchObject({ code: 'closed' })
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
    await backend.close()
  })

  it('discards foreign documents (stale version, malformed, non-object, unsafe key) on open', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'good', { v: 1 })
    await unit.close()
    await writeFile(recordPath(root, 'stale'), JSON.stringify({ version: 1, record: { v: 0 } }), 'utf8')
    await writeFile(recordPath(root, 'broken'), '{oops', 'utf8')
    await writeFile(recordPath(root, 'scalar'), JSON.stringify(5), 'utf8')
    await writeFile(recordPath(root, 'unsafe%2Fkey'), JSON.stringify({ version: 2, record: { v: 0 } }), 'utf8')
    await writeFile(join(root, 'recs', 't', 'not-json.txt'), 'ignored', 'utf8')
    await writeFile(join(root, 'recs', 'global.json'), JSON.stringify({ version: 1, record: 'old' }), 'utf8')
    // Stray unit-root entries: an undeclared directory and a non-document file.
    await mkdir(join(root, 'recs', 'stray-dir'), { recursive: true })
    await writeFile(join(root, 'recs', 'stray.txt'), 'ignored', 'utf8')
    const unit2 = await backend.kv.open(descriptor)
    expect(await unit2.loadAll()).toEqual({ tables: { t: { good: { v: 1 } } }, global: null })
    await backend.close()
  })

  it('propagates non-ENOENT read failures and refuses a global slot that is not declared', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    // A file where the unit directory should be: the lazy loadAll readdir
    // fails with ENOTDIR (opening itself touches nothing on the medium).
    await writeFile(join(root, 'recs'), 'not a directory', 'utf8')
    const unit = await backend.kv.open(descriptor)
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'ENOTDIR' })
    await unit.close()
    const noGlobal = { name: 'plain', version: 1, layout: 'per-record' as const, tables: ['t'], hasGlobal: false }
    const unit2 = await backend.kv.open(noGlobal)
    await expect(unit2.setGlobal('x')).rejects.toThrow(/does not declare a global slot/)
    await backend.close()
  })

  it('close drains in-flight writes and an unreadable record document reads as absent', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const big = unit.putRecord('t', 'big', { blob: 'x'.repeat(4 * 1024 * 1024) })
    await unit.close()
    await unit.close() // idempotent
    await expect(big).resolves.toBeUndefined()
    const onDisk = JSON.parse(await readFile(recordPath(root, 'big'), 'utf8')) as { record: { blob: string } }
    expect(onDisk.record).toEqual({ blob: 'x'.repeat(4 * 1024 * 1024) })
    await backend.close()
  })

  it('reads an unreadable record document as absent (per-record contract)', async () => {
    const root = await freshRoot()
    // A directory where the record document should be: readFile fails with
    // EISDIR on every platform (permission bits are unenforceable on win32).
    await mkdir(join(root, 'recs', 't', 'locked.json'), { recursive: true })
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await backend.close()
  })

  it('bootstraps an empty per-record tree from a legacy whole-unit file and preserves it', async () => {
    const root = await freshRoot()
    // A legacy single-layout file for the same unit and version; the extra
    // table is not declared and must be skipped.
    const legacy = JSON.stringify({
      unit: { name: 'recs', version: descriptor.version },
      global: null,
      tables: { t: { old1: { v: 1 }, old2: { v: 2 } }, undeclared: { k: { v: 0 } } },
    })
    await writeFile(join(root, 'recs.json'), legacy, 'utf8')
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { t: { old1: { v: 1 }, old2: { v: 2 } } }, global: null })
    await expect(readFile(join(root, 'recs.json'), 'utf8')).resolves.toBe(legacy)
    await unit.close()
    const unit2 = await backend.kv.open(descriptor)
    expect(await unit2.loadAll()).toEqual({ tables: { t: { old1: { v: 1 }, old2: { v: 2 } } }, global: null })
    await backend.close()
  })

  it('bootstraps from a legacy file only when its stored version is accepted', async () => {
    // Version 3 is neither current (2) nor declared compat: the legacy file
    // is left alone and the unit reads empty — migrating unvouched records
    // would stamp them current and surface as schema failures at the domain
    // layer instead of a discardable stale cache.
    const root = await freshRoot()
    const legacy = JSON.stringify({
      unit: { name: 'recs', version: 3 },
      global: null,
      tables: { t: { old: { v: 1 } } },
    })
    await writeFile(join(root, 'recs.json'), legacy, 'utf8')
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(recordPath(root, 'old'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'recs.json'), 'utf8')).resolves.toBe(legacy)
    await unit.close()
    await backend.close()

    // The same file bootstraps once version 3 is declared read-compatible…
    const root2 = await freshRoot()
    await writeFile(join(root2, 'recs.json'), legacy, 'utf8')
    const backend2 = new JsonStorageBackend(root2)
    const compat = { ...descriptor, version: 4, compatibleVersions: [3] }
    const unit2 = await backend2.kv.open(compat)
    expect(await unit2.loadAll()).toEqual({ tables: { t: { old: { v: 1 } } }, global: null })
    // …and the migrated documents are stamped with the CURRENT version.
    expect(JSON.parse(await readFile(join(root2, 'recs', 't', 'old.json'), 'utf8')))
      .toEqual({ version: 4, record: { v: 1 } })
    await unit2.close()
    await backend2.close()
  })

  it('backupRecord moves the document aside; reads see it absent and a write recreates it', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { v: 1 })
    const moved = await unit.backupRecord!('t', 'k')
    expect(moved).toMatch(/k\.json\.bak\.\d{12}$/)
    expect(JSON.parse(await readFile(moved, 'utf8'))).toEqual({ version: 2, record: { v: 1 } })
    await expect(readFile(recordPath(root, 'k'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // The moved file no longer ends in .json, so it reads as absent…
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    // …and the key is free for a fresh write.
    await unit.putRecord('t', 'k', { v: 2 })
    expect(await unit.loadAll()).toEqual({ tables: { t: { k: { v: 2 } } }, global: null })
    await expect(unit.backupRecord!('t', 'a/b')).rejects.toThrow(/not path-safe/)
    await unit.close()
    await expect(unit.backupRecord!('t', 'k')).rejects.toMatchObject({ code: 'closed' })
    await backend.close()
  })

  it('reads per-record documents stamped with a declared compat version and stamps writes current', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const compat = { ...descriptor, compatibleVersions: [1] }
    await mkdir(join(root, 'recs', 't'), { recursive: true })
    await writeFile(recordPath(root, 'oldrec'), JSON.stringify({ version: 1, record: { v: 'old' } }), 'utf8')
    await writeFile(recordPath(root, 'ancient'), JSON.stringify({ version: 0, record: { v: 'no' } }), 'utf8')
    const unit = await backend.kv.open(compat)
    // Version 1 is declared compat and served; version 0 is not and discards.
    expect(await unit.loadAll()).toEqual({ tables: { t: { oldrec: { v: 'old' } } }, global: null })
    await unit.putRecord('t', 'oldrec', { v: 'new' })
    expect(JSON.parse(await readFile(recordPath(root, 'oldrec'), 'utf8')))
      .toEqual({ version: 2, record: { v: 'new' } })
    await backend.close()
  })

  it('ignores the legacy whole-unit file when any new document path exists', async () => {
    const root = await freshRoot()
    const legacy = JSON.stringify({
      unit: { name: 'recs', version: descriptor.version },
      global: null,
      tables: { t: { old: { v: 1 } } },
    })
    await writeFile(join(root, 'recs.json'), legacy, 'utf8')
    await mkdir(join(root, 'recs', 't'), { recursive: true })
    await writeFile(recordPath(root, 'broken'), '{oops', 'utf8')
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(recordPath(root, 'old'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'recs.json'), 'utf8')).resolves.toBe(legacy)
    await backend.close()
  })

  it('leaves a foreign, shapeless, or malformed legacy file alone', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'recs.json'), JSON.stringify({ unit: { name: 'other', version: 3 }, tables: {} }), 'utf8')
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(join(root, 'recs.json'), 'utf8')).resolves.toContain('other')
    await unit.close()
    await backend.close()

    const root2 = await freshRoot()
    await writeFile(join(root2, 'recs.json'), JSON.stringify({ tables: { t: { k: { v: 1 } } } }), 'utf8')
    const backend2 = new JsonStorageBackend(root2)
    const unit2 = await backend2.kv.open(descriptor)
    expect(await unit2.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(join(root2, 'recs.json'), 'utf8')).resolves.toContain('tables')
    await backend2.close()

    const root3 = await freshRoot()
    // A directory where the legacy file should be: the migration read fails loudly.
    await mkdir(join(root3, 'recs.json'))
    const backend3 = new JsonStorageBackend(root3)
    const unit3 = await backend3.kv.open(descriptor)
    await expect(unit3.loadAll()).rejects.toMatchObject({ code: 'EISDIR' })
    await backend3.close()

    const root4 = await freshRoot()
    await writeFile(join(root4, 'recs.json'), 'not json at all', 'utf8')
    const backend4 = new JsonStorageBackend(root4)
    const unit4 = await backend4.kv.open(descriptor)
    expect(await unit4.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(join(root4, 'recs.json'), 'utf8')).resolves.toBe('not json at all')
    await backend4.close()

    const root5 = await freshRoot()
    // A current-version stamp so the shapeless `tables` is what stops the bootstrap.
    await writeFile(
      join(root5, 'recs.json'),
      JSON.stringify({ unit: { name: 'recs', version: descriptor.version }, tables: 'not an object' }),
      'utf8',
    )
    const backend5 = new JsonStorageBackend(root5)
    const unit5 = await backend5.kv.open(descriptor)
    expect(await unit5.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await expect(readFile(join(root5, 'recs.json'), 'utf8')).resolves.toContain('not an object')
    await backend5.close()

    await writeFile(
      join(root5, 'recs.json'),
      JSON.stringify({ unit: { name: 'recs', version: descriptor.version }, tables: null }),
      'utf8',
    )
    const backend6 = new JsonStorageBackend(root5)
    const unit6 = await backend6.kv.open(descriptor)
    expect(await unit6.loadAll()).toEqual({ tables: { t: {} }, global: null })
    await backend6.close()
  })
})
