/** SQLite event rows keyed by Session id, projected through SessionPersistence handles. @module */
import { LiveWriteBuffer } from './buffer.ts'
import { createHash, randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { mkdir, open, rename, stat, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES, SessionLogOffset, SessionId as sessionIdentity } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { assertContiguous, materializeAppendBatch, validateStoredEvents, SessionAlreadyExistsError,
  SessionAlreadyOwnedError, SessionFormatUnsupportedError, SessionHandleClosedError, SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError, SessionPersistenceRevision, SessionReadOnlyError,
  sessionFormatVersionRefusal } from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle, SessionHandleAppendOptions, SessionHandleFlushOptions,
  SessionHandleReadOptions, SessionPersistenceCreateOptions, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { decodeHeader, decodeEvent, materializeHeader } from './codec.ts'
import { SessionWriteLease } from './lease.ts'
import { ensureDurableDirectoryWin32 } from './win32.ts'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { sessionDir } from './paths.ts'
import { decodeRow, encodeRow, eventRow } from './row.ts'
import type { EventCompression, EventRow } from './row.ts'
import { DerivedTables } from './derive.ts'
import type { DerivedRows, Derivation, DerivationFailure } from './derive.ts'
import { prepareSchema } from './migrations/index.ts'
import type { SqlFiles } from './sql.ts'
import type { SqlFile } from './sql.ts'
import { archiveRow, archiveSession, EVENT_CODEC_COLD, readArchive } from './cold.ts'
import type { ColdArchive } from './cold.ts'
import { vacuumStorage } from './vacuum.ts'
import type { SessionStorageCompaction } from './vacuum.ts'

// SQLite primary result codes; extended result codes retain the low byte.
const SQLITE_BUSY = 5, SQLITE_CORRUPT = 11, SQLITE_NOTADB = 26
/**
 * Internal scheduling constant, not deployment configuration: events encoded or
 * decoded between two event-loop yields of a long write or read.
 */
const CODEC_GROUP_EVENTS = 256
/** SQLite busy handler wait for a locked database before an operation fails; a protocol constant shared by every opener. */
const BUSY_TIMEOUT_MS = 5000
/** Maximum intentional wait before a routed live session batch starts writing; matches the JSONL backend. */
const LIVE_WRITE_BATCH_MAX_DELAY_MS = 200
/** Admitted live events that start a write before the delay elapses, bounding one handle's batch. */
const LIVE_WRITE_BATCH_MAX_EVENTS = 256
/**
 * Internal scheduling constant, not deployment configuration: events one group
 * commit holds before later batches wait for the next group, bounding the
 * synchronous transaction that every writer's checkpoint shares.
 */
const COMMIT_GROUP_MAX_EVENTS = 1024
/** Internal scheduling constant, not deployment configuration: pause before a derived-table rebuild retries a locked database. */
const REBUILD_BUSY_RETRY_MS = 1000
const ARCHIVE_INTERVAL_MS = 60 * 60 * 1000
const ARCHIVE_BATCH = 32
const archiveCandidate = z.object({ session_key: z.number().int(), session_id: z.string().transform(sessionIdentity),
  header: z.string(), head_segment_id: z.number().int(), inherited_count: z.number().int().nonnegative(),
  event_count: z.number().int().positive(), last_opened_at: z.number().int() })
/** Whether a SQLite failure reports a database locked by another connection. */
function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode
  return typeof code === 'number' && (code & 0xff) === SQLITE_BUSY
}
/** Whether a SQLite failure reports file bytes that are not a readable database. */
function isUnreadable(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode
  return typeof code === 'number' && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(code & 0xff)
}
/** How an open recovers a database it cannot use; see {@link SqliteStoreOptions.recovery}. */
export type Recovery = 'replace' | 'report'
/**
 * One open that must replace its damaged file. Only damage is recoverable this way: a lock means a live writer, a
 * refused schema means a file another build can read, and a failed upgrade means bytes to restore, so those keep their
 * file and report the reason instead.
 */
class ReplaceDatabase extends Error {
  constructor(readonly wrapped: Error) {
    super(wrapped.message, { cause: wrapped })
    this.name = 'ReplaceDatabase'
  }
}
type SegmentId = Branded<'SessionSegmentId'>
const segmentId = (value: string): SegmentId => brandString<SegmentId>(value)
/** One event encoded before its transaction: its row and the derived rows written beside it. */
interface EncodedEvent {
  readonly row: EventRow
  readonly derived: DerivedRows
}
/** One appended batch, encoded before it queued, with the settlement of its caller's append. */
interface PendingAppend {
  readonly header: SessionHeader
  readonly batch: readonly SessionEvent[]
  readonly encoded: readonly EncodedEvent[]
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}
const metadata = z.object({ header: z.string(), event_count: z.number().int().nonnegative(), base_seq: z.number().int().nonnegative(),
  head_segment_id: z.number().int(), head_segment_uuid: z.string().transform(segmentId), inherited_count: z.number().int().nonnegative() })
const sessionIdentityRow = z.object({ session_id: z.string().transform(sessionIdentity) })
const segmentFields = { segment_id: z.number().int(), segment_uuid: z.string().transform(segmentId),
  event_count: z.number().int().nonnegative() }
const segmentRow = z.union([
  z.object({ ...segmentFields, parent_id: z.null(), base_seq: z.literal(0) }),
  z.object({ ...segmentFields, parent_id: z.number().int(), base_seq: z.number().int().nonnegative() }),
])
type Metadata = z.infer<typeof metadata>
type Segment = z.infer<typeof segmentRow>

/**
 * Whether a filesystem rejection reports a missing path.
 * @param error - rejected value from a `node:fs` operation.
 * @returns true for `ENOENT`.
 */
export function isAbsent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

