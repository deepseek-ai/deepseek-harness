/** Windowed reads of one assistant message from a stored Session log. */
import type { MessageId } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'

/** Events read per storage call while searching for a message. */
const WINDOW = 256

/** An assistant message's visible text and where its event sits in the log. */
export interface StoredReply {
  readonly seq: number
  /** The message's text blocks joined in order, as the copy action copies them. */
  readonly markdown: string
}

function replyIn(events: readonly SessionEvent[], messageId: MessageId): StoredReply | undefined {
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data.message.id !== messageId) continue
    return {
      seq: event.seq,
      markdown: event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    }
  }
  return undefined
}

/**
 * Find an assistant message by identity. With a known log length the search runs from the newest window backward,
 * because the reply being read is usually near the end; otherwise it runs forward until a short window ends the log.
 * @param handle - read access to the Session's stored log.
 * @param messageId - identity of the message.
 * @param length - number of stored events, when the caller knows it.
 * @param signal - cancellation of the storage reads.
 * @returns the message, or undefined when the log holds no assistant message with that identity.
 */
export async function findReply(
  handle: SessionHandle, messageId: MessageId, length: number | undefined, signal: AbortSignal,
): Promise<StoredReply | undefined> {
  if (length !== undefined) {
    for (let stop = length; stop > 0; stop -= WINDOW) {
      const from = Math.max(0, stop - WINDOW)
      const found = replyIn((await handle.read(from, stop - from, { signal })).events, messageId)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (let from = 0; ; from += WINDOW) {
    const { events } = await handle.read(from, WINDOW, { signal })
    const found = replyIn(events, messageId)
    if (found !== undefined || events.length < WINDOW) return found
  }
}

/**
 * Read the assistant message stored at one sequence number.
 * @param handle - read access to the Session's stored log.
 * @param messageId - identity the event must carry.
 * @param seq - sequence number a plan reported.
 * @param signal - cancellation of the storage read.
 * @returns the message, or undefined when that event is not the named assistant message.
 */
export async function replyAt(
  handle: SessionHandle, messageId: MessageId, seq: number, signal: AbortSignal,
): Promise<StoredReply | undefined> {
  return replyIn((await handle.read(seq, 1, { signal })).events, messageId)
}
