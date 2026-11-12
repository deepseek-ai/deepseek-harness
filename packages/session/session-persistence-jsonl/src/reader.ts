/** Historical JSONL Session reader using the released format catalog. @module */
import type { Context } from '@deepseek-ai/cordis'
import {
  createSessionFormatCatalogWithChildren,
  SessionFormatUnsupportedMigrationError,
  sessionFormatCatalog,
} from '@deepseek-ai/dsh-session-format-catalog'
import { readdirSync, type Dirent } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import pLimit, { type LimitFunction } from 'p-limit'
import { createHash } from 'node:crypto'
import {
  SessionPersistenceRevision, SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  assertStoredId, sessionFormatVersionRefusal, validateStoredEvents,
  type SessionLocation,
  type SessionPersistenceListOptions,
  type SessionPersistenceSnapshot, type SessionPersistenceStatOptions,
  type SessionPersistenceRevision as PersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionHeader, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import {
  assertNoRetiredHeaderFields, encodeSegment, generationLogPath, logPath, logSuffix,
  parseGenerationLogFilename, scanLog, SessionLogScanner,
  type JsonlCompression,
} from './format.ts'
import {
  createZstdFrameDecoder, decompressZstdFrame, decompressZstdPrefix, scanZstdFrames,
} from './zstd.ts'
import { prepareCatalogFacts } from './catalog-migration.ts'
import {
  JsonlGenerationSourceChangedError,
  JsonlGenerationUnsupportedMigrationError,
  decodeJsonlSource,
  prepareJsonlSource,
  type PreparedJsonlSource,
  type JsonlPhysicalIdentity,
} from './generation.ts'

import { settleLimited, settledValues } from './listing.ts'
import type { Config } from './index.ts'
import type { JsonlBackend, LegacySessionSnapshot, PreparedLegacySession } from './trace/migration.ts'

/** Default maximum legacy filesystem reads in flight. */
export const DEFAULT_LIST_CONCURRENCY = 3

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

/** Logical header paired with the catalog's selected physical-generation classification. */
interface GenerationHeader {
  readonly header: SessionHeader
  readonly formatStatus: NonNullable<SessionPersistenceSnapshot['formatStatus']>
}

/** Cached header result at one physical file revision. */
interface ListedHeader {
  readonly revision: PersistenceRevision
  readonly metadata: GenerationHeader | undefined
}

/** Decoded logical history of one legacy artifact. */
interface StoredLogBase {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount: SessionLogOffsetType
}

/** A decoded current generation that is already durable. */
interface CurrentStoredLog extends StoredLogBase {
  readonly status: 'current'
}

/** One authoritative immutable generation selected from a Session directory. */
interface ResolvedJsonlGeneration {
  readonly sourcePath: string
  readonly sourceVersion: number
}

/** Build the stat-derived best-effort change token shared by full and lightweight reads. */
function fileRevision(identity: JsonlPhysicalIdentity): PersistenceRevision {
  return SessionPersistenceRevision([
    identity.dev,
    identity.ino,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
  ].join(':'))
}

/** Fingerprint every generation independently of listing order. */
function corpusDigest(revisions: ReadonlyArray<readonly [string, string]>): string {
  const hash = createHash('sha256')
  const byPath = new Map(revisions)
  for (const path of [...byPath.keys()].sort()) hash.update(JSON.stringify([path, byPath.get(path)]))
  return hash.digest('hex')
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Whether a filesystem-owned failure should retain its original errno and path. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof (error as NodeJS.ErrnoException | null)?.code === 'string'
}

/** Historical JSONL decoding and metadata; this reader never changes stored generations. */
export class JsonlReader implements JsonlBackend {
  readonly name = 'session-persistence-jsonl'

  private root: string
  private compression: JsonlCompression
  /**
   * Bounds directory, header, and stat I/O across every concurrent listing of
   * this backend (`list()`, the root encoding check, historical fingerprints).
   * Queued tasks of a cancelled listing run and reject at their signal check.
   */
  readonly listLimit: LimitFunction
  private rootEncodingCheck: Promise<void> | undefined
  private listedHeaders = new Map<string, ListedHeader>()
  constructor(private readonly ctx: Context, config: Config) {
    /* v8 ignore next 5 -- generated catalog and Session source share one build-time version owner. */
    if (sessionFormatCatalog.currentVersion !== SESSION_FORMAT_VERSION) {
      throw new Error(
        `session-persistence-jsonl: format catalog v${sessionFormatCatalog.currentVersion} `
        + `does not match Session v${SESSION_FORMAT_VERSION}`,
      )
    }
    // Resolve once so later process.cwd() changes cannot split one backend across roots.
    this.root = resolve(config.root)
    this.compression = config.compression ?? DEFAULT_COMPRESSION
    this.listLimit = pLimit(config.listConcurrency ?? DEFAULT_LIST_CONCURRENCY)
    this.assertUsableRoot()
  }

  /**
   * Refusal-diagnostics hook: the absolute target path, without touching the filesystem.
   * @param meta - the stored header naming the session and its cwd.
   * @returns the artifact kind and absolute path.
   */
  private locate(meta: SessionHeader): SessionLocation {
    return { kind: 'jsonl', path: logPath(this.root, meta.cwd, meta.id, this.compression) }
  }

  /**
   * Prepare the selected legacy prefix for a destination-owned commit.
   * @param id - stored Session identity.
   * @param signal - optional cancellation.
   * @returns current logical history and commit-time source revalidation.
   */
  async prepare(id: SessionId, signal?: AbortSignal): Promise<PreparedLegacySession> {
    await this.ensureRootEncoding()
    signal?.throwIfAborted()
    const prepared = await this.requireStoredLog(id, signal)
    return { ...prepared.artifact, commit: publish => prepared.commit(publish) }
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
  ): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    await this.ensureRootEncoding()
    options?.signal?.throwIfAborted()
    const selected = await this.findLog(id, options?.signal)
    if (selected === undefined) return undefined
    const metadata = await this.readGenerationHeader(selected, id, options?.signal)
    if (metadata === undefined) return undefined
    try {
      const identity = await stat(selected.sourcePath, { bigint: true })
      options?.signal?.throwIfAborted()
      return {
        ...metadata,
        revision: selected.sourceVersion < SESSION_FORMAT_VERSION
          ? SessionPersistenceRevision(`${fileRevision(identity)}:${await this.historicalCorpusRevision(options?.signal)}`)
          : fileRevision(identity),
        sizeBytes: Number(identity.size),
        location: { kind: 'jsonl', path: selected.sourcePath },
      }
    } catch (error: unknown) {
      options?.signal?.throwIfAborted()
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  /**
   * List the metadata of stored legacy artifacts without decoding their event logs.
   * @param options - optional cancellation.
   * @param excluded - identities already represented by SQLite metadata.
   * @returns one snapshot per session, in no promised order.
   */
  async list(options?: SessionPersistenceListOptions, excluded?: ReadonlySet<SessionId>): Promise<readonly SessionPersistenceSnapshot[]> {
    const signal = options?.signal
    const snapshots: SessionPersistenceSnapshot[] = []
    const { artifacts, revisions } = await this.listArtifacts(signal, excluded)
    const corpusRevision = artifacts.some(artifact => artifact.sourceVersion < SESSION_FORMAT_VERSION)
      ? excluded !== undefined && excluded.size > 0 ? await this.historicalCorpusRevision(signal) : corpusDigest(revisions)
      : undefined
    for (const artifact of artifacts) {
      const { identity } = artifact
      snapshots.push({
        header: { ...artifact.header },
        formatStatus: artifact.formatStatus,
        revision: artifact.sourceVersion < SESSION_FORMAT_VERSION
          ? SessionPersistenceRevision(`${fileRevision(identity)}:${corpusRevision}`)
          : fileRevision(identity),
        sizeBytes: Number(identity.size),
        location: { kind: 'jsonl', path: artifact.path },
      })
    }
    signal?.throwIfAborted()
    return snapshots
  }

  // Historical framing and format restoration.

  /** Resolve and read one stored log, refusing loudly when the artifact is absent. */
  private async requireStoredLog(id: SessionId, signal?: AbortSignal): Promise<PreparedJsonlSource<LegacySessionSnapshot>> {
    const selected = await this.findLog(id, signal)
    if (selected === undefined) throw new SessionPersistenceNotFoundError(id)
    if (selected.sourceVersion < SESSION_FORMAT_VERSION) {
      return this.prepareStoredMigration(id, selected, signal)
    }
    if (selected.sourceVersion > SESSION_FORMAT_VERSION) {
      const header = await this.readGenerationHeader(selected, id, signal)
      /* v8 ignore else -- a readable future header is rejected inside readGenerationHeader. */
      if (header === undefined) {
        throw new SessionPersistenceCorruptionError(
          `session "${id}": stored log has a malformed header (raw log: ${selected.sourcePath})`,
          { cause: new Error('malformed Session header') },
        )
      }
      /* v8 ignore next -- readGenerationHeader rejects every future version. */
      throw new SessionFormatUnsupportedError(
        `${sessionFormatVersionRefusal(id, selected.sourceVersion)} (raw log: ${selected.sourcePath})`,
        { kind: 'jsonl', path: selected.sourcePath },
      )
    }
    return prepareJsonlSource({
      sourcePath: selected.sourcePath,
      ...signal === undefined ? {} : { signal },
      decode: async (bytes) => {
        const stored = await this.decodeStoredLog(selected.sourcePath, id, bytes, signal)
        return { header: stored.meta, inheritedEventCount: stored.inheritedEventCount, events: stored.events }
      },
    })
  }

  /** Decode one historical generation without publishing a successor. */
  private async prepareStoredMigration(
    id: SessionId,
    selected: ResolvedJsonlGeneration,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PreparedJsonlSource<LegacySessionSnapshot>> {
    let validateRelatedSources: () => Promise<void>
    try {
      const children = async () => (await this.listArtifacts(signal)).artifacts
        .filter(source => source.header.origin === 'subagent' && source.header.parentSession === id)
      const sources = await children()
      const related = await prepareCatalogFacts(id, sources, this.compression, signal)
      for (const failure of related.failures) {
        this.ctx.logger.warn(`${this.name}: session "${id}" catalog retained a child with unknown descriptor (raw log: ${failure.path}): ${String(failure.error)}`)
      }
      const membership = sources.map(source => source.path).sort()
      validateRelatedSources = async () => {
        const current = (await children()).map(source => source.path).sort()
        const before = new Set(membership)
        const after = new Set(current)
        const changed = current.find(path => !before.has(path)) ?? membership.find(path => !after.has(path))
        if (changed !== undefined) throw new JsonlGenerationSourceChangedError(changed)
        await related.validate()
      }
      return await prepareJsonlSource({
        sourcePath: selected.sourcePath, signal, validateRelatedSources,
        decode: async (bytes) => {
          let artifact: Awaited<ReturnType<typeof decodeJsonlSource>>
          try {
            artifact = await decodeJsonlSource(bytes, this.compression, selected.sourceVersion, {
              createRestore: header => createSessionFormatCatalogWithChildren(related.facts).createRestore(header, {
                recovery: 'recoverable', validation: 'transformed',
              }),
            }, headerValue => this.validateSourceIdentity(selected, headerValue, id, signal), signal)
          } catch (error: unknown) {
            if (error instanceof SessionFormatUnsupportedMigrationError) {
              throw new JsonlGenerationUnsupportedMigrationError(selected.sourceVersion, error)
            }
            throw error
          }
          const header = this.currentHeader(artifact.header)
          assertStoredId(id, header)
          const events = artifact.events as SessionEvent[]
          validateStoredEvents(header, events, { kind: 'jsonl', path: selected.sourcePath })
          return { header, events, inheritedEventCount: SessionLogOffset(artifact.inheritedEventCount) }
        },
      })
    } catch (error: unknown) {
      throw this.generationFailure(id, selected, error)
    }
  }

  /** Translate generation-layer failures into the persistence seam's error vocabulary. */
  private generationFailure(
    id: SessionId,
    selected: ResolvedJsonlGeneration,
    error: unknown,
  ): Error {
    if (error instanceof JsonlGenerationUnsupportedMigrationError) {
      return new SessionFormatUnsupportedError(
        `${error.message}; source v${error.fromVersion} artifact remains unchanged (raw log: ${selected.sourcePath})`,
        { kind: 'jsonl', path: selected.sourcePath },
      )
    }
    if (error instanceof JsonlGenerationSourceChangedError) return error
    if (error instanceof SessionFormatUnsupportedError
      || error instanceof SessionPersistenceCorruptionError
      || isErrnoException(error)
      || error instanceof DOMException && error.name === 'AbortError') return error
    return new SessionPersistenceCorruptionError(
      `session "${id}": stored log is corrupt: ${String(error)} (raw log: ${selected.sourcePath})`,
      { cause: error },
    )
  }

  /** Decode one current physical snapshot without adding recovery markers. */
  private async decodeStoredLog(
    path: string,
    expectedId: SessionId,
    buffer: Buffer,
    signal?: AbortSignal,
  ): Promise<CurrentStoredLog> {
    let parsed: {
      meta: SessionHeader
      inheritedEventCount: SessionLogOffsetType
      events: SessionEvent[]
    }
    try {
      if (this.compression === 'zstd') {
        parsed = await this.readZstdPrefix(buffer, signal)
      } else {
        signal?.throwIfAborted()
        const { meta, inheritedEventCount, events } = scanLog(buffer)
        signal?.throwIfAborted()
        parsed = {
          meta,
          inheritedEventCount,
          events,
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
    await this.assertStoredIdentity(path, SESSION_FORMAT_VERSION, parsed.meta, expectedId, signal)
    signal?.throwIfAborted()
    assertStoredId(expectedId, parsed.meta)
    const location = this.locate(parsed.meta)
    validateStoredEvents(parsed.meta, parsed.events, location)
    return { status: 'current', ...parsed }
  }

  async hasStoredJsonl(id: SessionId): Promise<boolean> {
    await this.ensureRootEncoding()
    return await this.findLog(id) !== undefined
  }

  /** Decode complete frames and retain complete JSONL records from a torn final frame. */
  private async readZstdPrefix(
    buffer: Buffer,
    signal?: AbortSignal,
  ): Promise<{
    meta: SessionHeader
    inheritedEventCount: SessionLogOffsetType
    events: SessionEvent[]
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
        }
      }
      // Complete JSONL records decoded from a torn final frame belong to the imported prefix.
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
      }
    } catch (error) {
      /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
      if (signal?.aborted) signal.throwIfAborted()
      throw error
    } finally {
      decoder.close()
    }
  }

  /** Enumerate selected physical generations without interpreting their headers or bodies. */
  private async listGenerations(signal?: AbortSignal, excluded?: ReadonlySet<SessionId>): Promise<ResolvedJsonlGeneration[]> {
    const names = new Set([...excluded ?? []].map(id => encodeSegment(id)))
    const selected = await this.mapSessionDirectories((dir) => {
      signal?.throwIfAborted()
      if (names.has(basename(dir))) return Promise.resolve(undefined)
      return this.resolveGenerationInDirectory(dir, signal)
    }, signal)
    return selected.filter(source => source !== undefined)
  }

  /**
   * Apply `task` to every Session directory through the shared listing
   * limiter. Results and the first failure follow the sequential
   * project-then-directory order; a project whose listing fails ends the
   * traversal after the directories of the projects before it.
   * @param task - per-directory operation; must not wait on the listing limiter.
   * @param signal - optional cancellation for directory listings.
   * @returns per-directory results in traversal order.
   */
  private async mapSessionDirectories<R>(
    task: (dir: string) => Promise<R>,
    signal?: AbortSignal,
  ): Promise<R[]> {
    const limit = this.listLimit
    // The root read counts against the same bound as every other listing read.
    const projectDirs = await limit(() => this.listProjectDirs(signal))
    const projects = await settleLimited(limit, projectDirs, project => this.listSessionDirs(project, signal))
    const dirs: string[] = []
    let projectFailure: PromiseRejectedResult | undefined
    for (const outcome of projects) {
      if (outcome.status === 'rejected') {
        projectFailure = outcome
        break
      }
      // Appended one by one: spreading a large project as call arguments exceeds the engine's argument limit.
      for (const dir of outcome.value) dirs.push(dir)
    }
    const results = settledValues(await settleLimited(limit, dirs, task))
    if (projectFailure !== undefined) throw projectFailure.reason
    return results
  }

  /** Historical logical events depend on the corpus, including members with unreadable headers. */
  private async historicalCorpusRevision(signal?: AbortSignal): Promise<string> {
    const paths = (await this.listGenerations(signal)).map(source => source.sourcePath)
    const entries = settledValues(await settleLimited(this.listLimit, paths, async (path) => {
      signal?.throwIfAborted()
      try {
        return [path, fileRevision(await stat(path, { bigint: true }))] as const
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        return [path, 'missing'] as const
      }
    }))
    signal?.throwIfAborted()
    return corpusDigest(entries)
  }

  private async listArtifacts(
    signal?: AbortSignal,
    excluded?: ReadonlySet<SessionId>,
  ): Promise<{
    artifacts: Array<GenerationHeader & { path: string; sourceVersion: number; identity: JsonlPhysicalIdentity }>
    revisions: Array<readonly [string, string]>
  }> {
    signal?.throwIfAborted()
    if (excluded === undefined) await this.ensureRootEncoding()
    signal?.throwIfAborted()
    const generations = await this.listGenerations(signal, excluded)
    const previous = this.listedHeaders
    const listed = new Map<string, ListedHeader>()
    const headers = await settleLimited(this.listLimit, generations, async (selected) => {
      signal?.throwIfAborted()
      let identity: JsonlPhysicalIdentity
      try {
        identity = await stat(selected.sourcePath, { bigint: true })
      } catch (error: unknown) {
        signal?.throwIfAborted()
        if (!isENOENT(error)) throw error
        return { selected, revision: 'missing', identity: undefined, metadata: undefined }
      }
      signal?.throwIfAborted()
      const revision = fileRevision(identity)
      const memo = previous.get(selected.sourcePath)
      const metadata = memo !== undefined && memo.revision === revision
        ? memo.metadata
        : await this.readListedHeader(selected, signal)
      listed.set(selected.sourcePath, { revision, metadata })
      return { selected, revision, identity, metadata }
    })
    const artifacts: Array<GenerationHeader & { path: string; sourceVersion: number; identity: JsonlPhysicalIdentity }> = []
    const revisions: Array<readonly [string, string]> = []
    const ids = new Set<SessionId>()
    for (const outcome of headers) {
      if (outcome.status === 'rejected') throw outcome.reason
      const { selected, revision, identity, metadata } = outcome.value
      revisions.push([selected.sourcePath, revision])
      if (identity === undefined || metadata === undefined) continue
      if (ids.has(metadata.header.id)) {
        throw new Error(`duplicate JSONL session id "${metadata.header.id}" appears in multiple project directories`)
      }
      ids.add(metadata.header.id)
      artifacts.push({ ...metadata, path: selected.sourcePath, sourceVersion: selected.sourceVersion, identity })
    }
    signal?.throwIfAborted()
    this.listedHeaders = listed
    return { artifacts, revisions }
  }

  /** Read one listed header; unsupported or corrupt artifacts do not appear as Sessions. */
  private async readListedHeader(selected: ResolvedJsonlGeneration, signal?: AbortSignal): Promise<GenerationHeader | undefined> {
    try {
      return await this.readGenerationHeader(selected, undefined, signal)
    } catch (error: unknown) {
      if (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) return undefined
      throw error
    }
  }

  /** Read and translate one selected generation header without inspecting its body. */
  private async readGenerationHeader(
    selected: ResolvedJsonlGeneration,
    expectedId?: SessionId,
    signal?: AbortSignal,
  ): Promise<GenerationHeader | undefined> {
    let first: string | undefined
    try {
      first = this.compression === 'zstd'
        ? await this.readFirstZstdLine(selected.sourcePath, signal)
        : await this.readFirstLine(selected.sourcePath, signal)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (isENOENT(error)) return undefined
      throw error
    }
    signal?.throwIfAborted()
    if (first === undefined) return undefined
    let value: unknown
    try {
      value = JSON.parse(first)
    } catch {
      return undefined
    }
    assertNoRetiredHeaderFields(value)
    const result = sessionFormatCatalog.readHeader(value)
    if ('storedVersion' in result && result.storedVersion !== selected.sourceVersion) {
      throw new Error(
        `session generation filename identifies v${selected.sourceVersion}, `
        + `but its header identifies v${result.storedVersion}`,
      )
    }
    if (result.status === 'unsupported') {
      const physicalId = String((value as { id?: unknown }).id)
      let reason = result.reason
      /* v8 ignore else -- released historical header migrations cannot refuse after physical decoding. */
      if (result.storedVersion > SESSION_FORMAT_VERSION) {
        reason = sessionFormatVersionRefusal(physicalId, result.storedVersion)
      }
      throw new SessionFormatUnsupportedError(
        `${reason} (raw log: ${selected.sourcePath})`,
        { kind: 'jsonl', path: selected.sourcePath },
      )
    }
    if (result.status === 'malformed') return undefined
    const header = this.currentHeader(result.header)
    await this.assertStoredIdentity(
      selected.sourcePath,
      selected.sourceVersion,
      header,
      expectedId,
      signal,
    )
    return {
      header,
      formatStatus: result.status,
    }
  }

  /** Convert format-catalog string identities to current branded Session metadata. */
  private currentHeader(header: {
    readonly version: number
    readonly id: string
    readonly createdAt: number
    readonly cwd?: string
    readonly parentSession?: string
    readonly isSeeded: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth: number
    readonly agentPreset?: string
  }): SessionHeader {
    /* v8 ignore next 3 -- readable catalog results are restored to its configured current version. */
    if (header.version !== SESSION_FORMAT_VERSION) {
      throw new Error(`format catalog returned non-current logical header v${header.version}`)
    }
    return {
      version: SESSION_FORMAT_VERSION,
      id: makeSessionId(header.id),
      createdAt: header.createdAt,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(header.parentSession === undefined
        ? {}
        : { parentSession: makeSessionId(header.parentSession) }),
      isSeeded: header.isSeeded,
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      delegationDepth: header.delegationDepth,
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    }
  }

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

  /** Read only the header frame; compression failures reject as corruption, while I/O and cancellation propagate. */
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
        try {
          const first = scanZstdFrames(content, 1).frames[0]
          if (first === undefined) continue
          const plaintext = await decompressZstdFrame(content.subarray(first.start, first.end))
          signal?.throwIfAborted()
          assertZstdHeaderFrame(plaintext)
          return plaintext.subarray(0, -1).toString('utf8')
        } catch (error) {
          /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
          if (signal?.aborted) signal.throwIfAborted()
          throw new SessionPersistenceCorruptionError(
            `corrupt Zstandard session log: header frame failed validation: ${String(error)} (raw log: ${path})`,
            { cause: error },
          )
        }
      }
    } finally {
      await handle.close()
    }
  }

  /** Select the numerically highest canonical generation in one Session directory. */
  private async resolveGenerationInDirectory(
    dir: string,
    signal?: AbortSignal,
  ): Promise<ResolvedJsonlGeneration | undefined> {
    signal?.throwIfAborted()
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      throw error
    }
    signal?.throwIfAborted()
    const generations: Array<{ readonly path: string; readonly version: number }> = []
    const opposite: string[] = []
    for (const entry of entries) {
      const version = parseGenerationLogFilename(entry.name, this.compression)
      if (version !== undefined) {
        generations.push({ path: join(dir, entry.name), version })
        continue
      }
      if (parseGenerationLogFilename(entry.name, this.oppositeCompression()) !== undefined) {
        opposite.push(join(dir, entry.name))
      }
    }
    if (opposite.length > 0) throw this.encodingMismatch(opposite[0] as string)
    const latest = generations.sort((left, right) => right.version - left.version)[0]
    if (latest === undefined) return undefined
    return {
      sourcePath: latest.path,
      sourceVersion: latest.version,
    }
  }

  /** Find the unique authoritative generation for an id across project directories. */
  private async findLog(id: SessionId, signal?: AbortSignal): Promise<ResolvedJsonlGeneration | undefined> {
    const matches: ResolvedJsonlGeneration[] = []
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      await this.rejectLegacyFlatArtifact(project, id, signal)
      signal?.throwIfAborted()
      const dir = join(project, encodeSegment(id))
      const selected = await this.resolveGenerationInDirectory(dir, signal)
      if (selected !== undefined) matches.push(selected)
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
    storedVersion: number,
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
      expectedPath = generationLogPath(
        this.root,
        meta.cwd,
        meta.id,
        storedVersion,
        this.compression,
      )
    } catch (error) {
      throw new Error(`corrupt session log "${path}": header id cannot name a storage path`, { cause: error })
    }
    if (path !== expectedPath && !await this.sameFile(path, expectedPath, signal)) {
      throw new Error(`corrupt session log "${path}": header id "${meta.id}" and cwd identify "${expectedPath}"`)
    }
    signal?.throwIfAborted()
  }

  /** Validate a supported historical header against the selected source path. */
  private validateSourceIdentity(
    selected: ResolvedJsonlGeneration,
    headerValue: Readonly<Record<string, unknown>>,
    expectedId: SessionId,
    signal?: AbortSignal,
  ): void | Promise<void> {
    const result = sessionFormatCatalog.readHeader(headerValue)
    if (result.status !== 'current' && result.status !== 'migration-required') return
    return this.assertStoredIdentity(
      selected.sourcePath,
      selected.sourceVersion,
      this.currentHeader(result.header),
      expectedId,
      signal,
    )
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
      return entries.filter(e => e.isDirectory() && e.name !== '.creation-locks' && e.name !== '.segments')
        .map(e => join(this.root, e.name))
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
    await this.mapSessionDirectories(async (dir) => {
      const incompatible = await this.findOppositeGenerationInDirectory(dir)
      if (incompatible !== undefined) throw this.encodingMismatch(incompatible)
    })
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

  /** Return the highest canonical generation encoded with the other configured suffix. */
  private async findOppositeGenerationInDirectory(dir: string): Promise<string | undefined> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      throw error
    }
    const generations: Array<{ readonly name: string; readonly version: number }> = []
    for (const entry of entries) {
      const version = parseGenerationLogFilename(entry.name, this.oppositeCompression())
      if (version !== undefined) generations.push({ name: entry.name, version })
    }
    const latest = generations.sort((left, right) => right.version - left.version)[0]
    return latest === undefined ? undefined : join(dir, latest.name)
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
