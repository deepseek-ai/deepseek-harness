/** SQLite Session persistence and durable takeover of legacy JSONL identities. @module */
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { settleLimited, settledValues } from '../listing.ts'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionPersistence, SessionAlreadyExistsError, SessionPersistenceNotFoundError, materializeCreateHeader } from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionPersistenceCreateOptions, SessionPersistenceOpenOptions,
  SessionPersistenceStatOptions, SessionPersistenceListOptions } from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { publishNewFileWin32, ensureDurableDirectoryWin32 } from '../win32.ts'
import { SqliteLogs } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { SessionWriteLease } from '../lease.ts'
import { sessionDir } from '../format.ts'
import { LegacySessionMigration } from './migration.ts'
import type { JsonlBackend } from './migration.ts'
export type { JsonlBackend } from './migration.ts'

/** Tuning defaults shared by the plugin schema and direct provider construction. */
export const SEGMENT_STORAGE_DEFAULTS = { busyTimeoutMs: 5000, flushDelayMs: 200, maxBufferedEvents: 256 } as const

/** SQLite storage location and scheduling. */
export interface SegmentStorageConfig {
  /**
   * SQLite file, defaulting to `.segments/sessions.sqlite` beneath the JSONL root;
   * a relative path resolves against the process working directory.
   */
  path?: string
  /** Milliseconds to wait for a locked database before failing; an integer of at least 0. Default 5000. */
  busyTimeoutMs?: number
  /** Maximum intentional batching wait in milliseconds; an integer of at least 1. Default 200. */
  flushDelayMs?: number
  /** Admitted live events that start a write before the delay; an integer of at least 1, not a memory limit. Default 256. */
  maxBufferedEvents?: number
}

const marker = z.object({ id: z.string().transform(SessionId), database: z.string() }).strict()

/** Routes the existing logical Session API; Segment identifiers never cross this service. */
export class TracePersistence extends SessionPersistence {
  private readonly directory: string
  private readonly sqlite: SqliteLogs
  private readonly migration: LegacySessionMigration
  private readonly rootPath: string
  private readonly jsonl: JsonlBackend
  constructor(ctx: Context, owner: Context, root: string,
    jsonl: JsonlBackend,
    config?: SegmentStorageConfig) {
    super(ctx)
    this.rootPath = resolve(root)
    this.directory = join(this.rootPath, '.segments')
    this.sqlite = new SqliteLogs({
      path: resolve(config?.path ?? join(this.directory, 'sessions.sqlite')),
      legacyRoot: this.rootPath,
      busyTimeoutMs: config?.busyTimeoutMs ?? SEGMENT_STORAGE_DEFAULTS.busyTimeoutMs,
      flushDelayMs: config?.flushDelayMs ?? SEGMENT_STORAGE_DEFAULTS.flushDelayMs,
      maxBufferedEvents: config?.maxBufferedEvents ?? SEGMENT_STORAGE_DEFAULTS.maxBufferedEvents,
      publish: id => this.publish(id),
      acquireCreationLease: header => this.acquireCreationLease(header),
      report: (id, error) => { owner.logger.error(`Segment persistence failed for ${id}; durability checkpoint will reject: ${String(error)}`) },
    })
    this.jsonl = jsonl
    this.migration = new LegacySessionMigration(jsonl, this.sqlite, id => this.selected(id), id => this.publish(id))
    this.sqlite.install(owner, () => this.migration.close())
  }

  /**
   * Initialize the selected storage at mount so configuration failures precede consumers.
   * @returns resolves once SQLite is ready.
   */
  async start(): Promise<void> {
    await this.sqlite.start()
  }

  /**
   * Claim a new identity across backends before its first write, retaining both locks until handle close.
   * @param header - pending Session metadata.
   * @returns the artifact lock and its root-wide creation guard.
   */
  protected async acquireCreationLease(header: SessionHeader): Promise<SessionWriteLease> {
    const guard = join(this.rootPath, '.creation-locks', createHash('sha256').update(header.id).digest('hex'))
    const lease = await SessionWriteLease.acquire(sessionDir(this.rootPath, header.cwd, header.id), header.id, guard)
    try {
      if (await this.jsonl.hasStoredJsonl(header.id)) {
        throw new SessionAlreadyExistsError(header.id)
      }
      return lease
    } catch (error: unknown) {
      try { await lease.release() }
      catch (releaseError: unknown) { throw new AggregateError([error, releaseError], 'Session creation and lock release failed') }
      throw error
    }
  }

