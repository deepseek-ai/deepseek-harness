/** Stored Session log stand-ins for read-aloud specs. */

/** One recorded storage read. */
export interface ReadCall {
  readonly offset: number
  readonly length: number
}

/**
 * Build an assistant message event.
 * @param seq - sequence number.
 * @param id - message identity.
 * @param texts - text blocks; a tool call sits between them.
 * @returns the event as storage returns it.
 */
export function reply(seq: number, id: string, ...texts: string[]): object {
  const content = texts.flatMap((text, index) => index === 0
    ? [{ type: 'text', text }]
    : [{ type: 'tool-call', id: `call-${index}` }, { type: 'text', text }])
  return { seq, time: 0, type: 'assistant/message', data: { turn: 0, step: 0, stream: [], message: { id, role: 'assistant', content } } }
}

/**
 * Build a user message event that carries an identity read-aloud must not match.
 * @param seq - sequence number.
 * @param id - message identity.
 * @returns the event as storage returns it.
 */
export function prompt(seq: number, id = `user-${seq}`): object {
  return { seq, time: 0, type: 'user/message', data: { id, role: 'user', content: [{ type: 'text', text: 'question' }] } }
}

/**
 * A read handle over a fixed event list that records every read and whether it was closed.
 * @param events - the stored log in sequence order.
 * @returns the handle and its observations.
 */
export function logHandle(events: readonly object[]) {
  const reads: ReadCall[] = []
  const state = { closed: false }
  const handle = {
    read: async (offset: number, length: number, options: { signal: AbortSignal }) => {
      options.signal.throwIfAborted()
      reads.push({ offset, length })
      return { eventState: 'owned', events: events.slice(offset, offset + length) }
    },
    [Symbol.asyncDispose]: async () => { state.closed = true },
  }
  return { handle, reads, state }
}
