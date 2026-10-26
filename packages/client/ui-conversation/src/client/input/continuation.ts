/** Manual continuation of settled transient model-request failures. */
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

const CONTINUABLE_FAILURES: ReadonlySet<string> = new Set([
  'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'STREAM_CLOSED',
])

/**
 * Derive the latest eligible failure from the loaded history. A loaded turn
 * start, admitted user message, and settled failed request are required;
 * preparation failures may have consumed input without admitting it.
 * @param feed - existing Session event source, including replacement and paging.
 * @returns a stable source of the eligible turn/end sequence, absent otherwise.
 */
export function createContinuationSource(feed: SessionEventSource): ObservableSnapshot<SessionSeq | undefined> {
  return {
    getSnapshot: () => {
      const { entries } = feed.getSnapshot()
      let ending: SessionSeq | undefined
      let admitted = false
      let attempted = false
      for (let index = entries.length - 1; index >= 0; index--) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- index is bounded by this immutable window's length.
        const entry = entries[index]!
        if (entry.type === 'transient') return undefined
        const event = entry.event
        switch (event.type) {
          case 'turn/end':
            if (ending !== undefined || event.data.reason.kind !== 'error'
              || !CONTINUABLE_FAILURES.has(event.data.reason.error.code)) return undefined
            ending = event.seq
            break
          case 'turn/start':
            return admitted && attempted ? ending : undefined
          case 'assistant/attempt':
            attempted = true
            break
          case 'step/start':
          case 'assistant/message':
            if (!attempted) return undefined
            break
          case 'user/message':
            if (ending !== undefined && event.surfaceOp === 'append' && event.data.source.kind === 'user') admitted = true
            break
          default:
            break
        }
      }
      return undefined
    },
    subscribe: listener => feed.subscribe(listener),
  }
}
