/** Per-session Conversation store shared by the shell body and header. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationFocus, ConversationStoreState, ConversationViewRequest } from './contract/views.ts'
import type { DraftInput, DraftSnapshot } from './contract/draft-editor.ts'
import { parseStoredDraft } from './draft.ts'

const CONVERSATION_STORE_KEY = 'dsh.conversation'

/** Declared write set for the Conversation shell. */
type ConversationActions = {
  setDraft: (draft: ConversationStoreState, text: DraftInput) => void
  setView: (draft: ConversationStoreState, view: string) => void
  openView: (draft: ConversationStoreState, view: string, focus: ConversationFocus) => void
  completeViewRequest: (draft: ConversationStoreState) => void
}

/**
 * Declare per-session draft persistence and View selection.
 * @returns the store handle.
 */
export function createConversationStore(): EngineStoreHandle<ConversationStoreState, ConversationActions> {
  return defineStore({
    init: (): ConversationStoreState => ({ draft: '', view: null, viewRequest: null }),
    persist: CONVERSATION_STORE_KEY,
    actions: {
      setDraft: (d, text: DraftInput) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      openView: (d, view: string, focus: ConversationFocus) => {
        d.view = view
        d.viewRequest = { view, focus }
      },
      completeViewRequest: (d) => { d.viewRequest = null },
    },
  })
}

/**
 * Read the pending focus request restored from storage. The request is returned only when its `focus`
 * is an object with a string `kind`; any other value is dropped because the request is a one-shot jump.
 * Payload fields are not validated, because plugins add kinds; Views read them defensively.
 * @param request - `viewRequest` as rehydrated from the persisted store value.
 * @returns the request when its focus carries a kind tag, otherwise null.
 */
export function restoredViewRequest(request: unknown): ConversationViewRequest | null {
  if (typeof request !== 'object' || request === null) return null
  if (!('view' in request) || typeof request.view !== 'string') return null
  if (!('focus' in request) || typeof request.focus !== 'object' || request.focus === null) return null
  if (!('kind' in request.focus) || typeof request.focus.kind !== 'string') return null
  // The kind tag is the persisted discriminant; Views switch on it and ignore kinds they do not accept.
  return request as ConversationViewRequest
}

/**
 * Read a Session's draft before its input source is published to React.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns saved semantic content, or an empty document when storage is absent or invalid.
 */
export function readConversationDraft(sessionId: SessionId): DraftSnapshot {
  const empty: DraftSnapshot = { text: '', references: [] }
  if (typeof localStorage === 'undefined') return empty
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return empty
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('draft' in stored)) return empty
    return parseStoredDraft(stored.draft) ?? empty
  } catch (_error: unknown) {
    // Unavailable browser storage or malformed JSON has no usable saved draft.
    return empty
  }
}

/**
 * Read the persisted View preference before the Slot store is materialized.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns the preferred View id, or null when storage has no usable value.
 */
export function readConversationViewPreference(sessionId: SessionId): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return null
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('view' in stored)) return null
    return typeof stored.view === 'string' ? stored.view : null
  } catch {
    return null
  }
}
