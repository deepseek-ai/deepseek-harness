/** Independent Session snapshots and passive event subscriptions. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, SessionSeq, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import {
  DEFAULT_MAX_MESSAGES, paginate, pageRecords, entryFor, addressId,
  validateHistoryWindow, validateAddress, rejectNotFound,
} from '../history.ts'
import { EventListener, ProjectionListener } from './listener.ts'
import { SessionAssistantStreamsListener } from './assistant-stream.ts'
import type {
  SessionEventFrame, SessionEventsPage, SessionPageRequest,
  SessionObserveEventRequest, SessionProjectionsRequest, SessionProjectionFrame,
  SessionAddress, SessionProjectionBaseline, SessionProjectionValues, SessionProjectionsValue, SessionWaitOutput, SessionHistoryRecord,
} from '../types.ts'


/** Session snapshots do not share lifetime with passive subscriptions. */
export class HistoryController {

  /** Reconnect state for this controller's assistant subscriptions. */
  readonly streamsListener: SessionAssistantStreamsListener

  /** @param ctx - Host context carrying Session reads and projections. */
  constructor(private readonly ctx: Context) {
    this.streamsListener = new SessionAssistantStreamsListener(this.ctx)
  }

  /**
   * Read a passive page of Session events at an exact cut.
   * @param request - Session identity and optional cut and page window.
   * @param signal - read cancellation.
   * @returns a page at the supplied cut, or the observed log end when omitted.
   */
  async events(request: SessionPageRequest, signal: AbortSignal): Promise<SessionEventsPage> {
    const spec = resolveHistoryRequest(request)
    try {
      return await this.usingObservation({ sessionId: addressId(request.address), projection: request.address.kind === 'subagent' }, signal, (observation) => {
        validateObservationAddress(request.address, observation)
        return history(observation, spec)
      })
    } catch (error: unknown) {
      if (remoteErrorOf(error)?.code === 'session/not-found') rejectNotFound(request.address)
      throw error
    }
  }

  /**
   * Subscribe to Session events without reading or activating the Session.
   * @param request - Session address to subscribe.
   * @param signal - stream cancellation.
   * @returns subscription readiness followed by event frames; readiness does not establish existence.
   */
  async *observeEvent(request: SessionObserveEventRequest, signal: AbortSignal): AsyncIterable<SessionEventFrame> {
    using listener = new EventListener(this.ctx, addressId(request.address), signal)
    yield { type: 'ready' }
    yield* listener.events()
  }

  /**
   * Read exact projections or migration cache hints without activating the Session.
   * @param request - Session identity whose exact projection baseline is required.
   * @param signal - read cancellation.
   * @returns exact sequenced values, migration cache hints, or null when absent.
   */
  async projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
    const { sessionId } = request
    if (sessionId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'sessionId must not be empty', {})
    }
    try {
      signal.throwIfAborted()
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) {
        const snapshot = this.ctx.sessionProjections.snapshot(live)
        return { kind: 'sequenced', asOfSeq: snapshot.asOfSeq, values: snapshot.values as SessionProjectionValues }
      } else {
        const stored = await this.ctx.get('sessionPersistence')?.stat(sessionId, { signal })
        signal.throwIfAborted()
        if (stored?.formatStatus === 'migration-required') {
          const cached = this.ctx.get('sessionProjectionCache')?.cachedSnapshot(stored.header)
          return { kind: 'migration-required', values: { ...cached?.values } as SessionProjectionValues }
        }
        return await this.usingObservation({ sessionId: request.sessionId, projection: true }, signal, observation => ({
          kind: 'sequenced' as const,
          ...projections(observation),
        }))
      }
    } catch (error: unknown) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'session/not-found') {
        return null
      }
      if (signal.aborted || code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'Session projection read was cancelled', {}, { cause: error })
      }
      if (remoteErrorOf(error) !== undefined) throw error
      throw new RemoteError('gateway/internal', 'Session projection read failed', {}, { cause: error })
    }
  }

  /**
   * Subscribe to sparse projection replacements without reading a baseline.
   * @param request - Session identity to subscribe without reading a baseline.
   * @param signal - stream cancellation.
   * @returns readiness followed by sparse per-key replacement values.
   */
  async *observeProjections(request: SessionProjectionsRequest, signal: AbortSignal): AsyncIterable<SessionProjectionFrame> {
    using listener = new ProjectionListener(this.ctx, request.sessionId, signal)
    yield { type: 'ready' }
    yield* listener.changes()
  }

  /**
   * Read bounded committed assistant messages through a stopping cursor.
   * @param sessionId - Session whose committed assistant messages are requested.
   * @param afterSeq - exclusive lower bound.
   * @param throughSeq - inclusive stopping-state cursor.
   * @param maxMessages - positive assistant record limit.
   * @param signal - caller cancellation, independent of a completed wait deadline.
   * @returns newest-first assistant messages and whether further matching records were omitted.
   */
  async assistantOutput(
    sessionId: SessionId, afterSeq: number, throughSeq: number, maxMessages: number, signal: AbortSignal,
  ): Promise<SessionWaitOutput> {
    return this.usingObservation({ sessionId, projection: false }, signal, (observation) => {
      if (throughSeq > observation.cursor) {
        throw new RemoteError('gateway/internal', 'Session history no longer covers the wait cursor', {})
      }
      const records: SessionHistoryRecord[] = []
      const events = observation.events
      for (let index = throughSeq; index > afterSeq; index--) {
        const event = events[index] as SessionEvent
        if (event.type !== 'assistant/message' || !isAppendSurfaceEvent(event)) continue
        if (records.length === maxMessages) return { records, truncated: true }
        records.push(entryFor(event))
      }
      return { records, truncated: false }
    })
  }

  /**
   * Acquire a read without activating a Session; projections are opt-in.
   * @param request - Session identity and whether to compute projections.
   * @param signal - read cancellation.
   * @param callback - omitted to transfer lease ownership to the caller.
   * @returns a lease the caller must dispose.
   */
  usingObservation(
    request: { readonly sessionId: SessionId; readonly projection: boolean }, signal: AbortSignal, callback?: undefined,
  ): Promise<SessionObservation>
  /**
   * Keep the borrowed lease alive until the callback settles, then dispose it.
   * @param request - Session identity and whether to compute projections.
   * @param signal - read cancellation.
   * @param callback - synchronous or asynchronous computation; retain a separate lease if it must escape.
   * @returns the callback result; read and callback failures propagate.
   */
  usingObservation<T>(
    request: { readonly sessionId: SessionId; readonly projection: boolean }, signal: AbortSignal,
    callback: (observation: SessionObservation) => T,
  ): Promise<Awaited<T>>
  async usingObservation<T>(
    { sessionId, projection }: { readonly sessionId: SessionId; readonly projection: boolean }, signal: AbortSignal,
    callback?: (observation: SessionObservation) => T,
  ): Promise<SessionObservation | Awaited<T>> {
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: projection ? 'all' : 'none' })
    } catch (error: unknown) {
      const code = (error as { readonly code?: unknown } | null | undefined)?.code
      if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      if (code === 'SESSION_QUERY_ABORTED') {
        // Keep the query's own message: cancellation detail was visible before this mapping.
        throw new RemoteError('gateway/cancelled',
          error instanceof Error ? error.message : 'Session read was cancelled', {}, { cause: error })
      }
      throw error
    }
    try {
      signal.throwIfAborted()
    } catch (error: unknown) {
      observation[Symbol.dispose]()
      throw error
    }
    if (callback === undefined) return observation
    using ownedObservation = observation
    return await callback(ownedObservation)
  }
}

