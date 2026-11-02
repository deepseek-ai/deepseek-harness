/**
 * One opened SQLite KV unit: prepared per-table statements over the
 * `u_<unit>_<table>` record tables plus this unit's row in the shared
 * `unit_globals` table. The first mutation of an accepted older version commits
 * its data and current version stamp in one transaction. Batch deletes also
 * use one transaction; other writes remain single statements. Write ordering
 * belongs to the caller per the KV contract.
 * @module @deepseek-ai/dsh-storage-sqlite/unit
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { recordTableName } from './schema.ts'

/** Prepared statements for one declared table. */
interface TableStatements {
  upsert: StatementSync
  remove: StatementSync
  selectAll: StatementSync
}

/**
 * The SQLite {@link KvUnit}. Constructed by the backend AFTER the unit's
 * record tables exist; statements are prepared once here and reused for every
 * primitive. Values are stored as JSON text in the `value` column.
 */
export class SqliteKvUnit implements KvUnit {
  private readonly tables = new Map<string, TableStatements>()
  private readonly globalUpsert: StatementSync | undefined
  private readonly globalSelect: StatementSync | undefined
  private needsVersionStamp: boolean
  private closed = false

  /**
   * @param db - Open database handle owned by the backend (never closed here).
   * @param descriptor - Validated descriptor whose record tables already exist.
   * @param storedVersion - Accepted unit version currently saved on the medium.
   * @param onClose - Backend callback releasing this unit's open-name slot.
   * @param ensureBackendUsable - Rejects use of a connection whose rollback failed.
   * @param onRollbackFailure - Retains the failure on the backend before this call rejects.
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly descriptor: KvUnitDescriptor,
    storedVersion: number,
    private readonly onClose: () => void,
    private readonly ensureBackendUsable: () => void,
    private readonly onRollbackFailure: (error: StorageError) => void,
  ) {
    this.needsVersionStamp = storedVersion !== descriptor.version
    for (const table of descriptor.tables) {
      // Both name segments are validated against UNIT_NAME_RE by the backend,
      // so the physical identifier is safe to interpolate into statement text.
      const physical = recordTableName(descriptor.name, table)
      this.tables.set(table, {
        upsert: db.prepare(
          `INSERT INTO "${physical}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ),
        remove: db.prepare(`DELETE FROM "${physical}" WHERE key = ?`),
        selectAll: db.prepare(`SELECT key, value FROM "${physical}"`),
      })
    }
    this.globalUpsert = descriptor.hasGlobal
      ? db.prepare(
        'INSERT INTO unit_globals (unit, value) VALUES (?, ?) ON CONFLICT(unit) DO UPDATE SET value = excluded.value',
      )
      : undefined
    this.globalSelect = descriptor.hasGlobal
      ? db.prepare('SELECT value FROM unit_globals WHERE unit = ?')
      : undefined
  }

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return this.settle(() => {
      const tables: Record<string, Record<string, unknown>> = {}
      for (const [name, statements] of this.tables) {
        // Null prototype: record keys are arbitrary strings, so '__proto__'
        // must land as an own property instead of mutating the prototype.
        const records: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        for (const row of statements.selectAll.all() as Array<{ key: string; value: string }>) {
          records[row.key] = this.parseValue(row.value, `table '${name}' key '${row.key}'`)
        }
        tables[name] = records
      }
      let global: unknown = null
      if (this.globalSelect !== undefined) {
        const row = this.globalSelect.get(this.descriptor.name) as { value: string } | undefined
        if (row !== undefined) global = this.parseValue(row.value, 'global slot')
      }
      return { tables, global }
    })
  }

  /** Parse one stored value column, mapping bad JSON to `malformed-medium`. */
  private parseValue(text: string, slot: string): unknown {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new StorageError(
        'malformed-medium',
        `kv unit '${this.descriptor.name}' holds unparsable JSON at ${slot}`,
        { cause: error },
      )
    }
  }

  putRecord(table: string, key: string, value: unknown): Promise<void> {
    return this.settle(() => {
      const statement = this.statementsFor(table).upsert
      const text = JSON.stringify(value)
      this.write(() => statement.run(key, text).changes)
    })
  }

  deleteRecord(table: string, key: string): Promise<void> {
    return this.settle(() => {
      const statement = this.statementsFor(table).remove
      this.write(() => statement.run(key).changes)
    })
  }

  deleteRecords(table: string, keys: readonly string[]): Promise<void> {
    return this.settle(() => {
      const remove = this.statementsFor(table).remove
      if (keys.length === 0) return
      this.write(() => {
        let changes = 0
        for (const key of new Set(keys)) changes += Number(remove.run(key).changes)
        return changes
      }, true)
    })
  }

  setGlobal(value: unknown): Promise<void> {
    return this.settle(() => {
      if (this.globalUpsert === undefined) {
        throw new Error(`kv unit '${this.descriptor.name}' declared no global slot`)
      }
      const statement = this.globalUpsert
      const text = JSON.stringify(value)
      this.write(() => statement.run(this.descriptor.name, text).changes)
    })
  }

  /** Commit batches and version updates atomically; missing-key deletes leave the stamp unchanged. */
  private write(operation: () => number | bigint, transactional = false): void {
    if (!this.needsVersionStamp && !transactional) {
      operation()
      return
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changed = operation() > 0
      if (this.needsVersionStamp && changed) {
        this.db.prepare('UPDATE units SET version = ? WHERE name = ?').run(this.descriptor.version, this.descriptor.name)
      }
      this.db.exec('COMMIT')
      if (changed) this.needsVersionStamp = false
    } catch (error) {
      if (this.db.isTransaction) {
        try {
          this.db.exec('ROLLBACK')
        } catch (rollbackError) {
          const failure = new StorageError(
            'unknown-state',
            `kv unit '${this.descriptor.name}' write and rollback failed; the backend is unusable and must be closed and reopened`,
            { cause: new AggregateError([error, rollbackError], 'write and rollback failed', { cause: error }) },
          )
          this.onRollbackFailure(failure)
          throw failure
        }
      }
      throw error
    }
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
    return Promise.resolve()
  }

  /**
   * Run one synchronous primitive behind the closed guard, mapping a throw to
   * a rejection so the Promise-returning contract never throws synchronously.
   */
  private settle<T>(operation: () => T): Promise<T> {
    try {
      this.ensureOpen()
      return Promise.resolve(operation())
    } catch (error) {
      // Non-Error throws can only enter through JSON.stringify propagating a
      // value's own toJSON throw; wrap those, preserve every real Error.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `kv unit '${this.descriptor.name}' is closed`)
    }
    this.ensureBackendUsable()
  }

  private statementsFor(table: string): TableStatements {
    const statements = this.tables.get(table)
    if (statements === undefined) {
      throw new Error(`kv unit '${this.descriptor.name}' declared no table '${table}'`)
    }
    return statements
  }
}
