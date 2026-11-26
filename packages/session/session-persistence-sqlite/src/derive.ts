/**
 * Derived tables: narrow, rebuildable tables of facts read out of events, keyed
 * by the event they describe. A {@link Derivation} declares one table and a pure
 * function from an event to that table's row; {@link DerivedTables} owns the key
 * columns, the per-Session view, versioning and rebuilding. Events remain the
 * only authority: a derived table can be dropped and refilled at any time. @module
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import { z } from 'zod'
import { decodeEnvelope } from './codec.ts'
import type { StoredEnvelope } from './codec.ts'
import { decodeRow, eventRow } from './row.ts'
import type { SqlFiles } from './sql.ts'

/**
 * The envelope members a derivation reads. `type` is any stored event type,
 * including types this build does not know, and `data` is untrusted stored JSON.
 */
export type DerivableEvent = Pick<StoredEnvelope, 'type' | 'seq' | 'time' | 'data' | 'sourceEventSeqs' | 'surfaceOp'>

/** A value a derivation stores in one column. */
export type DerivedValue = string | number | null

/**
 * One derived table and the events it is read from. A derivation is trusted
 * package code: its column types and view statements become SQL text unchanged.
 */
export interface Derivation {
  /** Table name, lowercase snake case. The store also creates the view `session_<name>`. */
  readonly name: string
  /**
   * Changes whenever `types`, `columns`, `indexes`, `views` or {@link derive} change; a stored table of
   * another version is dropped and rebuilt from events.
   */
  readonly version: number
  /** Event types this derivation reads; other events never reach {@link derive}. */
  readonly types: readonly string[]
  /** Column names, lowercase snake case, mapped to their SQLite type and constraints, in stored order. */
  readonly columns: Readonly<Record<string, string>>
  /** Secondary indexes, each a list of this table's columns, which include the key columns `segment_id` and `seq`. */
  readonly indexes?: readonly (readonly string[])[]
  /** Further views by name, each a `SELECT` over this table and earlier derivations' tables and views. */
  readonly views?: Readonly<Record<string, string>>
  /**
   * Read one row out of an event. Pure and synchronous. A thrown error skips the row and is reported, and
   * never fails the append.
   * @param event - an event of one of {@link types}.
   * @returns the values of {@link columns} in order, or nothing when the event yields no row.
   */
  derive(event: DerivableEvent): readonly DerivedValue[] | undefined
}

/**
 * One failure that left derived tables without a row, or stopped their rebuild. Events are unaffected.
 * `row`: a derivation threw or its table refused the row of one event; `segment` is known once the event is stored.
 * `event`: a rebuild could not decode one stored event and went on without it.
 * `rebuild`: a rebuild stopped; the stored cursors resume it at the next start.
 */
export type DerivationFailure =
  | { readonly kind: 'row'; readonly derivation: string; readonly seq: number; readonly segment: number | undefined; readonly error: unknown }
  | { readonly kind: 'event'; readonly eventNo: number; readonly error: unknown }
  | { readonly kind: 'rebuild'; readonly error: unknown }

/** Rows of one event, computed before its transaction. */
export type DerivedRows = readonly { readonly derivation: Derivation; readonly values: readonly DerivedValue[] }[]

/** Statements one connection reuses for derived writes and rebuilds. */
interface Prepared {
  readonly inserts: Map<Derivation, StatementSync>
  readonly behind: StatementSync
  readonly scan: StatementSync
  readonly advance: StatementSync
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/
/**
 * Internal scheduling constant, not deployment configuration: events one rebuild transaction reads,
 * bounding the time a rebuild holds the write lock and the JavaScript thread between appends.
 */
const REBUILD_CHUNK_EVENTS = 500
const registered = z.object({ name: z.string(), version: z.number().int() })
const trailing = z.object({ name: z.string(), cursor: z.number().int() })
const pending = eventRow.and(z.object({ event_no: z.number().int(), segment_id: z.number().int() }))

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new TypeError(`derived table identifier "${value}" must be lowercase snake case`)
  return value
}

/** Name of the index a derivation declares for one list of its columns. */
function indexName(derivation: Derivation, columns: readonly string[]): string {
  return `${derivation.name}_by_${columns.join('_')}`
}

/**
 * Every SQLite object one derivation owns: its table, the per-Session view, its indexes, and its further views.
 * @param derivation - derivation whose declared objects are listed.
 * @returns the object names, all of which a complete installation holds.
 */
function objects(derivation: Derivation): string[] {
  return [derivation.name, `session_${derivation.name}`,
    ...(derivation.indexes ?? []).map(columns => indexName(derivation, columns)),
    ...Object.keys(derivation.views ?? {})]
}

