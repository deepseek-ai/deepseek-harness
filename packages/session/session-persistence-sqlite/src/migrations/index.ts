/**
 * Opens a Segment database at the current schema: creates it in an empty file,
 * upgrades an older version one ordered step at a time, and refuses anything
 * else. Each step lives in its own module of this folder, so code that only
 * understands a retired layout stays out of the store. @module
 */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { APPLICATION_ID, SCHEMA_VERSION, TABLES } from '../schema.ts'
import { cold } from './cold.ts'
import { frames } from './frames.ts'
import type { Migration, MigrationOptions } from './types.ts'

/** Every step from the first schema version to the current one, in order. */
export const MIGRATIONS: readonly Migration[] = [frames, cold]

/**
 * Bring an opened database to the current schema inside the caller's write
 * transaction. Any refusal or step failure throws, and the database is
 * unchanged once the caller rolls back.
 * @param db - open database inside an immediate transaction.
 * @param options - database path, SQL files, store settings for rows a step writes, and the step notice.
 * @param migrations - upgrade steps; the package's own unless a test substitutes others.
 * @throws {HarnessError} `SESSION_STORAGE_FORMAT` for an unrelated or foreign database, a version newer
 * than this build, a version no step reads, or a database without the current tables;
 * `SESSION_STORAGE_UPGRADE`, with the step's error as cause, when a step fails.
 */
export function prepareSchema(db: DatabaseSync, options: MigrationOptions, migrations: readonly Migration[] = MIGRATIONS): void {
  const tables = (): Set<string> => new Set(db.prepare(options.sql.text('store/table-names')).all()
    .map(row => z.object({ name: z.string() }).parse(row).name))
  const refuse = (reason: string): never => {
    throw new HarnessError(`SQLite persistence database "${options.path}" ${reason}; it is left unchanged`, 'SESSION_STORAGE_FORMAT')
  }
  // The identity pragmas stay inline: their text is the pragma name, and the stamps interpolate package constants.
  let version = z.object({ user_version: z.number() }).parse(db.prepare('PRAGMA user_version').get()).user_version
  const application = z.object({ application_id: z.number() }).parse(db.prepare('PRAGMA application_id').get()).application_id
  if (version === 0 && application === 0) {
    if (tables().size !== 0) refuse('is not a Session database')
    db.exec(options.sql.text(`schema/v${SCHEMA_VERSION}`))
    // Fixed integers of this package, never caller input.
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`)
    return
  }
  if (application !== APPLICATION_ID) refuse('belongs to another application')
  if (version > SCHEMA_VERSION) {
    refuse(`has schema version ${version}, newer than version ${SCHEMA_VERSION} of this build; open it with the release that wrote it`)
  }
  while (version < SCHEMA_VERSION) {
    const step = migrations.find(candidate => candidate.from === version)
    if (step === undefined) return refuse(`has schema version ${version}, which this build cannot upgrade`)
    options.onStep(step)
    try { step.apply(db, options) }
    catch (error: unknown) {
      throw new HarnessError(`Upgrading SQLite persistence database "${options.path}" from schema version ${step.from} to ${step.to} failed; `
        + 'it is left unchanged. Restore a backup, or open it with the release that wrote it', 'SESSION_STORAGE_UPGRADE', { cause: error })
    }
    version = step.to
    db.exec(`PRAGMA user_version = ${version}`)
  }
  const present = tables()
  if (!TABLES.every(name => present.has(name))) refuse(`has schema version ${version} without its tables`)
}
