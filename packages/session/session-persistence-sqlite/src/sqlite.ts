/** SQLite event lists keyed by trace_uuid, projected through SessionPersistence handles. @module */
import { LiveWriteBuffer } from './buffer.ts'
import { createHash, randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DatabaseSync } from 'node:sqlite'
import { mkdir, open, stat, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { sessionDir } from './paths.ts'

/** Private Segment storage database schema version; incompatible versions are refused, never reset. */
export const SCHEMA_VERSION = 3
const APPLICATION_ID = 0x44535043
// SQLite primary result codes; extended result codes retain the low byte.
const SQLITE_CORRUPT = 11, SQLITE_NOTADB = 26
type SegmentId = Branded<'SessionSegmentId'>
const segmentId = (value: string): SegmentId => brandString<SegmentId>(value)
const metadata = z.object({ header: z.string(), event_count: z.number().int().nonnegative(),
  tail_segment_uuid: z.string().transform(segmentId), inherited_count: z.number().int().nonnegative() })
const traceIdentity = z.object({ trace_uuid: z.string().transform(sessionIdentity) })
const TRACE_METADATA_SQL = `SELECT t.trace_uuid, header, tail_segment_uuid, inherited_count,
  base_seq + COALESCE((SELECT seq + 1 FROM events WHERE segment_uuid = s.segment_uuid ORDER BY seq DESC LIMIT 1), 0) AS event_count
  FROM traces t LEFT JOIN segments s ON s.segment_uuid = t.tail_segment_uuid`
const segmentFields = { segment_uuid: z.string().transform(segmentId), event_count: z.number().int().nonnegative() }
const segmentRow = z.union([
  z.object({ ...segmentFields, parent_segment_uuid: z.null(), parent_end_seq: z.null(), base_seq: z.literal(0) }),
  z.object({ ...segmentFields, parent_segment_uuid: z.string().transform(segmentId),
    parent_end_seq: z.number().int().nonnegative(), base_seq: z.number().int().nonnegative() }),
])
type Metadata = z.infer<typeof metadata>
type Segment = z.infer<typeof segmentRow>

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
export interface SqliteLogsOptions {
  /** Absolute database path. */
  readonly path: string
  /** Resolved JSONL root holding the per-Session write-lock directories and `.segments` routing records. */
  readonly legacyRoot: string
  /** SQLite writer wait in milliseconds. */
  readonly busyTimeoutMs?: number
  /** Maximum intentional live write delay in milliseconds. */
  readonly flushDelayMs?: number
  /** Admitted live event count that starts a write before the delay elapses. */
  readonly maxBufferedEvents?: number
  /** Publish a Session's routing record after its first commit. */
  readonly publish: (id: SessionId) => Promise<void>
  /** Claim a new Session across the provider's physical backends. */
  readonly acquireCreationLease: (header: SessionHeader) => Promise<{ release(): Promise<void> }>
  /** Report a background live-write failure; the Session's next durability barrier retries and rejects. */
  readonly report: (id: SessionId, error: unknown) => void
}

/** Trace persistence over private predecessor-linked Segments in one SQLite database. */
export class SqliteLogs {
  /** Absolute database path, recorded in routing records. */
  readonly path: string
  /** Maximum intentional live write delay in milliseconds. */
  readonly flushDelayMs: number
  /** Admitted live event count that starts a write before the delay elapses. */
  readonly maxBufferedEvents: number
  private readonly busyTimeoutMs: number
  private readonly legacyRoot: string
  private readonly published: (id: SessionId) => Promise<void>
  private readonly acquireCreationLease: SqliteLogsOptions['acquireCreationLease']
  private readonly report: (id: SessionId, error: unknown) => void
  private readonly pendingCreates = new Map<SessionId, {
    header: SessionHeader
    inheritedCount: number
    head: SegmentId
    fork?: { sourceId: SessionId; endSeq: number; writeFrom: number }
  }>()
  private readonly creating = new Set<SessionId>()
  private readonly directorySyncs = new Set<string>()
  private ready: Promise<DatabaseSync> | undefined
  private closing: Promise<void> | undefined
  private failure: Error | undefined
  private readonly chains = new Map<SessionId, { head: SegmentId; nodes: Map<SegmentId, Segment> }>()
  private readonly handles = new Set<SqliteTrace>()
  private readonly writers = new Map<SessionId, SqliteTrace>()
  constructor(options: SqliteLogsOptions) {
    this.path = options.path
    this.legacyRoot = options.legacyRoot
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5000
    this.flushDelayMs = options.flushDelayMs ?? 200
    this.maxBufferedEvents = options.maxBufferedEvents ?? 256
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

  private async assertNewDatabase(): Promise<void> {
    let records: string[]
    try { records = await readdir(join(this.legacyRoot, '.segments')) }
    catch (error: unknown) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    if (!records.some(record => record.endsWith('.json'))) return
    // Another initializer may have created the database while routing records were read.
    try { await stat(this.path) }
    catch (error: unknown) {
      if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
      throw new HarnessError('The Segment database is missing but routing records remain; restore the database before writing', 'SESSION_STORAGE_MISSING')
    }
  }

  private async initialize(): Promise<DatabaseSync> {
    try { await stat(this.path) }
    catch (error: unknown) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') await this.assertNewDatabase()
      else throw error
    }
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
      const opened = new DatabaseSync(this.path, { timeout: this.busyTimeoutMs })
      db = opened
      // Readers can acquire a snapshot as soon as schema creation commits.
      opened.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
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
    CREATE TABLE events (
      segment_uuid TEXT NOT NULL REFERENCES segments(segment_uuid), seq INTEGER NOT NULL CHECK(seq >= 0),
      payload TEXT NOT NULL, PRIMARY KEY(segment_uuid, seq)
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
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

  private row(db: DatabaseSync, id: SessionId) {
    this.assertHealthy()
    const raw = db.prepare(`${TRACE_METADATA_SQL} WHERE t.trace_uuid = ?`).get(id)
    if (raw === undefined) return undefined
    return this.parseMetadata(raw, id)
  }

  private parseMetadata(raw: unknown, id: SessionId): Metadata {
    try { return metadata.parse(raw) }
    catch (error: unknown) { throw this.corruption(`session "${id}": stored SQLite trace metadata is invalid`, error) }
  }

  private segment(db: DatabaseSync, id: SegmentId): Segment {
    const row = db.prepare('SELECT s.*, COALESCE((SELECT seq + 1 FROM events WHERE segment_uuid = s.segment_uuid ORDER BY seq DESC LIMIT 1), 0) AS event_count FROM segments s WHERE segment_uuid = ?').get(id)
    if (row === undefined) throw new HarnessError('Trace references a missing segment', 'SESSION_STORAGE_CORRUPT')
    try { return segmentRow.parse(row) }
    catch (error: unknown) { throw this.corruption(`stored SQLite segment "${id}" metadata is invalid`, error) }
  }

  /** Fetch indexed ancestor metadata together, retaining the authoritative chain checks during reads. */
  private parents(db: DatabaseSync, id: SegmentId, offset: number, nodes: Map<SegmentId, Segment>): void {
    const rows = db.prepare(`SELECT s.*, COALESCE((SELECT seq + 1 FROM events WHERE segment_uuid = s.segment_uuid
      ORDER BY seq DESC LIMIT 1), 0) AS event_count FROM segment_ancestors a
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
    db.prepare('INSERT INTO segments VALUES (?, ?, ?, ?)').run(id, parent?.segment_uuid ?? null, parent === undefined ? null : end, base)
  }

  /** Locate the Segment holding the first `end` source events; `end` never exceeds the source event count. */
  private cut(db: DatabaseSync, source: Metadata, end: number): { parent?: Segment; end: number } {
    if (end === 0) return { end: 0 }
    const visited = new Set<SegmentId>()
    let current = this.segment(db, source.tail_segment_uuid), visible = source.event_count - current.base_seq
    for (;;) {
      if (visited.has(current.segment_uuid) || visible < 0 || visible > current.event_count) {
        throw new HarnessError('Invalid Trace segment chain', 'SESSION_STORAGE_CORRUPT')
      }
      visited.add(current.segment_uuid)
      if (current.parent_segment_uuid === null || end >= current.base_seq) return { parent: current, end: end - current.base_seq }
      const child = current
      current = this.segment(db, child.parent_segment_uuid)
      visible = child.parent_end_seq
      if (current.base_seq + visible !== child.base_seq) throw new HarnessError('Invalid segment offset', 'SESSION_STORAGE_CORRUPT')
    }
  }

  /**
   * Reserve a pending Trace; its rows commit with the first append or flush.
   * @param header - loop-owned metadata.
   * @param options - optional cancellation and inherited count.
   * @param fork - source prefix recorded by the awaited fork waterfall; the child shares its durable rows.
   * @returns exclusive in-process write handle.
   */
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions,
    fork?: { sourceId: SessionId; endSeq: number }): Promise<SqliteTrace> {
    this.check()
    options?.signal?.throwIfAborted()
    const meta = { ...header }
    // Preserve the existing seeded/cut refusal before reserving a Session.
    materializeHeader(meta, options?.inheritedEventCount)
    const inheritedCount = options?.inheritedEventCount ?? 0
    if (this.creating.has(meta.id) || this.pendingCreates.has(meta.id) || this.writers.has(meta.id)) {
      throw new SessionAlreadyExistsError(meta.id)
    }
    this.creating.add(meta.id)
    try {
      if (await this.stat(meta.id) !== undefined) throw new SessionAlreadyExistsError(meta.id)
      if (!await this.exists()) await this.assertNewDatabase()
      this.check()
      options?.signal?.throwIfAborted()
      let pendingFork: { sourceId: SessionId; endSeq: number; writeFrom: number } | undefined
      if (fork !== undefined) {
        const source = this.row(await this.database(), fork.sourceId)
        if (source === undefined && !this.pendingCreates.has(fork.sourceId)) throw new SessionPersistenceNotFoundError(fork.sourceId)
        // Share only the durable source prefix within the requested cut.
        // The child seed writes any remaining events into its own tail.
        pendingFork = { ...fork, writeFrom: Math.min(fork.endSeq, source?.event_count ?? 0) }
      }
      this.pendingCreates.set(meta.id, {
        header: meta,
        inheritedCount,
        head: segmentId(randomUUID()),
        ...(pendingFork === undefined ? {} : { fork: pendingFork }),
      })
      return await this.admit(meta, 'write', inheritedCount, true)
    } catch (error: unknown) {
      this.pendingCreates.delete(meta.id)
      throw error
    } finally {
      this.creating.delete(meta.id)
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
    ownership?: { release(): Promise<void> }): Promise<SqliteTrace> {
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
    const payloads = batch.map((event) => {
      decodeEvent(event)
      return JSON.stringify(event)
    })
    const db = await this.database()
    this.check(); signal?.throwIfAborted()
    this.transaction(db, () => {
      if (this.row(db, header.id) !== undefined) throw new SessionAlreadyExistsError(header.id)
      const head = segmentId(randomUUID())
      db.prepare('INSERT INTO segments VALUES (?, NULL, NULL, 0)').run(head)
      db.prepare('INSERT INTO traces VALUES (?, ?, ?, ?)').run(header.id, JSON.stringify(storedHeader), head, inheritedCount)
      const insert = db.prepare('INSERT INTO events (segment_uuid, seq, payload) VALUES (?, ?, ?)')
      for (const [seq, payload] of payloads.entries()) insert.run(head, seq, payload)
    })
    try { await this.published(header.id) }
    catch (error: unknown) {
      throw new HarnessError('Legacy Session committed, but routing publication failed; reopen the Session',
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
    ownership?: { release(): Promise<void> }): Promise<SqliteTrace> {
    if (access === 'write' && this.writers.has(header.id)) throw new SessionAlreadyOwnedError(header.id)
    let lease = access === 'write' && !created
      ? ownership ?? await this.acquireWriteLease(header, false)
      : undefined
    try {
      this.check()
      const handle = new SqliteTrace(header, access, this, async () => {
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
      SessionLogOffset(inheritedCount), this.pendingCreates.get(header.id)?.fork?.endSeq,
      this.pendingCreates.get(header.id)?.fork?.writeFrom)
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
      const payloads: string[] = [], stop = offset + Math.min(length, Math.max(0, meta.event_count - offset))
      const select = db.prepare('SELECT payload FROM events WHERE segment_uuid = ? AND seq >= ? AND seq < ? ORDER BY seq')
      for (const { segment, end } of ranges.reverse()) {
        const start = Math.max(0, offset - segment.base_seq), finish = Math.min(end, stop - segment.base_seq)
        if (finish <= start) continue
        const rows = select.all(segment.segment_uuid, start, finish)
        if (rows.length !== finish - start) throw new HarnessError('SQLite segment is incomplete', 'SESSION_STORAGE_CORRUPT')
        for (const row of rows) {
          const payload = row['payload']
          if (typeof payload !== 'string') {
            throw this.corruption(`session "${header.id}": stored SQLite event payload is not text`,
              new TypeError('expected a SQLite TEXT payload'))
          }
          payloads.push(payload)
        }
      }
      return { payloads, inheritedCount: meta.inherited_count, complete: offset === 0 && stop === meta.event_count }
    }, 'DEFERRED')
    const parsed: SessionEvent[] = []
    const decoded = stored.payloads.map((payload, index) => {
      try {
        const event = decodeEvent(JSON.parse(payload))
        parsed.push(event)
        return event
      } catch (error: unknown) {
        if (error instanceof SessionFormatUnsupportedMigrationError) throw new SessionFormatUnsupportedError(error.message)
        throw this.corruption(`session "${header.id}": stored event at index ${offset + index} is invalid`, error)
      }
    })
    if (stored.complete) {
      try {
        restoreReleasedV4Artifact({ header: { ...header, delegationDepth: header.delegationDepth ?? 0 },
          inheritedEventCount: stored.inheritedCount, events: decoded }, KNOWN_SESSION_EVENT_TYPES)
      } catch (error: unknown) {
        if (error instanceof SessionFormatUnsupportedMigrationError) throw new SessionFormatUnsupportedError(error.message)
        throw this.corruption(`session "${header.id}": stored V4 relationships are invalid`, error)
      }
    }
    const events = validateStoredEvents(header, parsed, { kind: 'sqlite', path: this.path })
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
    const payloads = batch.map((event) => {
      decodeEvent(event)
      return JSON.stringify(event)
    })
    this.transaction(db, () => {
      const row = this.ensureRow(db, header)
      assertContiguous(header.id, batch, row.event_count)
      const tail = this.segment(db, row.tail_segment_uuid)
      const insert = db.prepare('INSERT INTO events (segment_uuid, seq, payload) VALUES (?, ?, ?)')
      for (const [index, payload] of payloads.entries()) insert.run(tail.segment_uuid, tail.event_count + index, payload)
    })
    this.pendingCreates.delete(header.id)
    try { await this.published(header.id) }
    catch (error: unknown) { throw new HarnessError('Events committed, but routing publication failed; close and reopen the Session', 'SESSION_STORAGE_PUBLICATION', { cause: error }) }
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
    if (pending.fork === undefined) db.prepare('INSERT INTO segments VALUES (?, NULL, NULL, 0)').run(head)
    else {
      const source = this.row(db, pending.fork.sourceId)
      if (source === undefined) {
        if (!this.pendingCreates.has(pending.fork.sourceId)) throw new SessionPersistenceNotFoundError(pending.fork.sourceId)
        db.prepare('INSERT INTO segments VALUES (?, NULL, NULL, 0)').run(head)
      } else {
        const cut = this.cut(db, source, pending.fork.writeFrom)
        this.newSegment(db, head, cut.parent, cut.end)
      }
    }
    const storedHeader = materializeHeader(header, SessionLogOffset(pending.inheritedCount))
    db.prepare('INSERT INTO traces VALUES (?, ?, ?, ?)').run(
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
    if (pending.fork !== undefined) throw new HarnessError('Fork creation requires its constructor seed before flush', 'SESSION_FORK_SEED_REQUIRED')
    const db = await this.database()
    this.transaction(db, () => { this.ensureRow(db, header) })
    this.pendingCreates.delete(header.id)
    try { await this.published(header.id) }
    catch (error: unknown) {
      throw new HarnessError('Session committed, but routing publication failed; close and reopen the Session',
        'SESSION_STORAGE_PUBLICATION', { cause: error })
    }
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

  private async exists(): Promise<boolean> {
    if (this.ready !== undefined) return true
    try { await stat(this.path); return true }
    catch (error: unknown) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
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
        for (const trace of db.prepare(`${TRACE_METADATA_SQL} ORDER BY t.trace_uuid`).all()) {
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
      if (failures.length > 0) throw new AggregateError(failures, 'SQLite disposal failed')
    })()
  }
}

/** One SessionHandle over a logical SQLite event stream. */
export class SqliteTrace implements SessionHandle {
  private closed = false
  private pending: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private failure: Error | undefined
  private primed: SessionEvent[] | undefined
  private readonly buffer: LiveWriteBuffer
  constructor(readonly header: SessionHeader, readonly access: SessionAccess,
    private readonly logs: SqliteLogs,
    private readonly release: () => Promise<void>, private readonly acquireLease: () => Promise<void>,
    private readonly checkStorage: () => void,
    readonly inheritedEventCount = SessionLogOffset(0),
    private initialForkCut?: number, private forkWriteFrom?: number) {
    this.buffer = new LiveWriteBuffer({
      delayMs: this.logs.flushDelayMs,
      maxEvents: this.logs.maxBufferedEvents,
      enqueue: operation => this.enqueue(operation),
      persist: batch => this.logs.append(this.header, batch),
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
      ? await this.logs.read(this.header, offset, length) : primed.slice(offset, offset + length)
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
      this.buffer.append(batch, (error) => { this.logs.reportFailure(this.id, error) })
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
    const forkCut = this.initialForkCut
    if (forkCut !== undefined) {
      assertContiguous(this.id, events, 0)
      const marker = events[forkCut]
      if (marker?.type !== 'session/end-seed' || marker.data.inherited !== true) {
        throw new HarnessError('Fork seed is missing its inherited-prefix marker', 'SESSION_FORK_SEED_REQUIRED')
      }
      /* v8 ignore start -- a fork seed is admitted before any live event by construction. */
      if (this.buffer.length > 0 || this.buffer.active) {
        throw new HarnessError('Fork seed cannot follow admitted live events', 'SESSION_FORK_SEED_REQUIRED')
      }
      /* v8 ignore stop */
    }
    /* v8 ignore next -- a fork handle always carries its durable write offset with the logical marker. */
    const writeFrom = this.forkWriteFrom ?? forkCut
    const batch = materializeAppendBatch(forkCut === undefined ? events : events.slice(writeFrom))
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
        await this.logs.append(this.header, batch)
        this.initialForkCut = undefined
        this.forkWriteFrom = undefined
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
      try { await this.logs.materialize(this.header) }
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
