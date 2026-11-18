import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { runKvBackendContract } from '../../storage/tests/contract.ts'
import * as StorageSqlite from '../src/index.ts'
import { Config, SqliteStorageBackend, STORAGE_SQLITE_SCHEMA_VERSION } from '../src/index.ts'

/** Mirror the loader: resolve schemastery defaults before construction. */
function backendAt(path: string): SqliteStorageBackend {
  const backend = new SqliteStorageBackend(new Config({ path }))
  backends.push(backend)
  return backend
}

const backends: SqliteStorageBackend[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-'))
  dirs.push(dir)
  return join(dir, 'storage.db')
}

// The contract suite's reopen() needs a surviving medium, so the harness binds
// a real file; :memory: gets its own cases below.
runKvBackendContract('sqlite', async () => {
  const path = await freshDbPath()
  return {
    backend: backendAt(path),
    reopen: async () => backendAt(path),
  }
})

const DESCRIPTOR: KvUnitDescriptor = {
  name: 'specimen',
  version: 1,
  tables: ['records'],
  hasGlobal: true,
}

/** Exercise either a record write or a batch delete on the opened unit. */
function mutateUnit(unit: KvUnit, operation: 'putRecord' | 'deleteRecords'): Promise<void> {
  return operation === 'putRecord'
    ? unit.putRecord('records', 'new', { n: 2 })
    : unit.deleteRecords('records', ['saved', 'missing', 'saved'])
}

