/**
 * JSONL durable session-persistence backend. It stores a header and contiguous
 * events in one append-only file per session and serves the handle-based
 * `SessionPersistence` API: `create`/`open` return per-session handles, and
 * every read validates the same fail-closed storage contract.
 * @module @deepseek-ai/dsh-session-persistence-jsonl
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readdirSync } from 'node:fs'
import { open, mkdir, readFile, readdir, realpath, link, rm, stat, truncate } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'
import {
  SessionPersistence, SessionPersistenceRevision, SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  SessionAlreadyExistsError, SessionPersistenceNotFoundError,
  assertStoredId, assertVersion, materializeCreateHeader, validateStoredEvents,
  type SessionAccess, type SessionHandle,
  type SessionLocation, type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions, type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot, type SessionPersistenceStatOptions,
  type SessionPersistenceRevision as PersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import { JsonlBackendTracker, JsonlSessionHandle } from './storage.ts'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionHeader, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import {
  encodeSegment, eventLines, logPath, logSuffix, parseHeader, parseHeaderMeta, projectDir, scanLog, sessionDir,
  SessionLogScanner, toHeaderLine,
  type JsonlCompression,
} from './format.ts'
import {
  compressZstdFrame, createZstdFrameDecoder, decompressZstdFrame, decompressZstdPrefix, scanZstdFrames,
} from './zstd.ts'
import { ensureDurableDirectoryWin32, publishNewFileWin32 } from './win32.ts'

export type { JsonlCompression } from './format.ts'

/**
 * Internal handoff-reuse policy, not deployment configuration: a cold
 * observation and the resume that immediately follows it reuse one parsed
 * log, so the memo only needs the sessions in flight between those steps.
 */
const COLD_LOG_MEMO_MAX_ENTRIES = 2

const DEFAULT_PACK_CHUNKS = true
const DEFAULT_COMPRESSION: JsonlCompression = 'zstd'
/**
 * Internal scheduling constant, not deployment configuration: balance
 * frame-boundary event-loop yields against `setImmediate` overhead. One frame
 * remains an indivisible synchronous decode.
 */
const ZSTD_DECODE_YIELD_INTERVAL_MS = 500

/** Assert that the independently decodable first frame contains only the header record. */
function assertZstdHeaderFrame(plaintext: Buffer): void {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
}

/** Loader schema for the JSONL artifact's physical encoding. */
export const JsonlCompressionSchema: z<JsonlCompression> = z.union([
  z.const('zstd'),
  z.const('none'),
]).default(DEFAULT_COMPRESSION)

/** Plugin config: where the JSONL backend keeps its session logs, and the packed-row write switch. */
export interface Config {
  /**
   * Root directory for all session files. Required (no default): a default of
   * `process.cwd()` would scatter session files as the process's cwd changes
   * (bash calls, subprocesses). Sessions group under human-readable project
   * directories, then per-session directories. An existing root must be a
   * readable directory; an absent root is created on first materialization.
   */
  root: string
  /**
   * Write runs of consecutive `assistant/chunk` delta events as packed
   * `text-chunks`/`reasoning-chunks`/`tool-call-chunks` rows (lossless,
   * ~60% smaller logs measured on a real session). Defaults to true; false
   * keeps one `SessionEvent` per line for diagnostics. Reading packed rows is
   * unconditional: a log's layout never depends on this switch.
   */
  packChunks?: boolean
  /** Physical encoding; defaults to checksummed Zstandard frames. */
  compression?: JsonlCompression
}

/** A parsed, validated stored log: header, logical events, and any torn-tail repair state. */
interface StoredLog {
  readonly meta: SessionHeader
  /** The logical log, including any events recovered from a torn final frame. */
  readonly events: SessionEvent[]
  readonly tornTruncateTo: number | undefined
  /** Complete events recovered from the torn final frame; the write path rewrites them durably. */
  readonly recoveredTail: SessionEvent[]
  /** Exact fork-inherited prefix length stored in the header line. */
  readonly inheritedEventCount: SessionLogOffsetType
  readonly revision: PersistenceRevision
}

interface FileRevisionIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

