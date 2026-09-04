/**
 * The JSONL provider's session storage runtime: its concrete write/read
 * handle with a per-handle mutation chain and a routed live write-behind
 * buffer, the in-process bookkeeping that enforces one active writer per
 * session id, and the backend's live event routing and teardown. Deliberately
 * provider-local: the persistence seam exposes only the service and handle
 * contracts, and the shared contract suites pin equivalent observable
 * behavior across providers.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  assertContiguous,
  SessionAlreadyExistsError,
  materializeAppendBatch,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionWriteLease } from './lease.ts'

/** Maximum intentional wait before a routed live session batch starts writing. */
export const LIVE_WRITE_BATCH_MAX_DELAY_MS = 200

/** The file-storage primitives the handle drives on its owning service. */
export interface JsonlHandleStorage {
  /** Append encoded lines; `isMaterialized` selects create-vs-extend publication. */
  persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void>
  /** Materialize the header-only artifact for an explicitly flushed empty session. */
  persistHeader(header: SessionHeader, inheritedEventCount: SessionLogOffset): Promise<void>
  /** Truncate a torn physical tail before the first new append lands. */
  truncateTornTail(header: SessionHeader, truncateTo: number): Promise<void>
  /** Resolve the session's artifact path, or `undefined` before materialization. */
  resolveLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
  /** Read and validate the stored log at `path`. */
  readStoredLog(path: string, expectedId: SessionId, signal?: AbortSignal): Promise<{ events: SessionEvent[] }>
  /** Whether the id is still a created-but-unmaterialized session here. */
  hasPendingSession(id: SessionId): boolean
  /** Acquire the session's cross-process write lock in its artifact directory. */
  acquireWriteLease(header: SessionHeader): Promise<SessionWriteLease>
  /** Drop the handle's bookkeeping on close. */
  releaseHandle(handle: JsonlSessionHandle, materialized: boolean): void
}

/** Mutable per-handle log state; a write handle is its session's single mutator. */
export interface StorageHandleState {
  /** The stored next-seq (the logical end this handle knows). */
  cursor: number
  /** Whether the session has a durable artifact yet. */
  materialized: boolean
  /** Torn-tail truncation point, consumed by the first new append. */
  tornTruncateTo?: number | undefined
  /** Complete events recovered from the torn final frame; the first mutation rewrites them durably. */
  recoveredTail?: SessionEvent[] | undefined
  /** Exact fork-inherited prefix length stored with the log; `0` when unseeded. */
  inheritedEventCount: SessionLogOffset
  /** The validated stored prefix from a write open, served to reads until the first append. */
  primed?: SessionEvent[] | undefined
}

/**
 * The JSONL session handle. Mutations serialize on a per-handle promise
 * chain; reads re-scan the artifact on demand and never observe a shorter log
 * than a prior read on this handle. Routed live events buffer in a bounded
 * window and drain through the same chain as explicit appends.
 */
export class JsonlSessionHandle implements SessionHandle {
  private chain: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private observedLength = 0
  /** Routed live events awaiting their batching deadline (persistence-owned copies). */
  private buffered: SessionEvent[] = []
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  /** Set when a drain failed; the automatic timer stays quiet until the next drain. */
  private drainPaused = false
  private draining: Promise<void> | undefined

  constructor(
    private readonly storage: JsonlHandleStorage,
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    private readonly state: StorageHandleState,
    /** The cross-process write lock; a create handle acquires it lazily at first materialization. */
    private lease?: SessionWriteLease,
  ) {}

  /** Exact fork-inherited prefix length stored with this session's log. */
  get inheritedEventCount(): SessionLogOffset {
    return this.state.inheritedEventCount
  }

