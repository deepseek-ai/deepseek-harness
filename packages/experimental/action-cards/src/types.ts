/** Card proposals, recorded decisions and user-action results shared by every action kind. */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Kind-defined JSON fields of a proposal or decision; each kind validates its own fields. */
export type ActionCardFields = Readonly<Record<string, JsonValue>>

/** One card admitted from a successful `propose_action` call. */
export interface ActionCardProposal {
  /** Id of the logged tool call. */
  readonly callId: ToolCallId
  /** Turn whose answer the card follows. */
  readonly turn: number
  /** Registered action kind named by the call. */
  readonly action: string
  readonly title: string
  /** What the action does, in the user's language. */
  readonly brief: string
  /** Fields the kind's skill asks for. */
  readonly details: ActionCardFields
}

/**
 * Latest state of one card. Kinds define their own phases; `dismissed` is shared.
 * `replaced` (a later proposal superseded an unstarted card) is derived from the
 * log and never recorded.
 */
export interface ActionCardDecision {
  readonly callId: ToolCallId
  readonly action: string
  readonly phase: string
  /** Kind-defined fields such as a chosen location or a created package. */
  readonly data?: ActionCardFields | undefined
}

/** Open-Session proposals and decisions by call id, excluded from Session summaries. */
export interface ActionCardView {
  readonly proposals: Readonly<Record<string, ActionCardProposal>>
  readonly decisions: Readonly<Record<string, ActionCardDecision>>
}

/**
 * Result of a user action. `accepted` starts background work that records its
 * own progress; `settled` returns the decision now in effect; `refused` changed
 * nothing; `unconfirmed` lost its outcome to an unloading owner, which the
 * kind reconciles when the Session reopens.
 */
export type ActionCardResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'settled'; readonly decision: ActionCardDecision }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'unconfirmed'; readonly reason: string }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Card status notice; other readers preserve the recorded text without this plugin.
     * The producer uses through only to acknowledge delivered decisions.
     * @persistenceAttribution
     */
    'action-cards': { kind: 'action-cards'; through: SessionSeq } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Dismissals and kind-defined progress of action cards. */
    'plugin:action-cards/decision': ActionCardDecision
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Action card proposals and decisions for the currently open Session. */
    actionCards: SessionProjectionSummaryExcluded<ActionCardView>
  }
}