/** Build the stat-derived best-effort change token shared by full and lightweight reads. */
function fileRevision(identity: FileRevisionIdentity): PersistenceRevision {
  return SessionPersistenceRevision([
    identity.dev,
    identity.ino,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
  ].join(':'))
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * The JSONL persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence`. Sessions materialize lazily: a created session is
 * visible to this process immediately, reaches disk on its first append or
 * flush, and never existed if the process crashes before that.
 */
class JsonlSessionPersistence extends SessionPersistence {
  static Config: z<Config> = z.object({
    root: z.string().required(),
    packChunks: z.boolean().default(DEFAULT_PACK_CHUNKS),
    compression: JsonlCompressionSchema,
  })

  /** Backend label for diagnostics and effects; shadows `Service.name` without changing the service key. */
  override readonly name = 'session-persistence-jsonl'

  private root: string
  private packChunks: boolean
  private compression: JsonlCompression
  private rootEncodingCheck: Promise<void> | undefined
  private readonly tracker = new JsonlBackendTracker(this.name)
  /**
   * Bounded LRU of parsed, validated stored logs keyed by session id and
   * guarded by the stat-derived revision, so an immediate cold-read handoff
   * (observation then resume) parses the artifact once. Every local mutation
   * for an id invalidates its entry; a foreign write misses through the
   * revision guard.
   */
  private readonly coldLogMemo = new Map<SessionId, StoredLog>()

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Resolve once so later process.cwd() changes cannot split one backend across roots.
    this.root = resolve(config.root)
    this.packChunks = config.packChunks ?? DEFAULT_PACK_CHUNKS
    this.compression = config.compression ?? DEFAULT_COMPRESSION
    this.assertUsableRoot()
    this.tracker.install(ctx)
  }

  /**
   * Refusal-diagnostics hook: the absolute target path, without touching the filesystem.
   * @param meta - the stored header naming the session and its cwd.
   * @returns the artifact kind and absolute path.
   */
  private locate(meta: SessionHeader): SessionLocation {
    return { kind: 'jsonl', path: logPath(this.root, meta.cwd, meta.id, this.compression) }
  }

  // --- SessionPersistence service API ---

  /**
   * Create a new stored session and take its write ownership. The session is
   * visible to this process immediately; the physical artifact appears on the
   * first append or flush.
   * @param header - the immutable header to store; must be losslessly
   *   JSON-serializable with a non-negative safe-integer `createdAt`.
   * @param options - optional cancellation.
   * @returns the owned write handle.
   */
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    // Fail fast on a seeded/cut mismatch with the exact refusal the header
    // line encoder enforces at materialization.
    toHeaderLine(snapshot, options?.inheritedEventCount)
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0)
    await this.ensureRootEncoding()
    options?.signal?.throwIfAborted()
    if (this.tracker.hasPending(snapshot.id) || await this.findLog(snapshot.id, options?.signal) !== undefined) {
      throw new SessionAlreadyExistsError(snapshot.id)
    }
    options?.signal?.throwIfAborted()
    this.tracker.registerCreated(snapshot, inheritedEventCount)
    return this.tracker.adopt(new JsonlSessionHandle(this, snapshot.id, snapshot, 'write', { cursor: 0, materialized: false, inheritedEventCount }))
  }

  /**
   * Open an existing stored session for `read` or single-writer `write`.
   * @param id - the stored session to open.
   * @param access - `read` (no ownership) or `write` (atomic in-process claim).
   * @param options - optional cancellation.
   * @returns the open handle.
   */
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    await this.ensureRootEncoding()
    options?.signal?.throwIfAborted()
    const pending = this.tracker.pendingOf(id)
    if (access === 'read') {
      if (pending !== undefined) {
        return this.tracker.adopt(new JsonlSessionHandle(this, id, pending.header, 'read', { cursor: 0, materialized: false, inheritedEventCount: pending.inheritedEventCount }))
      }
      // Header-only existence and identity check: reads scan the log on demand.
      const snapshot = await this.stat(id, options)
      if (snapshot === undefined) {
        // stat() reports an artifact whose header it cannot parse as absent so
        // listing can skip foreign junk, but a physically present log must
        // refuse loudly here — a newer-format log's user must see "upgrade the
        // harness", never "not found".
        const stored = await this.requireStoredLog(id, options?.signal)
        // The full read succeeded after the header-only read failed (a writer
        // completed the header in between): serve the session.
        return this.tracker.adopt(new JsonlSessionHandle(this, id, stored.meta, 'read', { cursor: 0, materialized: true, inheritedEventCount: stored.inheritedEventCount }))
      }
      // A stored foreign format version is refused at open, matching the
      // refusal every read of this handle would produce.
      assertVersion(snapshot.header, this.locate(snapshot.header))
      return this.tracker.adopt(new JsonlSessionHandle(this, id, snapshot.header, 'read', { cursor: 0, materialized: true, inheritedEventCount: snapshot.inheritedEventCount }))
    }
    // A pending entry always belongs to an ACTIVE creator handle (close erases
    // it), so the claim below rejects that case as already owned.
    this.tracker.claimWrite(id)
    try {
      const stored = await this.requireStoredLog(id, options?.signal)
      return this.tracker.adopt(new JsonlSessionHandle(this, id, stored.meta, 'write', {
        cursor: stored.events.length,
        materialized: true,
        tornTruncateTo: stored.tornTruncateTo,
        recoveredTail: stored.recoveredTail,
        inheritedEventCount: stored.inheritedEventCount,
        primed: stored.events,
      }))
    } catch (error) {
      this.tracker.releaseClaim(id)
      throw error
    }
  }

  /**
   * Flush every active write handle in one durability barrier; see the seam
   * contract.
   * @returns resolution once every write handle active at the call has flushed.
   */
  flush(): Promise<void> {
    return this.tracker.flushAll()
  }

  /**
   * Observe one stored session without reading its event log.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot (`sizeBytes` carries the physical artifact size), or
   *   `undefined` when the session does not exist.
   */
  async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<(SessionPersistenceSnapshot & { inheritedEventCount: SessionLogOffsetType }) | undefined> {
    options?.signal?.throwIfAborted()
    await this.ensureRootEncoding()
    options?.signal?.throwIfAborted()
    const pending = this.tracker.pendingOf(id)
    if (pending !== undefined) {
      return { header: pending.header, revision: pending.revision, inheritedEventCount: pending.inheritedEventCount }
    }
    const path = await this.findLog(id, options?.signal)
    if (path === undefined) return undefined
    let first: string | undefined
    try {
      first = this.compression === 'zstd'
        ? await this.readFirstZstdLine(path, options?.signal)
        : await this.readFirstLine(path, options?.signal)
    } catch (error: unknown) {
      options?.signal?.throwIfAborted()
      // The artifact vanished between discovery and the header read: absent.
      if (isENOENT(error)) return undefined
      throw error
    }
    options?.signal?.throwIfAborted()
    if (first === undefined) return undefined // empty/half-written file
    let stored
    try {
      stored = parseHeader(first)
    } catch (error: unknown) {
      // A foreign-version refusal from the raw header line names the artifact
      // it refused, matching the refusal a full read would produce.
      if (error instanceof SessionFormatUnsupportedError) {
        throw new SessionFormatUnsupportedError(`${error.message} (raw log: ${path})`, { kind: 'jsonl', path })
      }
      throw error
    }
    if (stored === undefined) return undefined
    const meta = stored.meta
    await this.assertStoredIdentity(path, meta, id, options?.signal)
    try {
      const identity = await stat(path, { bigint: true })
      options?.signal?.throwIfAborted()
      return {
        header: meta,
        revision: fileRevision(identity),
        sizeBytes: Number(identity.size),
        inheritedEventCount: stored.inheritedEventCount,
      }
    } catch (error: unknown) {
      options?.signal?.throwIfAborted()
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  /**
   * List every stored session visible to this process: materialized artifacts
   * plus this process's created-but-unmaterialized sessions.
   * @param options - optional cancellation.
   * @returns one snapshot per session, in no promised order.
   */
  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    const signal = options?.signal
    const snapshots: SessionPersistenceSnapshot[] = []
    const listed = new Set<SessionId>()
    // Snapshot pending entries BEFORE scanning storage: a session whose first
    // append lands mid-scan is then still in this snapshot (its artifact may
    // predate the scan), so create-to-list visibility never has a hole.
    const pending = [...this.tracker.pendingEntries()]
    for (const artifact of await this.listArtifacts(signal)) {
      signal?.throwIfAborted()
      try {
        const identity = await stat(artifact.path, { bigint: true })
        signal?.throwIfAborted()
        listed.add(artifact.header.id)
        snapshots.push({
          header: artifact.header,
          revision: fileRevision(identity),
          sizeBytes: Number(identity.size),
        })
      } catch (error: unknown) {
        signal?.throwIfAborted()
        if (!isENOENT(error)) throw error
      }
    }
    for (const [id, entry] of pending) {
      if (!listed.has(id)) snapshots.push({ header: entry.header, revision: entry.revision })
    }
    signal?.throwIfAborted()
    return snapshots
  }

  // --- handle-facing storage internals (package-private via the handle class below) ---

  /** Resolve and read one stored log, refusing loudly when the artifact is absent. */
  private async requireStoredLog(id: SessionId, signal?: AbortSignal): Promise<StoredLog> {
    const path = await this.findLog(id, signal)
    if (path === undefined) throw new SessionPersistenceNotFoundError(id)
    return this.readStoredLog(path, id, signal)
  }

  /**
   * Read, parse, and validate one stored log as the current logical prefix.
   * @param path - the artifact file to read.
   * @param expectedId - the session identity the artifact must carry.
   * @param signal - optional cancellation for the stat/read/decode work.
   * @returns the validated stored log with any torn-tail truncation point.
   */
  async readStoredLog(path: string, expectedId: SessionId, signal?: AbortSignal): Promise<StoredLog> {
    signal?.throwIfAborted()
    const probe = fileRevision(await stat(path, { bigint: true }))
    const memoized = this.coldLogMemo.get(expectedId)
    if (memoized !== undefined && memoized.revision === probe) {
      this.coldLogMemo.delete(expectedId)
      this.coldLogMemo.set(expectedId, memoized)
      return memoized
    }
    const { buffer, revision } = await this.readStableFile(path, signal)
    let parsed: {
      meta: SessionHeader
      inheritedEventCount: SessionLogOffsetType
      events: SessionEvent[]
      tornTruncateTo: number | undefined
      recoveredTail: SessionEvent[]
    }
    try {
      if (this.compression === 'zstd') {
        parsed = await this.readZstdPrefix(buffer, signal)
      } else {
        signal?.throwIfAborted()
        const { meta, inheritedEventCount, events, committedBytes } = scanLog(buffer)
        signal?.throwIfAborted()
        parsed = {
          meta,
          inheritedEventCount,
          events,
          tornTruncateTo: committedBytes < buffer.byteLength ? committedBytes : undefined,
          // A torn raw tail is one incomplete JSONL line; it holds no complete
          // record to recover.
          recoveredTail: [],
        }
      }
    } catch (error: unknown) {
      signal?.throwIfAborted()
      // A parse-time format refusal predates any SessionHeader, so attach the
      // artifact this read actually refused; every other parse failure is
      // committed bytes the decoder cannot interpret — damage, classified for
      // the seam's stable error vocabulary.
      if (error instanceof SessionFormatUnsupportedError) {
        throw new SessionFormatUnsupportedError(`${error.message} (raw log: ${path})`, { kind: 'jsonl', path })
      }
      throw new SessionPersistenceCorruptionError(`session "${expectedId}": stored log is corrupt: ${String(error)} (raw log: ${path})`, { cause: error })
    }
    signal?.throwIfAborted()
    await this.assertStoredIdentity(path, parsed.meta, expectedId, signal)
    signal?.throwIfAborted()
    assertStoredId(expectedId, parsed.meta)
    const location = this.locate(parsed.meta)
    assertVersion(parsed.meta, location)
    validateStoredEvents(parsed.meta, parsed.events, location)
    const stored: StoredLog = { ...parsed, revision }
    this.coldLogMemo.delete(expectedId)
    this.coldLogMemo.set(expectedId, stored)
    for (const oldest of this.coldLogMemo.keys()) {
      if (this.coldLogMemo.size <= COLD_LOG_MEMO_MAX_ENTRIES) break
      this.coldLogMemo.delete(oldest)
    }
    return stored
  }

  /**
   * Resolve a session's unique log path.
   * @param id - the stored session to locate.
   * @param signal - optional cancellation for the directory scans.
   * @returns the artifact path, or `undefined` when absent.
   */
  async resolveLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined> {
    await this.ensureRootEncoding()
    signal?.throwIfAborted()
    return this.findLog(id, signal)
  }

  /**
   * Durably append one validated batch; lazily materializes on the first write.
   * @param header - the session's stored header.
   * @param events - the validated contiguous batch, in seq order.
   * @param isMaterialized - whether the session already has a durable artifact.
   * @param inheritedEventCount - the exact fork-inherited prefix length written into a materializing header line.
   */
  async persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffsetType,
  ): Promise<void> {
    this.coldLogMemo.delete(header.id)
    await this.ensureRootEncoding()
    if (isMaterialized) {
      await this.appendLines(header, events)
    } else {
      await this.materialize(header, inheritedEventCount, events)
      this.tracker.materialized(header.id)
    }
  }

  /**
   * Materialize a header-only artifact for an explicitly durable empty session.
   * @param header - the session's stored header.
   * @param inheritedEventCount - the exact fork-inherited prefix length written into the header line.
   */
  async persistHeader(header: SessionHeader, inheritedEventCount: SessionLogOffsetType): Promise<void> {
    this.coldLogMemo.delete(header.id)
    await this.ensureRootEncoding()
    await this.materialize(header, inheritedEventCount, [])
    this.tracker.materialized(header.id)
  }

  /**
   * Truncate a torn physical tail durably before this session's first new append.
   * @param header - the session's stored header.
   * @param truncateTo - the byte offset the artifact is truncated to.
   */
  async truncateTornTail(header: SessionHeader, truncateTo: number): Promise<void> {
    this.coldLogMemo.delete(header.id)
    await this.repair(header, truncateTo)
    this.ctx.logger.warn(`${this.name}: session "${header.id}" recovered from a torn tail; incomplete tail bytes were discarded`)
  }

  /**
   * Whether this process still tracks a created-but-unmaterialized session.
   * @param id - the session to test.
   * @returns true while the pending entry exists.
   */
  hasPendingSession(id: SessionId): boolean {
    return this.tracker.hasPending(id)
  }

  /**
   * Release one handle's backend bookkeeping on close.
   * @param handle - the closing handle.
   * @param materialized - whether the session reached durable storage.
   */
  releaseHandle(handle: JsonlSessionHandle, materialized: boolean): void {
    this.tracker.release(handle, materialized)
  }

  /**
   * Read a file's bytes with one bounded stability retry: a writer appending
   * between stat and readFile yields a torn read, so a changed revision
   * triggers exactly one re-read. A second change does not loop — the log is
   * append-only, so the bytes at the retry's own pre-read stat size are a
   * committed prefix, and the decoders treat anything past a torn cut as
   * unwritten. A continuous writer therefore delays a read by at most one
   * extra whole-file read instead of starving it.
   * @param path - the artifact file to read.
   * @param signal - optional cancellation for the stat/read work.
   * @returns the stable bytes (or the committed prefix) and their revision.
   */
  private async readStableFile(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ buffer: Buffer; revision: PersistenceRevision }> {
    signal?.throwIfAborted()
    let identity = await stat(path, { bigint: true })
    for (let attempt = 0; ; attempt += 1) {
      const before = fileRevision(identity)
      const buffer = await readFile(path, { signal })
      signal?.throwIfAborted()
      const after = await stat(path, { bigint: true })
      if (before === fileRevision(after)) return { buffer, revision: before }
      if (attempt === 1) {
        return { buffer: buffer.subarray(0, Number(identity.size)), revision: before }
      }
      identity = after
    }
  }

  /** Decode complete frames and retain complete JSONL records from a torn final frame. */
  private async readZstdPrefix(
    buffer: Buffer,
    signal?: AbortSignal,
  ): Promise<{
    meta: SessionHeader
    inheritedEventCount: SessionLogOffsetType
    events: SessionEvent[]
    tornTruncateTo: number | undefined
    recoveredTail: SessionEvent[]
  }> {
    signal?.throwIfAborted()
    const { frames, tornStart } = scanZstdFrames(buffer)
    signal?.throwIfAborted()
    if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')

    const decoder = createZstdFrameDecoder()
    let yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS
    try {
      const decodedFrames = decoder.decode(buffer, frames)
      signal?.throwIfAborted()
      const headerFrame = decodedFrames.next()
      signal?.throwIfAborted()
      /* v8 ignore next -- a non-empty structural frame list makes the decoder yield its first frame or throw. */
      if (headerFrame.done) throw new Error('empty or header-less Zstandard session log')
      assertZstdHeaderFrame(headerFrame.value)
      const scanner = new SessionLogScanner(headerFrame.value)

      let remainingFrames = frames.length - 1
      for (const plaintext of decodedFrames) {
        signal?.throwIfAborted()
        scanner.write(plaintext)
        remainingFrames -= 1
        if (remainingFrames > 0 && performance.now() >= yieldDeadline) {
          await scheduler.yield()
          signal?.throwIfAborted()
          yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS
        }
      }
      signal?.throwIfAborted()
      const complete = scanner.checkpoint()
      if (complete.committedBytes !== complete.inputBytes) {
        throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
      }
      if (tornStart === undefined) {
        const prefix = scanner.finish()
        return {
          meta: prefix.meta,
          inheritedEventCount: prefix.inheritedEventCount,
          events: prefix.events,
          tornTruncateTo: undefined,
          recoveredTail: [],
        }
      }
      // A torn final frame's append never resolved, but complete JSONL records
      // already flushed into it are real emitted events: recover them, and let
      // the write path truncate the torn bytes and rewrite them durably.
      let recoveredPlaintext: Buffer = Buffer.alloc(0)
      try {
        signal?.throwIfAborted()
        recoveredPlaintext = await decompressZstdPrefix(buffer.subarray(tornStart))
      } catch {
        /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
        if (signal?.aborted) signal.throwIfAborted()
        // A structurally incomplete final frame may end before Node's decoder
        // can emit any plaintext; the complete prior frames remain recoverable.
      }
      signal?.throwIfAborted()
      scanner.write(recoveredPlaintext)
      const prefix = scanner.finish()
      return {
        meta: prefix.meta,
        inheritedEventCount: prefix.inheritedEventCount,
        events: prefix.events,
        tornTruncateTo: tornStart,
        recoveredTail: prefix.events.slice(complete.eventCount),
      }
    } catch (error) {
      /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
      if (signal?.aborted) signal.throwIfAborted()
      throw error
    } finally {
      decoder.close()
    }
  }

  private async listArtifacts(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; path: string }>> {
    signal?.throwIfAborted()
    await this.ensureRootEncoding()
    signal?.throwIfAborted()
    const artifacts: Array<{ header: SessionHeader; path: string }> = []
    const ids = new Set<SessionId>()
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      for (const dir of await this.listSessionDirs(project, signal)) {
        signal?.throwIfAborted()
        const opposite = join(dir, `session${logSuffix(this.oppositeCompression())}`)
        const oppositeExists = await this.exists(opposite)
        signal?.throwIfAborted()
        if (oppositeExists) throw this.encodingMismatch(opposite)
        const path = join(dir, `session${logSuffix(this.compression)}`)
        const pathExists = await this.exists(path)
        signal?.throwIfAborted()
        if (!pathExists) continue
        // Read only headers so listing scales with session count, not log size.
        const first = this.compression === 'zstd'
          ? await this.readFirstZstdLine(path, signal)
          : await this.readFirstLine(path, signal)
        signal?.throwIfAborted()
        if (first === undefined) continue // empty/half-written file
        let meta: SessionHeader | undefined
        try {
          meta = parseHeaderMeta(first)
        } catch (error: unknown) {
          // Listing skips an unreadable (foreign-version) header instead of
          // failing the whole list; opening that id still refuses loudly.
          if (error instanceof SessionFormatUnsupportedError) continue
          throw error
        }
        if (meta === undefined) continue // not a session header
        await this.assertStoredIdentity(path, meta, undefined, signal)
        signal?.throwIfAborted()
        if (ids.has(meta.id)) {
          throw new Error(`duplicate JSONL session id "${meta.id}" appears in multiple project directories`)
        }
        ids.add(meta.id)
        artifacts.push({ header: meta, path })
      }
    }
    signal?.throwIfAborted()
    return artifacts
  }

  // --- materialization / append / repair (file mechanics) ---

  /** Atomically write the header line + first batch (temp-write, fsync, publish). */
  private async materialize(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffsetType,
    events: readonly SessionEvent[],
  ): Promise<void> {
    const project = projectDir(this.root, meta.cwd)
    const dir = sessionDir(this.root, meta.cwd, meta.id)
    const finalPath = logPath(this.root, meta.cwd, meta.id, this.compression)
    await this.rejectOppositeArtifact(meta.cwd, meta.id)
    const content = await this.encodeMaterialization(meta, inheritedEventCount, events)
    /* v8 ignore next -- native Windows coverage exercises this platform dispatch; Linux covers the POSIX peer */
    if (process.platform === 'win32') {
      await this.materializeWin32(project, dir, finalPath, meta.id, content)
    } else {
      await this.materializePosix(project, dir, finalPath, meta.id, content)
    }
  }

  /* v8 ignore start -- Windows uses the Win32 durable-publish path; POSIX coverage exercises this peer. */
  private async materializePosix(
    project: string,
    dir: string,
    finalPath: string,
    id: SessionId,
    content: Buffer | string,
  ): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(dirname(this.root))
    await mkdir(project, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(this.root)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(project)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    // Publish via link()+unlink(), NOT rename(): link fails with EEXIST if the
    // final path already exists, so two processes materializing the same id
    // concurrently cannot clobber each other. rename() would silently overwrite.
    let linked = false
    try {
      await link(tmp, finalPath)
      linked = true
    } finally {
      // Remove an unpublished temp on failure. After publication, defer cleanup
      // until the directory entry is durable so cleanup cannot reject a live log.
      /* v8 ignore next -- link failure is the TOCTOU/IO race guarded above; not reachable in test */
      if (!linked) await rm(tmp, { force: true })
    }
    // link() succeeded — the log is published. fsync the directory so the new
    // entry survives a power loss: the new link is not crash-durable until the
    // parent directory's metadata is synced.
    await this.syncDirPosix(dir)
    // Best-effort temp cleanup: the log is already published and durable, so a
    // failure to remove the redundant temp hard link must NOT reject the
    // append. Swallow only the rm failure; nothing else of consequence runs here.
    try {
      await rm(tmp, { force: true })
    } catch {
      /* v8 ignore next -- redundant temp link; publish already durable, rm failure is an unreachable IO edge */
    }
  }
  /* v8 ignore stop */

  /* v8 ignore start -- native Windows coverage exercises this integration path */
  private async materializeWin32(
    project: string,
    dir: string,
    finalPath: string,
    id: SessionId,
    content: Buffer | string,
  ): Promise<void> {
    await ensureDurableDirectoryWin32(this.root)
    await ensureDurableDirectoryWin32(project)
    await ensureDurableDirectoryWin32(dir)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    try {
      await publishNewFileWin32(tmp, finalPath)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }
  /* v8 ignore stop */

  private async rejectExistingLog(finalPath: string, id: SessionId): Promise<void> {
    // Never publish over an existing committed log: materialize is the first
    // write of a session the backend believes is new. A file here means a
    // different session shares this id on disk — reject loudly. (create already
    // guards the create path, so this is unreachable-in-practice TOCTOU
    // defense.)
    /* v8 ignore next 3 -- create guards collisions before materialize; this is a TOCTOU backstop */
    if (await this.exists(finalPath)) {
      throw new Error(`refusing to materialize "${id}": a log already exists on disk (open it instead)`)
    }
  }

  private async writeSyncedTempFile(finalPath: string, content: Buffer | string): Promise<string> {
    const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return tmp
  }

  /** Encode the header and first batch without combining their frame boundaries. */
  private async encodeMaterialization(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffsetType,
    events: readonly SessionEvent[],
  ): Promise<Buffer | string> {
    const header = JSON.stringify(toHeaderLine(meta, meta.isSeeded ? inheritedEventCount : undefined)) + '\n'
    if (events.length === 0) {
      return this.compression === 'none' ? header : compressZstdFrame(header)
    }
    const body = eventLines(events, this.packChunks) + '\n'
    if (this.compression === 'none') return header + body
    const headerFrame = await compressZstdFrame(header)
    const eventFrame = await compressZstdFrame(body)
    return Buffer.concat([headerFrame, eventFrame])
  }

  /** Encode one durable append batch in the configured physical representation. */
  private async encodeEventBatch(events: readonly SessionEvent[]): Promise<Buffer | string> {
    const body = eventLines(events, this.packChunks) + '\n'
    return this.compression === 'zstd' ? compressZstdFrame(body) : body
  }

  /** fsync a POSIX directory so a just-created/renamed entry is crash-durable. */
  /* v8 ignore start -- Windows uses write-through namespace operations; POSIX coverage exercises directory fsync. */
  private async syncDirPosix(dir: string): Promise<void> {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  /* v8 ignore stop */

  /**
   * Append and fsync event lines. On a partial write or sync failure, restore the
   * previous size before rethrowing because the unchanged cursor will retry the
   * batch; leaving partial bytes would create duplicate sequence numbers.
   */
  private async appendLines(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const content = await this.encodeEventBatch(events)
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    const handle = await open(path, 'a')
    let closed = false
    const closeAppendHandle = async (): Promise<void> => {
      if (closed) return
      closed = true
      await handle.close()
    }

    try {
      const { size: before } = await handle.stat()
      try {
        await handle.writeFile(content)
        await handle.sync()
      } catch (error) {
        try {
          await closeAppendHandle()
          await this.rollbackAppend(path, before)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to roll back append to "${path}"`)
        }
        throw error
      }
    } finally {
      await closeAppendHandle()
    }
  }

  private async rollbackAppend(path: string, size: number): Promise<void> {
    const handle = await open(path, 'r+')
    try {
      await handle.truncate(size)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /** Truncate the log file to `offset` bytes and fsync (discard the crash tail). */
  private async repair(meta: SessionHeader, offset: number): Promise<void> {
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    await truncate(path, offset)
    const handle = await open(path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  // --- discovery helpers ---

  /**
   * Read the first newline-terminated line of a file without loading the whole
   * file. Returns undefined if the file is empty or has no complete first line.
   * Reads in bounded chunks so a huge log costs only the header read.
   */
  private async readFirstLine(path: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const handle = await open(path, 'r')
    try {
      signal?.throwIfAborted()
      const chunks: Buffer[] = []
      const buf = Buffer.alloc(8192)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buf, 0, buf.length, null)
        signal?.throwIfAborted()
        if (bytesRead === 0) return undefined // EOF with no newline → no complete line
        const slice = buf.subarray(0, bytesRead)
        const nl = slice.indexOf(0x0a)
        if (nl !== -1) {
          chunks.push(slice.subarray(0, nl))
          signal?.throwIfAborted()
          return Buffer.concat(chunks).toString('utf8')
        }
        chunks.push(Buffer.from(slice))
      }
    } finally {
      await handle.close()
    }
  }

  /** Read and validate only the independently compressed header frame. */
  private async readFirstZstdLine(path: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const handle = await open(path, 'r')
    try {
      signal?.throwIfAborted()
      let content = Buffer.alloc(0)
      const chunk = Buffer.alloc(8192)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        signal?.throwIfAborted()
        if (bytesRead === 0) return undefined
        signal?.throwIfAborted()
        content = Buffer.concat([content, chunk.subarray(0, bytesRead)])
        signal?.throwIfAborted()
        const first = scanZstdFrames(content, 1).frames[0]
        signal?.throwIfAborted()
        if (first === undefined) continue
        let plaintext: Buffer
        try {
          signal?.throwIfAborted()
          plaintext = await decompressZstdFrame(content.subarray(first.start, first.end))
        } catch (error) {
          /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
          if (signal?.aborted) signal.throwIfAborted()
          throw new Error('corrupt Zstandard session log: header frame failed validation', { cause: error })
        }
        signal?.throwIfAborted()
        assertZstdHeaderFrame(plaintext)
        return plaintext.subarray(0, -1).toString('utf8')
      }
    } finally {
      await handle.close()
    }
  }

  /** Find the unique physical log for an id across every project directory. */
  private async findLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined> {
    const matches: string[] = []
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      await this.rejectLegacyFlatArtifact(project, id, signal)
      signal?.throwIfAborted()
      const dir = join(project, encodeSegment(id))
      const path = join(dir, `session${logSuffix(this.compression)}`)
      const opposite = join(dir, `session${logSuffix(this.oppositeCompression())}`)
      const oppositeExists = await this.exists(opposite)
      signal?.throwIfAborted()
      if (oppositeExists) throw this.encodingMismatch(opposite)
      const pathExists = await this.exists(path)
      signal?.throwIfAborted()
      if (pathExists) matches.push(path)
    }
    if (matches.length > 1) {
      throw new Error(`duplicate JSONL session id "${id}" appears in multiple project directories`)
    }
    signal?.throwIfAborted()
    return matches[0]
  }

  /** Require an existing configured root to be a readable directory. */
  private assertUsableRoot(): void {
    try {
      readdirSync(this.root)
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }

  /** Reject metadata that does not identify the selected physical log. */
  private async assertStoredIdentity(
    path: string,
    meta: SessionHeader,
    expectedId?: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (expectedId !== undefined && meta.id !== expectedId) {
      throw new Error(`corrupt session log "${path}": requested id "${expectedId}" does not match header id "${meta.id}"`)
    }
    let expectedPath: string
    try {
      expectedPath = logPath(this.root, meta.cwd, meta.id, this.compression)
    } catch (error) {
      throw new Error(`corrupt session log "${path}": header id cannot name a storage path`, { cause: error })
    }
    if (path !== expectedPath && !await this.sameFile(path, expectedPath, signal)) {
      throw new Error(`corrupt session log "${path}": header id "${meta.id}" and cwd identify "${expectedPath}"`)
    }
    signal?.throwIfAborted()
  }

  /**
   * Whether two path spellings resolve to the same physical file. This admits
   * case aliases on case-insensitive filesystems without weakening identity
   * checks on case-sensitive stores.
   */
  private async sameFile(path: string, expectedPath: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    try {
      const [actual, expected] = await Promise.all([realpath(path), realpath(expectedPath)])
      signal?.throwIfAborted()
      return actual === expected
    } catch (error) {
      signal?.throwIfAborted()
      /* v8 ignore else -- non-ENOENT realpath failures require an external permission or I/O fault */
      if (isENOENT(error)) return false
      /* v8 ignore next -- non-ENOENT realpath failures are external I/O faults, propagated unchanged */
      throw error
    }
  }

  /** The human-readable project directories under the configured root. */
  private async listProjectDirs(signal?: AbortSignal): Promise<string[]> {
    try {
      signal?.throwIfAborted()
      const entries = await readdir(this.root, { withFileTypes: true })
      signal?.throwIfAborted()
      return entries.filter(e => e.isDirectory()).map(e => join(this.root, e.name))
    } catch (error) {
      // Only an absent root means no sessions; rethrow every other I/O failure.
      if (isENOENT(error)) return []
      throw error
    }
  }

  /** List session-owned directories and reject the obsolete flat-file layout. */
  private async listSessionDirs(project: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    const entries = await readdir(project, { withFileTypes: true })
    signal?.throwIfAborted()
    const legacy = entries.find(entry =>
      entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')))
    if (legacy !== undefined) throw this.legacyLayout(join(project, legacy.name))
    return entries.filter(entry => entry.isDirectory()).map(entry => join(project, entry.name))
  }

  /** Reject a root that already belongs to the other physical encoding. */
  private ensureRootEncoding(): Promise<void> {
    this.rootEncodingCheck ??= this.checkRootEncoding()
    return this.rootEncodingCheck
  }

  private async checkRootEncoding(): Promise<void> {
    for (const project of await this.listProjectDirs()) {
      for (const dir of await this.listSessionDirs(project)) {
        const incompatible = join(dir, `session${logSuffix(this.oppositeCompression())}`)
        if (await this.exists(incompatible)) throw this.encodingMismatch(incompatible)
      }
    }
  }

  private async rejectLegacyFlatArtifact(
    project: string,
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const encoded = encodeSegment(id)
    for (const compression of ['zstd', 'none'] as const) {
      const path = join(project, encoded + logSuffix(compression))
      const artifactExists = await this.exists(path)
      signal?.throwIfAborted()
      if (artifactExists) throw this.legacyLayout(path)
    }
  }

  private async rejectOppositeArtifact(cwd: string | undefined, id: SessionId): Promise<void> {
    const path = logPath(this.root, cwd, id, this.oppositeCompression())
    if (await this.exists(path)) throw this.encodingMismatch(path)
  }

  private oppositeCompression(): JsonlCompression {
    return this.compression === 'zstd' ? 'none' : 'zstd'
  }

  private encodingMismatch(path: string): Error {
    return new Error(
      `session artifact ${JSON.stringify(path)} uses ${logSuffix(this.oppositeCompression())}, `
      + `but this backend is configured for compression ${JSON.stringify(this.compression)}; `
      + 'use a separate root or select the matching compression mode',
    )
  }

  private legacyLayout(path: string): Error {
    return new Error(
      `session artifact ${JSON.stringify(path)} uses the unsupported flat-file layout; `
      + 'use a separate root or move it into a project/session directory before loading',
    )
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const handle = await open(path, 'r')
      await handle.close()
      return true
    } catch (error) {
      // Only ENOENT means absent. A permission/I/O error must surface rather
      // than letting load or collision checks proceed under false absence.
      /* v8 ignore else -- Windows reports file-valued parents as ENOENT; POSIX covers direct ENOTDIR. */
      if (isENOENT(error)) {
        // Windows reports ENOENT, not ENOTDIR, for `regular-file/child`, so it
        // alone verifies the immediate parent to keep a blocked session
        // directory a storage fault. POSIX open already reported ENOTDIR before
        // this point, where the extra stat would only cost a syscall per probe.
        /* v8 ignore next -- native Windows coverage exercises this platform dispatch; POSIX reports ENOTDIR from open */
        if (process.platform === 'win32') await this.assertLogParentAllowsAbsence(path)
        return false
      }
      /* v8 ignore next -- Windows repairs ENOTDIR from ENOENT above; POSIX covers direct ENOTDIR. */
      throw error
    }
  }

  /* v8 ignore start -- native Windows coverage exercises this repair; POSIX open reports ENOTDIR before this point. */
  private async assertLogParentAllowsAbsence(path: string): Promise<void> {
    try {
      const parent = dirname(path)
      const info = await stat(parent)
      if (info.isDirectory()) return
      const error = new Error(`ENOTDIR: parent path exists but is not a directory: ${parent}`) as NodeJS.ErrnoException
      error.code = 'ENOTDIR'
      error.path = parent
      throw error
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }
  /* v8 ignore stop */
}

/**
 * One open channel onto a JSONL-stored session: the shared storage-handle
 * scaffolding over this backend's file primitives. Reads re-scan the artifact
 * under the stable-read loop.
 */

export default JsonlSessionPersistence
