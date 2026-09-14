/**
 * Pure types of the goal domain: the ONE home of the `goal` projection-key
 * declaration plus the durable payload vocabulary it carries, free of this
 * package's host-side imports (cordis events, dsh-agent, dsh-llm, the
 * service). Two namespace projections serve it — `./types` for host
 * consumers, `./client` (the browser half-entry's re-export) for client
 * aggregates — with zero content duplication. Host-coupled domain
 * vocabulary (message sources, events, fold shapes) lives in ./domain.ts.
 *
 * @module @deepseek-ai/dsh-goal/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies one goal across its durable revisions. */
export type GoalId = Branded<'GoalId'>

/** Compare-and-set identity for one exact goal revision. */
export interface GoalRef {
  /** Stable goal identity. */
  readonly id: GoalId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/** Input whose omitted round cap is resolved by the service configuration. */
export interface CreateGoalRequest {
  readonly objective: string
  readonly maxGoalRounds?: number
}

/** Wire-safe acknowledgement of one created goal. */
export interface CreateGoalResult {
  readonly ref: GoalRef
}

/** Fields changed by an edit; at least one must be present. */
export interface EditGoalRequest {
  readonly objective?: string
  readonly maxGoalRounds?: number
}

/** Durable continuation phase. Activation is process-local and separate. */
export type GoalPhase =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'

/** Machine-routable and human-readable explanation for a blocked goal. */
export interface GoalBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/** Full durable state written by every non-clear goal mutation. */
export interface GoalSnapshot extends GoalRef {
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: GoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: GoalBlockReason
  /** Total admitted goal-round cap. */
  readonly maxGoalRounds: number
}

/** Whether this live process may automatically continue an active goal. */
export type GoalActivation = 'armed' | 'disarmed'

/** Live process-local activation update forwarded to UI clients. */
export interface GoalActivationChanged {
  /** Session whose live goal activation changed. */
  readonly sessionId: SessionId
  /** Current exact activation, absent when no goal is current. */
  readonly goal?: {
    /** Exact current goal identity. */
    readonly id: GoalId
    /** Exact current goal revision. */
    readonly revision: number
    /** Current process-local continuation state. */
    readonly activation: GoalActivation
  }
}

/** Current goal projection, including values derived from the session log. */
export interface GoalView extends GoalSnapshot {
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: GoalActivation
}

/**
 * The `goal` projection value: the current durable goal with its replay
 * counters, including admitted goal rounds.
 * Activation is process-local (never persisted) and deliberately absent —
 * the projection reflects durable phase only.
 */
export interface GoalProjection {
  /** Current durable goal snapshot (the CAS ref for mutations rides on it). */
  readonly goal: GoalSnapshot
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
}

/** Strict checkpoint state used to derive the current goal client value. */
export interface GoalProjectionState {
  /** Latest valid current goal, or null before creation and after clear. */
  readonly current: GoalProjection | null
  /** Goal identities already created in this Session, retained to reject reuse. */
  readonly seenGoalIds: GoalId[]
  /** First strict replay failure, or null while the durable stream is valid. */
  readonly failure: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    goal: GoalProjectionState
  }
  interface SessionProjectionMap {
    /**
     * The session's current goal and admitted-round count, or
     * `null` before the first create and after a clear tombstone.
     * `goal/change` supplies the whole lifecycle value; matching admitted
     * `user/message` events advance `roundsStarted`.
     */
    goal: GoalProjection | null
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Process-local goal activation changed for one session.
     * @mode emit
     * @param payload - session id and the exact current goal activation, or no goal after a clear.
     */
    'goal/activation-changed'(payload: GoalActivationChanged): void
  }
}
