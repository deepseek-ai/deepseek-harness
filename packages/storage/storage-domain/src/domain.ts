/**
 * Runtime of one open domain: authoritative in-memory state, the single
 * per-domain write chain, and change-event emission. Reads are synchronous
 * from memory; every write queues on the chain, awaits backend durability
 * FIRST, then mutates memory, then emits `domain/changed` — a rejected
 * backend write leaves memory untouched (no divergence between reads and the
 * medium) unless the backend reports `unknown-state`, which quarantines the
 * domain: reads and later writes reject until close. Events carry values that
 * equal the in-memory state at emission, in write order.
 * @module @deepseek-ai/dsh-storage-domain/src/domain
 */

import type { Context } from '@deepseek-ai/cordis'
import { StorageError, type KvUnit } from '@deepseek-ai/dsh-storage'
import { DomainError } from './error.ts'
import type { DomainSpec, DomainGlobalSpec, TableKeyOf, TableValueOf } from './spec.ts'
import type { DomainChanged } from './events.ts'

/** Handle on a domain's global singleton. */
export interface DomainGlobal<G> {
  /**
   * Current value, synchronously from the authoritative in-memory state.
   * Before the first `set` this is the spec's `initial`.
   * @returns the current global value.
   */
  get(): G

  /**
   * Replace the value durably. Queued on the domain's write chain; the first
   * `set` is what materializes the global on the medium.
   * @param value - New value; must satisfy the spec's schema (not re-checked
   * here — validation happens at the durable read boundary).
   * @returns resolution after durability and event emission.
   */
  set(value: G): Promise<void>
}

/**
 * Handle on one declared table. Records are plain immutable data: returned
 * values are the stored objects themselves (no defensive copies) and must not
 * be mutated in place — replace via `put`/`update`.
 */
export interface KvTable<K extends string, V> {
  /**
   * Read one record, synchronously from memory.
   * @param key - Record key.
   * @returns the record, or `undefined` when absent.
   */
  get(key: K): V | undefined

  /**
   * Snapshot iterator over `[key, record]` pairs. A snapshot, not a live
   * view: iteration stays stable while queued writes land.
   * @returns the pair iterator.
   */
  entries(): IterableIterator<[K, V]>

  /**
   * Snapshot iterator over keys.
   * @returns the key iterator.
   */
  keys(): IterableIterator<K>

  /** Current record count. */
  readonly size: number

  /**
   * Insert or overwrite one record durably.
   * @param key - Record key.
   * @param value - The full new record (no partial merge).
   * @returns resolution after durability and event emission.
   */
  put(key: K, value: V): Promise<void>

  /**
   * Delete one record durably.
   * @param key - Record key.
   * @returns `true` when the record existed, `false` when it was already
   * absent (no write and no event in that case).
   */
  delete(key: K): Promise<boolean>

  /**
   * Delete several records durably in one write slot.
   *
   * The batch is one job on the domain's write chain: it runs at its slot, not
   * at call time, so an earlier queued write of the same domain is visible to
   * it and no other write interleaves. Missing keys are ignored. The in-memory
   * records reach the committed state before any `domain/changed` listener
   * runs. A backend failure normally rejects with the batch unapplied, leaving
   * every record in place. A backend that cannot establish or restore the
   * batch's state rejects with `unknown-state` and quarantines the domain:
   * synchronous reads and every later write reject with that error, while
   * `close()` still works.
   * @param keys - Record keys; duplicates are harmless.
   * @returns the number of keys that existed and were removed.
   */
  deleteMany(keys: readonly K[]): Promise<number>

  /**
   * Atomic read-modify-write on the domain's write chain: `fn` sees the
   * value current at its queue slot, so concurrent updates never interleave.
   * @param key - Record key; a missing key rejects with `missing-key`.
   * @param fn - Synchronous pure transform from current to next record.
   * @returns the stored next record.
   */
  update(key: K, fn: (current: V) => V): Promise<V>
}

/** Global handle of a spec: typed when declared, `never` (inaccessible) when not. */
export type DomainGlobalHandleOf<S extends DomainSpec> =
  S extends { readonly global: DomainGlobalSpec<infer G> } ? DomainGlobal<G> : never

