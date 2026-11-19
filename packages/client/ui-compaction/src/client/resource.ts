/** Recover immutable summaries without changing the conversation history window. */
import type { Context } from '@deepseek-ai/cordis'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError, remoteErrorOf, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { parseSummaryAddress, summaryDocument, type CompactionDocument } from './summary.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Markdown from one durable compaction/summary event. */
    compaction: CompactionDocument
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Invalid persisted summary identity. */
    'compaction-summary/invalid-address': Record<string, never>
    /** Missing or empty summary event. */
    'compaction-summary/not-found': Record<string, never>
    /** Failed Session history read. */
    'compaction-summary/read-failed': Record<string, never>
  }
}

/** Bind immutable summary reads to the existing history API.
 * @param remote - Session history reader.
 * @returns a provider that reads the events ending at the requested event.
 */
export function summaryResourceProvider(remote: Pick<Context['remote']['session'], 'events'>): ResourceProvider<'compaction'> {
  return {
    protocol: 'compaction',
    async *open(address, { signal }): AsyncIterable<RemoteResult<CompactionDocument>> {
      const aborted = (): boolean => signal.aborted
      if (aborted()) return
      const target = parseSummaryAddress(address)
      if (target === undefined) {
        yield { ok: false, error: new RemoteError('compaction-summary/invalid-address', 'Invalid summary address.', {}) }
        return
      }
      try {
        const events = await remote.events({ address: target.session, throughSeq: target.seq, maxMessages: 1 }, signal)
        if (aborted()) return
        if (!events.ok) { yield events; return }
        const event = events.value.records.find(entry => entry.event.seq === target.seq)?.event
        const document = event === undefined ? undefined : summaryDocument(event)
        if (document !== undefined) { yield { ok: true, value: document }; return }
        yield { ok: false, error: new RemoteError('compaction-summary/not-found', 'Summary unavailable in this Session.', {}) }
      } catch (error) {
        if (!aborted()) yield {
          ok: false,
          error: remoteErrorOf(error) ?? new RemoteError('compaction-summary/read-failed', 'Unable to read the summary.', {}),
        }
      }
    },
  }
}
