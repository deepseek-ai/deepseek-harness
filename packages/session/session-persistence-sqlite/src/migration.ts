/** Exclusive legacy Session import with same-provider open sequencing. @module */
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionAccess, SessionHandle, SessionPersistence, SessionPersistenceListOptions, SessionPersistenceOpenOptions, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { SqliteLogs } from './sqlite.ts'

/** Current logical history decoded from one immutable legacy artifact. */
export interface LegacySessionSnapshot {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

/** Prepared logical history retained under Session ownership until import. */
export interface PreparedLegacySession extends LegacySessionSnapshot {
  /**
   * Commit the prepared history while Session ownership remains held.
   * @param publish - destination-owned atomic import of the prepared snapshot.
   * @returns completed destination commit.
   */
  commit(publish: (snapshot: LegacySessionSnapshot) => Promise<void>): Promise<void>
}

/** Historical reads used by the persistence service; no JSONL writes or live handles. */
export interface JsonlBackend extends Pick<SessionPersistence, 'stat'> {
  readonly listLimit: <T>(operation: () => Promise<T>) => Promise<T>
  /** @param id - Session identity. @returns whether a physical legacy artifact exists. */
  hasStoredJsonl(id: SessionId): Promise<boolean>
  /** @param id - Session identity. @param signal - optional cancellation. @returns prepared logical prefix and commit. */
  prepare(id: SessionId, signal?: AbortSignal): Promise<PreparedLegacySession>
  /** @param options - optional cancellation. @param excluded - authoritative SQLite identities. @returns legacy metadata. */
  list(options?: SessionPersistenceListOptions, excluded?: ReadonlySet<SessionId>): Promise<readonly SessionPersistenceSnapshot[]>
}

/** Owns pending legacy opens until import, ownership handoff, and cleanup finish. */
export class LegacySessionMigration {
  private readonly pending = new Map<SessionId, Promise<unknown>>()
  private closing = false
  constructor(private readonly jsonl: JsonlBackend, private readonly sqlite: SqliteLogs,
    private readonly selected: (id: SessionId) => Promise<boolean>, private readonly publish: (id: SessionId) => Promise<void>) {}

  /**
   * Serialize legacy opens within this provider; another provider contending for ownership receives an ownership error.
   * @param id - legacy Session identity.
   * @param access - requested access after import.
   * @param options - optional cancellation checked when the queued open starts.
   * @returns SQLite handle; a write handle retains the import lease without a release/reacquire gap.
   */
  open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    if (this.closing) return Promise.reject(new HarnessError('Session migration is closing', 'SESSION_STORAGE_CLOSED'))
    const previous = this.pending.get(id) ?? Promise.resolve()
    const next = previous.catch((_error: unknown) => { /* A failed caller does not cancel the next open. */ })
      .then(() => this.migrate(id, access, options?.signal))
    this.pending.set(id, next)
    const settled = (): void => { if (this.pending.get(id) === next) this.pending.delete(id) }
    void next.then(settled, settled)
    return next
  }

  private async migrate(id: SessionId, access: SessionAccess, signal?: AbortSignal): Promise<SessionHandle> {
    signal?.throwIfAborted()
    if (await this.selected(id)) return this.sqlite.open(id, access, signal)
    // Header inspection does not decode history; the full snapshot is read only under ownership.
    const metadata = await this.jsonl.stat(id, signal === undefined ? undefined : { signal })
    if (metadata === undefined) {
      // The reader owns precise absent/malformed-header diagnostics.
      await this.jsonl.prepare(id, signal)
      throw new HarnessError('Legacy Session has no readable metadata', 'SESSION_STORAGE_CORRUPT')
    }
    let lease: Awaited<ReturnType<SqliteLogs['acquireSessionLease']>> | undefined = await this.sqlite.acquireSessionLease(metadata.header)
    let handle: SessionHandle | undefined
    try {
      signal?.throwIfAborted()
      if (!await this.selected(id)) {
        const prepared = await this.jsonl.prepare(id, signal)
        await prepared.commit(snapshot => this.sqlite.importLegacy(snapshot.header, snapshot.inheritedEventCount, snapshot.events, signal))
      } else await this.publish(id)
      signal?.throwIfAborted()
      handle = await this.sqlite.open(id, access, signal, access === 'write' ? lease : undefined)
      if (access === 'write') lease = undefined
      else {
        const imported = lease
        lease = undefined
        await imported.release()
      }
      return handle
    } catch (error: unknown) {
      const cleanup = await Promise.allSettled([handle?.close(), lease?.release()])
      const failures = cleanup.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length > 0) throw new AggregateError([error, ...failures], 'Session migration and cleanup failed')
      throw error
    }
  }

  /** Stop admission and settle accepted imports before SQLite closes. @returns settled cleanup. */
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.pending.values()])
  }
}