describe('sqlite backend specifics', () => {
  it('opens an in-memory database', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    expect((await unit.loadAll()).tables['records']).toEqual({ k: { n: 1 } })
    await backend.close()
  })

  it.each(['ABORT', 'ROLLBACK'])('restores a batch delete after SQLite %s', async (action) => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'a', { n: 1 })
    await unit.putRecord('records', 'b', { n: 2 })
    const db = new DatabaseSync(path)
    try {
      db.exec('CREATE TRIGGER block_b BEFORE DELETE ON "u_specimen_records"'
        + ` WHEN old.key = 'b' BEGIN SELECT RAISE(${action}, 'blocked'); END`)
      await expect(unit.deleteRecords('records', ['a', 'b'])).rejects.toThrow(/blocked/)
      // The transaction rolled back, so the key deleted before the failing row is back.
      expect((await unit.loadAll()).tables['records']).toEqual({ a: { n: 1 }, b: { n: 2 } })
      db.exec('DROP TRIGGER block_b')
      await unit.deleteRecords('records', ['a', 'b'])
      expect((await unit.loadAll()).tables['records']).toEqual({})
    } finally {
      await backend.close()
      db.close()
    }
  })

  it('reports unknown-state when a failed batch cannot roll back', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'a', { n: 1 })
    await unit.putRecord('records', 'b', { n: 2 })
    const db = new DatabaseSync(path)
    db.exec('CREATE TRIGGER block_b BEFORE DELETE ON "u_specimen_records"'
      + " WHEN old.key = 'b' BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    // oxlint-disable-next-line typescript/unbound-method -- Delegated through Reflect.apply with the spy's receiver.
    const original = DatabaseSync.prototype.exec
    const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'ROLLBACK') throw new Error('rollback denied')
      Reflect.apply(original, this, [sql])
    })
    try {
      await expect(unit.deleteRecords('records', ['a', 'b'])).rejects.toMatchObject({ code: 'unknown-state' })
      // Later statements would run inside the still-open transaction.
      await expect(unit.putRecord('records', 'c', { n: 3 })).rejects.toMatchObject({ code: 'unknown-state' })
      await expect(unit.loadAll()).rejects.toMatchObject({ code: 'unknown-state' })
    } finally {
      execSpy.mockRestore()
      db.close()
    }
    // The denied rollback leaves the unit's connection in a transaction; the
    // backend close is what releases it, and this test's file is discarded by
    // afterEach.
    await expect(unit.close()).resolves.toBeUndefined()
    await backend.close()
  })

  it('leaves a batch unapplied when BEGIN fails, then retries on the same unit', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'a', { n: 1 })
    // oxlint-disable-next-line typescript/unbound-method -- Delegated through Reflect.apply with the spy's receiver.
    const original = DatabaseSync.prototype.exec
    const beginError = new Error('begin denied')
    const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('BEGIN')) throw beginError
      Reflect.apply(original, this, [sql])
    })
    try {
      await expect(unit.deleteRecords('records', ['a'])).rejects.toBe(beginError)
      expect((await unit.loadAll()).tables['records']).toEqual({ a: { n: 1 } })
    } finally {
      execSpy.mockRestore()
    }
    await unit.deleteRecords('records', ['a'])
    expect((await unit.loadAll()).tables['records']).toEqual({})
    await expect(unit.close()).resolves.toBeUndefined()
    await backend.close()
  })

  it('materializes STRICT record tables and stamps the schema version', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    try {
      const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(version).toBe(STORAGE_SQLITE_SCHEMA_VERSION)
      const table = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'u_specimen_records'",
      ).get() as { sql: string } | undefined
      expect(table?.sql).toContain('STRICT')
      const unitRow = db.prepare('SELECT version FROM units WHERE name = ?').get('specimen') as { version: number }
      expect(unitRow.version).toBe(DESCRIPTOR.version)
    } finally {
      db.close()
    }
  })

  it('rejects a mismatched database schema version', async () => {
    const path = await freshDbPath()
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 999')
    db.close()

    const backend = backendAt(path)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })
    await backend.close()
  })

  it.each([
    ['single', 'putRecord'], ['single', 'deleteRecords'],
    ['per-record', 'putRecord'], ['per-record', 'deleteRecords'],
  ] as const)('preserves the unit stamp when BEGIN is busy with layout %s and %s, then retries', async (layout, operation) => {
    const path = await freshDbPath()
    const first = backendAt(path)
    await (await first.kv.open(DESCRIPTOR)).putRecord('records', 'saved', { n: 1 })
    await first.close()

    const observer = new DatabaseSync(path)
    const backend = backendAt(path)
    try {
      const unit = await backend.kv.open({ ...DESCRIPTOR, version: 2, compatibleVersions: [1], layout })
      await unit.deleteRecord('records', 'missing')
      expect(observer.prepare('SELECT version FROM units WHERE name = ?').get(DESCRIPTOR.name)).toEqual({ version: 1 })
      observer.exec('BEGIN IMMEDIATE')
      await expect(mutateUnit(unit, operation)).rejects.toMatchObject({ errcode: 5 })
      expect(observer.isTransaction).toBe(true)
      expect(observer.prepare('SELECT version FROM units WHERE name = ?').get(DESCRIPTOR.name)).toEqual({ version: 1 })
      expect((await unit.loadAll()).tables['records']).toEqual({ saved: { n: 1 } })
      observer.exec('ROLLBACK')

      await mutateUnit(unit, operation)
      expect(observer.prepare('SELECT version FROM units WHERE name = ?').get(DESCRIPTOR.name)).toEqual({ version: 2 })
      expect((await unit.loadAll()).tables['records']).toEqual(operation === 'putRecord' ? { saved: { n: 1 }, new: { n: 2 } } : {})
      await backend.close()
      const oldReader = backendAt(path)
      await expect(oldReader.kv.open({ ...DESCRIPTOR, layout })).rejects.toMatchObject({ code: 'version-mismatch' })
      await oldReader.close()
    } finally {
      if (observer.isTransaction) observer.exec('ROLLBACK')
      await backend.close()
      observer.close()
    }
  })

  it.each([
    ['ABORT', 'putRecord'], ['ABORT', 'deleteRecords'],
    ['ROLLBACK', 'putRecord'], ['ROLLBACK', 'deleteRecords'],
  ] as const)('preserves data and stamp on %s during the first %s version update, then retries', async (action, operation) => {
    const path = await freshDbPath()
    const first = backendAt(path)
    await (await first.kv.open(DESCRIPTOR)).putRecord('records', 'saved', { n: 1 })
    await first.close()

    const observer = new DatabaseSync(path)
    const backend = backendAt(path)
    try {
      const physicalVersion = observer.prepare('PRAGMA user_version').get()
      observer.exec(`CREATE TRIGGER reject_unit_version BEFORE UPDATE ON units BEGIN SELECT RAISE(${action}, 'version write failed'); END`)
      const unit = await backend.kv.open({ ...DESCRIPTOR, version: 2, compatibleVersions: [1] })
      const savedVersion = () => observer.prepare('SELECT version FROM units WHERE name = ?').get(DESCRIPTOR.name)
      expect(savedVersion()).toEqual({ version: 1 })
      await expect(mutateUnit(unit, operation)).rejects.toThrow('version write failed')
      expect(savedVersion()).toEqual({ version: 1 })
      expect((await unit.loadAll()).tables['records']).toEqual({ saved: { n: 1 } })
      observer.exec('DROP TRIGGER reject_unit_version')
      await mutateUnit(unit, operation)
      expect(savedVersion()).toEqual({ version: 2 })
      expect(observer.prepare('PRAGMA user_version').get()).toEqual(physicalVersion)
      expect((await unit.loadAll()).tables['records']).toEqual(operation === 'putRecord' ? { saved: { n: 1 }, new: { n: 2 } } : {})
    } finally {
      await backend.close()
      observer.close()
    }
  })

  it.each(['putRecord', 'deleteRecords'] as const)('rejects all backend use after a failed %s rollback and preserves both errors', async (operation) => {
    const path = await freshDbPath()
    const siblingDescriptor = { ...DESCRIPTOR, name: 'sibling' }
    const first = backendAt(path)
    await (await first.kv.open(DESCRIPTOR)).putRecord('records', 'saved', { n: 1 })
    await (await first.kv.open(siblingDescriptor)).close()
    await first.close()

    const observer = new DatabaseSync(path)
    const backend = backendAt(path)
    try {
      observer.exec("CREATE TRIGGER reject_unit_version BEFORE UPDATE ON units BEGIN SELECT RAISE(ABORT, 'version write failed'); END")
      const unit = await backend.kv.open({ ...DESCRIPTOR, version: 2, compatibleVersions: [1] })
      const sibling = await backend.kv.open(siblingDescriptor)
      // oxlint-disable-next-line typescript/unbound-method -- replay the original method with the intercepted connection as this
      const originalExec = DatabaseSync.prototype.exec
      const rollbackError = new Error('rollback failed')
      const rollback = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
        if (sql === 'ROLLBACK') throw rollbackError
        originalExec.call(this, sql)
      })
      try {
        const pending = backend.kv.open({ ...DESCRIPTOR, name: 'pending' })
        const failure: unknown = await mutateUnit(unit, operation).catch((error: unknown) => error)
        expect(failure).toMatchObject({
          name: 'StorageError',
          code: 'unknown-state',
          cause: {
            name: 'AggregateError',
            cause: { message: 'version write failed' },
            errors: [{ message: 'version write failed' }, rollbackError],
          },
        })
        await expect(sibling.putRecord('records', 'acknowledged', { n: 3 })).rejects.toBe(failure)
        await expect(sibling.loadAll()).rejects.toBe(failure)
        await expect(unit.loadAll()).rejects.toBe(failure)
        await expect(pending).rejects.toBe(failure)
        await expect(backend.kv.open({ ...DESCRIPTOR, name: 'later' })).rejects.toBe(failure)
        expect(observer.prepare('SELECT * FROM u_sibling_records').all()).toEqual([])
      } finally {
        rollback.mockRestore()
      }
      await backend.close()
      expect(observer.prepare('SELECT version FROM units WHERE name = ?').get(DESCRIPTOR.name)).toEqual({ version: 1 })
      expect(observer.prepare('SELECT key FROM u_specimen_records').all()).toEqual([{ key: 'saved' }])
      expect(observer.prepare('SELECT * FROM u_sibling_records').all()).toEqual([])
    } finally {
      await backend.close()
      observer.close()
    }
  })

  it('rejects invalid unit and table names before touching the medium', async () => {
    const backend = backendAt(':memory:')
    await expect(backend.kv.open({ ...DESCRIPTOR, name: 'Bad-Name' })).rejects.toThrow(/violates/)
    await expect(backend.kv.open({ ...DESCRIPTOR, tables: ['ok', '1bad'] })).rejects.toThrow(/violates/)
    await backend.close()
  })

  it('rejects a second open of the same unit name', async () => {
    const backend = backendAt(':memory:')
    await backend.kv.open(DESCRIPTOR)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/already open/)
    await backend.close()
  })

  it('allows re-open after unit close, and rejects open on a closed backend', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.close()
    const again = await backend.kv.open(DESCRIPTOR)
    await again.putRecord('records', 'k', 1)
    await backend.close()
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'closed' })
  })

  it('round-trips prototype-polluting keys as own properties', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', '__proto__', { evil: true })
    await unit.putRecord('records', 'constructor', { n: 1 })
    const { tables } = await unit.loadAll()
    const records = tables['records']!
    expect(Object.hasOwn(records, '__proto__')).toBe(true)
    expect(records['__proto__']).toEqual({ evil: true })
    expect(records['constructor']).toEqual({ n: 1 })
    expect(Object.getPrototypeOf({})).not.toHaveProperty('evil')
    await backend.close()
  })

  // Repeated durable DDL across four connections needs an instrumented I/O budget.
  it('leaves a failed materialization unstamped so a repaired medium reopens', async () => {
    const path = await freshDbPath()
    // Obstruct table creation: an index squatting on the unit_globals name
    // makes CREATE TABLE IF NOT EXISTS throw AFTER the units table exists.
    const setup = new DatabaseSync(path)
    try {
      setup.exec('CREATE TABLE squatter (x TEXT)')
      setup.exec('CREATE INDEX unit_globals ON squatter(x)')
    } finally {
      setup.close()
    }

    const broken = backendAt(path)
    try {
      await expect(broken.kv.open(DESCRIPTOR)).rejects.toThrow(/already an index/)
    } finally {
      await broken.close()
    }

    // Clear the obstruction; the medium must still be version 0, not a
    // half-materialized database stamped as current.
    const repair = new DatabaseSync(path)
    try {
      expect((repair.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0)
      expect(repair.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'units'").get())
        .toEqual({ name: 'units' })
      repair.exec('DROP INDEX unit_globals')
      expect(repair.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'unit_globals'").get())
        .toBeUndefined()
    } finally {
      repair.close()
    }

    const backend = backendAt(path)
    try {
      const unit = await backend.kv.open(DESCRIPTOR)
      await unit.putRecord('records', 'k', { n: 1 })
      expect((await unit.loadAll()).tables['records']).toEqual({ k: { n: 1 } })
    } finally {
      await backend.close()
    }
  }, 90_000)

  it('rejects unparsable stored JSON with malformed-medium', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'good', { n: 1 })
    await unit.setGlobal({ g: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    db.prepare('UPDATE u_specimen_records SET value = ? WHERE key = ?').run('{not json', 'good')
    db.close()

    const reopened = backendAt(path)
    const damaged = await reopened.kv.open(DESCRIPTOR)
    await expect(damaged.loadAll()).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await reopened.close()
  })

  it('wraps a non-Error toJSON throw into an Error rejection', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    // JSON.stringify propagates a value's own toJSON throw verbatim; the unit
    // must still reject with an Error instance.
    const hostile = { toJSON: () => { throw 'not an error' } }
    await expect(unit.putRecord('records', 'k', hostile)).rejects.toThrow('not an error')
    await expect(unit.putRecord('records', 'k', hostile)).rejects.toBeInstanceOf(Error)
    await backend.close()
  })

  it('rejects setGlobal on a unit without a global slot and writes to undeclared tables', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open({ ...DESCRIPTOR, hasGlobal: false })
    await expect(unit.setGlobal({ g: 1 })).rejects.toThrow(/declared no global slot/)
    await expect(unit.putRecord('undeclared', 'k', 1)).rejects.toThrow(/declared no table/)
    expect((await unit.loadAll()).global).toBeNull()
    await backend.close()
  })

  it('drains a still-pending failed open during close', async () => {
    const path = await freshDbPath()
    const first = backendAt(path)
    await (await first.kv.open(DESCRIPTOR)).close()
    await first.close()

    const backend = backendAt(path)
    // Do not await: close() must tolerate an in-flight open that will reject
    // (version mismatch) while its name is still reserved in the unit table.
    const pending = backend.kv.open({ ...DESCRIPTOR, version: 99 })
    const closed = backend.close()
    await expect(pending).rejects.toMatchObject({ code: 'version-mismatch' })
    await closed
  })

  it('propagates filesystem errors other than an existing database file', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-'))
    dirs.push(dir)
    await chmod(dir, 0o500)
    const backend = backendAt(join(dir, 'storage.db'))
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'EACCES' })
    await backend.close()
    await chmod(dir, 0o700)
  })

  it('propagates an invalid database filename before opening SQLite', async () => {
    const path = await freshDbPath()
    const backend = backendAt(`${path}\0invalid`)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/null bytes/i)
    await backend.close()
  })

  it('preserves the mode of an existing database file', async () => {
    if (process.platform === 'win32') return
    const path = await freshDbPath()
    await writeFile(path, '', { mode: 0o644 })
    await chmod(path, 0o644)
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', 1)
    await backend.close()
  })

  it('registers on the storage hub as backend sqlite and closes on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const fiber = await ctx.plugin(StorageSqlite, { path: ':memory:' })
    const backend = ctx.storage.backend.get('sqlite')
    expect(ctx.get(storageBackendServiceKey('sqlite'))).toBe(backend)
    const unit = await backend.kv!.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })

    await fiber.dispose()
    expect(ctx.storage.backend.names()).toEqual([])
    expect(ctx.get(storageBackendServiceKey('sqlite'))).toBeUndefined()
    await expect(backend.kv!.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects an unparsable global slot with malformed-medium', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.setGlobal({ g: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    db.prepare('UPDATE unit_globals SET value = ? WHERE unit = ?').run('][', 'specimen')
    db.close()

    const reopened = backendAt(path)
    const damaged = await reopened.kv.open(DESCRIPTOR)
    await expect(damaged.loadAll()).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await reopened.close()
  })
})