/** The derived tables of one store: schema installation, row derivation, and rebuilding from events. */
export class DerivedTables {
  private readonly statements = new Map<DatabaseSync, Prepared>()
  private readonly byType = new Map<string, Derivation[]>()
  private readonly reported = new Set<string>()

  /**
   * @param derivations - tables to maintain, in dependency order for their views.
   * @param report - receives the first failure of each kind and table; later ones of the same kind and
   * table are not reported, so a derivation that fails on every event reports once.
   * @param sql - SQL files of the owning store.
   * @throws {TypeError} for a table, column, index column or view name that is not lowercase snake case.
   */
  constructor(private readonly derivations: readonly Derivation[], private readonly report: (failure: DerivationFailure) => void,
    private readonly sql: SqlFiles) {
    for (const derivation of derivations) {
      identifier(derivation.name)
      for (const column of Object.keys(derivation.columns)) identifier(column)
      for (const index of derivation.indexes ?? []) for (const column of index) identifier(column)
      for (const view of Object.keys(derivation.views ?? {})) identifier(view)
      for (const type of derivation.types) this.byType.set(type, [...this.byType.get(type) ?? [], derivation])
    }
  }

  private fail(failure: DerivationFailure): void {
    const key = failure.kind === 'row' ? `row ${failure.derivation}` : failure.kind
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.report(failure)
  }

  /**
   * Create every missing table, view and index, schedule a rebuild for each table that is missing or whose stored
   * version differs, and mark each stored table without a derivation here as behind from the current end of the log,
   * inside the caller's write transaction.
   * @param db - open database inside an immediate transaction.
   * @param populated - whether events already exist, so a new table starts behind them.
   */
  install(db: DatabaseSync, populated: boolean): void {
    db.exec(this.sql.text('derived/create-registry'))
    // A current table this build does not maintain stops receiving rows here; its cursor lets a later build resume it.
    db.prepare(this.sql.text('derived/mark-unmaintained-behind')).run(JSON.stringify(this.derivations.map(derivation => derivation.name)))
    const stored = new Map(db.prepare(this.sql.text('derived/registered-versions')).all().map((row) => {
      const entry = registered.parse(row)
      return [entry.name, entry.version]
    }))
    const present = new Set(db.prepare(this.sql.text('store/object-names')).all().map(row => row.name))
    // A recorded table whose version changed, or that lost any object it declares, is built again.
    const stale = this.derivations.filter(derivation => stored.get(derivation.name) !== derivation.version
      || !objects(derivation).every(name => present.has(name)))
    // The statements that drop and create derived objects stay inline: their identifiers, columns and view
    // bodies come from each derivation, so they have no fixed text.
    for (const derivation of stale.toReversed()) {
      for (const view of Object.keys(derivation.views ?? {}).toReversed()) db.exec(`DROP VIEW IF EXISTS ${view}`)
      db.exec(`DROP VIEW IF EXISTS session_${derivation.name}`)
      for (const index of derivation.indexes ?? []) db.exec(`DROP INDEX IF EXISTS ${indexName(derivation, index)}`)
      db.exec(`DROP TABLE IF EXISTS ${derivation.name}`)
    }
    const record = db.prepare(this.sql.text('derived/record-derivation'))
    for (const derivation of stale) {
      const { name } = derivation
      db.exec(`CREATE TABLE ${name} (
        segment_id INTEGER NOT NULL, seq INTEGER NOT NULL,
        ${Object.entries(derivation.columns).map(([column, type]) => `${column} ${type},`).join(' ')}
        PRIMARY KEY(segment_id, seq)) STRICT, WITHOUT ROWID;
        ${(derivation.indexes ?? []).map(columns => `CREATE INDEX ${indexName(derivation, columns)} ON ${name}(${columns.join(', ')});`).join(' ')}
        CREATE VIEW session_${name} AS SELECT p.session_id, d.* FROM session_segments p
          JOIN ${name} d ON d.segment_id = p.segment_id AND d.seq < p.end_seq;
        ${Object.entries(derivation.views ?? {}).map(([view, select]) => `CREATE VIEW ${view} AS ${select};`).join(' ')}`)
      record.run(name, derivation.version, populated ? 0 : null)
    }
    // The planner needs statistics to prefer a derived index over a primary-key scan; without them the correlated
    // lookup in `session_tools` reads every result of the Segment for each tool call. A full analysis is worth its cost
    // only once, when none exist yet; `PRAGMA optimize` on close keeps them current afterwards.
    if (db.prepare(this.sql.text('store/has-statistics')).get() === undefined) db.exec(this.sql.text('store/analyze'))
  }