/** One open domain, typed by its spec. */
export interface Domain<S extends DomainSpec> {
  /** Domain name from the spec. */
  readonly name: string
  /** Global singleton handle; a spec without `global` has no usable handle (`never`). */
  readonly global: DomainGlobalHandleOf<S>
  /**
   * Resolve one declared table handle. Handles are stable — repeated calls
   * return the same instance.
   * @param name - Declared table name.
   * @returns the typed table handle.
   */
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), release the backend unit, then free
   * the domain name for a later open. Idempotent — repeated calls share one
   * teardown. The consumer owns this call (typically as its own `ctx.effect`
   * disposer); the facility closes any domain left open when it unmounts.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void>
}

/** Internal boundary handing table handles their domain-owned write machinery. */
interface TableHost {
  readonly domainName: string
  readonly unit: KvUnit
  /** Queue one job on the domain's single write chain. */
  enqueue<T>(job: () => Promise<T>): Promise<T>
  /** Throw `closed` after teardown, or the recorded `unknown-state` while quarantined. */
  assertReadable(): void
  /** Emit `domain/changed` for one durably landed write. */
  emitChanged(change: DomainChanged): void
}

const noop = () => {}

/**
 * The single domain implementation behind the {@link Domain} interface. The
 * facility constructs it from a validated `loadAll` snapshot and erases it to
 * `Domain<S>`; nothing outside this package constructs one.
 */
export class DomainImpl {
  /** Domain name from the spec. */
  readonly name: string

  private readonly tables = new Map<string, KvTableImpl<string, unknown>>()
  private globalValue: unknown
  private readonly globalHandle?: DomainGlobal<unknown>

  /** Tail of the write chain; every link settles (rejections are observed by the caller's slice). */
  private chain: Promise<void> = Promise.resolve()
  /** Set when close begins: new writes reject while already-queued writes drain. */
  private disposing = false
  /** Set when the unit reports `unknown-state`: reads and writes reject with it. */
  private failure?: StorageError
  /** Set when close finishes (chain drained, unit closed): reads reject from here on. */
  private closed = false
  private disposal?: Promise<void>

  /**
   * @param ctx - Context that carries `domain/changed` emissions.
   * @param spec - The domain declaration.
   * @param unit - The opened backend unit; this instance owns its lifecycle.
   * @param records - Validated records from the unit's `loadAll`, one entry
   * per declared table (empty maps included) — the facility builds it from
   * the spec, so the entry set IS the table set.
   * @param globalValue - Validated stored global, or the spec's `initial`
   * when the medium held none; `undefined` when the spec declares no global.
   * @param onClosed - Facility hook run once after teardown completes; frees
   * the domain name for a later open.
   */
  constructor(
    private readonly ctx: Context,
    spec: DomainSpec,
    private readonly unit: KvUnit,
    records: Map<string, Map<string, unknown>>,
    globalValue: unknown,
    private readonly onClosed: () => void,
  ) {
    this.name = spec.name
    const host: TableHost = {
      domainName: spec.name,
      unit,
      enqueue: job => this.enqueue(job),
      assertReadable: () => { this.assertReadable() },
      emitChanged: (change) => { this.emitChanged(change) },
    }
    for (const [table, tableRecords] of records) {
      this.tables.set(table, new KvTableImpl(host, table, tableRecords))
    }
    if (spec.global !== undefined) {
      this.globalValue = globalValue
      this.globalHandle = {
        get: () => {
          this.assertReadable()
          return this.globalValue
        },
        set: value => this.enqueue(async () => {
          await this.unit.setGlobal(value)
          this.globalValue = value
          this.emitChanged({ domain: this.name, table: '', key: '', operation: 'put', value })
        }),
      }
    }
  }

  /** Global singleton handle; accessing it on a spec that declares no global is a caller bug and throws. */
  get global(): DomainGlobal<unknown> {
    if (this.globalHandle === undefined) {
      throw new Error(`domain '${this.name}' declares no global`)
    }
    return this.globalHandle
  }

