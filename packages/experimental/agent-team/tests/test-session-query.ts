/** Minimal concrete Session query for Agent Team continuation tests. */

import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { SessionObservation, SessionObservationOptions } from '@deepseek-ai/dsh-session-query'

/** Undisposable immutable cut over one session's header and events. */
function cut(
  source: 'live' | 'prepared',
  header: SessionHeader,
  events: readonly SessionEvent[],
): SessionObservation {
  const lease = (): SessionObservation => ({
    source,
    header,
    inheritedEventCount: SessionLogOffset(0),
    events,
    cursor: events.at(-1)?.seq ?? -1,
    retain: lease,
    [Symbol.dispose]: () => {},
  })
  return lease()
}

/** Session query implementation whose search faces are outside these tests. */
export class TestSessionQuery extends SessionQueryEngine {
  static override inject = ['sessions', 'sessionPersistence']

  /** Live-preferred observation backed directly by a short-lived persistence read handle. */
  override async observeSession(
    sessionId: SessionId,
    options: SessionObservationOptions = {},
  ): Promise<SessionObservation> {
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) return cut('live', live.header, live.snapshotEvents())
    const handle = await this.ctx.sessionPersistence.open(
      sessionId,
      'read',
      options.signal === undefined ? {} : { signal: options.signal },
    )
    try {
      return cut(
        'prepared',
        handle.header,
        await handle.read(0, undefined, options.signal === undefined ? {} : { signal: options.signal }),
      )
    } finally {
      await handle.close()
    }
  }

  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}
