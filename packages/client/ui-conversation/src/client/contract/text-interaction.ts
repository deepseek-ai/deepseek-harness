/** Conversation text gestures and plugin-owned action surfaces. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Browser gesture offered to text interaction consumers. */
export type TextInteractionTrigger = 'selection' | 'contextmenu'

/** Synchronous browser gesture; reading text does not imply source-data offsets. */
export interface TextInteractionGesture {
  readonly trigger: TextInteractionTrigger
  readonly hasSelection: boolean
  readonly readText: () => string | null
  /** Cancel the originating browser event during dispatch only. */
  readonly preventDefault: () => void
}

/** Scoped gesture offered to one registered plugin. */
export interface TextInteractionRequest extends TextInteractionGesture {
  readonly sessionId: SessionId
  /** Select this plugin's keyed surface for the current gesture. */
  readonly open: () => void
}

/** One consumer whose ID also names its keyed Slot renderer. */
export interface TextInteractionDefinition {
  readonly id: string
  readonly onInteraction: (request: TextInteractionRequest) => void
}

/** Area-local actions provided to the currently selected plugin component. */
export interface TextInteractionSurface {
  readonly trigger: TextInteractionTrigger
  readonly dismiss: () => void
  readonly readText: () => string | null
  readonly clearSelection: () => void
}