  /**
   * Read a slice of the valid contiguous logical log; see the seam contract.
   * @param offset - first logical seq to include (default 0).
   * @param length - maximum events returned (default: the rest).
   * @param options - optional cancellation.
   * @returns the requested slice.
   */
  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<readonly SessionEvent[]> {
    // Closed-handle refusal precedes argument validation: a closed handle
    // rejects SessionHandleClosedError regardless of the arguments.
    this.assertOpen('read')
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`)
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`)
    }
    options?.signal?.throwIfAborted()
    if (this.state.primed !== undefined) {
      this.observedLength = Math.max(this.observedLength, this.state.primed.length)
      return this.state.primed.slice(offset, offset + length)
    }
    // A write handle knows its own materialization; a read handle asks the
    // backend so a writer's later materialization becomes visible here.
    if (this.access === 'write' && !this.state.materialized) return []
    const path = await this.storage.resolveLog(this.id, options?.signal)
    if (path === undefined) {
      if (this.storage.hasPendingSession(this.id)) return []
      throw new SessionPersistenceNotFoundError(this.id)
    }
    const { events } = await this.storage.readStoredLog(path, this.id, options?.signal)
    if (events.length < this.observedLength) {
      throw new Error(`session "${this.id}": stored log shrank below a previously observed prefix (${events.length} < ${this.observedLength})`)
    }
    this.observedLength = events.length
    return events.slice(offset, offset + length)
  }

  /**
   * Durably append a contiguous batch; see the seam contract.
   * @param events - the contiguous batch in seq order.
   * @param options - optional cancellation observed before the write starts.
   */
  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append')
    // Validate and deep-snapshot the batch HERE, before queueing behind the
    // chain, so the checked value is exactly the value persisted.
    const batch = materializeAppendBatch(events)
    return this.run('append', async () => {
      options?.signal?.throwIfAborted()
      await this.persistContiguous(batch)
    })
  }

  /**
   * Durability barrier; materializes the artifact when nothing has been
   * appended yet, so an explicitly flushed empty session survives this process.
   * @param options - optional cancellation observed before the barrier starts.
   */
  flush(options?: SessionHandleFlushOptions): Promise<void> {
    return this.run('flush', async () => {
      options?.signal?.throwIfAborted()
      if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush')
      if (this.state.materialized) return // appends are durable on resolution
      await this.ensureLease()
      await this.storage.persistHeader(this.header, this.state.inheritedEventCount)
      this.state.materialized = true
    })
  }

  /**
   * Release the handle; see the seam contract. Idempotent and uncancellable.
   * A write handle first drains its routed live buffer through the still-open
   * storage, so backend teardown loses nothing regardless of which fiber
   * unwinds first; a drain or lock-release failure still frees the in-process
   * claim, then rejects — both failures together reject as one
   * `AggregateError`.
   * @returns settlement of the release.
   */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      let drainFailure: unknown
      // Producers on other fibers may still publish while close waits for
      // in-flight mutations (root disposal is concurrent), so drain again
      // until a full pass leaves the routed buffer empty. The chain never
      // rejects because run() swallows each operation's rejection after its
      // caller observed it.
      for (;;) {
        try {
          await this.drainLive()
        } catch (error: unknown) {
          drainFailure = error
          break
        }
        await this.chain
        if (this.buffered.length === 0) break
      }
      // After a drain failure the chain may still hold in-flight mutations.
      await this.chain
      // Free the in-process claim no matter how the kernel-lock release
      // fares: a skipped releaseHandle would wedge the id in this process
      // behind a lock the kernel may already have dropped.
      const failures: Error[] = []
      if (drainFailure !== undefined) {
        failures.push(drainFailure instanceof Error ? drainFailure : new Error(errorChain(drainFailure)))
      }
      try {
        await this.lease?.release()
      } catch (releaseFailure: unknown) {
        /* v8 ignore next -- lock releases reject with Error */
        failures.push(releaseFailure instanceof Error ? releaseFailure : new Error(errorChain(releaseFailure)))
      }
      this.storage.releaseHandle(this, this.state.materialized)
      if (failures.length > 1) throw new AggregateError(failures, `session "${this.id}": close failed to drain and to release its write lock`)
      if (failures[0] !== undefined) throw failures[0]
    })()
  }

  /** `await using` support: delegates to {@link close}. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /**
   * Buffer one published live session event and arm the bounded batching
   * window when it is idle. The routing installer is the only caller.
   * @param event - the live event, retained as a persistence-owned copy.
   * @param reportBackgroundFailure - observes a deadline-driven drain failure
   *   (the events stay buffered; the next {@link drainLive} retries loudly).
   */
  enqueueLive(event: SessionEvent, reportBackgroundFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event))
    if (this.batchTimer !== undefined || this.drainPaused) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined
      this.drainLive().catch(reportBackgroundFailure)
    }, LIVE_WRITE_BATCH_MAX_DELAY_MS)
  }

  /**
   * Durably drain the routed live buffer through the mutation chain;
   * concurrent callers join one drain, and a failure retains the batch in
   * order so `session/flush` can retry and reject loudly.
   */
  drainLive(): Promise<void> {
    return this.draining ??= this.drainBuffered().finally(() => {
      this.draining = undefined
    })
  }

  private async drainBuffered(): Promise<void> {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    this.drainPaused = false
    while (this.buffered.length > 0) {
      // Capture inside the chained turn so events landing while an earlier
      // batch writes coalesce into the next one, in order.
      await this.enqueueChain(async () => {
        // Only this single-flight drain splices the buffer, so the batch the
        // while-guard saw is still here when the chained turn runs.
        const batch = this.buffered.splice(0)
        try {
          await this.persistContiguous(materializeAppendBatch(batch))
        } catch (error: unknown) {
          this.buffered = batch.concat(this.buffered)
          this.drainPaused = true
          throw error
        }
      })
    }
  }

  /** The shared durable-append body: contiguity, ownership, torn-tail repair, storage write, state advance. */
  private async persistContiguous(batch: readonly SessionEvent[]): Promise<void> {
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    if (batch.length === 0) return
    await this.ensureLease()
    assertContiguous(this.id, batch, this.state.cursor)
    // Commit any pending torn-tail repair first, clearing each step's state
    // only once it lands so a failed step retries on the next mutation:
    // truncate the torn bytes, then durably rewrite the complete events
    // recovered from them (already counted in the primed cursor).
    if (this.state.tornTruncateTo !== undefined) {
      await this.storage.truncateTornTail(this.header, this.state.tornTruncateTo)
      this.state.tornTruncateTo = undefined
    }
    if (this.state.recoveredTail !== undefined) {
      if (this.state.recoveredTail.length > 0) {
        await this.storage.persistBatch(this.header, this.state.recoveredTail, this.state.materialized, this.state.inheritedEventCount)
      }
      this.state.recoveredTail = undefined
    }
    await this.storage.persistBatch(this.header, batch, this.state.materialized, this.state.inheritedEventCount)
    this.state.materialized = true
    this.state.cursor += batch.length
    this.state.primed = undefined
    this.observedLength = this.state.cursor
  }

  /**
   * Hold the cross-process write lock before this session's first durable
   * write. An open write handle holds it from construction; a create handle
   * acquires it here — immediately before the first log bytes publish — and
   * keeps it through close even when materialization then fails, so a
   * materializing session stays exclusively owned across retries.
   */
  private async ensureLease(): Promise<void> {
    this.lease ??= await this.storage.acquireWriteLease(this.header)
  }

  /** Serialize one operation onto the chain without the closed-handle refusal (drain-from-close). */
  private enqueueChain(op: () => Promise<void>): Promise<void> {
    const next = this.chain.then(op)
    this.chain = next.catch(() => {})
    return next
  }

  /** Serialize one public mutating operation onto this handle's chain. */
  private async run(operation: string, op: () => Promise<void>): Promise<void> {
    this.assertOpen(operation)
    return this.enqueueChain(async () => {
      this.assertOpen(operation)
      return op()
    })
  }

  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation)
  }
}

