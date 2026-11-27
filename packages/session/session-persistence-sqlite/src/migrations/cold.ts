/**
 * Schema version 2 to 3: adds cold Segment archive tracking, per-Session open
 * watermarks, parent Segment indexing, and the cold payload update trigger
 * without rewriting event or Segment rows. @module
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Migration } from './types.ts'

const V2_TABLES = ['events', 'segment_paths', 'segments', 'sessions']

/** Upgrades a version 2 event-row database to version 3 in place. */
export const cold: Migration = {
  from: 2,
  to: 3,
  apply(db: DatabaseSync, { sql }): void {
    const present = new Set(db.prepare(sql.text('upgrade/2-to-3/table-names')).all().map(row => row.name))
    if (!V2_TABLES.every(name => present.has(name))) {
      throw new Error('schema version 2 is stored without the event-row tables')
    }
    db.exec(sql.text('upgrade/2-to-3/add-cold-storage'))
  },
}