  /**
   * Resolve one declared table handle; an undeclared name is a caller bug
   * and throws.
   * @param name - Declared table name.
   * @returns the stable table handle.
   */
  table(name: string): KvTable<string, unknown> {
    const table = this.tables.get(name)
    if (table === undefined) {
      throw new Error(`domain '${this.name}' declares no table '${name}'`)
    }
    return table
  }

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), close the unit, then free the name via
   * the facility hook. Idempotent — repeated calls share one teardown.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void> {
    this.disposal ??= this.runClose()
    return this.disposal
  }

  private async runClose(): Promise<void> {
    this.disposing = true
    // Chain links never reject (each is settled via then(noop, noop)), so
    // this await is a pure drain barrier.
    await this.chain
    await this.unit.close()
    this.closed = true
    this.onClosed()
  }

  /**
   * Dispatch one post-durability change notification, containing observer
   * failures: the write is already committed (medium and memory both hold
   * the new state), so a throwing listener must not retroactively reject it.
   */
  private emitChanged(change: DomainChanged): void {
    try {
      this.ctx.emit('domain/changed', change)
    } catch (error) {
      // Swallows synchronous observer exceptions only: emit dispatches
      // listeners inline and nothing else runs in the try. The event is a
      // notification, not a transaction participant — the commit point has
      // passed, so containment (with a log) is the only correct outcome.
      this.ctx.logger.warn(`domain '${this.name}': domain/changed listener failed: ${String(error)}`)
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.disposing) {
      return Promise.reject(new DomainError('closed', `domain '${this.name}' is closed`))
    }
    const run = async (): Promise<T> => {
      // A poisoned unit makes in-memory state unverifiable: reject before the
      // job runs, including jobs queued before the failure surfaced.
      if (this.failure !== undefined) throw this.failure
      try {
        return await job()
      } catch (error: unknown) {
        if (error instanceof StorageError && error.code === 'unknown-state') this.failure = error
        throw error
      }
    }
    const result = this.chain.then(run)
    this.chain = result.then(noop, noop)
    return result
  }

  private assertReadable(): void {
    // Close wins: the KvUnit contract reports `closed` for calls after teardown.
    if (this.closed) {
      throw new DomainError('closed', `domain '${this.name}' is closed`)
    }
    if (this.failure !== undefined) throw this.failure
  }
}

/** Table handle bound to one in-memory record map and its domain's write chain. */
class KvTableImpl<K extends string, V> implements KvTable<K, V> {
  constructor(
    private readonly host: TableHost,
    private readonly tableName: string,
    private readonly records: Map<string, unknown>,
  ) {}

  get(key: K): V | undefined {
    this.host.assertReadable()
    return this.records.get(key) as V | undefined
  }

  entries(): IterableIterator<[K, V]> {
    this.host.assertReadable()
    return ([...this.records.entries()] as [K, V][])[Symbol.iterator]()
  }

  keys(): IterableIterator<K> {
    this.host.assertReadable()
    return ([...this.records.keys()] as K[])[Symbol.iterator]()
  }

  get size(): number {
    this.host.assertReadable()
    return this.records.size
  }

  put(key: K, value: V): Promise<void> {
    return this.host.enqueue(async () => {
      await this.host.unit.putRecord(this.tableName, key, value)
      this.records.set(key, value)
      this.emitPut(key, value)
    })
  }

  delete(key: K): Promise<boolean> {
    return this.host.enqueue(async () => {
      // Existence is decided at this job's chain slot, not at call time: an
      // earlier queued put of the same key makes this delete observe it.
      if (!this.records.has(key)) return false
      await this.host.unit.deleteRecord(this.tableName, key)
      this.records.delete(key)
      this.emitDeleted(key)
      return true
    })
  }

  deleteMany(keys: readonly K[]): Promise<number> {
    return this.host.enqueue(async () => {
      // Existence and the backend write happen at this job's chain slot, so an
      // earlier queued put of a key is observed and the batch is one unit call.
      const present = [...new Set(keys)].filter(key => this.records.has(key))
      if (present.length === 0) return 0
      await this.host.unit.deleteRecords(this.tableName, present)
      // Memory reaches the committed batch state before the first listener runs,
      // so every `domain/changed` observes the same removed set as the medium.
      for (const key of present) this.records.delete(key)
      for (const key of present) this.emitDeleted(key)
      return present.length
    })
  }

  update(key: K, fn: (current: V) => V): Promise<V> {
    return this.host.enqueue(async () => {
      if (!this.records.has(key)) {
        throw new DomainError(
          'missing-key',
          `domain '${this.host.domainName}' table '${this.tableName}' has no record '${key}' to update`,
        )
      }
      const next = fn(this.records.get(key) as V)
      await this.host.unit.putRecord(this.tableName, key, next)
      this.records.set(key, next)
      this.emitPut(key, next)
      return next
    })
  }

  private emitPut(key: K, value: V): void {
    this.host.emitChanged({
      domain: this.host.domainName,
      table: this.tableName,
      key,
      operation: 'put',
      value,
    })
  }

  private emitDeleted(key: K): void {
    this.host.emitChanged({
      domain: this.host.domainName,
      table: this.tableName,
      key,
      operation: 'deleted',
    })
  }
}
