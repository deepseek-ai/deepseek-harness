/** Browser-safe Session reading state and Remote requests. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Host-confirmed reading state for one Session; turn numbers survive log-format migrations. */
export interface SessionReadState {
  readonly sessionId: SessionId
  /** Latest turn that ended while this Host served the Session; 0 when none did. */
  readonly completedTurn: number
  /** Whether {@link SessionReadState.completedTurn} ended with an execution error; older history reads as success. */
  readonly failed: boolean
  readonly readTurn: number
  readonly manualUnread: boolean
}

/** Explicit marks replace the manual reminder; automatic acknowledgements only advance the read position. */
export type SessionReadAction =
  | { readonly type: 'unread' }
  | { readonly type: 'read' | 'acknowledge'; readonly throughTurn: number }

/** Reconnect baseline followed by complete replacement records. */
export type SessionReadFrame =
  | { readonly type: 'baseline'; readonly items: readonly SessionReadState[] }
  | { readonly type: 'changed'; readonly state: SessionReadState }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The requested Session does not exist. */
    'session-status/not-found': { readonly sessionId: SessionId }
    /** Reading state could not be updated; the previous value remains visible. */
    'session-status/unavailable': {}
  }
}
