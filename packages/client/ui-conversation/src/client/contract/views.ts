/** Conversation view and session-local presentation state. */
import type { DraftInput } from './draft-editor.ts'

/**
 * One conversation view tab, projected from a 'conversation.view' slot
 * entry's registration options (label falls back to the entry id).
 */
export interface ViewTab { id: string; label: string }

/**
 * Session entities a Conversation View can be asked to reveal, keyed by kind.
 * Plugins add kinds by declaration merging; every value stays JSON-serializable because
 * `viewRequest` is persisted with the Conversation store.
 */
export interface ConversationFocusMap {
  /** One tool call. */
  'tool-call': { readonly callId: string }
  /** One model request, addressed by its turn and the step that issued it. */
  'request': { readonly turn: number; readonly step: number }
}

/** Kind tag of a {@link ConversationFocus}. */
export type ConversationFocusKind = keyof ConversationFocusMap

/** One addressable Session entity. */
export type ConversationFocus = {
  [K in ConversationFocusKind]: { readonly kind: K } & ConversationFocusMap[K]
}[ConversationFocusKind]

/** One-shot focus request addressed to a Conversation View. */
export interface ConversationViewRequest {
  /** Target `conversation.view` entry id. */
  readonly view: string
  /** Session entity the View reveals. */
  readonly focus: ConversationFocus
}

/** Per-session state owned by the target-neutral Conversation shell. */
export interface ConversationStoreState {
  /** Composer draft (persisted; survives session switches and reloads). */
  draft: DraftInput
  /** Preferred `conversation.view` entry id; null resolves to Chat when registered. */
  view: string | null
  /**
   * Focus request consumed and acknowledged by the addressed View. Rehydrated from storage without
   * validation; read it through `restoredViewRequest`.
   */
  viewRequest: ConversationViewRequest | null
}
