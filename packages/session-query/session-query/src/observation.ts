/** Shared live/prepared observations for Session page and lifecycle consumers. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  BorrowedSessionSource,
  SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { SessionQueryError } from './config.ts'

/** One exact immutable Session cut retained for the caller's read lifetime. */
export interface SessionObservation extends Disposable {
  /** Whether the cut came from an attached Session or a retained preparation. */
  readonly source: 'live' | 'prepared'
  /** Immutable Session identity metadata. */
  readonly header: SessionHeader
  /** Immutable contiguous events at {@link cursor}. */
  readonly events: readonly SessionEvent[]
  /** Last observed event seq, or -1 for an empty log. */
  readonly cursor: number
  /** Durable source revision for a cold prepared observation. */
  readonly revision?: SessionPersistenceRevision
  /** Exact projection baseline at {@link cursor}, when the registry is mounted. */
  readonly projections?: ProjectionSnapshot
  /**
   * Retain the same immutable cut for another Host owner.
   * @returns an independently disposable lease over this observation.
   */
  retain(): SessionObservation
}

/** Projection work and cancellation requested for one exact observation. */
export interface SessionObservationOptions {
  /** Optional cancellation while resolving a cold source. */
  readonly signal?: AbortSignal
  /** Whether to compute every projection or leave projection state untouched. */
  readonly projectionMode?: 'all' | 'none'
}

/** Builds point observations without a corpus listing preflight. */
export class SessionObservationReader {
  /** @param ctx - context carrying Session and optional persistence/projection services. */
  constructor(private readonly ctx: Context) {}

  /**
   * Observe one live-preferred Session and retain a cold preparation until disposal.
   * @param sessionId - logical Session identity.
   * @param options - cancellation and all-or-none projection computation for this read.
   * @returns one exact immutable observation.
   */
  async read(
    sessionId: SessionId,
    options: SessionObservationOptions = {},
  ): Promise<SessionObservation> {
    const { signal, projectionMode = 'all' } = options
    for (;;) {
      throwIfObservationAborted(signal)
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) return this.live(live, projectionMode)
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) throw notFound(sessionId)

      let borrowed: BorrowedSessionSource
      try {
        borrowed = await persistence.borrowSession(sessionId, signal)
      } catch (error: unknown) {
        throwIfObservationAborted(signal)
        if (hasErrorName(error, 'SessionPersistenceNotFoundError')) throw notFound(sessionId, error)
        if (hasErrorName(error, 'SessionPersistenceCorruptionError')) {
          throw new SessionQueryError(
            `stored session "${sessionId}" is corrupt: ${error.message}`,
            'SESSION_QUERY_CORRUPT_SESSION',
            { cause: error },
          )
        }
        throw new SessionQueryError(
          `failed to observe session "${sessionId}": ${errorMessage(error)}`,
          'SESSION_QUERY_PERSISTENCE_FAILED',
          { cause: error },
        )
      }

      try {
        throwIfObservationAborted(signal)
        if (borrowed.inspection.meta.id !== sessionId) {
          throw new SessionQueryError(
            `session persistence returned "${borrowed.inspection.meta.id}" for "${sessionId}"`,
            'SESSION_QUERY_SOURCE_CONFLICT',
          )
        }
        const attached = this.ctx.sessions.get(sessionId)
        if (attached !== undefined) {
          const liveObservation = this.live(attached, projectionMode)
          borrowed[Symbol.dispose]()
          return liveObservation
        }
        if (borrowed.source === 'live') {
          // The live Session disappeared between persistence's race check and
          // this read. Retry against its now-cold durable identity.
          borrowed[Symbol.dispose]()
          continue
        }
        const prepared = borrowed
        const events = prepared.inspection.events
        let projections: ProjectionSnapshot | undefined
        try {
          projections = projectionMode === 'none'
            ? undefined
            : this.preparedProjections(prepared, events)
        } catch (error: unknown) {
          throw new SessionQueryError(
            `failed to project session "${sessionId}": ${errorMessage(error)}`,
            'SESSION_QUERY_CORRUPT_SESSION',
            { cause: error },
          )
        }
        let references = 1
        const lease = (): SessionObservation => {
          let disposed = false
          return {
            source: 'prepared',
            header: prepared.inspection.meta,
            events,
            cursor: events.at(-1)?.seq ?? -1,
            revision: prepared.revision,
            ...projections === undefined ? {} : { projections },
            retain: () => {
              if (disposed || references === 0) throw new Error(`session observation "${sessionId}" is disposed`)
              references += 1
              return lease()
            },
            [Symbol.dispose]: () => {
              if (disposed) return
              disposed = true
              references -= 1
              if (references === 0) prepared[Symbol.dispose]()
            },
          }
        }
        return lease()
      } catch (error: unknown) {
        borrowed[Symbol.dispose]()
        throw error
      }
    }
  }

  private live(
    session: Session,
    projectionMode: NonNullable<SessionObservationOptions['projectionMode']>,
  ): SessionObservation {
    const events = session.snapshotEvents()
    const projections = projectionMode === 'none'
      ? undefined
      : this.ctx.get('sessionProjections')?.snapshot(session)
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'live',
        header: session.header,
        events,
        cursor: events.at(-1)?.seq ?? -1,
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${session.id}" is disposed`)
          return lease()
        },
        [Symbol.dispose]: () => { disposed = true },
      }
    }
    return lease()
  }

  private preparedProjections(
    observation: Extract<BorrowedSessionSource, { readonly source: 'prepared' }>,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    const prepared = observation.preparedSession
    const cache = this.ctx.get('sessionProjectionCache')
    return cache === undefined
      ? registry.hydrate(prepared, {}, events, 0)
      : cache.hydratePrepared(prepared, observation.inspection.meta, events)
  }
}

function throwIfObservationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new SessionQueryError(
    'session observation was aborted',
    'SESSION_QUERY_ABORTED',
    { cause: signal.reason },
  )
}

function notFound(sessionId: SessionId, cause?: unknown): SessionQueryError {
  return new SessionQueryError(
    `session "${sessionId}" not found`,
    'SESSION_QUERY_SESSION_NOT_FOUND',
    cause === undefined ? undefined : { cause },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name
}
