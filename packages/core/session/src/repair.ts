/**
 * Pending tool-result recovery shared by failed live steps, interrupted logs,
 * and fork seeds. Tail repair preserves closed steps and supplies only missing
 * tool results and lifecycle boundaries, with cause-specific retry guidance.
 * @module @deepseek-ai/dsh-session/repair
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from './types.ts'
import type { SessionEvent, SessionSeq as SessionSeqType } from './types.ts'

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/**
 * Why an open tail turn is closed with synthetic events: `interrupted` is
 * crash recovery over a persisted log; `forked` is a fork seed cut inside the
 * source's open turn. The cause selects the synthetic `turn/end` reason, the
 * model-visible wording of synthetic error tool results, and the
 * deterministic synthetic message-id prefix. The error codes
 * ({@link TOOL_NOT_STARTED} / {@link TOOL_OUTCOME_UNKNOWN}) are shared: both
 * causes state the same fact about the call's recorded lifecycle.
 */
export type OpenTurnCloseCause = { readonly kind: 'interrupted' } | { readonly kind: 'forked' }

/** Model-visible wording of the synthetic error tool results, keyed by cause. */
const CLOSER_TEXT = {
  interrupted: {
    started: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
  },
  forked: {
    started: 'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
  },
} as const

/**
 * Return deterministic synthetic events that close an open tail turn. Unmatched
 * calls receive error results first, followed by an open `step/end` and a
 * cause-specific `turn/end`; sequences continue the log and timestamps reuse the
 * last real event. A balanced or empty log returns no events.
 *
 * @param events - the loaded durable log to scan (a valid committed prefix, possibly with a crash tail).
 * @param cause - the owning close operation: selects result wording and the turn-ending reason.
 * @returns the synthetic closer events to append after `events`, in order; empty when the log is already balanced.
 */
export function openTurnClosers(events: readonly SessionEvent[], cause: OpenTurnCloseCause): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  const recovery = new ToolCallRecovery(cause)
  for (const event of events) {
    recovery.observe(event)
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        break
      // Other event types do not move the turn/step boundary cursor.
      default:
        break
    }
  }

  // Balanced log (no open tail turn): nothing to close. An open turn implies
  // `events` is non-empty (its turn/start was logged), so `last` exists.
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  // The last real event supplies the seq base and the timestamp for the
  // synthetic closers (reusing the last timestamp keeps them deterministic and
  // never invents a "future" time).
  const closers: SessionEvent[] = recovery.results()
  let seq = last.seq + closers.length + 1
  const time = last.time

  // Close an open step before its turn.
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, reason: { kind: cause.kind } } })
  return closers
}

/**
 * Track unanswered assistant tool requests from one Session's committed events.
 * Observe from the start of the owned step or replay prefix, and recover before
 * its step closes. This state retains pending identities, not event history.
 */
export class ToolCallRecovery {
  private readonly pendingCalls = new Map<ToolCallId, { turn: number; step: number; callSeq?: SessionSeqType }>()
  private last: Pick<SessionEvent, 'seq' | 'time'> | undefined

  /** @param cause - defaults to interrupted live/crash recovery; fork-seed construction supplies its own cause. */
  constructor(private readonly cause: OpenTurnCloseCause = { kind: 'interrupted' }) {}

  /**
   * Consume the next committed event; closed steps and turn boundaries discard pending requests.
   * @param event - the next event from the same Session, in sequence order.
   */
  observe(event: SessionEvent): void {
    this.last = { seq: event.seq, time: event.time }
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'step/end':
        this.pendingCalls.clear()
        break
      case 'assistant/message':
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            this.pendingCalls.set(block.id, { turn: event.data.turn, step: event.data.step })
          }
        }
        break
      case 'tool/call': {
        const entry = this.pendingCalls.get(event.data.callId)
        if (entry) entry.callSeq = event.seq
        break
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const entry = this.pendingCalls.get(callId)
        if (event.surfaceOp === 'append' && entry !== undefined
          && entry.turn === event.data.turn && entry.step === event.data.step) {
          this.pendingCalls.delete(callId)
        }
        break
      }
      // SessionEvent is merge-extensible; unrelated events retain pending requests.
      default:
        break
    }
  }

  /**
   * Build conservative error results in assistant order without changing tracked state.
   * Sequences follow the latest observed event and timestamps reuse its time.
   * Callers commit the results and observe those commits before recovering again.
   * @returns pending tool-result events, empty when no request remains unanswered.
   */
  results(): SessionEvent<'tool/result'>[] {
    if (this.last === undefined) return []
    let seq = this.last.seq + 1
    const time = this.last.time
    const results: SessionEvent<'tool/result'>[] = []

    const text = CLOSER_TEXT[this.cause.kind]
    // Close calls before their step: providers reject dangling assistant calls,
    // and Map insertion order preserves their transcript order.
    for (const [callId, { turn, step, callSeq }] of this.pendingCalls) {
      const started = callSeq !== undefined
      const message: ToolResultMessage = deepFreeze({
        id: brandString<MessageId>(`${this.cause.kind}-tool-result-${callId}-${seq}`),
        role: 'tool',
        toolCallId: callId,
        isError: true,
        source: { kind: 'tool', callId },
        content: [{
          type: 'text',
          text: started ? text.started : text.notStarted,
        }],
      })
      results.push({
        type: 'tool/result',
        seq: SessionSeq(seq++),
        time,
        data: {
          turn,
          step,
          message,
          error: started
            ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
            : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
        },
        surfaceOp: 'append',
        ...started ? { sourceEventSeqs: [callSeq] } : {},
      })
    }

    return results
  }
}

/**
 * Crash-recovery entry point: synthetic closers that balance a persisted log
 * whose tail turn was interrupted. Used by crash-recovery callers; fork
 * seeds receive their `forked`-cause closers through `buildForkSeed` in
 * `./fork.ts`.
 *
 * @param events - the persisted log to scan, possibly ending inside an open turn.
 * @returns the synthetic `interrupted` closer events to append after `events`; empty when the log is already balanced.
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  return openTurnClosers(events, { kind: 'interrupted' })
}