  private markerPath(id: SessionId): string {
    return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`)
  }

  private parseMarker(text: string, path: string) {
    try { return marker.parse(JSON.parse(text)) }
    catch (error: unknown) {
      throw new HarnessError(`Stored Segment routing record is invalid: ${path}`, 'SESSION_STORAGE_CORRUPT', { cause: error })
    }
  }

  private async assertRoutingDatabase(): Promise<void> {
    if (await this.sqlite.hasDatabase()) return
    let names: string[]
    try { names = await readdir(this.directory) }
    catch (error: unknown) { if (isAbsent(error)) return; throw error }
    if (names.some(name => name.endsWith('.json'))) {
      throw new HarnessError('The Segment database is missing but routing records remain; restore the database before creating Sessions', 'SESSION_STORAGE_MISSING')
    }
  }

  private async selected(id: SessionId): Promise<boolean> {
    let text: string
    try { text = await readFile(this.markerPath(id), 'utf8') }
    catch (error: unknown) {
      if (!isAbsent(error)) throw error
      await this.assertRoutingDatabase()
      return await this.sqlite.stat(id) !== undefined
    }
    const selected = this.parseMarker(text, this.markerPath(id))
    await this.assertRoutingDatabase()
    if (selected.id !== id || selected.database !== this.sqlite.path) {
      throw new HarnessError('Recorded Segment storage differs from the configured database; restore the original configuration', 'SESSION_STORAGE_IDENTITY')
    }
    if (await this.sqlite.stat(id) === undefined) {
      if (!await this.sqlite.hasDatabase()) {
        throw new HarnessError('Recorded Segment database is missing; restore it before opening the Session', 'SESSION_STORAGE_MISSING')
      }
      throw new SessionPersistenceNotFoundError(id)
    }
    return true
  }

  /**
   * Atomically publish durable backend selection after the database commit.
   * @param id - committed Session identity.
   */
  protected async publish(id: SessionId): Promise<void> {
    if (process.platform === 'win32') await ensureDurableDirectoryWin32(this.directory)
    else await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = this.markerPath(id)
    try {
      const stored = this.parseMarker(await readFile(path, 'utf8'), path)
      if (stored.id !== id || stored.database !== this.sqlite.path) throw new HarnessError('Stored routing identity differs', 'SESSION_STORAGE_IDENTITY')
      await this.syncDirectory()
      return
    } catch (error: unknown) { if (!isAbsent(error)) throw error }
    const temporary = join(this.directory, `.route-${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    try {
      try { await file.writeFile(JSON.stringify({ id, database: this.sqlite.path }) + '\n'); await file.sync() }
      finally { await file.close() }
      try {
        if (process.platform === 'win32') await publishNewFileWin32(temporary, path)
        else await link(temporary, path)
      } catch (error: unknown) {
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
          const stored = this.parseMarker(await readFile(path, 'utf8'), path)
          if (stored.id !== id || stored.database !== this.sqlite.path) throw new HarnessError('Stored routing identity differs', 'SESSION_STORAGE_IDENTITY')
        } else throw error
      }
      await this.syncDirectory()
    } finally { await rm(temporary, { force: true }) }
  }

  private async syncDirectory(): Promise<void> {
    if (process.platform === 'win32') return
    const directory = await open(this.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions) {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    await this.start()
    await this.assertRoutingDatabase()
    if (await this.stat(snapshot.id) !== undefined) throw new SessionAlreadyExistsError(snapshot.id)
    return this.sqlite.create(snapshot, options)
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions) {
    options?.signal?.throwIfAborted()
    await this.start()
    return await this.selected(id) ? this.sqlite.open(id, access, options?.signal) : this.migration.open(id, access, options)
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions) {
    options?.signal?.throwIfAborted()
    return await this.selected(id) ? this.sqlite.stat(id, options?.signal) : this.jsonl.stat(id, options)
  }

  async list(options?: SessionPersistenceListOptions) {
    options?.signal?.throwIfAborted()
    await this.assertRoutingDatabase()
    // Routing records publish after their commit, so reading them first guarantees each one's row is in the later scan.
    let names: string[] = []
    try { names = await this.jsonl.listLimit(async () => {
      options?.signal?.throwIfAborted()
      return readdir(this.directory)
    }) } catch (error: unknown) { if (!isAbsent(error)) throw error }
    const { entries: segmented, omitted } = await this.sqlite.scan(options?.signal)
    // A row omitted for its header is still stored; only a routing record without a row is lost state.
    const known = new Set([...segmented.map(entry => entry.header.id), ...omitted])
    const entries = await this.jsonl.list(options, known)
    settledValues(await settleLimited(this.jsonl.listLimit, names.filter(name => name.endsWith('.json')), async (name) => {
      options?.signal?.throwIfAborted()
      const path = join(this.directory, name)
      const text = await readFile(path, { encoding: 'utf8', signal: options?.signal })
      options?.signal?.throwIfAborted()
      const stored = this.parseMarker(text, path)
      if (stored.database !== this.sqlite.path) {
        throw new HarnessError('Recorded Segment storage differs from the configured database; restore the original configuration', 'SESSION_STORAGE_IDENTITY')
      }
      if (!known.has(stored.id)) {
        throw new HarnessError('Recorded Segment Session is missing; restore its database before listing Sessions', 'SESSION_STORAGE_MISSING')
      }
    }))
    options?.signal?.throwIfAborted()
    return [...entries.filter(entry => !known.has(entry.header.id)), ...segmented]
  }

  async flush(): Promise<void> { await this.sqlite.flush() }
}

function isAbsent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
