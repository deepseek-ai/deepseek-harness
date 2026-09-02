/** Live/persisted logical-corpus resolution for session-query. */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader, SessionId , SessionLogOffset } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionRecord } from './types.ts'
import { SessionQueryError } from './config.ts'
import { readColdSessionLog, type ColdSessionLog } from './cold-read.ts'
import { assertSessionHeadersCompatible } from './sources.ts'

/** Detached source selected for one exact read. */
export interface LogicalSession {
  /** Cloned source header. */
  header: SessionHeader
  /** Exact fork-inherited event count paired with {@link header}. */
  inheritedEventCount: SessionLogOffset
  /** Cloned raw event log. */
  events: SessionEvent[]
}

/** Borrowed source visible only during one synchronous batch projection. */
export interface LogicalSessionSource {
  /** Header selected with `events`; callers must clone retained output. */
  readonly header: SessionHeader
  /** Raw events selected with `header`; valid only for the projection call. */
  readonly events: readonly SessionEvent[]
}

/** One source-projection result in a batch logical-corpus observation. */
export type LogicalProjectionResult<Value> =
  | { sessionId: SessionId; status: 'fulfilled'; value: Value }
  | { sessionId: SessionId; status: 'rejected'; reason: unknown }

/** Resolves a live-preferred corpus against the persistence service mounted now. */
export class SessionCorpus {
  private _persistence: SessionPersistence | undefined
  private readonly _optionalPersistenceFiber: Fiber

  constructor(
    private readonly _ctx: Context,
    private readonly _persistedReadConcurrency: number,
  ) {
    this._optionalPersistenceFiber = _ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      this._persistence = service
      childCtx.effect(() => () => {
        /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
        if (this._persistence === service) this._persistence = undefined
      }, 'sessionQuery.persistenceBinding')
    })
    _ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuery.optionalPersistence')
  }

  /**
   * List the complete logical corpus with live precedence and cloned headers.
   * @param signal - optional cancellation for persistence listing.
   * @returns records in deterministic newest-first order.
   */
  async listSessions(signal?: AbortSignal): Promise<SessionRecord[]> {
    signal?.throwIfAborted()
    const persistence = this._persistence
    const persisted = persistence === undefined ? [] : await listPersisted(persistence, signal)
    signal?.throwIfAborted()
    const records = new Map<SessionId, SessionRecord>()
    for (const header of persisted) {
      records.set(header.id, { header: structuredClone(header), live: false, persisted: true })
    }
    for (const session of this._ctx.sessions.list()) {
      const durable = records.get(session.id)
      if (durable !== undefined) assertSessionHeadersCompatible(session.header, durable.header)
      records.set(session.id, {
        header: structuredClone(session.header),
        live: true,
        persisted: durable !== undefined,
      })
    }
    return [...records.values()].sort(compareSessions)
  }

  /**
   * Load one logical source, preferring a detached live snapshot.
   *
   * A known live target never consults persistence, so an optional backend's
   * failure cannot make current in-memory history unreadable.
   * @param sessionId - session to resolve.
   * @param signal - optional cancellation for persisted source resolution.
   * @returns detached live-preferred header and events.
   */
  async load(sessionId: SessionId, signal?: AbortSignal): Promise<LogicalSession> {
    signal?.throwIfAborted()
    const live = this._ctx.sessions.get(sessionId)
    if (live !== undefined) {
      const snapshot = snapshotLive(live)
      signal?.throwIfAborted()
      return snapshot
    }
    const persistence = this._persistence
    if (persistence === undefined) throw notFound(sessionId)
    const listed = (await listPersisted(persistence, signal)).find(header => header.id === sessionId)
    signal?.throwIfAborted()
    if (listed === undefined) throw notFound(sessionId)
    const loaded = await inspectPersisted(persistence, sessionId, signal)
    signal?.throwIfAborted()
    const attached = this._ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      const snapshot = snapshotLive(attached)
      signal?.throwIfAborted()
      return snapshot
    }
    assertSessionHeadersCompatible(loaded.header, listed)
    const snapshot = {
      header: structuredClone(loaded.header),
      inheritedEventCount: loaded.inheritedEventCount,
      events: loaded.events.map(event => structuredClone(event)),
    }
    signal?.throwIfAborted()
    return snapshot
  }

  /**
   * Project unique logical sources immediately from one persistence listing.
   *
   * The synchronous projector runs before a persisted worker claims its next id.
   * Full logs are borrowed only for that call and never retained by the batch.
   * @param sessionIds - sessions to resolve in first-occurrence order.
   * @param project - synchronous fold that owns/clones every retained value.
   * @param signal - cancellation shared by listing and every persisted inspection.
   * @returns one fulfilled or rejected projected result per unique requested id.
   */
  async projectMany<Value>(
    sessionIds: readonly SessionId[],
    project: (source: LogicalSessionSource) => Value,
    signal?: AbortSignal,
  ): Promise<LogicalProjectionResult<Value>[]> {
    const ids = [...new Set(sessionIds)]
    signal?.throwIfAborted()
    const resolved = new Map<SessionId, LogicalProjectionResult<Value>>()
    const unresolved: SessionId[] = []
    for (const id of ids) {
      const session = this._ctx.sessions.get(id)
      if (session === undefined) {
        unresolved.push(id)
      } else {
        resolved.set(id, projectSource(id, sourceLive(session), project, signal))
      }
    }
    if (unresolved.length === 0) return orderedResults(ids, resolved)

    const persistence = this._persistence
    if (persistence === undefined) {
      for (const sessionId of unresolved) {
        resolved.set(sessionId, { sessionId, status: 'rejected', reason: notFound(sessionId) })
      }
      return orderedResults(ids, resolved)
    }

    let persisted: SessionHeader[]
    try {
      persisted = await listPersisted(persistence, signal)
      signal?.throwIfAborted()
    } catch (error: unknown) {
      if (signal?.aborted) signal.throwIfAborted()
      for (const sessionId of unresolved) {
        resolved.set(sessionId, { sessionId, status: 'rejected', reason: error })
      }
      return orderedResults(ids, resolved)
    }
    const persistedById = new Map(persisted.map(header => [header.id, header]))
    const resolvePersisted = async (sessionId: SessionId): Promise<void> => {
      const listed = persistedById.get(sessionId)
      if (listed === undefined) {
        const attached = this._ctx.sessions.get(sessionId)
        resolved.set(sessionId, attached === undefined
          ? { sessionId, status: 'rejected', reason: notFound(sessionId) }
          : projectSource(sessionId, sourceLive(attached), project, signal))
        return
      }
      try {
        signal?.throwIfAborted()
        const loaded = await inspectPersisted(persistence, sessionId, signal)
        signal?.throwIfAborted()
        const attached = this._ctx.sessions.get(sessionId)
        if (attached !== undefined) {
          resolved.set(sessionId, projectSource(sessionId, sourceLive(attached), project, signal))
          return
        }
        assertSessionHeadersCompatible(loaded.header, listed)
        resolved.set(sessionId, projectSource(sessionId, {
          header: loaded.header,
          events: loaded.events,
        }, project, signal))
      } catch (error: unknown) {
        if (signal?.aborted) signal.throwIfAborted()
        resolved.set(sessionId, { sessionId, status: 'rejected', reason: error })
      }
    }
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        signal?.throwIfAborted()
        const index = cursor
        if (index >= unresolved.length) return
        cursor += 1
        await resolvePersisted(unresolved[index] as SessionId)
      }
    }
    const workerCount = Math.min(this._persistedReadConcurrency, unresolved.length)
    const settlements = await Promise.allSettled(
      Array.from({ length: workerCount }, () => worker()),
    )
    if (signal?.aborted) signal.throwIfAborted()
    /* v8 ignore start -- per-id failures settle inside resolvePersisted; workers reject only on abort above */
    for (const settlement of settlements) {
      if (settlement.status === 'rejected') {
        const reason: unknown = settlement.reason
        throw reason
      }
    }
    /* v8 ignore stop */
    signal?.throwIfAborted()
    return orderedResults(ids, resolved)
  }
}

