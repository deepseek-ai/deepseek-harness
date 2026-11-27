/**
 * The SQL text of this package, kept as files under `resources/sql/`. This
 * module is their only reader, and it sits at the root of `src/` because the
 * package is bundled into `lib/index.js`: `../resources/sql/` names the same
 * folder from both files. @module
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Every file under `resources/sql/`, as its path without the `.sql` extension. `schema/vN` and
 * `upgrade/A-to-B/*` describe one released schema version and are not edited after that release.
 */
export const SQL_FILES = [
  'schema/v1',
  'schema/v2',
  'schema/v3',
  'upgrade/1-to-2/table-names',
  'upgrade/1-to-2/retire-v1-objects',
  'upgrade/1-to-2/segments-parents-first',
  'upgrade/1-to-2/insert-segment',
  'upgrade/1-to-2/insert-sessions',
  'upgrade/1-to-2/frames-by-segment',
  'upgrade/1-to-2/orphan-frames',
  'upgrade/1-to-2/insert-event',
  'upgrade/1-to-2/create-frames-set-aside',
  'upgrade/1-to-2/set-aside-frames',
  'upgrade/1-to-2/drop-v1-tables',
  'upgrade/2-to-3/table-names',
  'upgrade/2-to-3/add-cold-storage',
  'store/table-names',
  'store/object-names',
  'store/has-statistics',
  'store/analyze',
  'store/reoptimize',
  'store/checkpoint',
  'store/vacuum',
  'store/any-event',
  'store/session-by-id',
  'store/sessions',
  'store/segment-by-id',
  'store/segment-ancestors',
  'store/fork-attachment',
  'store/insert-segment',
  'store/insert-session',
  'store/insert-event',
  'store/events-in-range',
  'cold/candidates',
  'cold/archive-by-session',
  'cold/touch',
  'cold/record',
  'cold/evict',
  'cold/restore',
  'cold/forget',
  'derived/create-registry',
  'derived/mark-unmaintained-behind',
  'derived/registered-versions',
  'derived/record-derivation',
  'derived/tables-behind',
  'derived/events-after',
  'derived/advance-cursor',
  'derived/session-tools',
] as const

/** The name of one file under `resources/sql/`. */
export type SqlFile = typeof SQL_FILES[number]

/** Reads SQL files on first use and keeps their text for the lifetime of the instance. */
export class SqlFiles {
  private readonly texts = new Map<SqlFile, string>()

  /**
   * The text of one SQL file, read synchronously the first time it is asked for.
   * @param name - file path under `resources/sql/` without the `.sql` extension.
   * @returns the whole file, including its leading comment.
   * @throws {Error} naming the file, with the filesystem error as cause, when it cannot be read.
   */
  text(name: SqlFile): string {
    let text = this.texts.get(name)
    if (text === undefined) {
      // A filesystem path, not a URL: packaged applications read files inside their archive by path.
      try { text = readFileSync(fileURLToPath(new URL(`../resources/sql/${name}.sql`, import.meta.url)), 'utf8') }
      catch (error: unknown) { throw new Error(`SQL file "resources/sql/${name}.sql" of the SQLite Session persistence package cannot be read`, { cause: error }) }
      this.texts.set(name, text)
    }
    return text
  }
}
