/** Session query using production observations with search outside these tests. */

import SessionQueryEngine from '@deepseek-ai/dsh-session-query'

/** Session query implementation whose search faces are outside these tests. */
export class TestSessionQuery extends SessionQueryEngine {
  static override inject = ['sessions', 'sessionPersistence']

  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}