/**
 * Validate an Address against the exact read used by a Controller.
 * @param address - caller-supplied Session address.
 * @param observation - borrowed read; subagent addresses require projections.
 */
export function validateObservationAddress(address: SessionAddress, observation: SessionObservation): void {
  if (observation.header.cwd === undefined) rejectNotFound(address)
  validateAddress(address, observation.header, observation.inheritedEventCount, observation.projections)
}

/**
 * Convert a borrowed observation to one page without acquiring or retaining it.
 * @param observation - exact read cut owned by the caller.
 * @param request - validated page window and optional inclusive cut.
 * @returns a chronological page at the requested cut.
 */
export function history(observation: SessionObservation, request: Omit<SessionPageRequest, 'address'> & { readonly maxMessages: number }): SessionEventsPage {
  const cursor = request.throughSeq === undefined ? observation.cursor
    : request.throughSeq === -1 ? -1 : SessionSeq(request.throughSeq)
  if (cursor > observation.cursor) {
    throw new RemoteError('gateway/bad-request', `session history cut ${String(cursor)} exceeds ${String(observation.cursor)}`, {})
  }
  const page = paginate(
    observation.events,
    request.beforeSeq === undefined ? undefined : SessionLogOffset(request.beforeSeq),
    request.maxMessages,
    cursor,
    request.turnWindow,
  )
  return { cursor, records: pageRecords(page.events), hasMore: page.hasMore }
}

/**
 * Convert the projection baseline without acquiring or retaining its observation.
 * @param observation - projected read cut owned by the caller.
 * @returns the exact baseline; missing projection support fails explicitly.
 */
export function projections(observation: SessionObservation): SessionProjectionBaseline {
  const snapshot = observation.projections
  if (snapshot === undefined) throw new RemoteError('session/projections-unavailable', 'Session projections are unavailable', {})
  return { asOfSeq: snapshot.asOfSeq, values: snapshot.values as SessionProjectionValues }
}

/**
 * Validate and resolve the history page window.
 * @param request - external history window.
 * @returns the validated request with an explicit message budget.
 */
export function resolveHistoryRequest(request: SessionPageRequest): SessionPageRequest & { readonly maxMessages: number } {
  if (request.throughSeq !== undefined
    && (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1 || Object.is(request.throughSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  if (request.beforeSeq !== undefined
    && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0 || Object.is(request.beforeSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'beforeSeq must be a non-negative safe integer', {})
  }
  validateHistoryWindow(request)
  return { ...request, maxMessages: request.maxMessages ?? DEFAULT_MAX_MESSAGES }
}
