/** Exclusive legacy Session import with same-provider open sequencing. @module */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { setTimeout } from 'node:timers/promises'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle, SessionPersistenceOpenOptions } from '@deepseek-ai/dsh-session-persistence'
import type { SqliteStore } from './sqlite.ts'

/** Historical reads used by the persistence service; no JSONL writes or live handles. */
export type JsonlBackend = Pick<JsonlSessionPersistence, 'stat' | 'hasStoredJsonl' | 'prepare' | 'list'>

/** Owns pending legacy opens until import, ownership handoff, and cleanup finish. */
export class LegacySessionMigration {
  private readonly pending = new Map<SessionId, Promise<unknown>>()
  private closing = false
  private readonly stopped = new AbortController()
  constructor(private readonly jsonl: JsonlBackend, private readonly sqlite: SqliteStore,
    private readonly selected: (id: SessionId) => Promise<boolean>, private readonly publish: (id: SessionId) => Promise<void>) {}

  /**
   * Serialize legacy opens within this provider. Readers wait for another provider's import; writers reject contention.
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
    // The caller observed no SQLite row before queueing; the lease loop below rechecks before each attempt.
    // Header inspection does not decode history; the full snapshot is read only under ownership.
    const metadata = await this.jsonl.stat(id, signal === undefined ? undefined : { signal })
    if (metadata === undefined) {
      // A Session committed to SQLite while this open was queued has no legacy metadata.
      if (await this.selected(id)) return this.sqlite.open(id, access, signal)
      // The reader owns precise absent/malformed-header diagnostics.
      await this.jsonl.prepare(id, signal)
      throw new HarnessError('Legacy Session has no readable metadata', 'SESSION_STORAGE_CORRUPT')
    }
    let lease: Awaited<ReturnType<SqliteStore['acquireSessionLease']>> | undefined
    const waitingSignal = signal === undefined ? this.stopped.signal : AbortSignal.any([signal, this.stopped.signal])
    for (;;) {
      waitingSignal.throwIfAborted()
      if (await this.selected(id)) return this.sqlite.open(id, access, signal)
      try {
        lease = await this.sqlite.acquireSessionLease(metadata.header)
        break
      } catch (error: unknown) {
        if (access !== 'read' || !(error instanceof SessionAlreadyOwnedError)) throw error
        // Kernel leases have no completion notification; observe the committed row between acquisition attempts.
        await setTimeout(50, undefined, { signal: waitingSignal })
      }
    }
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
    this.stopped.abort(new HarnessError('Session migration is closing', 'SESSION_STORAGE_CLOSED'))
    await Promise.allSettled([...this.pending.values()])
  }
}
