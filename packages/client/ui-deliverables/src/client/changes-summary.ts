/** Fetch-once cache of the change summaries the Host serves for announced `workspace/changes` events. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesSummaryUrl, isChangesSummary, type ChangesSummary } from '../changes.ts'
import { HostReadStore } from './host-read-store.ts'

/** A summary, `'missing'` once the Host no longer serves it, or `'loading'` while the request runs. */
export type ChangesSummaryState = ChangesSummary | 'missing' | 'loading'

/** One browser plugin's summary reads; a summary or a missing answer is kept until the connection is replaced. */
export class ChangesSummaryStore extends HostReadStore<ChangesSummaryState> {
  constructor() {
    super({
      loading: 'loading',
      failed: 'missing',
      retryable: () => false,
      decode: async (response) => {
        if (!response.ok) return 'missing'
        const value: unknown = await response.json()
        return isChangesSummary(value) ? value : 'missing'
      },
    })
  }

  /**
   * Read one summary once; a later read of the same coordinates returns the cached state.
   * @param sessionId - viewed Session.
   * @param seq - the announcing event's sequence.
   * @returns after the state is published.
   */
  load(sessionId: SessionId, seq: number): Promise<void> {
    return this.loadUrl(changesSummaryUrl(sessionId, seq))
  }
}
