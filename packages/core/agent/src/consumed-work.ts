/**
 * How one agent log accounts for the work it consumed.
 *
 * The turn and step vocabulary alone cannot answer this. A turn that stops
 * before its first step leaves a `turn/end` shaped exactly like the balanced
 * no-op turns a rejection or an empty claim produces, so reading turns in
 * isolation either credits cut-short work as finished or convicts every no-op.
 * The missing fact is the inbox's own record: {@link Inbox} logs each mutation
 * with `removedCount` and marks a cancellation `outcome: 'canceled'`, which
 * separates a turn claiming its input from work being dropped unrun.
 *
 * @module @deepseek-ai/dsh-agent/consumed-work
 */

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'

/** How one agent log accounts for the work it consumed. */
export interface ConsumedWork {
  /**
   * The latest closed turn that accounts for consumed work: one that entered a
   * model step, or one that claimed inbox input and then failed, was stopped,
   * or was rejected. Absent when no turn closed over any work.
   */
  readonly end?: SessionEvent<'turn/end'>
  /**
   * Whether accepted work was cancelled out of the inbox, unrun, after that
   * turn. This is the only account of input a cancellation took before any turn
   * could open over it — no `turn/end` describes it.
   */
  readonly droppedUnrun: boolean
}

/**
 * Whether a turn that consumed input but never reached a step ends in a way
 * that accounts for that input. Only a `completed` end does not: it had
 * nothing left to run once its claim was rewritten away. A `blocked` end is
 * that input's ending too — the pre-step rejection that produced it discarded
 * the claimed messages, so the work it took will never run.
 * @param reason - the turn's recorded ending.
 * @returns whether the ending accounts for the input the turn took.
 */
function accountsForClaim(reason: TurnEndReason): boolean {
  switch (reason.kind) {
    case 'completed':
      return false
    case 'blocked':
    case 'aborted':
    case 'interrupted':
    case 'error':
      return true
    /* v8 ignore next 5 -- unreachable: `max-tokens` requires a step and short-circuits
     * before this call; `forked` exists only in constructor seed history, while production
     * callers fold an operation-owned suffix. `TurnEndReasonMap` is merge-extensible, so a
     * backend-added variant cannot be listed; an unnameable ending over consumed input must
     * not read as success. */
    default:
      return true
  }
}

/**
 * Fold one agent log, or an owned suffix of one, into its account of consumed
 * work. Single pass, and every input is the log itself: no caller has to sample
 * live state before cancelling, so a cancellation issued by anyone — the owner's
 * teardown, an ancestor's interrupt, an unloading plugin — reads the same.
 * @param events - the log, or an owned suffix, to fold.
 * @returns the accounting turn when one closed, and whether work was dropped unrun after it.
 */
export function foldConsumedWork(events: readonly SessionEvent[]): ConsumedWork {
  const stepped = new Set<number>()
  const claimed = new Set<number>()
  let open: number | undefined
  let end: SessionEvent<'turn/end'> | undefined
  let droppedUnrun = false
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        open = event.data.turn
        break
      case 'step/start':
        stepped.add(event.data.turn)
        break
      case 'agent/inbox/spliced': {
        const { removedCount, outcome, inserted } = event.data
        if (removedCount === undefined) break
        // A replacement keeps the work pending under a new identity, so only a
        // cancellation that leaves nothing behind drops it.
        if (outcome === 'canceled') droppedUnrun ||= inserted.length === 0
        // Claims are the loop's own step-boundary reads, always inside a turn.
        else if (open !== undefined) claimed.add(open)
        break
      }
      case 'turn/end': {
        const { turn, reason } = event.data
        open = undefined
        if (stepped.delete(turn) || (claimed.delete(turn) && accountsForClaim(reason))) {
          end = event
          // Anything dropped before this turn closed is what its own ending
          // reports; only a later drop is still unaccounted for.
          droppedUnrun = false
        }
        break
      }
      default:
        break
    }
  }
  return { ...end === undefined ? {} : { end }, droppedUnrun }
}
