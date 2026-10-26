/** Admitted input and a settled turn for manual-continuation tests. */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'

/**
 * Build one settled turn with ordinary user input.
 * @param reason - recorded turn ending.
 * @param number - turn number and corresponding event offset.
 * @returns ordered durable entries.
 */
export function continuationTurn(reason: TurnEndReason, number = 1): { type: 'event'; event: SessionEvent }[] {
  const offset = (number - 1) * 6
  return [
    { type: 'event', event: { type: 'turn/start', seq: SessionSeq(offset), time: 0, data: { turn: number } } },
    { type: 'event', event: { type: 'step/start', seq: SessionSeq(offset + 1), time: 0, data: { turn: number, step: 1 } } },
    { type: 'event', event: {
      type: 'user/message', seq: SessionSeq(offset + 2), time: 0, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }),
    } },
    { type: 'event', event: {
      type: 'assistant/attempt', seq: SessionSeq(offset + 3), time: 0, data: { turn: number, step: 1, stream: [] },
    } },
    { type: 'event', event: { type: 'step/end', seq: SessionSeq(offset + 4), time: 0, data: { turn: number, step: 1 } } },
    { type: 'event', event: { type: 'turn/end', seq: SessionSeq(offset + 5), time: 0, data: { turn: number, reason } } },
  ]
}