function projectSource<Value>(
  sessionId: SessionId,
  source: LogicalSessionSource,
  project: (source: LogicalSessionSource) => Value,
  signal?: AbortSignal,
): LogicalProjectionResult<Value> {
  try {
    signal?.throwIfAborted()
    const value = project(source)
    signal?.throwIfAborted()
    return { sessionId, status: 'fulfilled', value }
  } catch (reason: unknown) {
    /* v8 ignore next -- the synchronous projector has no external cancellation yield */
    if (signal?.aborted) signal.throwIfAborted()
    return { sessionId, status: 'rejected', reason }
  }
}

function sourceLive(session: Session): LogicalSessionSource {
  return { header: session.header, events: session.snapshotEvents() }
}

function orderedResults<Value>(
  ids: readonly SessionId[],
  resolved: ReadonlyMap<SessionId, LogicalProjectionResult<Value>>,
): LogicalProjectionResult<Value>[] {
  return ids.map(sessionId => resolved.get(sessionId) as LogicalProjectionResult<Value>)
}

async function listPersisted(
  persistence: SessionPersistence,
  signal?: AbortSignal,
): Promise<SessionHeader[]> {
  try {
    const snapshots = await persistence.list(signal === undefined ? undefined : { signal })
    return snapshots.map(snapshot => snapshot.header)
  } catch (error: unknown) {
    if (signal?.aborted) signal.throwIfAborted()
    throw new SessionQueryError(
      `session persistence listing failed: ${errorMessage(error)}`,
      'SESSION_QUERY_PERSISTENCE_FAILED',
      { cause: error },
    )
  }
}

async function inspectPersisted(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<ColdSessionLog> {
  try {
    return await readColdSessionLog(persistence, sessionId, signal)
  } catch (error: unknown) {
    if (signal?.aborted) signal.throwIfAborted()
    if (error instanceof Error && error.name === 'SessionPersistenceCorruptionError') {
      throw new SessionQueryError(
        `stored session "${sessionId}" is corrupt: ${errorMessage(error)}`,
        'SESSION_QUERY_CORRUPT_SESSION',
        { cause: error },
      )
    }
    throw new SessionQueryError(
      `failed to read stored session "${sessionId}": ${errorMessage(error)}`,
      'SESSION_QUERY_PERSISTENCE_FAILED',
      { cause: error },
    )
  }
}

function snapshotLive(session: Session): LogicalSession {
  return {
    header: structuredClone(session.header),
    inheritedEventCount: session.inheritedEventCount,
    events: session.snapshotEvents().map(event => structuredClone(event)),
  }
}

function compareSessions(a: SessionRecord, b: SessionRecord): number {
  return b.header.createdAt - a.header.createdAt || a.header.id.localeCompare(b.header.id)
}

function notFound(sessionId: SessionId): SessionQueryError {
  return new SessionQueryError(`session "${sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
