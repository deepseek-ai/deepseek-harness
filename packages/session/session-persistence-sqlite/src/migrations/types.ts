/** Types of the schema upgrade steps. @module */
import type { DatabaseSync } from 'node:sqlite'
import type { EventCompression } from '../row.ts'
import type { SqlFiles } from '../sql.ts'

/** Store settings and reports a schema upgrade uses. */
export interface MigrationOptions {
  /** Database path, named in refusals and failures. */
  readonly path: string
  /** Encoding for event rows a step writes. */
  readonly compression: EventCompression
  /** SQL files of the store that opens the database. */
  readonly sql: SqlFiles
  /** Receives each step before it runs: a step blocks the process for as long as it rewrites the database. */
  readonly onStep: (step: Migration) => void
  /** Receives each part of the stored data a step could not carry over and set aside instead of failing the upgrade. */
  readonly onSetAside: (detail: string, error: unknown) => void
}

/**
 * One upgrade of the stored schema by exactly one version. A step runs inside
 * the transaction that opens the database, so a thrown error leaves the
 * database at `from`, unchanged. A step writes the schema of its `to` version
 * from `resources/sql/schema/v<to>.sql` and keeps its own statements under
 * `resources/sql/upgrade/<from>-to-<to>/`; it reads no other SQL file, so a
 * later version adds files and leaves a released step as it was.
 */
export interface Migration {
  /** Stored `user_version` this step reads. */
  readonly from: number
  /** Stored `user_version` this step leaves; always `from + 1`. */
  readonly to: number
  /**
   * Rewrite the database from `from` to `to`.
   * @param db - open database inside an immediate transaction.
   * @param options - store settings for rows the step writes.
   */
  apply(db: DatabaseSync, options: MigrationOptions): void
}