  /**
   * Derive the rows of one event. Runs before the event's transaction; a derivation that throws is reported
   * and yields no row.
   * @param event - event about to be stored, or read back by a rebuild.
   * @param segment - Segment holding the event when it is already stored, for failure reports.
   * @param wanted - limits the derivations that run; all of the event's type run by default.
   * @returns rows to pass to {@link insert}.
   */
  rows(event: DerivableEvent, segment?: number, wanted: (derivation: Derivation) => boolean = () => true): DerivedRows {
    const rows: { derivation: Derivation; values: readonly DerivedValue[] }[] = []
    for (const derivation of this.byType.get(event.type) ?? []) {
      if (!wanted(derivation)) continue
      try {
        const values = derivation.derive(event)
        if (values !== undefined) rows.push({ derivation, values })
      } catch (error: unknown) { this.fail({ kind: 'row', derivation: derivation.name, seq: event.seq, segment, error }) }
    }
    return rows
  }

  /**
   * Store derived rows beside their event, replacing a row a rebuild already wrote. A row its table
   * refuses is reported and skipped; an error that ended the transaction propagates.
   * @param db - open database inside the event's transaction.
   * @param segment - Segment holding the event.
   * @param seq - the event's sequence.
   * @param rows - rows from {@link rows}.
   */
  insert(db: DatabaseSync, segment: number, seq: number, rows: DerivedRows): void {
    if (rows.length === 0) return
    const { inserts } = this.prepared(db)
    for (const { derivation, values } of rows) {
      const bound: SQLInputValue[] = [segment, seq, ...values]
      try {
        // Prepared on first use, inside the guard: a table that vanished under a running store costs its rows, not the append.
        // Inline because the table name and the number of columns come from the derivation.
        let statement = inserts.get(derivation)
        if (statement === undefined) {
          statement = db.prepare(`INSERT OR REPLACE INTO ${derivation.name} VALUES (?, ?${', ?'.repeat(Object.keys(derivation.columns).length)})`)
          inserts.set(derivation, statement)
        }
        statement.run(...bound)
      } catch (error: unknown) {
        // A failure that ended the transaction is the events' failure too; only a refused row is skipped.
        if (!db.isTransaction) throw error
        this.fail({ kind: 'row', derivation: derivation.name, seq, segment, error })
      }
    }
  }

  /**
   * Derive one bounded run of stored events for the tables that are behind,
   * inside the caller's write transaction. A stored event that cannot be decoded
   * is reported and passed over.
   * @param db - open database inside an immediate transaction.
   * @returns whether any table is still behind after this run.
   */
  rebuild(db: DatabaseSync): boolean {
    const statements = this.prepared(db)
    // A table whose derivation this build does not hold stays as it is.
    const behind = new Map<Derivation, number>()
    for (const raw of statements.behind.all()) {
      const entry = trailing.parse(raw), derivation = this.derivations.find(candidate => candidate.name === entry.name)
      if (derivation !== undefined) behind.set(derivation, entry.cursor)
    }
    if (behind.size === 0) return false
    const stored = statements.scan.all(Math.min(...behind.values()), JSON.stringify([...this.byType.keys()]), REBUILD_CHUNK_EVENTS)
    let scanned = 0
    for (const raw of stored) {
      const row = pending.parse(raw)
      scanned = row.event_no
      let event: DerivableEvent
      try { event = decodeEnvelope(decodeRow(row)) }
      catch (error: unknown) {
        this.fail({ kind: 'event', eventNo: row.event_no, error })
        continue
      }
      // A table that is not behind, or already past this event, keeps the row it has.
      const due = (derivation: Derivation): boolean => (behind.get(derivation) ?? Infinity) < row.event_no
      this.insert(db, row.segment_id, row.seq, this.rows(event, row.segment_id, due))
    }
    // A short run reached the end of the log; later events are derived in their own transactions.
    const caughtUp = stored.length < REBUILD_CHUNK_EVENTS
    for (const [derivation, cursor] of behind) statements.advance.run(caughtUp ? null : Math.max(scanned, cursor), derivation.name)
    return !caughtUp
  }

  private prepared(db: DatabaseSync): Prepared {
    let statements = this.statements.get(db)
    if (statements === undefined) {
      statements = {
        inserts: new Map(),
        behind: db.prepare(this.sql.text('derived/tables-behind')),
        scan: db.prepare(this.sql.text('derived/events-after')),
        advance: db.prepare(this.sql.text('derived/advance-cursor')),
      }
      this.statements.set(db, statements)
    }
    return statements
  }

  /**
   * Forget the statements prepared on a closed connection.
   * @param db - connection being closed.
   */
  release(db: DatabaseSync): void { this.statements.delete(db) }
}