/** Normalize one rejected value for error causes and close-failure aggregation. */
function asError(error: unknown): Error {
  /* v8 ignore next -- rejected values are normally Error; normalize a hostile rejection. */
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Build the provider-wide refusal after a transaction whose commit state cannot be known.
 * @param cause - the failed COMMIT or ROLLBACK, with the original operation failure when present.
 * @returns the error every later SQLite operation of this store rejects with.
 */
function unknownOutcome(cause: unknown): HarnessError {
  return new HarnessError('SQLite transaction outcome is unknown; Segment storage is unusable until the session persistence plugin restarts', 'SESSION_STORAGE_UNKNOWN', { cause })
}

/** Resolved settings and provider callbacks for one SQLite Segment store. */
export interface SqliteStoreOptions {
  /** Absolute database path. */
  readonly path: string
  /** Resolved JSONL root holding the per-Session write-lock directories and `.segments` routing records. */
  readonly legacyRoot: string
  /** Physical `data` encoding for new rows; stored rows decode by their own codec regardless. */
  readonly compression: EventCompression
  /** Reader of the package's SQL files, shared with whatever built the derivations. */
  readonly sql: SqlFiles
  /** Derived tables to maintain beside events. */
  readonly derivations: readonly Derivation[]
  /** Publish a Session's routing record after its first commit. */
  readonly publish: (id: SessionId) => Promise<void>
  /** Claim a new Session across the provider's physical backends. */
  readonly acquireCreationLease: (header: SessionHeader) => Promise<{ release(): Promise<void> }>
  /** Report a background live-write failure; the Session's next durability barrier retries and rejects. */
  readonly report: (id: SessionId, error: unknown) => void
  /** Report a derived-table failure, the first of each kind and table; events are unaffected. */
  readonly reportDerivation: (failure: DerivationFailure) => void
  /** Report a schema upgrade about to rewrite the database from one version to the next; the process blocks until it finishes. */
  readonly reportUpgrade: (from: number, to: number) => void
  /** Report stored data a schema upgrade could not carry over and set aside; the Session it belongs to reads as damaged. */
  readonly reportSetAside: (detail: string, error: unknown) => void
  /** Report a database moved aside for a new empty one; its stored Sessions are no longer listed. */
  readonly reportRecovery: (detail: string) => void
  /**
   * What an open does when the stored database cannot be used. `replace` keeps every stored byte by moving the file
   * aside and starts a new empty database, so the Session service stays available. `report` refuses and leaves the
   * storage root for an operator to repair. Defaults to `replace`.
   */
  readonly recovery?: Recovery
  /** Days of inactivity before archiving; `0` or omitted disables archiving. */
  readonly coldAfterDays?: number
  /** Report maintenance failures without treating the hot database as unavailable. */
  readonly reportArchive: (error: unknown) => void
}

/** Session persistence over private predecessor-linked Segments in one SQLite database. */
export class SqliteStore {
  /** Absolute database path, recorded in routing records. */
  readonly path: string
  private readonly legacyRoot: string
  private readonly compression: EventCompression
  private readonly derived: DerivedTables
  private rebuilding: Promise<void> | undefined
  /** Set while an open that ran an upgrade step has not committed, so its failure is kept instead of retried. */
  private upgrading = false
  private readonly published: (id: SessionId) => Promise<void>
  private readonly acquireCreationLease: SqliteStoreOptions['acquireCreationLease']
  private readonly report: (id: SessionId, error: unknown) => void
  private readonly reportDerivation: SqliteStoreOptions['reportDerivation']
  private readonly reportUpgrade: SqliteStoreOptions['reportUpgrade']
  private readonly reportSetAside: SqliteStoreOptions['reportSetAside']
  private readonly reportRecovery: SqliteStoreOptions['reportRecovery']
  private readonly recovery: Recovery
  private readonly coldAfterMs: number | undefined
  private readonly reportArchive: SqliteStoreOptions['reportArchive']
  private readonly archiveDirectory: string
  private readonly archiveStop = new AbortController()
  private archiving: Promise<void> | undefined
  private readonly inflightWarms = new Set<Promise<unknown>>()
  private readonly warming = new Map<SessionId, {
    promise: Promise<SessionEvent[] | undefined>
    abort: AbortController
    waiters: number
  }>()
  private readonly pendingCreates = new Map<SessionId, {
    header: SessionHeader
    inheritedCount: number
    head: SegmentId
  }>()
  private readonly creating = new Set<SessionId>()
  private readonly directorySyncs = new Set<string>()
  /** SQL text of this store's statements, shared with its derived tables and upgrade steps. */
  private readonly sql: SqlFiles
  private readonly statements = new Map<SqlFile, StatementSync>()
  private ready: Promise<DatabaseSync> | undefined
  private closing: Promise<void> | undefined
  private compacting: Promise<SessionStorageCompaction> | undefined
  private failure: Error | undefined
  private readonly chains = new Map<SessionId, { head: number; nodes: Map<number, Segment> }>()
  private readonly handles = new Set<SqliteSessionHandle>()
  private readonly writers = new Map<SessionId, SqliteSessionHandle>()
  /** Appended batches awaiting the next group commit, in arrival order. */
  private readonly commitQueue: PendingAppend[] = []
  private commitDrain: Promise<void> | undefined
  constructor(options: SqliteStoreOptions) {
    this.path = options.path
    this.legacyRoot = options.legacyRoot
    this.compression = options.compression
    this.sql = options.sql
    this.derived = new DerivedTables(options.derivations, options.reportDerivation, this.sql)
    this.reportDerivation = options.reportDerivation
    this.reportUpgrade = options.reportUpgrade
    this.reportSetAside = options.reportSetAside
    this.reportRecovery = options.reportRecovery
    this.recovery = options.recovery ?? 'replace'
    this.coldAfterMs = options.coldAfterDays !== undefined && options.coldAfterDays > 0
      ? options.coldAfterDays * 86_400_000
      : undefined
    this.reportArchive = options.reportArchive
    this.archiveDirectory = `${this.path}.cold`
    this.published = options.publish
    this.acquireCreationLease = options.acquireCreationLease
    this.report = options.report
  }

  private corruption(context: string, error: unknown): SessionPersistenceCorruptionError {
    return new SessionPersistenceCorruptionError(context, { cause: asError(error) })
  }

  private parseHeader(id: SessionId, text: string): SessionHeader {
    let value: unknown
    try { value = JSON.parse(text) }
    catch (error: unknown) { throw this.corruption(`session "${id}": stored SQLite header is not valid JSON`, error) }
    const version = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { version?: unknown }).version
      : undefined
    if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
      throw new SessionPersistenceCorruptionError(`session "${id}": stored SQLite header has no valid version`, {
        cause: new TypeError('missing or invalid session version'),
      })
    }
    if (version !== SESSION_FORMAT_VERSION) {
      throw new SessionFormatUnsupportedError(sessionFormatVersionRefusal(id, version))
    }
    try { return decodeHeader(value) }
    catch (error: unknown) { throw this.corruption(`session "${id}": stored SQLite header is invalid`, error) }
  }

  private database(): Promise<DatabaseSync> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return this.ready ??= this.initialize().catch((error: unknown) => {
      this.ready = undefined
      // A failed upgrade fails the same way on unchanged data; retrying would block the process again each time.
      if (this.upgrading) this.failure = asError(error)
      throw error
    })
  }

  /**
   * Refuse to use or create a database while routing records claim one that is missing.
   *
   * Routing records name Sessions whose history lived in the database, so an absent database is history an operator
   * can still restore. Under `replace` the orphaned records are reported and then ignored, and a new empty database
   * takes their place.
   * @returns resolves when the database file exists or no routing record requires it.
   * @throws {HarnessError} `SESSION_STORAGE_MISSING` under `report`, with the file left absent for a restore.
   */
  async assertRoutingDatabase(): Promise<void> {
    if (this.ready !== undefined || await this.databaseFileExists()) return
    let records: string[]
    try { records = await readdir(join(this.legacyRoot, '.segments')) }
    catch (error: unknown) {
      if (isAbsent(error)) return
      throw error
    }
    const orphaned = records.filter(record => record.endsWith('.json'))
    if (orphaned.length === 0) return
    // Another initializer may have created the database while routing records were read.
    if (await this.databaseFileExists()) return
    if (this.recovery === 'replace') {
      // The records stay in place: a database an operator restores from a backup finds them again. They are ignored here
      // only because no database exists to hold their Sessions, and a later run with a restored file reads them normally.
      this.reportRecovery(`SQLite Session database "${this.path}" is missing while ${orphaned.length} routing record(s) remain; `
        + 'a new empty database replaces it. The Sessions those records name stay recoverable from a backup, because the '
        + 'records are kept and a restored database is read through them')
      return
    }
    throw new HarnessError('The Segment database is missing but routing records remain; restore the database before using Sessions', 'SESSION_STORAGE_MISSING')
  }

  /**
   * Prepare the database, which may be absent, locked by another process, or unreadable.
   *
   * An absent file becomes a new empty database with the current schema. A lock waits for the busy timeout, because the
   * writer that holds it may commit meanwhile, and then reports the lock instead of replacing a live writer's file. A
   * damaged file is moved aside to `<name>.unreadable-<timestamp>` beside it, with the routing records that name its
   * Sessions, and a new empty database takes its place: the store keeps working and every stored byte stays available,
   * so nothing is deleted. `report` refuses instead, which leaves the storage root exactly as it was for an operator.
   * @returns the open database.
   * @throws {HarnessError} `SESSION_STORAGE_LOCKED` or `SESSION_STORAGE_MISSING` under `report`. A refused schema and a
   * failed upgrade propagate under either mode, because their file is readable and must not be replaced.
   */
  private async initialize(): Promise<DatabaseSync> {
    try { return await this.openDatabase() }
    catch (error: unknown) {
      // Anything else is a file this build cannot interpret, which only an operator or another build can resolve.
      if (!(error instanceof ReplaceDatabase)) throw error
      // A file that cannot be moved aside is not replaced: its bytes are the only copy of the damaged history.
      /* v8 ignore next -- reached only when the move of a damaged file fails, which needs an unwritable volume. */
      if (!await this.setAside()) throw error.wrapped
      return await this.openDatabase()
    }
  }

  /**
   * Move a damaged database, its journal, and the routing records that name it aside, so the next open creates a new
   * database and lists Sessions again. Every stored byte and every record stays readable under its new name.
   * @returns whether the files were moved. A file that cannot be moved is left where it is: replacing it would discard the
   * only copy of the damaged bytes, so the caller reports the storage fault instead.
   */
  private async setAside(): Promise<boolean> {
    // The suffix keeps the database name first, so a later recovery never overwrites an earlier one.
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const aside = `${this.path}.unreadable-${stamp}`
    // The journal belongs to the bytes being moved, so a new database must not adopt it. A journal is usually absent, and
    // a move that fails for any other reason means the damaged bytes cannot be preserved.
    for (const [from, to] of [
      [this.path, aside], [`${this.path}-wal`, `${aside}-wal`], [`${this.path}-shm`, `${aside}-shm`],
      [this.archiveDirectory, `${aside}.cold`],
    ] as const) {
      try { await rename(from, to) }
      /* v8 ignore next -- a journal is usually absent, and a volume that refuses the move of a readable file is a
         storage fault no test can stage without changing the process's own filesystem permissions. */
      catch (error: unknown) { if (!isAbsent(error)) return false }
    }
    // A routing record names a Session whose history was in the moved database. Left under its `.json` name it would make
    // `list()` refuse every call as a missing Session, so the records move with the bytes they name.
    const records = join(this.legacyRoot, '.segments')
    try {
      for (const name of await readdir(records)) {
        if (!name.endsWith('.json')) continue
        try { await rename(join(records, name), join(records, `${name}.unreadable-${stamp}`)) }
        /* v8 ignore next -- a record vanishes only when another process removes it, which the lease prevents here. */
        catch (error: unknown) { if (!isAbsent(error)) throw error }
      }
    } catch (error: unknown) {
      /* v8 ignore next -- the routing directory is created before the first commit, so it is absent only on a new root. */
      if (!isAbsent(error)) throw error
    }
    this.reportRecovery(`SQLite Session database "${this.path}" cannot be read; it and the routing records naming its `
      + `Sessions were moved to "${basename(aside)}". A new empty database replaces it, and the moved files hold every `
      + 'stored Session')
    return true
  }

  /**
   * Report one lock past the busy timeout.
   *
   * SQLite holds its locks as operating-system locks, which the kernel releases when a process exits, so a lock that
   * outlasts the busy timeout belongs to a live writer. Replacing its file would not stop that writer: it would keep
   * writing to the moved bytes while the new database started empty, splitting one history in two. Every platform
   * therefore reports the lock rather than replacing, and only an operator decides that the writer is gone.
   * @param error - the busy failure.
   * @returns the error to throw.
   */
  private lockOutcome(error: unknown): Error {
    return new HarnessError(`SQLite Session database "${this.path}" is locked by another process, which may be writing it; `
      + 'close every other DSH process that uses this storage root and open the Session again',
    'SESSION_STORAGE_LOCKED', { cause: asError(error) })
  }

  /** Open, create, and validate the configured database. */
  private async openDatabase(): Promise<DatabaseSync> {
    await this.assertRoutingDatabase()
    await this.ensureDirectory(dirname(this.path))
    // Retain the routing directory before the first Session commit.
    await this.ensureDirectory(join(this.legacyRoot, '.segments'))
    try { const file = await open(this.path, 'wx', 0o600); await file.close() }
    catch (error: unknown) {
      if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    const { DatabaseSync } = await import('node:sqlite')
    let db: DatabaseSync | undefined
    try {
      const opened = new DatabaseSync(this.path, { timeout: BUSY_TIMEOUT_MS })
      db = opened
      // Connection pragmas stay inline: each is one setting whose meaning is this call site.
      // Readers can acquire a snapshot as soon as schema creation commits.
      // A 16 KiB page cuts the padding that large `data` values leave at the end of a page: 1.3% of a 370 MB store,
      // against 6% more per-page slack in a small one. WAL requires the change before the first write.
      opened.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA page_size = 16384; PRAGMA journal_size_limit = 67108864;')
      const deadline = performance.now() + BUSY_TIMEOUT_MS
      for (;;) {
        try { opened.exec('PRAGMA journal_mode = WAL'); break }
        catch (error: unknown) {
          if (!isBusy(error)) throw error
          if (performance.now() >= deadline) throw this.lockOutcome(error)
          // SQLite can bypass its busy handler during the journal-mode lock upgrade.
          // No schema or Session writes have started, so retrying this pragma is safe.
          await setImmediate()
        }
      }
      this.transaction(opened, () => {
        prepareSchema(opened, { path: this.path, compression: this.compression, sql: this.sql,
          onStep: (step) => {
            this.upgrading = true
            this.reportUpgrade(step.from, step.to)
          },
          onSetAside: this.reportSetAside })
        this.derived.install(opened, opened.prepare(this.sql.text('store/any-event')).get() !== undefined)
      })
      this.upgrading = false
      this.scheduleRebuild(opened)
      if (this.coldAfterMs !== undefined) this.scheduleArchive(opened, this.coldAfterMs)
      return opened
    } catch (error: unknown) {
      db?.close()
      if (error instanceof HarnessError
        || error instanceof SessionPersistenceCorruptionError
        || error instanceof SessionFormatUnsupportedError) throw error
      // A lock is never damage: another process may be writing these bytes, so the file is reported and kept.
      if (isBusy(error)) throw this.lockOutcome(error)
      // Tagged so the caller replaces exactly this file, and only this file.
      if (isUnreadable(error)) {
        const corruption = this.corruption(`SQLite persistence database "${this.path}" is unreadable`, error)
        throw this.recovery === 'replace' ? new ReplaceDatabase(corruption) : corruption
      }
      throw error
    }
  }

  /** Persist newly created directory entries, retaining unfinished synchronization for initialization retries. */
  private async ensureDirectory(target: string): Promise<void> {
    /* v8 ignore start -- Windows uses write-through directory publication instead of directory fsync. */
    if (process.platform === 'win32') return ensureDurableDirectoryWin32(target)
    /* v8 ignore stop */
    /* v8 ignore start -- Windows cannot fsync directory handles; its write-through publication returns above. */
    const firstCreated = await mkdir(target, { recursive: true, mode: 0o700 })
    if (firstCreated !== undefined) {
      for (let current = resolve(target); ; current = dirname(current)) {
        this.directorySyncs.add(dirname(current))
        if (current === resolve(firstCreated)) break
      }
    }
    for (const directory of this.directorySyncs) {
      const parent = await open(directory, 'r')
      try { await parent.sync() } finally { await parent.close() }
      this.directorySyncs.delete(directory)
    }
    /* v8 ignore stop */
  }

  private transaction<T>(db: DatabaseSync, operation: () => T, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE'): T {
    this.assertHealthy()
    // Transaction control stays inline here and in the group commit: each statement is a keyword this code sequences.
    db.exec(`BEGIN ${mode}`)
    let result: T
    try { result = operation() }
    catch (error: unknown) {
      try { if (db.isTransaction) db.exec('ROLLBACK') }
      catch (rollbackError: unknown) {
        this.failure = unknownOutcome(new AggregateError([error, rollbackError], 'SQLite operation and rollback failed'))
        throw this.failure
      }
      throw error
    }
    try { db.exec('COMMIT'); return result }
    catch (commitError: unknown) {
      this.failure = unknownOutcome(commitError)
      try { if (db.isTransaction) db.exec('ROLLBACK') }
      catch (rollbackError: unknown) {
        this.failure = unknownOutcome(new AggregateError([commitError, rollbackError], 'SQLite COMMIT and ROLLBACK failed'))
      }
      throw this.failure
    }
  }

  private assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure
  }

  private check(): void {
    if (this.closing !== undefined) throw new HarnessError('SQLite persistence is closing', 'SESSION_STORAGE_CLOSED')
    this.assertHealthy()
  }

  // The worker holds SQLite's write lock during VACUUM. Queue local writes asynchronously instead of
  // letting SQLite's synchronous busy handler block the Host. WAL reads still use the normal connection.
  private async waitForCompaction(): Promise<void> {
    while (this.compacting !== undefined) {
      await this.compacting.catch((_error: unknown) => { /* A refused compaction does not affect writes. */ })
    }
  }

  private async afterCompaction<T>(write: () => T): Promise<T> {
    await this.waitForCompaction()
    this.assertHealthy()
    return write()
  }

  private commit<T>(db: DatabaseSync, write: () => T): Promise<T> {
    return this.afterCompaction(() => this.transaction(db, write))
  }

  /** Prepare one SQL file's statement on first use; the store holds a single connection. */
  private statement(db: DatabaseSync, file: SqlFile): StatementSync {
    let statement = this.statements.get(file)
    if (statement === undefined) {
      statement = db.prepare(this.sql.text(file))
      this.statements.set(file, statement)
    }
    return statement
  }

  private row(db: DatabaseSync, id: SessionId) {
    this.assertHealthy()
    const raw = this.statement(db, 'store/session-by-id').get(id)
    if (raw === undefined) return undefined
    return this.parseMetadata(raw, id)
  }

  private scheduleArchive(db: DatabaseSync, age: number): void {
    const { signal } = this.archiveStop
    this.archiving = (async () => {
      await setImmediate(undefined, { signal })
      await this.rebuilding
      let after = 0
      for (;;) {
        await this.waitForCompaction()
        signal.throwIfAborted()
        this.assertHealthy()
        const cutoff = Date.now() - age
        const candidates = this.statement(db, 'cold/candidates').all(after, cutoff, cutoff, ARCHIVE_BATCH)
        for (const value of candidates) {
          signal.throwIfAborted()
          const candidate = archiveCandidate.parse(value)
          after = candidate.session_key
          try { await this.archiveCandidate(db, candidate, signal) }
          catch (error: unknown) {
            signal.throwIfAborted()
            if (!(error instanceof SessionAlreadyOwnedError)) this.reportArchive(error)
          }
          await setImmediate(undefined, { signal })
        }
        if (candidates.length < ARCHIVE_BATCH) {
          after = 0
          await delay(ARCHIVE_INTERVAL_MS, undefined, { signal, ref: false })
        } else await setImmediate(undefined, { signal })
      }
    })().catch((error: unknown) => { if (!signal.aborted) this.reportArchive(error) })
  }

  private async archiveCandidate(db: DatabaseSync, candidate: z.infer<typeof archiveCandidate>, signal: AbortSignal): Promise<void> {
    const id = candidate.session_id
    if ([...this.handles].some(handle => handle.id === id)) return
    const header = this.parseHeader(id, candidate.header)
    await this.ensureDirectory(this.archiveDirectory)
    const archive = await archiveSession(this.archiveDirectory, header, SessionLogOffset(candidate.inherited_count),
      this.archiveHistory(db, header, candidate.event_count, signal), candidate.event_count, signal)
    if (archive === undefined) return
    await this.waitForCompaction()
    let lease: { release(): Promise<void> } | undefined
    let retained = false
    try {
      lease = await this.acquireWriteLease(header, false)
      signal.throwIfAborted()
      retained = await this.commit(db, () => {
        signal.throwIfAborted()
        if ([...this.handles].some(handle => handle.id === id)) return false
        const result = this.statement(db, 'cold/record').run(archive.archive, archive.sha256, archive.bytes,
          id, candidate.head_segment_id, candidate.event_count, candidate.last_opened_at)
        if (result.changes === 0) return false
        if (this.statement(db, 'cold/evict').run(candidate.head_segment_id).changes !== candidate.event_count) {
          throw new HarnessError('Cold Segment changed during eviction', 'SESSION_STORAGE_CORRUPT')
        }
        return true
      })
    } finally {
      // An unknown COMMIT outcome retains the file: the database may already refer to it.
      try { await lease?.release() }
      finally { if (!retained && this.failure === undefined) await this.removeArchive(archive.archive) }
    }
  }

  private async *archiveHistory(db: DatabaseSync, header: SessionHeader, end: number, signal: AbortSignal): AsyncGenerator<SessionEvent> {
    try {
      for (let offset = 0; offset < end; offset += CODEC_GROUP_EVENTS) {
        await setImmediate(undefined, { signal })
        if (this.coldRow(db, header.id) !== undefined) return
        yield* await this.read(header, offset, Math.min(CODEC_GROUP_EVENTS, end - offset), signal)
      }
    } finally {
      if (![...this.handles].some(handle => handle.id === header.id)) this.chains.delete(header.id)
    }
  }

  private coldRow(db: DatabaseSync, id: SessionId): z.infer<typeof archiveRow> | undefined {
    const row = this.statement(db, 'cold/archive-by-session').get(id)
    if (row === undefined) return undefined
    try { return archiveRow.parse(row) }
    catch (error: unknown) { throw this.corruption(`session "${id}": stored SQLite cold archive metadata is invalid`, error) }
  }

  private async removeArchive(name: string): Promise<void> {
    try { await rm(join(this.archiveDirectory, `${name}.jsonl.zst`), { force: true }) }
    catch (error: unknown) { this.reportArchive(error) }
  }

  private async touch(db: DatabaseSync, id: SessionId): Promise<void> {
    if (this.coldAfterMs !== undefined) {
      const now = Date.now()
      try {
        await this.afterCompaction(() => {
          if (this.closing === undefined) this.statement(db, 'cold/touch').run(now, id, now - ARCHIVE_INTERVAL_MS)
        })
      }
      catch (error: unknown) {
        if (!isBusy(error)) throw error
        this.reportArchive(error)
      }
    }
  }

  private async archivedEvents(header: SessionHeader, locator: ColdArchive, row: Metadata, signal?: AbortSignal): Promise<SessionEvent[]> {
    let snapshot: Awaited<ReturnType<typeof readArchive>>
    try { snapshot = await readArchive(this.archiveDirectory, locator, signal) }
    catch (error: unknown) {
      signal?.throwIfAborted()
      if (error instanceof SessionFormatUnsupportedError) throw error
      throw this.corruption(`Session "${header.id}" cold archive cannot be read`, error)
    }
    if (!isDeepStrictEqual(snapshot.meta, header)
      || snapshot.inheritedEventCount !== row.inherited_count || snapshot.events.length !== row.event_count) {
      throw this.corruption(`Session "${header.id}" cold archive does not match its SQLite metadata`, new Error('Archive identity or range mismatch'))
    }
    const events = validateStoredEvents(header, snapshot.events, { kind: 'sqlite', path: this.path })
    assertContiguous(header.id, events, 0)
    return events
  }

  private ensureWarm(db: DatabaseSync, header: SessionHeader, row: Metadata,
    signal: AbortSignal | undefined): Promise<SessionEvent[] | undefined> {
    signal?.throwIfAborted()
    let entry = this.warming.get(header.id)
    if (entry === undefined) {
      const locator = this.coldRow(db, header.id)
      if (locator === undefined) return Promise.resolve(undefined)
      const abort = new AbortController()
      const combined = AbortSignal.any([this.archiveStop.signal, abort.signal])
      const created = {
        abort,
        waiters: 0,
        promise: this.warm(db, header, row, locator, combined).finally(() => {
          this.inflightWarms.delete(created.promise)
          if (this.warming.get(header.id) === created) this.warming.delete(header.id)
        }),
      }
      this.inflightWarms.add(created.promise)
      entry = created
      this.warming.set(header.id, entry)
    }
    entry.waiters += 1
    if (signal === undefined) return entry.promise
    const active = entry
    return new Promise<SessionEvent[] | undefined>((resolve, reject) => {
      const onAbort = (): void => {
        active.waiters -= 1
        if (active.waiters === 0) {
          this.warming.delete(header.id)
          active.abort.abort(signal.reason)
        }
        reject(asError(signal.reason))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      active.promise.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
        (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(asError(error)) },
      )
    })
  }

  private async warm(db: DatabaseSync, header: SessionHeader, row: Metadata, locator: z.infer<typeof archiveRow>,
    signal: AbortSignal): Promise<SessionEvent[] | undefined> {
    let events: SessionEvent[]
    try { events = await this.archivedEvents(header, locator, row, signal) }
    catch (error: unknown) {
      signal.throwIfAborted()
      this.check()
      if (this.coldRow(db, header.id)?.archive !== locator.archive) return undefined
      throw error
    }
    const encoded = await this.encodeBatch(events, signal)
    await this.waitForCompaction()
    let lease: { release(): Promise<void> } | undefined
    try {
      const until = Date.now() + BUSY_TIMEOUT_MS
      while (this.coldRow(db, header.id)?.archive === locator.archive) {
        signal.throwIfAborted()
        this.check()
        try { lease = await this.acquireWriteLease(header, false); break }
        catch (error: unknown) {
          if (!(error instanceof SessionAlreadyOwnedError)) throw error
          if (Date.now() >= until) throw new HarnessError('Cold Session is locked by another opener', 'SESSION_STORAGE_LOCKED', { cause: error })
        }
        await delay(50, undefined, { signal })
      }
      if (lease === undefined) return events
      const restored = await this.commit(db, () => {
        this.check(); signal.throwIfAborted()
        if (this.coldRow(db, header.id)?.archive !== locator.archive) return false
        const restore = this.statement(db, 'cold/restore')
        for (const event of encoded) {
          const { row: restored, derived } = event
          if (restore.run(restored.codec, restored.data, locator.segment_id, restored.seq,
            restored.type, restored.time, restored.surface_op, restored.source_seqs, restored.ignorable).changes !== 1) {
            throw new HarnessError('Cold Segment is incomplete', 'SESSION_STORAGE_CORRUPT')
          }
          this.derived.insert(db, locator.segment_id, restored.seq, derived)
        }
        this.statement(db, 'cold/forget').run(locator.segment_id)
        const now = Date.now()
        this.statement(db, 'cold/touch').run(now, header.id, now)
        return true
      })
      if (restored) await this.removeArchive(locator.archive)
      return events
    } catch (error: unknown) {
      if (isBusy(error)) throw this.lockOutcome(error)
      throw error
    } finally { await lease?.release() }
  }

  private parseMetadata(raw: unknown, id: SessionId): Metadata {
    try { return metadata.parse(raw) }
    catch (error: unknown) { throw this.corruption(`session "${id}": stored SQLite Session metadata is invalid`, error) }
  }

  private segment(db: DatabaseSync, id: number): Segment {
    const row = this.statement(db, 'store/segment-by-id').get(id)
    if (row === undefined) throw new HarnessError('Session references a missing segment', 'SESSION_STORAGE_CORRUPT')
    try { return segmentRow.parse(row) }
    catch (error: unknown) { throw this.corruption(`stored SQLite segment ${id} metadata is invalid`, error) }
  }

  /** Fetch the metadata of every ancestor on the Segment's path together, retaining the authoritative chain checks during reads. */
  private parents(db: DatabaseSync, id: number, offset: number, nodes: Map<number, Segment>): void {
    const rows = this.statement(db, 'store/segment-ancestors').all(id, offset)
    for (const row of rows) {
      let parsed: Segment
      try { parsed = segmentRow.parse(row) }
      catch (error: unknown) { throw this.corruption('Stored SQLite predecessor metadata is invalid', error) }
      nodes.set(parsed.segment_id, parsed)
    }
  }

  /** Insert a Segment whose first sequence is `end` events into `parent`, returning its row id. */
  private newSegment(db: DatabaseSync, id: SegmentId, parent: Segment | undefined, end: number): number {
    const base = parent === undefined ? 0 : parent.base_seq + end
    return Number(this.statement(db, 'store/insert-segment').run(id, parent?.segment_id ?? null, base).lastInsertRowid)
  }

  private insertSession(db: DatabaseSync, header: SessionHeader, head: number,
    inheritedCount: number, encoded: readonly EncodedEvent[]): void {
    const openedAt = this.coldAfterMs === undefined ? 0 : Date.now()
    this.statement(db, 'store/insert-session').run(header.id, JSON.stringify(header), head, inheritedCount, openedAt)
    this.insertEvents(db, head, encoded)
  }

  /** Store consecutive event rows; the last row's sequence fixes the Segment's event count. */
  private insertEvents(db: DatabaseSync, segment: number, encoded: readonly EncodedEvent[]): void {
    const insert = this.statement(db, 'store/insert-event')
    for (const { row, derived } of encoded) {
      insert.run(segment, row.seq, row.type, row.time, row.surface_op, row.source_seqs, row.ignorable, row.codec, row.data)
      this.derived.insert(db, segment, row.seq, derived)
    }
  }

  /** Serialize, compress and derive a batch before its transaction, yielding between groups of a long batch. */
  private async encodeBatch(batch: readonly SessionEvent[], signal?: AbortSignal): Promise<EncodedEvent[]> {
    const encoded: EncodedEvent[] = []
    for (const [index, event] of batch.entries()) {
      if (index > 0 && index % CODEC_GROUP_EVENTS === 0) await setImmediate(undefined, { signal })
      encoded.push({ row: encodeRow(event, this.compression), derived: this.derived.rows(event) })
    }
    return encoded
  }

  /**
   * Rebuild derived tables that are behind after open, one bounded transaction per event-loop turn so appends
   * interleave. A locked database is tried again after a pause; any other failure is reported, and the stored
   * cursor resumes the rebuild at the next start.
   */
  private scheduleRebuild(db: DatabaseSync): void {
    this.rebuilding = (async () => {
      for (;;) {
        await setImmediate()
        if (this.closing !== undefined || this.failure !== undefined) return
        try {
          if (!await this.commit(db, () => this.derived.rebuild(db))) return
        } catch (error: unknown) {
          // Another writer held the lock past the busy timeout; its release lets the next attempt through.
          if (!isBusy(error)) throw error
          await delay(REBUILD_BUSY_RETRY_MS)
        }
      }
    })().catch((error: unknown) => { this.reportDerivation({ kind: 'rebuild', error }) })
  }

  /**
   * Locate the Segment a fork of `source` at `end` attaches to, through its Segment paths rather than the parent chain.
   * Fork creation is the consumer; `end` never exceeds the source event count.
   * @param db - open database inside the caller's transaction.
   * @param source - forked Session metadata.
   * @param end - exclusive logical prefix length shared with the source.
   * @returns the attachment Segment and the prefix length within it; no Segment for an empty prefix.
   */
  cut(db: DatabaseSync, source: Metadata, end: number): { parent?: Segment; end: number } {
    if (end === 0) return { end: 0 }
    const tail = this.segment(db, source.head_segment_id)
    if (end >= tail.base_seq) return { parent: tail, end: end - tail.base_seq }
    // Among ancestors starting at or before the cut, the deepest one holds it; an empty-prefix tie is logically equivalent.
    const raw = this.statement(db, 'store/fork-attachment').get(tail.segment_id, end)
    if (raw === undefined) throw new HarnessError('Invalid Session segment chain', 'SESSION_STORAGE_CORRUPT')
    let parent: Segment, visible: number
    try {
      parent = segmentRow.parse(raw)
      visible = z.object({ visible_end: z.number().int().nonnegative() }).parse(raw).visible_end
    } catch (error: unknown) { throw this.corruption('Stored SQLite predecessor metadata is invalid', error) }
    const within = end - parent.base_seq
    if (within > visible || within > parent.event_count) throw new HarnessError('Invalid segment offset', 'SESSION_STORAGE_CORRUPT')
    return { parent, end: within }
  }

  /**
   * Reserve a fresh Session, or commit fork history and its shared prefix in one transaction.
   * @param header - loop-owned metadata.
   * @param options - optional cancellation, logical inherited count, and selected fork history.
   * @returns exclusive in-process write handle.
   */
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SqliteSessionHandle> {
    this.check()
    options?.signal?.throwIfAborted()

    const meta = materializeHeader(header, options?.inheritedEventCount)
    const inheritedCount = options?.inheritedEventCount ?? 0
    if (this.creating.has(meta.id) || this.pendingCreates.has(meta.id) || this.writers.has(meta.id)) {
      throw new SessionAlreadyExistsError(meta.id)
    }
    this.creating.add(meta.id)
    try {
      if (await this.stat(meta.id) !== undefined) throw new SessionAlreadyExistsError(meta.id)
      await this.assertRoutingDatabase()
      this.check()
      options?.signal?.throwIfAborted()
      if (options?.parentSource !== undefined) {
        return await this.createFork(meta, inheritedCount, options.parentSource, options.signal)
      }
      this.pendingCreates.set(meta.id, {
        header: meta,
        inheritedCount,
        head: segmentId(randomUUID()),
      })
      return await this.admit(meta, 'write', inheritedCount, true)
    } catch (error: unknown) {
      this.pendingCreates.delete(meta.id)
      throw error
    } finally {
      this.creating.delete(meta.id)
    }
  }

  /** Share the parent's persisted prefix and commit the child's remaining events under one creation lease. */
  private async createFork(header: SessionHeader, inheritedCount: number,
    source: NonNullable<SessionPersistenceCreateOptions['parentSource']>, signal?: AbortSignal): Promise<SqliteSessionHandle> {
    // A live parent writer drains its admitted events first so the shared prefix is durable.
    const writer = this.writers.get(source.sessionId)
    if (writer !== undefined) await (writer.closeCompletion ?? writer.flush())
    signal?.throwIfAborted()
    const events = materializeAppendBatch(source.events.slice(source.endSeq))
    assertContiguous(header.id, events, source.endSeq)
    const encoded = await this.encodeBatch(events)
    const db = await this.database()
    const handle = await this.admit(header, 'write', inheritedCount, false,
      await this.acquireWriteLease(header, true))
    try {
      for (;;) {
        if (source.endSeq > 0) {
          const parentRow = this.row(db, source.sessionId)
          if (parentRow !== undefined) {
            await this.ensureWarm(db, this.parseHeader(source.sessionId, parentRow.header), parentRow, signal)
          }
        }
        this.check(); signal?.throwIfAborted()
        const committed = await this.commit(db, () => {
          this.check(); signal?.throwIfAborted()
          if (this.row(db, header.id) !== undefined) throw new SessionAlreadyExistsError(header.id)
          const parent = this.row(db, source.sessionId)
          if (parent === undefined) throw new SessionPersistenceNotFoundError(source.sessionId)
          if (source.endSeq > parent.event_count) {
            throw new HarnessError(`Parent Session "${source.sessionId}" is not persisted through ${source.endSeq} events`, 'SESSION_FORK_PREFIX_NOT_PERSISTED')
          }
          if (source.endSeq > 0 && this.coldRow(db, source.sessionId) !== undefined) return false
          const cut = this.cut(db, parent, source.endSeq)
          const head = this.newSegment(db, segmentId(randomUUID()), cut.parent, cut.end)
          this.insertSession(db, header, head, inheritedCount, encoded)
          return true
        })
        if (committed) break
      }
      await this.route(header.id)
      return handle
    } catch (error: unknown) {
      try { await handle.close() }
      catch (closeError: unknown) { throw new AggregateError([error, closeError], 'Fork creation and handle cleanup failed') }
      throw error
    }
  }

  /**
   * Acquire a handle; a write open reads the stored log once to validate it before the restore read.
   * @param id - Session identity.
   * @param access - read or in-process exclusive write access.
   * @param signal - optional cancellation.
   * @param ownership - optional import lease, transferred only to a successful write open.
   * @returns handle over the original stored identity.
   */
  async open(id: SessionId, access: SessionAccess, signal?: AbortSignal,
    ownership?: { release(): Promise<void> }): Promise<SqliteSessionHandle> {
    this.check(); signal?.throwIfAborted()
    if (access === 'read') await this.writers.get(id)?.closeCompletion
    this.check(); signal?.throwIfAborted()
    const pending = this.pendingCreates.get(id)
    if (pending !== undefined) return this.admit(pending.header, access, pending.inheritedCount)
    if (!await this.exists()) throw new SessionPersistenceNotFoundError(id)
    const db = await this.database()
    this.check(); signal?.throwIfAborted()
    const row = this.row(db, id)
    if (row === undefined) throw new SessionPersistenceNotFoundError(id)
    const header = this.parseHeader(id, row.header)
    if (header.id !== id) throw new HarnessError('SQLite Session identity mismatch', 'SESSION_STORAGE_CORRUPT')
    let retriedLease = false
    for (;;) {
      this.check(); signal?.throwIfAborted()
      if (access === 'write' && this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
      const primed = await this.ensureWarm(db, header, row, signal)
      let handle: SqliteSessionHandle
      try {
        handle = await this.admit(header, access, row.inherited_count, false, ownership)
      } catch (error: unknown) {
        if (!(error instanceof SessionAlreadyOwnedError) || retriedLease) throw error
        retriedLease = true
        await delay(50, undefined, { signal })
        continue
      }
      try {
        signal?.throwIfAborted()
        if (access === 'write' && this.coldRow(db, id) !== undefined) {
          await handle.close()
          continue
        }
        if (primed === undefined) await this.touch(db, id)
        if (access === 'write') {
          handle.prime(primed !== undefined && this.row(db, id)?.event_count === primed.length
            ? primed : await this.read(handle.header, 0, Number.MAX_SAFE_INTEGER, signal))
        }
        this.check(); signal?.throwIfAborted()
        return handle
      } catch (error: unknown) {
        try { await handle.close() }
        catch (closeError: unknown) { throw new AggregateError([error, closeError], 'SQLite open and handle cleanup failed') }
        throw error
      }
    }
  }

  /**
   * Claim existing Session ownership for a legacy import and its subsequent write open.
   * @param header - legacy metadata identifying the artifact lock.
   * @returns database and artifact leases, retained until release or successful write-open transfer.
   */
  acquireSessionLease(header: SessionHeader): Promise<{ release(): Promise<void> }> {
    this.check()
    return this.acquireWriteLease(header, false)
  }

  /**
   * Import a validated legacy log as one independent root Segment under caller-held Session ownership.
   * A transaction failure leaves no partial Session; publication failure leaves the committed row authoritative.
   * @param header - current logical metadata decoded by the legacy reader.
   * @param inheritedCount - exact logical inheritance count from the legacy header.
   * @param events - complete, contiguous legacy prefix without consumer-generated repairs.
   * @param signal - cancellation checked before the synchronous transaction.
   */
  async importLegacy(header: SessionHeader, inheritedCount: SessionLogOffset,
    events: readonly SessionEvent[], signal?: AbortSignal): Promise<void> {
    this.check(); signal?.throwIfAborted()
    const storedHeader = materializeHeader(header, inheritedCount)
    const batch = materializeAppendBatch(events)
    assertContiguous(header.id, batch, 0)
    const encoded = await this.encodeBatch(batch)
    const db = await this.database()
    this.check(); signal?.throwIfAborted()
    await this.commit(db, () => {
      this.check(); signal?.throwIfAborted()
      if (this.row(db, header.id) !== undefined) throw new SessionAlreadyExistsError(header.id)
      const head = this.newSegment(db, segmentId(randomUUID()), undefined, 0)
      this.insertSession(db, storedHeader, head, inheritedCount, encoded)
    })
    await this.route(header.id)
  }

  /** Publish routing after a commit; the committed rows stay authoritative when publication fails. */
  private async route(id: SessionId): Promise<void> {
    try { await this.published(id) }
    catch (error: unknown) {
      throw new HarnessError('Session history committed, but routing publication failed; close and reopen the Session',
        'SESSION_STORAGE_PUBLICATION', { cause: error })
    }
  }

  /** Hold both database-wide Session ownership and the root's artifact/creation guards. */
  private async acquireWriteLease(header: SessionHeader, created: boolean): Promise<{ release(): Promise<void> }> {
    await this.database()
    const database = await realpath(this.path)
    const directory = join(`${database}.session-locks`, createHash('sha256').update(header.id).digest('hex'))
    const shared = await SessionWriteLease.acquire(directory, header.id)
    let artifact: { release(): Promise<void> }
    try {
      artifact = created
        ? await this.acquireCreationLease(header)
        : await SessionWriteLease.acquire(sessionDir(this.legacyRoot, header.cwd, header.id), header.id)
    } catch (error: unknown) {
      try {
        await shared.release()
      } catch (releaseError: unknown) {
        throw new AggregateError([error, releaseError], 'SQLite write ownership acquisition and rollback failed')
      }
      throw error
    }
    return {
      release: async () => {
        const results = await Promise.allSettled([artifact.release(), shared.release()])
        const failures = results
          .filter(result => result.status === 'rejected')
          .map((result): unknown => result.reason)
        if (failures.length > 1) throw new AggregateError(failures, 'SQLite write ownership release failed')
        if (failures.length === 1) throw failures[0]
      },
    }
  }

  /**
   * Admit a handle. A write open takes the cross-process lease now; a created Session takes it
   * immediately before its first commit, so an unused create leaves no filesystem footprint.
   */
  private async admit(header: SessionHeader, access: SessionAccess, inheritedCount = 0, created = false,
    ownership?: { release(): Promise<void> }): Promise<SqliteSessionHandle> {
    if (access === 'write' && this.writers.has(header.id)) throw new SessionAlreadyOwnedError(header.id)
    let lease = access === 'write' && !created
      ? ownership ?? await this.acquireWriteLease(header, false)
      : undefined
    try {
      this.check()
      const handle = new SqliteSessionHandle(header, access, this, async () => {
        this.handles.delete(handle)
        if (![...this.handles].some(active => active.id === header.id)) this.chains.delete(header.id)
        if (access === 'write') {
          this.writers.delete(header.id)
          this.pendingCreates.delete(header.id)
        }
        await lease?.release()
      }, async () => {
        lease ??= await this.acquireWriteLease(header, true)
      }, () => {
        this.assertHealthy()
      },
      SessionLogOffset(inheritedCount))
      this.handles.add(handle)
      if (access === 'write') this.writers.set(header.id, handle)
      return handle
    } catch (error: unknown) {
      await lease?.release()
      throw error
    }
  }

  /**
   * Read only the requested indexed list slice, validating the decoded event vocabulary.
   * @param header - selected Session metadata.
   * @param offset - first sequence.
   * @param length - maximum number of events.
   * @param signal - optional cancellation while reading an archive.
   * @returns independently owned event slice.
   */
  async read(header: SessionHeader, offset: number, length: number, signal?: AbortSignal): Promise<SessionEvent[]> {
    this.assertHealthy()
    if (this.pendingCreates.has(header.id)) return []
    const db = await this.database()
    const stored = this.transaction(db, () => {
      const meta = this.row(db, header.id)
      if (meta === undefined) throw new SessionPersistenceNotFoundError(header.id)
      let cached = this.chains.get(header.id)
      if (cached === undefined || cached.head !== meta.head_segment_id) {
        cached = { head: meta.head_segment_id, nodes: new Map() }
        this.chains.set(header.id, cached)
      }
      const visited = new Set<number>(), ranges: { segment: Segment; end: number }[] = []
      let current = this.segment(db, meta.head_segment_id), end = meta.event_count - current.base_seq
      cached.nodes.set(current.segment_id, current)
      for (;;) {
        if (visited.has(current.segment_id) || end < 0 || end > current.event_count) {
          throw new HarnessError('Invalid Session segment chain', 'SESSION_STORAGE_CORRUPT')
        }
        visited.add(current.segment_id)
        ranges.push({ segment: current, end })
        if (current.parent_id === null || current.base_seq <= offset) break
        const child = current
        if (!cached.nodes.has(child.parent_id)) this.parents(db, child.segment_id, offset, cached.nodes)
        current = cached.nodes.get(child.parent_id) ?? this.segment(db, child.parent_id)
        cached.nodes.set(current.segment_id, current)
        // A child's base is the cut in its parent, so the parent contributes the events before it.
        end = child.base_seq - current.base_seq
      }
      // Rows of each Segment range, oldest Segment first.
      const rows: EventRow[] = []
      const stop = offset + Math.min(length, Math.max(0, meta.event_count - offset))
      const select = this.statement(db, 'store/events-in-range')
      for (const { segment, end } of ranges.reverse()) {
        const start = Math.max(segment.base_seq, offset), finish = Math.min(segment.base_seq + end, stop)
        if (finish <= start) continue
        let expected = start
        for (const raw of select.all(segment.segment_id, start, finish)) {
          const row = eventRow.safeParse(raw)
          if (!row.success) throw this.corruption(`session "${header.id}": stored SQLite event row is invalid`, row.error)
          if (row.data.seq !== expected) break
          if (row.data.codec === EVENT_CODEC_COLD) {
            const archive = this.coldRow(db, header.id)
            if (archive === undefined) throw new HarnessError('Cold event has no archive record', 'SESSION_STORAGE_CORRUPT')
            return { archive, meta }
          }
          rows.push(row.data)
          expected++
        }
        if (expected !== finish) throw new HarnessError('SQLite segment is incomplete', 'SESSION_STORAGE_CORRUPT')
      }
      return { rows, inheritedCount: meta.inherited_count, complete: offset === 0 && stop === meta.event_count }
    }, 'DEFERRED')
    // Another process may have archived after this read handle opened. Recheck in the same snapshot as the payload read.
    if (stored.archive !== undefined) {
      try { return (await this.archivedEvents(header, stored.archive, stored.meta, signal)).slice(offset, offset + length) }
      catch (error: unknown) {
        signal?.throwIfAborted()
        this.check()
        // A concurrent open may commit the inline payloads and remove the archive before this handle reads it.
        if (this.coldRow(db, header.id)?.archive !== stored.archive.archive) return this.read(header, offset, length, signal)
        throw error
      }
    }
    const decoded: (SessionFormatEvent & SessionEvent)[] = []
    // One synchronous transaction fetched the rows; decoding yields the event loop between groups,
    // so a long history does not stall it.
    for (const [index, row] of stored.rows.entries()) {
      if (index > 0 && index % CODEC_GROUP_EVENTS === 0) await setImmediate()
      try {
        decoded.push(decodeEvent(decodeRow(row)))
      } catch (error: unknown) {
        if (error instanceof SessionFormatUnsupportedMigrationError) throw new SessionFormatUnsupportedError(error.message)
        throw this.corruption(`session "${header.id}": stored event at index ${offset + index} is invalid`, error)
      }
    }
    if (stored.complete) {
      try {
        restoreReleasedV4Artifact({ header: { ...header, delegationDepth: header.delegationDepth ?? 0 },
          inheritedEventCount: stored.inheritedCount, events: decoded }, KNOWN_SESSION_EVENT_TYPES)
      } catch (error: unknown) {
        if (error instanceof SessionFormatUnsupportedMigrationError) throw new SessionFormatUnsupportedError(error.message)
        throw this.corruption(`session "${header.id}": stored V4 relationships are invalid`, error)
      }
    }
    const events = validateStoredEvents(header, decoded, { kind: 'sqlite', path: this.path })
    assertContiguous(header.id, events, offset)
    return events
  }

  /**
   * Insert a new suffix atomically; recover the append position through the event index without updating metadata counters.
   * @param header - selected Session metadata.
   * @param batch - independently materialized new events.
   */
  async append(header: SessionHeader, batch: readonly SessionEvent[]): Promise<void> {
    const db = await this.database()
    const encoded = await this.encodeBatch(batch)
    await new Promise<void>((resolve, reject) => {
      this.commitQueue.push({ header, batch, encoded, resolve, reject })
      this.scheduleCommits(db)
    })
  }

  /** Start draining queued batches unless a drain is running; a finished drain restarts for batches queued meanwhile. */
  private scheduleCommits(db: DatabaseSync): void {
    if (this.commitDrain !== undefined) return
    this.commitDrain = this.drainCommits(db).finally(() => {
      this.commitDrain = undefined
      if (this.commitQueue.length > 0) this.scheduleCommits(db)
    })
  }

  /**
   * Commit queued batches a group at a time. The yield before each group lets batches that other writers
   * append in the same turn share one transaction, so a checkpoint costs one commit and one fsync per group
   * rather than per writer, and it returns the process to its I/O phase between commits; a lone writer pays
   * the same single yield per commit. A batch that fails on its own terms rolls back to its savepoint and
   * rejects alone; an error that ends the whole transaction rejects every batch of the group, and each
   * handle retains its batch for retry.
   */
  private async drainCommits(db: DatabaseSync): Promise<void> {
    while (this.commitQueue.length > 0) {
      await setImmediate()
      const group = this.takeCommitGroup()
      const failures = new Map<PendingAppend, unknown>()
      try {
        await this.commit(db, () => {
          for (const entry of group) {
            db.exec('SAVEPOINT batch')
            try {
              const row = this.ensureRow(db, entry.header)
              assertContiguous(entry.header.id, entry.batch, row.event_count)
              this.insertEvents(db, row.head_segment_id, entry.encoded)
              db.exec('RELEASE batch')
            } catch (error: unknown) {
              if (!db.isTransaction) throw error
              try { db.exec('ROLLBACK TO batch; RELEASE batch') }
              catch (rollbackError: unknown) { throw new AggregateError([error, rollbackError], 'SQLite batch and its savepoint rollback failed') }
              failures.set(entry, error)
            }
          }
        })
      } catch (error: unknown) {
        for (const entry of group) entry.reject(error)
        continue
      }
      for (const entry of group) {
        if (failures.has(entry)) { entry.reject(failures.get(entry)); continue }
        this.pendingCreates.delete(entry.header.id)
        this.route(entry.header.id).then(entry.resolve, entry.reject)
      }
    }
  }

  /** Dequeue the next group: consecutive batches up to the event cap, always at least one. */
  private takeCommitGroup(): PendingAppend[] {
    let events = 0, count = 0
    for (const entry of this.commitQueue) {
      if (count > 0 && events + entry.batch.length > COMMIT_GROUP_MAX_EVENTS) break
      events += entry.batch.length
      count++
    }
    return this.commitQueue.splice(0, count)
  }

  private ensureRow(db: DatabaseSync, header: SessionHeader): Metadata {
    let row = this.row(db, header.id)
    if (row !== undefined) {
      if (this.pendingCreates.has(header.id)) throw new SessionAlreadyExistsError(header.id)
      return row
    }
    const pending = this.pendingCreates.get(header.id)
    if (pending === undefined) throw new SessionPersistenceNotFoundError(header.id)
    const head = this.newSegment(db, pending.head, undefined, 0)
    this.insertSession(db, materializeHeader(header, SessionLogOffset(pending.inheritedCount)), head, pending.inheritedCount, [])
    row = this.row(db, header.id)
    if (row === undefined) throw new HarnessError('Committed Session metadata is unavailable', 'SESSION_STORAGE_CORRUPT')
    return row
  }

  /**
   * Materialize a pending empty Session at its explicit durability barrier.
   * @param header - pending Session metadata.
   */
  async materialize(header: SessionHeader): Promise<void> {
    this.assertHealthy()
    const pending = this.pendingCreates.get(header.id)
    if (pending === undefined) return
    const db = await this.database()
    await this.commit(db, () => { this.ensureRow(db, header) })
    this.pendingCreates.delete(header.id)
    await this.route(header.id)
  }

  /**
   * Observe metadata without querying any event payloads.
   * @param id - selected Session identity.
   * @param signal - optional cancellation.
   * @returns header, exact count and revision, or absence.
   */
  async stat(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceSnapshot | undefined> {
    this.check(); signal?.throwIfAborted()
    const pending = this.pendingCreates.get(id)
    // Each create mints its own head, so a closed unmaterialized create and a
    // later create of the same id never share a revision.
    if (pending !== undefined) return { header: pending.header, revision: SessionPersistenceRevision(`pending:${pending.head}`) }
    if (!await this.exists()) return undefined
    const row = this.row(await this.database(), id)
    if (row === undefined) return undefined
    return this.snapshot(id, row, this.parseHeader(id, row.header))
  }

  private snapshot(id: SessionId, row: Metadata, header: SessionHeader): SessionPersistenceSnapshot {
    if (header.id !== id) throw new HarnessError('SQLite Session identity mismatch', 'SESSION_STORAGE_CORRUPT')
    // SQLite rows always hold the current Session format.
    return { header, formatStatus: 'current', eventCount: row.event_count,
      revision: SessionPersistenceRevision(`${row.head_segment_uuid}:${row.event_count}`) }
  }

  private async databaseFileExists(): Promise<boolean> {
    try { await stat(this.path); return true }
    catch (error: unknown) {
      if (isAbsent(error)) return false
      throw error
    }
  }

  private async exists(): Promise<boolean> {
    return this.ready !== undefined || this.databaseFileExists()
  }

  /**
   * Whether the configured database file exists without opening or creating it.
   * @returns true when the database file exists.
   */
  async hasDatabase(): Promise<boolean> { return await this.exists() }

  /**
   * Open or create the configured database and validate its schema.
   * @returns resolves once the database is ready for session operations.
   */
  async start(): Promise<void> { this.check(); await this.database() }

  /** Reclaim space without starting, replacing, or upgrading a database.
   * @returns byte measurements from the completed SQLite compaction attempt.
   */
  async compactStorage(): Promise<SessionStorageCompaction> {
    this.check()
    if (this.compacting !== undefined) return this.compacting
    if (this.ready === undefined) throw new HarnessError('Open the SQLite Session store before compacting it', 'SESSION_STORAGE_NOT_READY')
    const ready = this.ready
    this.compacting = (async () => {
      await ready
      this.assertHealthy()
      return await vacuumStorage(this.path, this.sql)
    })().finally(() => { this.compacting = undefined })
    return this.compacting
  }

  /**
   * List Sessions, omitting rows whose stored header is corrupt or of an unsupported version.
   * Matching an unreadable JSONL generation header, an omitted row still rejects direct
   * `open` and `stat`. Invalid row metadata and an identity mismatch reject the listing.
   * @param signal - optional cancellation.
   * @returns listed snapshots and the ids of stored rows omitted for their header.
   */
  async scan(signal?: AbortSignal): Promise<{ entries: SessionPersistenceSnapshot[]; omitted: Set<SessionId> }> {
    this.check(); signal?.throwIfAborted()
    const pending = [...this.pendingCreates.keys()]
    const entries: SessionPersistenceSnapshot[] = [], omitted = new Set<SessionId>(), seen = new Set<SessionId>()
    if (await this.exists()) {
      const db = await this.database()
      // One joined query observes all durable metadata in the same read snapshot.
      this.transaction(db, () => {
        for (const stored of this.statement(db, 'store/sessions').all()) {
          signal?.throwIfAborted()
          const id = sessionIdentityRow.parse(stored).session_id
          seen.add(id)
          const row = this.parseMetadata(stored, id)
          let header: SessionHeader
          try { header = this.parseHeader(id, row.header) }
          catch (error: unknown) {
            /* v8 ignore next -- parseHeader classifies every header failure; any other error must not be skipped. */
            if (!(error instanceof SessionPersistenceCorruptionError || error instanceof SessionFormatUnsupportedError)) throw error
            omitted.add(id)
            continue
          }
          entries.push(this.snapshot(id, row, header))
        }
      }, 'DEFERRED')
    }
    for (const id of pending) {
      if (seen.has(id)) continue
      const entry = await this.stat(id, signal)
      if (entry !== undefined) entries.push(entry)
    }
    return { entries, omitted }
  }

  /**
   * Register live-event and durability listeners for the provider lifetime.
   * @param ctx - owning parent scope, disposed after injected consumers.
   * @param beforeClose - optional admitted-import settlement before handle teardown.
   */
  install(ctx: Context, beforeClose?: () => Promise<void>): void {
    ctx.effect(() => async () => { await beforeClose?.(); await this.close() })
    ctx.on('session/event', (session, event) => {
      const handle = this.writers.get(session.id)
      if (handle !== undefined) void handle.receive(event).catch((error: unknown) => {
        ctx.logger.error(`SQLite persistence failed for ${session.id}: ${String(error)}`)
      })
    })
    ctx.on('session/flush', session => this.writers.get(session.id)?.flush())
    ctx.on('session/disposed', (session) => {
      const handle = this.writers.get(session.id)
      if (handle !== undefined) void handle.close().catch((error: unknown) => {
        ctx.logger.error(`SQLite handle close failed for ${session.id}: ${String(error)}`)
      })
    })
  }

  /**
   * Report a background failure while retaining the rejected durability state.
   * @param id - affected Session.
   * @param error - retained failure.
   */
  reportFailure(id: SessionId, error: unknown): void { this.report(id, error) }

  /** Join all admitted writer operations; commits already use FULL synchronous durability. */
  async flush(): Promise<void> {
    this.check()
    const results = await Promise.allSettled([...this.writers.values()].map(async (handle) => {
      try { await handle.flush() } catch (error: unknown) {
        if (error instanceof SessionHandleClosedError) await handle.close(); else throw error
      }
    }))
    const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'SQLite flush failed')
  }

  /** Drain admitted handles before closing the database connection. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.archiveStop.abort(new HarnessError('SQLite persistence is closing', 'SESSION_STORAGE_CLOSED'))
      await this.compacting?.catch((_error: unknown) => { /* The requesting caller receives the failure. */ })
      await Promise.allSettled(this.inflightWarms)
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (this.ready !== undefined) {
        // Initialization closes its connection before rejecting; disposal only joins that attempt.
        const db = await this.ready.catch((_error: unknown) => undefined)
        // Initialization starts the rebuild, so it is joined only after initialization settles.
        await this.rebuilding
        await this.archiving
        if (db !== undefined) this.derived.release(db)
        // Write volume during this process changed the tables the analysis sampled at open. `PRAGMA optimize` analyzes
        // only the tables whose rows changed, so the next open starts with statistics that match the stored data.
        if (db !== undefined) {
          try { db.exec(this.sql.text('store/reoptimize')) } catch (error: unknown) { failures.push(error) }
        }
        try { db?.close() } catch (error: unknown) { failures.push(error) }
      }
      this.statements.clear()
      if (failures.length > 0) throw new AggregateError(failures, 'SQLite disposal failed')
    })()
  }
}