/** One created-but-unmaterialized session tracked in this process only. */
export interface PendingSession {
  readonly header: SessionHeader
  readonly revision: SessionPersistenceRevision
  /** Exact fork-inherited prefix length supplied at create. */
  readonly inheritedEventCount: SessionLogOffset
}

/**
 * The JSONL backend's in-process bookkeeping: the single active writer per
 * session id (doubling as the live event router), the open-handle set the
 * teardown sweep closes, and the created-but-unmaterialized sessions this
 * process can already observe.
 */
export class JsonlBackendTracker {
  /** Every open handle; teardown closes what remains. */
  readonly openHandles = new Set<SessionHandle>()
  /** `null` marks a claim whose handle is still being constructed. */
  private readonly writers = new Map<SessionId, JsonlSessionHandle | null>()
  private readonly pending = new Map<SessionId, PendingSession>()
  private counter = 0

  /** @param name - backend label used in in-memory revision tokens and teardown errors. */
  constructor(private readonly name: string) {}

  /**
   * Claim write ownership and record the created session as pending, making
   * it observable to this process before it materializes. Before
   * materialization this registration is the only guard — session ids do not
   * collide across processes, and no durable artifact exists for another
   * process to open; the handle takes the cross-process lock at its first
   * materializing write.
   * @param header - the validated detached header.
   * @param inheritedEventCount - the exact fork-inherited prefix length.
   * @throws {SessionAlreadyExistsError} when a concurrent create or an open
   *   write handle holds the id — for create, the duplicate is the fact.
   */
  registerCreated(header: SessionHeader, inheritedEventCount: SessionLogOffset): void {
    if (this.writers.has(header.id)) throw new SessionAlreadyExistsError(header.id)
    this.writers.set(header.id, null)
    this.pending.set(header.id, {
      header,
      revision: SessionPersistenceRevision(`memory:${this.name}:${++this.counter}`),
      inheritedEventCount,
    })
  }

