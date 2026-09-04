/** Web presentation fold joining transient Assistant frames to one durable v2 settlement. */

import type {
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
} from '../../types.ts'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type {
  SessionAssistantSettlementEntry,
  SessionEventLikeEntry,
  SessionLiveEventEntry,
  SessionTransientEventEntry,
} from '../contract/events.ts'

interface ActiveAttempt {
  readonly attemptId: LlmAttemptId
  readonly startedAfterSeq: number
  readonly turn: number
  readonly step: number
  nextIndex: number
}

/** One Web publication decision from the assistant stream fold. */
export type ClientAssistantStreamResult =
  | { readonly type: 'publish'; readonly entry: SessionLiveEventEntry }
  | {
    readonly type: 'settlement'
    readonly attemptId: LlmAttemptId
    readonly entry: SessionAssistantSettlementEntry
  }
  | { readonly type: 'abandonment'; readonly attemptId: LlmAttemptId }
  | { readonly type: 'transient'; readonly entry: SessionTransientEventEntry }
  | { readonly type: 'rebaseline' }
  | undefined

/** Keeps transient Assistant presentation behind one settlement-aware interface. */
export class ClientAssistantStream {
  private activeAttempt: ActiveAttempt | undefined
  private readonly pending = new Map<number, SessionAssistantSettlementEntry>()
  private publishedSeqs = new Set<number>()
  private durableCursor = -1
  private transientInGap = 0

  /**
   * Replace the durable Web window and adopt an optional reconnect baseline.
   * @param entries - durable entries in the replacement window.
   * @param baseline - compact prefix for an Assistant attempt that is still live.
   * @returns immediately visible durable entries plus reconstructed transient chunks.
   */
  replace(
    entries: readonly SessionEventLikeEntry[],
    baseline?: SessionAssistantStreamBaseline,
  ): readonly SessionEventLikeEntry[] {
    this.pending.clear()
    this.transientInGap = 0
    this.activeAttempt = undefined
    const opening = baseline?.activeAttempt
    if (opening !== undefined) {
      this.activeAttempt = {
        attemptId: opening.attemptId,
        startedAfterSeq: opening.startedAfterSeq,
        turn: opening.turn,
        step: opening.step,
        nextIndex: opening.nextIndex,
      }
    }
    const visible: SessionEventLikeEntry[] = [...entries]
    this.publishedSeqs = new Set(visible.map(entry => entry.event.seq))
    this.durableCursor = visible.reduce((cursor, entry) => Math.max(cursor, entry.event.seq), -1)
    if (opening !== undefined) {
      for (const [index, member] of expandAssistantStream(
        opening.stream as unknown as readonly AssistantStreamRecord[],
      ).entries()) {
        this.transientInGap += 1
        visible.push({
          type: 'transient',
          event: {
            type: 'assistant/live-chunk',
            seq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
            time: member.time,
            data: {
              attemptId: opening.attemptId,
              turn: opening.turn,
              step: opening.step,
              chunk: member.chunk,
            },
          },
        })
        if (index + 1 >= opening.nextIndex) break
      }
    }
    return visible
  }

  /**
   * Stage one durable v2 settlement while its matching live attempt is open.
   * @param entry - newly followed durable entry.
   * @returns a publication decision, or `undefined` when no entry becomes visible.
   */
  acceptDurable(entry: SessionLiveEventEntry): ClientAssistantStreamResult {
    const event = entry.event
    this.durableCursor = Math.max(this.durableCursor, event.seq)
    this.transientInGap = 0
    const settlement = assistantSettlementEntry(entry)
    if (settlement !== undefined && this.attemptForSettlement(settlement.event) !== undefined) {
      if (this.pending.has(event.seq)) return { type: 'rebaseline' }
      this.pending.set(event.seq, settlement)
      return undefined
    }
    return this.publish(entry)
  }

  /**
   * Fold one dense transient frame and release its named durable settlement.
   * @param frame - next Assistant stream frame received by the follow connection.
   * @returns a transient, publication, or rebaseline decision, or `undefined` when no entry becomes visible.
   */
  acceptFrame(frame: SessionAssistantStreamFrame): ClientAssistantStreamResult {
    switch (frame.type) {
      case 'start':
        if (this.activeAttempt !== undefined || this.pending.size > 0) return { type: 'rebaseline' }
        this.pending.clear()
        this.activeAttempt = {
          attemptId: frame.attemptId,
          startedAfterSeq: frame.startedAfterSeq,
          turn: frame.turn,
          step: frame.step,
          nextIndex: 0,
        }
        return undefined
      case 'chunk': {
        const attempt = this.activeAttempt
        // A controller mounted after the Host saw this attempt has no start
        // frame to reconstruct. Its durable settlement publishes directly;
        // ignore the transient suffix until the next known start.
        if (attempt === undefined || attempt.attemptId !== frame.attemptId) return undefined
        if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
        attempt.nextIndex += 1
        this.transientInGap += 1
        return {
          type: 'transient',
          entry: {
            type: 'transient',
            event: {
              type: 'assistant/live-chunk',
              seq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
              time: frame.time,
              data: {
                attemptId: frame.attemptId,
                turn: attempt.turn,
                step: attempt.step,
                chunk: frame.chunk as never,
              },
            },
          },
        }
      }
      case 'end': {
        const attempt = this.activeAttempt
        if (attempt === undefined || attempt.attemptId !== frame.attemptId) {
          return undefined
        }
        this.activeAttempt = undefined
        if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
        if (frame.outcome.kind === 'abandoned') {
          return this.pending.size === 0
            ? { type: 'abandonment', attemptId: attempt.attemptId }
            : { type: 'rebaseline' }
        }
        if (this.publishedSeqs.has(frame.outcome.seq)) return undefined
        const entry = this.pending.get(frame.outcome.seq)
        if (entry === undefined
          || entry.event.type !== frame.outcome.eventType) {
          return { type: 'rebaseline' }
        }
        this.pending.delete(frame.outcome.seq)
        this.publishedSeqs.add(entry.event.seq)
        return { type: 'settlement', attemptId: attempt.attemptId, entry }
      }
    }
  }

  private attemptForSettlement(
    event: SessionAssistantSettlementEntry['event'],
  ): ActiveAttempt | undefined {
    const attempt = this.activeAttempt
    if (attempt === undefined
      || (event.type === 'assistant/message' && event.surfaceOp !== 'append')
      || event.seq <= attempt.startedAfterSeq
      || attempt.turn !== event.data.turn
      || attempt.step !== event.data.step) return undefined
    return attempt
  }

  private publish(entry: SessionLiveEventEntry): ClientAssistantStreamResult {
    this.publishedSeqs.add(entry.event.seq)
    return { type: 'publish', entry }
  }
}

function assistantSettlementEntry(
  entry: SessionLiveEventEntry,
): SessionAssistantSettlementEntry | undefined {
  return entry.event.type === 'assistant/message' || entry.event.type === 'assistant/attempt'
    ? entry as SessionAssistantSettlementEntry
    : undefined
}