/** One SessionHandle over a logical SQLite event stream. */
export class SqliteSessionHandle implements SessionHandle {
  private closed = false
  private pending: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private failure: Error | undefined
  private primed: SessionEvent[] | undefined
  private readonly buffer: LiveWriteBuffer
  constructor(readonly header: SessionHeader, readonly access: SessionAccess,
    private readonly store: SqliteStore,
    private readonly release: () => Promise<void>, private readonly acquireLease: () => Promise<void>,
    private readonly checkStorage: () => void,
    readonly inheritedEventCount = SessionLogOffset(0)) {
    this.buffer = new LiveWriteBuffer({
      delayMs: LIVE_WRITE_BATCH_MAX_DELAY_MS,
      maxEvents: LIVE_WRITE_BATCH_MAX_EVENTS,
      enqueue: operation => this.enqueue(operation),
      persist: batch => this.store.append(this.header, batch),
      retry: (error) => {
        if (error instanceof HarnessError && error.code === 'SESSION_STORAGE_PUBLICATION') {
          this.failure = error
          return false
        }
        return true
      },
      canSchedule: () => this.failure === undefined && this.closing === undefined,
    })
  }
  get id() { return this.header.id }

  /** Completion of an already-started close, including its final durability drain. */
  get closeCompletion(): Promise<void> | undefined { return this.closing }

