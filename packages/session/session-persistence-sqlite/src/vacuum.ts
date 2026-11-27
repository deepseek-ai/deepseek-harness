/** Run explicit SQLite compaction on a separate connection without blocking the Host. @module */
import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { APPLICATION_ID, SCHEMA_VERSION } from './schema.ts'
import type { SqlFiles } from './sql.ts'

/**
 * Byte measurements from one explicit SQLite compaction run.
 *
 * Explicit temporary design decision: kept internal to `@deepseek-ai/dsh-session-persistence-sqlite`
 * rather than on `SessionPersistence` because no other persistence backend requires `VACUUM`-style
 * page reclamation.
 * @internal
 */
export interface SessionStorageCompaction {
  /** Total database and write-ahead log bytes before compaction. */
  readonly beforeBytes: number
  /** Total database and write-ahead log bytes after compaction. */
  readonly afterBytes: number
  /** True when the database rewrite succeeded, while an active reader prevented final journal truncation. */
  readonly checkpointPending: boolean
}

const COMPACTION_BUSY_TIMEOUT_MS = 1000
const SQLITE_BUSY = 5
const requestSchema = z.object({ path: z.string(), appId: z.number().int(), version: z.number().int(),
  vacuum: z.string(), checkpoint: z.string() })
const appIdRow = z.object({ application_id: z.number().int() })
const versionRow = z.object({ user_version: z.number().int() })
const checkpointRow = z.object({ busy: z.number().int() })

const response = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), beforeBytes: z.number().int().nonnegative(), afterBytes: z.number().int().nonnegative(),
    checkpointPending: z.boolean() }),
  z.object({ status: z.literal('locked') }),
  z.object({ status: z.literal('failed'), message: z.string() }),
])

/** Validated compaction worker payload. */
export type CompactionRequest = z.infer<typeof requestSchema>
/** Structured result returned from the compaction worker. */
export type CompactionResponse = z.infer<typeof response>

/**
 * Measure total bytes occupied on disk by the main SQLite file and any active WAL file.
 * @param path - database file path.
 * @returns combined main-database and WAL byte count.
 */
export function databaseStorageBytes(path: string): number {
  return statSync(path).size + (statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0)
}

/**
 * Execute one synchronous SQLite rewrite and WAL checkpoint on an isolated connection.
 * @param rawRequest - untrusted worker payload.
 * @returns structured completion, lock contention, or failure report.
 */
export function runCompaction(rawRequest: unknown): CompactionResponse {
  try {
    const request = requestSchema.parse(rawRequest)
    const identity = statSync(request.path, { bigint: true })
    const beforeBytes = databaseStorageBytes(request.path)
    const db = new DatabaseSync(request.path, { timeout: COMPACTION_BUSY_TIMEOUT_MS })
    try {
      const opened = statSync(request.path, { bigint: true })
      if (opened.dev !== identity.dev || opened.ino !== identity.ino
        || appIdRow.parse(db.prepare('PRAGMA application_id').get()).application_id !== request.appId
        || versionRow.parse(db.prepare('PRAGMA user_version').get()).user_version !== request.version) {
        throw new Error('Database identity changed before compaction')
      }
      db.exec('PRAGMA synchronous = FULL')
      const checkpoint = db.prepare(request.checkpoint)
      if (checkpointRow.parse(checkpoint.get()).busy !== 0) return { status: 'locked' }
      db.exec(request.vacuum)
      const checkpointPending = checkpointRow.parse(checkpoint.get()).busy !== 0
      return { status: 'done', beforeBytes, afterBytes: databaseStorageBytes(request.path), checkpointPending }
    } finally { db.close() }
  } catch (error: unknown) {
    const code = error instanceof Error && 'errcode' in error ? error.errcode : undefined
    return typeof code === 'number' && (code & 0xff) === SQLITE_BUSY
      ? { status: 'locked' } : { status: 'failed', message: String(error) }
  }
}

/** Compact a validated SQLite store and join the worker before returning.
 * @param path - the provider's database path, not a caller-supplied path.
 * @param sql - the owning store's SQL files.
 * @returns measured bytes and whether the post-rewrite checkpoint was blocked.
 */
export async function vacuumStorage(path: string, sql: SqlFiles): Promise<SessionStorageCompaction> {
  const request: CompactionRequest = { path, appId: APPLICATION_ID, version: SCHEMA_VERSION,
    vacuum: sql.text('store/vacuum'), checkpoint: sql.text('store/checkpoint') }
  let entry: string | URL
  /* v8 ignore start -- built-worker e2e covers the bundled .cjs entry without resolving tsx. */
  if (!import.meta.url.endsWith('.ts')) entry = fileURLToPath(new URL('./worker.cjs', import.meta.url))
  /* v8 ignore stop */
  else {
    const tsEntry = new URL('./worker.ts', import.meta.url).href
    const loader = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register(); await import(${JSON.stringify(tsEntry)})`
    entry = new URL(`data:text/javascript,${encodeURIComponent(loader)}`)
  }
  const worker = new Worker(entry, { workerData: request, execArgv: [] })
  let reply: unknown, failure: Error | undefined
  worker.once('message', (message: unknown) => { reply = message })
  worker.once('error', (error: Error) => { failure = error })
  const exit = await new Promise<number>((resolve) => { worker.once('exit', resolve) })
  const result = response.safeParse(reply)
  if (exit === 0 && result.success) {
    if (result.data.status === 'done') {
      const { beforeBytes, afterBytes, checkpointPending } = result.data
      return { beforeBytes, afterBytes, checkpointPending }
    }
    if (result.data.status === 'locked') {
      throw new HarnessError('Another SQLite connection prevents compaction; close it and retry', 'SESSION_STORAGE_LOCKED')
    }
    throw new HarnessError('SQLite compaction did not complete; check disk space and storage access',
      'SESSION_STORAGE_COMPACTION_FAILED', { cause: new Error(result.data.message) })
  }
  const cause = failure ?? new Error(`Compaction worker exited without a valid result (exit ${exit})`)
  throw new HarnessError('SQLite compaction did not complete; check disk space and storage access',
    'SESSION_STORAGE_COMPACTION_FAILED', { cause })
}
