/**
 * Generic-job adaptation for background terminal sends: the registry pull
 * source over the backend's consuming send reader.
 *
 * @module @deepseek-ai/dsh-tool-terminal/background
 */

import type { JobOutputSource } from '@deepseek-ai/dsh-jobs'
import type { TerminalSendOperation } from '@deepseek-ai/dsh-terminal'
import { renderSendRead } from './render.ts'

/**
 * Adapt the backend's consuming send reader to a registry pull source. The
 * reader has no offsets of its own — each call hands over what arrived since
 * the previous one — so the source counts the bytes it delivered to keep the
 * registry's cursor monotonic. It binds lazily because the send starts inside
 * the job starter, after the registry admitted the job; a read before that
 * point delivers nothing.
 * @param operation - the live send, once the starter has begun it.
 * @returns one unlabeled source over the send's bounded delta.
 */
export function sendSource(operation: () => TerminalSendOperation | undefined): JobOutputSource {
  return {
    read: (fromByte) => {
      const live = operation()
      if (live === undefined) return { text: '', nextOffset: fromByte, lossy: false }
      const text = renderSendRead(live.readOutput())
      return { text, nextOffset: fromByte + Buffer.byteLength(text), lossy: false }
    },
  }
}
