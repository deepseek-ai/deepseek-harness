/** Concrete Session query using the standard live and persisted projections. */

import SessionQueryEngine from '@deepseek-ai/dsh-session-query'

/** Session query implementation whose search faces are outside these tests. */
export class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}