  private check(): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, 'access')
    this.checkStorage()
    if (this.failure !== undefined) throw this.failure
  }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions) {
    this.check(); options?.signal?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new RangeError('read offset and length must be non-negative safe integers')
    await this.pending
    this.check(); options?.signal?.throwIfAborted()
    const primed = this.primed
    this.primed = undefined
    const events = primed === undefined
      ? await this.store.read(this.header, offset, length, options?.signal) : primed.slice(offset, offset + length)
    // The synchronous SQLite read cannot be interrupted; a cancelled read still returns no events.
    options?.signal?.throwIfAborted()
    return { eventState: 'detached' as const, events }
  }

  /**
   * Retain the validated write-open prefix for the immediate restore read.
   * @param events - exclusively owned validated prefix.
   */
  prime(events: SessionEvent[]): void { this.primed = events }

  /**
   * Admit one live event into the bounded batching window, including while close drains the routed producer.
   * @param event - newly emitted event, copied before asynchronous persistence.
   * @returns admission completion; durability requires flush. Rejects once the close drain has finished.
   */
  receive(event: SessionEvent): Promise<void> {
    // Provider failures retain their identity across Session event admission.
    try { this.checkStorage() } catch (error: unknown) { return Promise.reject(asError(error)) }
    try {
      if (this.closed) throw new SessionHandleClosedError(this.id, 'receive')
      this.primed = undefined
      const batch = materializeAppendBatch([event])
      this.buffer.append(batch, (error) => { this.store.reportFailure(this.id, error) })
      return Promise.resolve()
    } catch (error: unknown) {
      this.failure = new HarnessError('Session event admission failed', 'SESSION_STORAGE_FAILED', { cause: error })
      return Promise.reject(this.failure)
    }
  }

  /** Drain admitted live records without forcing an unused empty Session to materialize. */
  drainLive(): Promise<void> {
    if (this.buffer.length === 0 && !this.buffer.active) return this.pending
    return this.buffer.drain()
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.check()
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    if (events.length === 0) return
    options?.signal?.throwIfAborted()
    const batch = materializeAppendBatch(events)
    // Live and explicit batches own separate durable writes. Drain admitted live
    // events first so an aborted or failed explicit append cannot take them.
    await this.drainLive()
    /* v8 ignore next -- concurrent admission can follow a completed drain before append resumes. */
    while (this.buffer.length > 0) await this.drainLive()
    options?.signal?.throwIfAborted()
    this.primed = undefined
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      try {
        await this.store.append(this.header, batch)
      } catch (error: unknown) {
        if (error instanceof HarnessError && error.code === 'SESSION_STORAGE_PUBLICATION') this.failure = error
        throw error
      }
    }, options?.signal)
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.check()
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush')
    options?.signal?.throwIfAborted()
    do { await this.drainLive() } while (this.buffer.length > 0)
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      try { await this.store.materialize(this.header) }
      catch (error: unknown) {
        if (error instanceof HarnessError && error.code === 'SESSION_STORAGE_PUBLICATION') this.failure = error
        throw error
      }
    }, options?.signal)
  }

  private enqueue(operation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const next = this.pending.then(async () => {
      this.checkStorage()
      if (this.failure !== undefined) throw this.failure
      signal?.throwIfAborted()
      await this.acquireLease()
      await operation()
    })
    this.pending = next.then(() => undefined, () => undefined)
    return next
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const drained = this.drainLive()
    return this.closing = (async () => {
      const failures: Error[] = []
      try {
        let draining = drained
        for (;;) {
          await draining
          await this.pending
          if (this.buffer.length === 0) break
          draining = this.drainLive()
        }
        if (this.failure !== undefined) failures.push(this.failure)
      } catch (error: unknown) {
        failures.push(asError(error))
      }
      await this.pending
      this.closed = true
      try { await this.release() }
      catch (error: unknown) { failures.push(asError(error)) }
      if (failures.length > 1) throw new AggregateError(failures, `session "${this.id}": close failed to drain and release`)
      if (failures[0] !== undefined) throw failures[0]
    })()
  }
  [Symbol.asyncDispose]() { return this.close() }
}
