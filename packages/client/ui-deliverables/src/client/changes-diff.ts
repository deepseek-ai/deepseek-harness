/** Cache of the file comparisons the Host serves for listed changed files, read once per comparison and again after a failure. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesDiffUrl, isChangesDiff, type ChangesDiff } from '../changes.ts'
import { HostReadStore } from './host-read-store.ts'

/**
 * A comparison, `'missing'` once the Host no longer serves it, `'error'` for
 * a failed read a later request retries, or `'loading'` while the request runs.
 */
export type ChangesDiffState = ChangesDiff | 'missing' | 'error' | 'loading'

/** One browser plugin's comparison reads; a failed read is the one state a later request replaces. */
export class ChangesDiffStore extends HostReadStore<ChangesDiffState> {
  constructor() {
    super({
      loading: 'loading',
      failed: 'error',
      retryable: state => state === 'error',
      decode: async (response) => {
        if (response.status === 404) return 'missing'
        if (!response.ok) return 'error'
        const value: unknown = await response.json()
        return isChangesDiff(value) ? value : 'error'
      },
    })
  }

  /**
   * Read one comparison; a cached comparison or a missing one is kept, a failed one is read again.
   * @param sessionId - viewed Session.
   * @param seq - the announcing event's sequence.
   * @param index - the file's index in the summary.
   * @returns after the state is published.
   */
  load(sessionId: SessionId, seq: number, index: number): Promise<void> {
    return this.loadUrl(changesDiffUrl(sessionId, seq, index))
  }
}
