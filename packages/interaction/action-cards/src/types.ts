/** Card proposals, recorded decisions and user-action results shared by every action kind. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Kind-defined JSON fields of a proposal or decision; each kind validates its own fields. */
export type ActionCardFields = Readonly<Record<string, JsonValue>>

/** Id of one card in its Session: the id of the assistant message whose answer holds the card's block. */
export type ActionCardId = Branded<'ActionCardId'>

/** Language of the fenced answer block that offers a card. The Host reads cards from these blocks and the Web client hides them. */
export type ActionCardFence = 'action-card'

/** One card admitted from an `action-card` block. */
export interface ActionCardProposal {
  readonly cardId: ActionCardId
  /** Turn whose answer the card follows. */
  readonly turn: number
  /** Registered action kind the card names. */
  readonly action: string
  readonly title: string
  /** What the action does, in the user's language. */
  readonly brief: string
  /** Fields the kind's skill asks for. */
  readonly details: ActionCardFields
}

/** Latest recorded decision of one card. Kinds define their own phases alongside the shared `dismissed` phase. */
export interface ActionCardDecision {
  readonly cardId: ActionCardId
  readonly action: string
  readonly phase: string
  /** Kind-defined fields such as a chosen location or a created package. */
  readonly data?: ActionCardFields | undefined
}

/** Open-Session proposals and decisions by card id, excluded from Session summaries. */
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
  interface SessionEventMap {
    /** A card was dismissed or its kind recorded progress; the latest event for one card replaces earlier ones. */
    'action-cards/decision': ActionCardDecision
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Action card proposals and decisions for the currently open Session. */
    actionCards: SessionProjectionSummaryExcluded<ActionCardView>
  }
}
