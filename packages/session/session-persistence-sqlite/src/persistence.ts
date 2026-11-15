/** SQLite Session persistence and durable takeover of legacy JSONL identities. @module */
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './index.ts'
import pLimit, { type LimitFunction } from 'p-limit'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionPersistence, SessionAlreadyExistsError, SessionPersistenceNotFoundError, materializeCreateHeader } from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionPersistenceCreateOptions, SessionPersistenceOpenOptions,
  SessionPersistenceStatOptions, SessionPersistenceListOptions, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { publishNewFileWin32, ensureDurableDirectoryWin32 } from './win32.ts'
import { SqliteStore, isAbsent } from './sqlite.ts'
import { SessionWriteLease } from './lease.ts'
import { sessionDir } from './paths.ts'
import { LegacySessionMigration } from './migration.ts'
import type { JsonlBackend } from './migration.ts'

const marker = z.object({ id: z.string().transform(SessionId), database: z.string() }).strict()

/** Routes the existing logical Session API; Segment identifiers never cross this service. */
export class SqliteSessionPersistence extends SessionPersistence {
  private readonly directory: string
  private readonly sqlite: SqliteStore
  private readonly migration: LegacySessionMigration
  private readonly rootPath: string
  private readonly jsonl: JsonlBackend
  private readonly listLimit: LimitFunction
  private readonly publishedRoutes = new Set<SessionId>()
  constructor(ctx: Context, owner: Context, config: Config,
    jsonl: JsonlBackend) {
    super(ctx)
    this.rootPath = resolve(config.root)
    this.listLimit = pLimit(config.listConcurrency ?? 3)
    this.directory = join(this.rootPath, '.segments')
    this.sqlite = new SqliteStore({
      path: join(this.directory, 'sessions.sqlite'),
      legacyRoot: this.rootPath,
      compression: config.compression ?? 'zstd',
      frameEvents: config.frameEvents ?? 64,
      publish: id => this.publish(id),
      acquireCreationLease: header => this.acquireCreationLease(header),
      report: (id, error) => { owner.logger.error(`Segment persistence failed for ${id}; durability checkpoint will reject: ${String(error)}`) },
    })
    this.jsonl = jsonl
    this.migration = new LegacySessionMigration(jsonl, this.sqlite,
      async id => await this.selected(id) !== undefined, id => this.publish(id))
    this.sqlite.install(owner, () => this.migration.close())
  }

  /**
   * Initialize SQLite before a Session is created or opened.
   * @returns resolves once SQLite is ready.
   */
  async start(): Promise<void> {
    await this.sqlite.start()
  }

  /**
   * Claim the existing artifact lock before a new Session first commits.
   * @param header - pending Session metadata.
   * @returns the held artifact lock.
   */
  protected async acquireCreationLease(header: SessionHeader): Promise<SessionWriteLease> {
    const lease = await SessionWriteLease.acquire(sessionDir(this.rootPath, header.cwd, header.id), header.id)
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

  /** Decode one routing record and require it to name `id` in the configured database. */
  private readMarker(text: string, path: string, id: SessionId): void {
    let stored: z.infer<typeof marker>
    try { stored = marker.parse(JSON.parse(text)) }
    catch (error: unknown) {
      throw new HarnessError(`Stored Segment routing record is invalid: ${path}`, 'SESSION_STORAGE_CORRUPT', { cause: error })
    }
    if (stored.id !== id || stored.database !== this.sqlite.path) {
      throw new HarnessError('Recorded Segment storage differs from the configured database; restore the original configuration', 'SESSION_STORAGE_IDENTITY')
    }
  }

  private async selected(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceSnapshot | undefined> {
    let text: string
    try { text = await readFile(this.markerPath(id), 'utf8') }
    catch (error: unknown) {
      if (!isAbsent(error)) throw error
      await this.sqlite.assertRoutingDatabase()
      return this.sqlite.stat(id, signal)
    }
    this.readMarker(text, this.markerPath(id), id)
    await this.sqlite.assertRoutingDatabase()
    const snapshot = await this.sqlite.stat(id, signal)
    if (snapshot === undefined) {
      if (!await this.sqlite.hasDatabase()) {
        throw new HarnessError('Recorded Segment database is missing; restore it before opening the Session', 'SESSION_STORAGE_MISSING')
      }
      throw new SessionPersistenceNotFoundError(id)
    }
    return snapshot
  }

  /**
   * Atomically publish durable backend selection once per Session in this provider after the database commit.
   * @param id - committed Session identity.
   */
  protected async publish(id: SessionId): Promise<void> {
    if (this.publishedRoutes.has(id)) return
    if (process.platform === 'win32') await ensureDurableDirectoryWin32(this.directory)
    else await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = this.markerPath(id)
    try {
      this.readMarker(await readFile(path, 'utf8'), path, id)
      await this.syncDirectory()
      this.publishedRoutes.add(id)
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
          this.readMarker(await readFile(path, 'utf8'), path, id)
        } else throw error
      }
      await this.syncDirectory()
    } finally { await rm(temporary, { force: true }) }
    this.publishedRoutes.add(id)
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
    await this.sqlite.assertRoutingDatabase()
    // SQLite rejects an existing row itself; only the retained JSONL identity needs this check.
    if (await this.jsonl.hasStoredJsonl(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id)
    return this.sqlite.create(snapshot, options)
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions) {
    options?.signal?.throwIfAborted()
    await this.start()
    return await this.selected(id) ? this.sqlite.open(id, access, options?.signal) : this.migration.open(id, access, options)
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions) {
    options?.signal?.throwIfAborted()
    const snapshot = await this.selected(id, options?.signal)
    options?.signal?.throwIfAborted()
    return snapshot === undefined ? this.jsonl.stat(id, options) : snapshot
  }

  async list(options?: SessionPersistenceListOptions) {
    options?.signal?.throwIfAborted()
    await this.sqlite.assertRoutingDatabase()
    // Routing records publish after their commit, so reading them first guarantees each one's row is in the later scan.
    let names: string[] = []
    try { names = await this.listLimit(async () => {
      options?.signal?.throwIfAborted()
      return readdir(this.directory)
    }) } catch (error: unknown) { if (!isAbsent(error)) throw error }
    const [{ entries: segmented, omitted }, entries] = await Promise.all([
      this.sqlite.scan(options?.signal),
      this.jsonl.list(options),
    ])
    // A row omitted for its header is still stored; only a routing record without a row is lost state.
    const known = new Set([...segmented.map(entry => entry.header.id), ...omitted])
    // Routing records are named by their Session hash, so membership needs no record reads.
    const routed = new Set([...known].map(id => basename(this.markerPath(id))))
    for (const name of names) {
      if (name.endsWith('.json') && !routed.has(name)) {
        throw new HarnessError('Recorded Segment Session is missing; restore its database before listing Sessions', 'SESSION_STORAGE_MISSING')
      }
    }
    options?.signal?.throwIfAborted()
    return [...entries.filter(entry => !known.has(entry.header.id)), ...segmented]
  }

  async flush(): Promise<void> { await this.sqlite.flush() }
}
