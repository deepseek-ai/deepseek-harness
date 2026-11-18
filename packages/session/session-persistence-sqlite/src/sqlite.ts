/** SQLite event lists keyed by trace_uuid, projected through SessionPersistence handles. @module */
import { LiveWriteBuffer } from './buffer.ts'
import { createHash, randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { mkdir, open, stat, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
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
import { decodeFrame, encodeFrame } from './frame.ts'
import type { EncodedFrame, FrameCompression } from './frame.ts'

/** Private Segment storage database schema version; incompatible versions are refused, never reset. */
export const SCHEMA_VERSION = 1
const APPLICATION_ID = 0x44535043
// SQLite primary result codes; extended result codes retain the low byte.
const SQLITE_BUSY = 5, SQLITE_CORRUPT = 11, SQLITE_NOTADB = 26
/**
 * Internal scheduling constant, not deployment configuration: frames decoded
 * concurrently on the thread pool between two event-loop yields of a read.
 */
const READ_DECODE_GROUP_FRAMES = 8
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
type SegmentId = Branded<'SessionSegmentId'>
const segmentId = (value: string): SegmentId => brandString<SegmentId>(value)
/** One appended batch, encoded before it queued, with the settlement of its caller's append. */
interface PendingAppend {
  readonly header: SessionHeader
  readonly batch: readonly SessionEvent[]
  readonly frames: readonly EncodedFrame[]
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}
const metadata = z.object({ header: z.string(), event_count: z.number().int().nonnegative(), base_seq: z.number().int().nonnegative(),
  tail_segment_uuid: z.string().transform(segmentId), inherited_count: z.number().int().nonnegative() })
const traceIdentity = z.object({ trace_uuid: z.string().transform(sessionIdentity) })
const frameRow = z.object({ start_seq: z.number().int().nonnegative(), end_seq: z.number().int().positive(),
  codec: z.number().int(), payload: z.instanceof(Uint8Array) })
const TRACE_METADATA_SQL = `SELECT t.trace_uuid, header, tail_segment_uuid, inherited_count, base_seq,
  base_seq + COALESCE((SELECT end_seq FROM frames WHERE segment_uuid = s.segment_uuid ORDER BY start_seq DESC LIMIT 1), 0) AS event_count
  FROM traces t LEFT JOIN segments s ON s.segment_uuid = t.tail_segment_uuid`
const segmentFields = { segment_uuid: z.string().transform(segmentId), event_count: z.number().int().nonnegative() }
const segmentRow = z.union([
  z.object({ ...segmentFields, parent_segment_uuid: z.null(), parent_end_seq: z.null(), base_seq: z.literal(0) }),
  z.object({ ...segmentFields, parent_segment_uuid: z.string().transform(segmentId),
    parent_end_seq: z.number().int().nonnegative(), base_seq: z.number().int().nonnegative() }),
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
  /** Physical frame encoding for new writes; stored frames decode by their own codec regardless. */
  readonly compression: FrameCompression
  /** Maximum events per new frame; stored frames keep their written size. */
  readonly frameEvents: number
  /** Publish a Session's routing record after its first commit. */
  readonly publish: (id: SessionId) => Promise<void>
  /** Claim a new Session across the provider's physical backends. */
  readonly acquireCreationLease: (header: SessionHeader) => Promise<{ release(): Promise<void> }>
  /** Report a background live-write failure; the Session's next durability barrier retries and rejects. */
  readonly report: (id: SessionId, error: unknown) => void
}

/** Trace persistence over private predecessor-linked Segments in one SQLite database. */
export class SqliteStore {
  /** Absolute database path, recorded in routing records. */
  readonly path: string
  private readonly legacyRoot: string
  private readonly compression: FrameCompression
  private readonly frameEvents: number
  private readonly published: (id: SessionId) => Promise<void>
  private readonly acquireCreationLease: SqliteStoreOptions['acquireCreationLease']
  private readonly report: (id: SessionId, error: unknown) => void
  private readonly pendingCreates = new Map<SessionId, {
    header: SessionHeader
    inheritedCount: number
    head: SegmentId
  }>()
  private readonly creating = new Set<SessionId>()
  private readonly directorySyncs = new Set<string>()
  private readonly statements = new Map<string, StatementSync>()
  private ready: Promise<DatabaseSync> | undefined
  private closing: Promise<void> | undefined
  private failure: Error | undefined
  private readonly chains = new Map<SessionId, { head: SegmentId; nodes: Map<SegmentId, Segment> }>()
  private readonly handles = new Set<SqliteSessionHandle>()
  private readonly writers = new Map<SessionId, SqliteSessionHandle>()
  /** Appended batches awaiting the next group commit, in arrival order. */
  private readonly commitQueue: PendingAppend[] = []
  private commitDrain: Promise<void> | undefined
  constructor(options: SqliteStoreOptions) {
    this.path = options.path
    this.legacyRoot = options.legacyRoot
    this.compression = options.compression
    this.frameEvents = options.frameEvents
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
      throw error
    })
  }

  /**
   * Refuse to use or create a database while routing records claim one that is missing.
   * @returns resolves when the database file exists or no routing record requires it.
   */
  async assertRoutingDatabase(): Promise<void> {
    if (this.ready !== undefined || await this.databaseFileExists()) return
    let records: string[]
    try { records = await readdir(join(this.legacyRoot, '.segments')) }
    catch (error: unknown) {
      if (isAbsent(error)) return
      throw error
    }
    if (!records.some(record => record.endsWith('.json'))) return
    // Another initializer may have created the database while routing records were read.
    if (await this.databaseFileExists()) return
    throw new HarnessError('The Segment database is missing but routing records remain; restore the database before using Sessions', 'SESSION_STORAGE_MISSING')
  }

  private async initialize(): Promise<DatabaseSync> {
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
      // Readers can acquire a snapshot as soon as schema creation commits.
      opened.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
      const deadline = performance.now() + BUSY_TIMEOUT_MS
      for (;;) {
        try { opened.exec('PRAGMA journal_mode = WAL'); break }
        catch (error: unknown) {
          const code = (error as { errcode?: unknown } | null)?.errcode
          if (typeof code !== 'number' || (code & 0xff) !== SQLITE_BUSY || performance.now() >= deadline) throw error
          // SQLite can bypass its busy handler during the journal-mode lock upgrade.
          // No schema or Session writes have started, so retrying this pragma is safe.
          await setImmediate()
        }
      }
      this.transaction(opened, () => {
        const current = this.schemaState(opened)
        if (current.version === 0 && current.application === 0) {
          const tables = opened.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()
          if (tables.length !== 0) throw new HarnessError('Refusing an unrelated SQLite database', 'SESSION_STORAGE_FORMAT')
          this.createSchema(opened)
        } else if (current.version !== SCHEMA_VERSION || current.application !== APPLICATION_ID) {
          throw new HarnessError('Unsupported SQLite persistence schema; database left intact', 'SESSION_STORAGE_FORMAT')
        }
      })
      return opened
    } catch (error: unknown) {
      db?.close()
      if (error instanceof HarnessError
        || error instanceof SessionPersistenceCorruptionError
        || error instanceof SessionFormatUnsupportedError) throw error
      if (error !== null && typeof error === 'object' && 'errcode' in error
        && typeof error.errcode === 'number' && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(error.errcode & 0xff)) {
        throw this.corruption(`SQLite persistence database "${this.path}" is unreadable`, error)
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

  private schemaState(db: DatabaseSync): { version: number; application: number } {
    return {
      version: z.object({ user_version: z.number() }).parse(db.prepare('PRAGMA user_version').get()).user_version,
      application: z.object({ application_id: z.number() }).parse(db.prepare('PRAGMA application_id').get()).application_id,
    }
  }

  private createSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE segments (
      segment_uuid TEXT PRIMARY KEY, parent_segment_uuid TEXT REFERENCES segments(segment_uuid), parent_end_seq INTEGER,
      base_seq INTEGER NOT NULL CHECK(base_seq >= 0),
      CHECK((parent_segment_uuid IS NULL AND parent_end_seq IS NULL AND base_seq = 0)
        OR (parent_segment_uuid IS NOT NULL AND parent_end_seq IS NOT NULL AND parent_end_seq >= 0 AND parent_segment_uuid != segment_uuid))
    ) STRICT;
    CREATE TABLE traces (
      trace_uuid TEXT PRIMARY KEY, header TEXT NOT NULL,
      tail_segment_uuid TEXT NOT NULL REFERENCES segments(segment_uuid),
      inherited_count INTEGER NOT NULL CHECK(inherited_count >= 0)
    ) STRICT;
    CREATE UNIQUE INDEX exclusive_trace_head ON traces(tail_segment_uuid);
    CREATE TABLE frames (
      segment_uuid TEXT NOT NULL REFERENCES segments(segment_uuid),
      start_seq INTEGER NOT NULL CHECK(start_seq >= 0), end_seq INTEGER NOT NULL CHECK(end_seq > start_seq),
      codec INTEGER NOT NULL CHECK(codec IN (0, 1)), payload BLOB NOT NULL, PRIMARY KEY(segment_uuid, start_seq)
    ) STRICT;
    CREATE TRIGGER frames_no_update BEFORE UPDATE ON frames BEGIN SELECT RAISE(ABORT, 'frames are append-only'); END;
    CREATE TRIGGER frames_no_delete BEFORE DELETE ON frames BEGIN SELECT RAISE(ABORT, 'frames are append-only'); END;
    CREATE TRIGGER segments_no_reparent BEFORE UPDATE OF parent_segment_uuid, parent_end_seq, base_seq ON segments
      BEGIN SELECT RAISE(ABORT, 'segment ancestry is immutable'); END;
    PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`)
    this.createAncestrySchema(db)
  }

  /** Maintain immutable ancestor ranges in the same transaction as each new Segment. */
  private createAncestrySchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE segment_ancestors (
      segment_uuid TEXT NOT NULL REFERENCES segments(segment_uuid),
      ancestor_uuid TEXT NOT NULL REFERENCES segments(segment_uuid),
      end_seq INTEGER NOT NULL CHECK(end_seq >= 0),
      PRIMARY KEY(segment_uuid, ancestor_uuid), CHECK(segment_uuid != ancestor_uuid)
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER segments_index_ancestors AFTER INSERT ON segments WHEN NEW.parent_segment_uuid IS NOT NULL BEGIN
      INSERT INTO segment_ancestors VALUES (NEW.segment_uuid, NEW.parent_segment_uuid, NEW.parent_end_seq);
      INSERT INTO segment_ancestors SELECT NEW.segment_uuid, ancestor_uuid, end_seq
        FROM segment_ancestors WHERE segment_uuid = NEW.parent_segment_uuid;
    END;
    CREATE TRIGGER ancestors_no_update BEFORE UPDATE ON segment_ancestors
      BEGIN SELECT RAISE(ABORT, 'segment ancestry is immutable'); END;
    CREATE TRIGGER ancestors_no_delete BEFORE DELETE ON segment_ancestors
      BEGIN SELECT RAISE(ABORT, 'segment ancestry is immutable'); END;`)
  }

  private transaction<T>(db: DatabaseSync, operation: () => T, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE'): T {
    this.assertHealthy()
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

  private statement(db: DatabaseSync, sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (statement === undefined) {
      statement = db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private row(db: DatabaseSync, id: SessionId) {
    this.assertHealthy()
    const raw = this.statement(db, `${TRACE_METADATA_SQL} WHERE t.trace_uuid = ?`).get(id)
    if (raw === undefined) return undefined
    return this.parseMetadata(raw, id)
  }

  private parseMetadata(raw: unknown, id: SessionId): Metadata {
    try { return metadata.parse(raw) }
    catch (error: unknown) { throw this.corruption(`session "${id}": stored SQLite trace metadata is invalid`, error) }
  }

  private segment(db: DatabaseSync, id: SegmentId): Segment {
    const row = this.statement(db, 'SELECT s.*, COALESCE((SELECT end_seq FROM frames WHERE segment_uuid = s.segment_uuid ORDER BY start_seq DESC LIMIT 1), 0) AS event_count FROM segments s WHERE segment_uuid = ?').get(id)
    if (row === undefined) throw new HarnessError('Trace references a missing segment', 'SESSION_STORAGE_CORRUPT')
    try { return segmentRow.parse(row) }
    catch (error: unknown) { throw this.corruption(`stored SQLite segment "${id}" metadata is invalid`, error) }
  }

  /** Fetch indexed ancestor metadata together, retaining the authoritative chain checks during reads. */
  private parents(db: DatabaseSync, id: SegmentId, offset: number, nodes: Map<SegmentId, Segment>): void {
    const rows = this.statement(db, `SELECT s.*, COALESCE((SELECT end_seq FROM frames WHERE segment_uuid = s.segment_uuid ORDER BY start_seq DESC LIMIT 1), 0) AS event_count FROM segment_ancestors a
      JOIN segments s ON s.segment_uuid = a.ancestor_uuid
      WHERE a.segment_uuid = ? AND (s.base_seq > ? OR s.base_seq + a.end_seq > ?)`).all(id, offset, offset)
    for (const row of rows) {
      let parsed: Segment
      try { parsed = segmentRow.parse(row) }
      catch (error: unknown) { throw this.corruption('Stored SQLite predecessor metadata is invalid', error) }
      nodes.set(parsed.segment_uuid, parsed)
    }
  }

  private newSegment(db: DatabaseSync, id: SegmentId, parent: Segment | undefined, end: number): void {
    const base = parent === undefined ? 0 : parent.base_seq + end
    this.statement(db, 'INSERT INTO segments VALUES (?, ?, ?, ?)').run(id, parent?.segment_uuid ?? null, parent === undefined ? null : end, base)
  }

  private insertTrace(db: DatabaseSync, header: SessionHeader, head: SegmentId,
    inheritedCount: number, frames: readonly EncodedFrame[]): void {
    this.statement(db, 'INSERT INTO traces VALUES (?, ?, ?, ?)').run(header.id, JSON.stringify(header), head, inheritedCount)
    this.insertFrames(db, head, 0, frames)
  }

  /** Store consecutive frames from `start`; the last frame's end becomes the Segment's event count. */
  private insertFrames(db: DatabaseSync, segment: SegmentId, start: number, frames: readonly EncodedFrame[]): void {
    const insert = this.statement(db, 'INSERT INTO frames (segment_uuid, start_seq, end_seq, codec, payload) VALUES (?, ?, ?, ?, ?)')
    let seq = start
    for (const frame of frames) {
      insert.run(segment, seq, seq + frame.count, frame.codec, frame.bytes)
      seq += frame.count
    }
  }

  /** Serialize and compress a batch before its transaction: one frame per chunk, yielding between chunks of a long batch. */
  private async encodeBatch(batch: readonly SessionEvent[]): Promise<EncodedFrame[]> {
    const frames: EncodedFrame[] = []
    for (let start = 0; start < batch.length; start += this.frameEvents) {
      if (start > 0) await setImmediate()
      frames.push(encodeFrame(batch.slice(start, start + this.frameEvents).map(event => JSON.stringify(event)), this.compression))
    }
    return frames
  }

  /**
   * Locate the Segment a fork of `source` at `end` attaches to, through the ancestor index rather than the parent chain.
   * Fork creation is the consumer; `end` never exceeds the source event count.
   * @param db - open database inside the caller's transaction.
   * @param source - forked Trace metadata.
   * @param end - exclusive logical prefix length shared with the source.
   * @returns the attachment Segment and the prefix length within it; no Segment for an empty prefix.
   */
  cut(db: DatabaseSync, source: Metadata, end: number): { parent?: Segment; end: number } {
    if (end === 0) return { end: 0 }
    const tail = this.segment(db, source.tail_segment_uuid)
    if (end >= tail.base_seq) return { parent: tail, end: end - tail.base_seq }
    // Among ancestors starting at or before the cut, the deepest one holds it; an empty-prefix tie is logically equivalent.
    const raw = this.statement(db, `SELECT s.*, a.end_seq AS visible_end, COALESCE((SELECT end_seq FROM frames WHERE segment_uuid = s.segment_uuid ORDER BY start_seq DESC LIMIT 1), 0) AS event_count FROM segment_ancestors a
      JOIN segments s ON s.segment_uuid = a.ancestor_uuid
      WHERE a.segment_uuid = ? AND s.base_seq <= ? ORDER BY s.base_seq DESC, a.end_seq DESC LIMIT 1`).get(tail.segment_uuid, end)
    if (raw === undefined) throw new HarnessError('Invalid Trace segment chain', 'SESSION_STORAGE_CORRUPT')
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
   * Reserve a fresh Trace, or commit fork history and its shared prefix in one transaction.
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
    const frames = await this.encodeBatch(events)
    const handle = await this.admit(header, 'write', inheritedCount, false,
      await this.acquireWriteLease(header, true))
    try {
      const db = await this.database()
      this.check(); signal?.throwIfAborted()
      this.transaction(db, () => {
        if (this.row(db, header.id) !== undefined) throw new SessionAlreadyExistsError(header.id)
        const parent = this.row(db, source.sessionId)
        if (parent === undefined) throw new SessionPersistenceNotFoundError(source.sessionId)
        if (source.endSeq > parent.event_count) {
          throw new HarnessError(`Parent Session "${source.sessionId}" is not persisted through ${source.endSeq} events`, 'SESSION_FORK_PREFIX_NOT_PERSISTED')
        }
        const cut = this.cut(db, parent, source.endSeq)
        const head = segmentId(randomUUID())
        this.newSegment(db, head, cut.parent, cut.end)
        this.insertTrace(db, header, head, inheritedCount, frames)
      })
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
   * @param id - trace_uuid identifying the event list.
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
    if (header.id !== id) throw new HarnessError('SQLite Trace identity mismatch', 'SESSION_STORAGE_CORRUPT')
    const handle = await this.admit(header, access, row.inherited_count, false, ownership)
    try {
      signal?.throwIfAborted()
      if (access === 'write') handle.prime(await this.read(handle.header, 0, Number.MAX_SAFE_INTEGER))
      signal?.throwIfAborted()
    } catch (error: unknown) {
      try { await handle.close() }
      catch (closeError: unknown) { throw new AggregateError([error, closeError], 'SQLite open and handle cleanup failed') }
      throw error
    }
    return handle
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
    const frames = await this.encodeBatch(batch)
    const db = await this.database()
    this.check(); signal?.throwIfAborted()
    this.transaction(db, () => {
      if (this.row(db, header.id) !== undefined) throw new SessionAlreadyExistsError(header.id)
      const head = segmentId(randomUUID())
      this.newSegment(db, head, undefined, 0)
      this.insertTrace(db, storedHeader, head, inheritedCount, frames)
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
   * @param header - selected Trace metadata.
   * @param offset - first sequence.
   * @param length - maximum number of events.
   * @returns independently owned event slice.
   */
  async read(header: SessionHeader, offset: number, length: number): Promise<SessionEvent[]> {
    this.assertHealthy()
    if (this.pendingCreates.has(header.id)) return []
    const db = await this.database()
    const stored = this.transaction(db, () => {
      const meta = this.row(db, header.id)
      if (meta === undefined) throw new SessionPersistenceNotFoundError(header.id)
      let cached = this.chains.get(header.id)
      if (cached === undefined || cached.head !== meta.tail_segment_uuid) {
        cached = { head: meta.tail_segment_uuid, nodes: new Map() }
        this.chains.set(header.id, cached)
      }
      const visited = new Set<SegmentId>(), ranges: { segment: Segment; end: number }[] = []
      let current = this.segment(db, meta.tail_segment_uuid), end = meta.event_count - current.base_seq
      cached.nodes.set(current.segment_uuid, current)
      for (;;) {
        if (visited.has(current.segment_uuid) || end < 0 || end > current.event_count) {
          throw new HarnessError('Invalid Trace segment chain', 'SESSION_STORAGE_CORRUPT')
        }
        visited.add(current.segment_uuid)
        ranges.push({ segment: current, end })
        if (current.parent_segment_uuid === null || current.base_seq <= offset) break
        const child = current
        if (!cached.nodes.has(child.parent_segment_uuid)) this.parents(db, child.segment_uuid, offset, cached.nodes)
        current = cached.nodes.get(child.parent_segment_uuid) ?? this.segment(db, child.parent_segment_uuid)
        cached.nodes.set(current.segment_uuid, current)
        end = child.parent_end_seq
        if (current.base_seq + end !== child.base_seq) throw new HarnessError('Invalid segment offset', 'SESSION_STORAGE_CORRUPT')
      }
      // Frames overlapping each Segment range, with the slice of their events the read covers.
      const frames: { codec: number; bytes: Uint8Array; skip: number; take: number }[] = []
      const stop = offset + Math.min(length, Math.max(0, meta.event_count - offset))
      const select = this.statement(db, `SELECT start_seq, end_seq, codec, payload FROM frames
        WHERE segment_uuid = ? AND end_seq > ? AND start_seq < ? ORDER BY start_seq`)
      for (const { segment, end } of ranges.reverse()) {
        const start = Math.max(0, offset - segment.base_seq), finish = Math.min(end, stop - segment.base_seq)
        if (finish <= start) continue
        let expected = start
        for (const row of select.all(segment.segment_uuid, start, finish)) {
          const frame = frameRow.safeParse(row)
          if (!frame.success) throw this.corruption(`session "${header.id}": stored SQLite frame is invalid`, frame.error)
          if (frame.data.start_seq > expected) break
          const until = Math.min(finish, frame.data.end_seq)
          frames.push({ codec: frame.data.codec, bytes: frame.data.payload, skip: expected - frame.data.start_seq, take: until - expected })
          expected = until
        }
        if (expected !== finish) throw new HarnessError('SQLite segment is incomplete', 'SESSION_STORAGE_CORRUPT')
      }
      return { frames, inheritedCount: meta.inherited_count, complete: offset === 0 && stop === meta.event_count }
    }, 'DEFERRED')
    const decoded: (SessionFormatEvent & SessionEvent)[] = []
    // One synchronous transaction fetched the frames; compressed frames decode on the thread pool a group at a
    // time, and parsing each group yields the event loop before the next, so a long history does not stall it.
    for (let group = 0; group < stored.frames.length; group += READ_DECODE_GROUP_FRAMES) {
      if (group > 0) await setImmediate()
      const frames = stored.frames.slice(group, group + READ_DECODE_GROUP_FRAMES)
      const texts = await Promise.all(frames.map(async (frame, index) => {
        try { return await decodeFrame(frame.codec, frame.bytes) } catch (error: unknown) {
          throw this.corruption(`session "${header.id}": stored frame holding event ${offset + decoded.length + index} cannot be decoded`, error)
        }
      }))
      for (const [index, lines] of texts.entries()) {
        const frame = frames[index]
        /* v8 ignore next -- a frame group only holds the frames it was built from. */
        if (frame === undefined) continue
        if (lines.length < frame.skip + frame.take) throw new HarnessError('SQLite frame is shorter than its recorded range', 'SESSION_STORAGE_CORRUPT')
        for (const text of lines.slice(frame.skip, frame.skip + frame.take)) {
          try {
            decoded.push(decodeEvent(JSON.parse(text)))
          } catch (error: unknown) {
            if (error instanceof SessionFormatUnsupportedMigrationError) throw new SessionFormatUnsupportedError(error.message)
            throw this.corruption(`session "${header.id}": stored event at index ${offset + decoded.length} is invalid`, error)
          }
        }
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
   * @param header - selected Trace metadata.
   * @param batch - independently materialized new events.
   */
  async append(header: SessionHeader, batch: readonly SessionEvent[]): Promise<void> {
    const db = await this.database()
    const frames = await this.encodeBatch(batch)
    await new Promise<void>((resolve, reject) => {
      this.commitQueue.push({ header, batch, frames, resolve, reject })
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
        this.transaction(db, () => {
          for (const entry of group) {
            db.exec('SAVEPOINT batch')
            try {
              const row = this.ensureRow(db, entry.header)
              assertContiguous(entry.header.id, entry.batch, row.event_count)
              this.insertFrames(db, row.tail_segment_uuid, row.event_count - row.base_seq, entry.frames)
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
    const head = pending.head
    this.newSegment(db, head, undefined, 0)
    const storedHeader = materializeHeader(header, SessionLogOffset(pending.inheritedCount))
    this.statement(db, 'INSERT INTO traces VALUES (?, ?, ?, ?)').run(
      header.id, JSON.stringify(storedHeader), head, pending.inheritedCount,
    )
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
    this.transaction(db, () => { this.ensureRow(db, header) })
    this.pendingCreates.delete(header.id)
    await this.route(header.id)
  }

  /**
   * Observe metadata without querying any event payloads.
   * @param id - selected trace_uuid.
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
    if (header.id !== id) throw new HarnessError('SQLite Trace identity mismatch', 'SESSION_STORAGE_CORRUPT')
    // SQLite rows always hold the current Session format.
    return { header, formatStatus: 'current', eventCount: row.event_count,
      revision: SessionPersistenceRevision(`${row.tail_segment_uuid}:${row.event_count}`) }
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
        for (const trace of this.statement(db, `${TRACE_METADATA_SQL} ORDER BY t.trace_uuid`).all()) {
          signal?.throwIfAborted()
          const id = traceIdentity.parse(trace).trace_uuid
          seen.add(id)
          const row = this.parseMetadata(trace, id)
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
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (this.ready !== undefined) {
        // Initialization closes its connection before rejecting; disposal only joins that attempt.
        const db = await this.ready.catch((_error: unknown) => undefined)
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
      ? await this.store.read(this.header, offset, length) : primed.slice(offset, offset + length)
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
