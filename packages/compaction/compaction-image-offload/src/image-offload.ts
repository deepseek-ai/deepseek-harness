/** Select and log permanent image omissions in current model-request order. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ImageOffloadTarget } from './projection.ts'

/**
 * Record one decision omitting the oldest retained input-image occurrences.
 * Assistant nodes carry model output and are excluded. Image indexes count
 * every occurrence, including previously offloaded ones, within each message.
 * @param session - session whose next request applies the decision.
 * @param sourceEventSeqs - input message events in the failed request's order.
 * @param count - additional retained occurrences the adapter needs omitted.
 * @returns whether any occurrence remained to offload.
 */
export function offloadOldestImages(session: Session, sourceEventSeqs: readonly SessionSeq[], count: number): boolean {
  const targets: ImageOffloadTarget[] = []
  for (const seq of sourceEventSeqs) {
    if (count === 0) break
    // Existing Session history read; migration deferred. Current surface nodes index the durable log.
    // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
    const event = session.eventAt(seq)!
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue
    // oxlint-disable-next-line typescript/no-non-null-assertion -- both input node types produce a message
    const message = session.deriveEventMessage(event)!
    const imageIndexes: number[] = []
    let imageIndex = 0
    const visit = (blocks: readonly ContentBlock[]): void => {
      for (const block of blocks) {
        if (count === 0) break
        if (block.type === 'image') {
          if (block.offloaded !== true) {
            imageIndexes.push(imageIndex)
            count -= 1
          }
          imageIndex += 1
        }
      }
    }
    visit(message.content)
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes })
  }
  if (targets.length === 0) return false
  session.append('image/offload', { targets })
  return true
}