  /**
   * Claim write ownership for an existing session.
   * @param id - the session to claim.
   * @throws {SessionAlreadyOwnedError} when an active write handle exists.
   */
  claimWrite(id: SessionId): void {
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    this.writers.set(id, null)
  }

  /**
   * Roll a failed write open back.
   * @param id - the session whose claim is dropped.
   */
  releaseClaim(id: SessionId): void {
    this.writers.delete(id)
  }

  /**
   * The pending entry for a created-but-unmaterialized session, if any.
   * @param id - the session to look up.
   * @returns the pending header and in-memory revision.
   */
  pendingOf(id: SessionId): PendingSession | undefined {
    return this.pending.get(id)
  }

  /**
   * Whether this process still tracks a created-but-unmaterialized session.
   * @param id - the session to test.
   * @returns true while the pending entry exists.
   */
  hasPending(id: SessionId): boolean {
    return this.pending.has(id)
  }

  /**
   * Iterate the pending sessions for listing.
   * @returns the pending entries, keyed by session id.
   */
  pendingEntries(): IterableIterator<[SessionId, PendingSession]> {
    return this.pending.entries()
  }

  /**
   * Drop a pending entry once the session materialized durably.
   * @param id - the session that reached durable storage.
   */
  materialized(id: SessionId): void {
    this.pending.delete(id)
  }

  /**
   * Track one open handle for teardown and, for a write handle, bind it as
   * the session's live event route.
   * @param handle - the just-constructed handle.
   * @returns the same handle, for construction-site chaining.
   */
  adopt(handle: JsonlSessionHandle): JsonlSessionHandle {
    this.openHandles.add(handle)
    if (handle.access === 'write') this.writers.set(handle.id, handle)
    return handle
  }

  /**
   * Release one handle's bookkeeping on close. A write handle drops its
   * ownership claim; a creator that never materialized leaves nothing behind —
   * the session never existed.
   * @param handle - the closing handle.
   * @param materialized - whether the session reached durable storage.
   */
  release(handle: JsonlSessionHandle, materialized: boolean): void {
    this.openHandles.delete(handle)
    if (handle.access !== 'write') return
    this.writers.delete(handle.id)
    if (!materialized) this.pending.delete(handle.id)
  }

  /**
   * Drain and flush every active write handle — the service-wide durability
   * barrier behind `SessionPersistence.flush`.
   * @throws {AggregateError} naming each session whose flush failed; the
   *   remaining handles still flush.
   */
  async flushAll(): Promise<void> {
    const errors: unknown[] = []
    for (const writer of [...this.writers.values()]) {
      if (writer === null) continue // a claim mid-construction routes nothing yet
      try {
        await writer.drainLive()
        await writer.flush()
      } catch (error: unknown) {
        // A handle closed during the sweep counts as flushed: close itself
        // drained the routed buffer durably before refusing this flush.
        if (error instanceof SessionHandleClosedError) continue
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${this.name} flush failed`)
  }

  /**
   * Install the backend's live session routing and teardown. Persistence
   * enforces one active write handle per id, so the listeners route published
   * sessions' events by id; the teardown effect closes every open handle —
   * close drains the routed buffer — and aggregates failures. This provider
   * owns no separate storage connection, so closing handles is the complete
   * teardown. Registrations are effects of the current fiber.
   * @param ctx - the backend's context.
   */
  install(ctx: Context): void {
    ctx.on('session/event', (session: Session, event) => {
      this.writers.get(session.id)?.enqueueLive(event, (error) => {
        ctx.logger.warn(`session-persistence: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`)
      })
    })
    ctx.on('session/flush', (session: Session) => {
      const writer = this.writers.get(session.id)
      if (writer === null || writer === undefined) return undefined
      return (async () => {
        await writer.drainLive()
        await writer.flush()
      })()
    })
    ctx.on('session/disposed', (session: Session) => {
      const writer = this.writers.get(session.id)
      if (writer === null || writer === undefined) return
      writer.close().catch((error: unknown) => {
        ctx.logger.warn(`session-persistence: final drain for session "${session.id}" failed: ${String(error)}`)
      })
    })
    ctx.effect(() => async () => {
      const errors: unknown[] = []
      for (const handle of [...this.openHandles]) {
        try {
          await handle.close()
        } catch (error: unknown) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `${this.name} dispose failed`)
    }, `${this.name} open handles`)
  }
}
