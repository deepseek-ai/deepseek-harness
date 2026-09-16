/** Controller and UI-domain fixture shapes for the client test runtime. */
import type {
  ISession, SessionEventLikeEntry, SessionSnapshot, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  EMPTY_CONVERSATION_SNAPSHOT,
  type ConversationSnapshot,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  EMPTY_CHAT_SNAPSHOT,
  type ChatSnapshot,
} from '@deepseek-ai/dsh-client-ui-chat/client'

/**
 * Fixture overrides for the session behavior face: any subset of the
 * production ISession verbs (typed against it, so a face change surfaces
 * here at compile time), plus extra members feature-specific casts consume.
 * The open Record tail means a misnamed EXTRA member is not caught by the
 * compiler (it grafts as dead weight); the ISession verbs stay safe — a
 * misnamed verb leaves the fail-loud stub in place, which names itself at
 * the first call.
 */
export type SessionBehaviorOverrides = Partial<ISession> & Record<string, unknown>

/**
 * act-wrapped mutation runner shared by every runtime object: public mutators
 * funnel through it so tests never handle SlotCore microtask batching or
 * React act themselves.
 */
export type Stabilizer = (fn: () => void | Promise<void>) => Promise<void>

/** Mutable top-level snapshot fields accepted by fixture update callbacks. */
export type FixtureSnapshot<T> = { -readonly [Key in keyof T]: T[Key] }

/** Writable test representation of the immutable Session Controller snapshot. */
export type SessionFixtureSnapshot = FixtureSnapshot<SessionSnapshot>

/**
 * Session fixture accepted by {@link TestSessions.add}: identity plus optional
 * snapshot/list-row overrides and the session behavior face the feature under
 * test actually calls (kept open — the runtime never fakes methods a test did
 * not supply, so an unstubbed call fails loud at the call site).
 */
export interface SessionFixture {
  id: string
  /** Overrides merged over {@link sessionSnapshot}; Conversation data arrives through the event feed. */
  snapshot?: Partial<Omit<SessionSnapshot, 'sessionId'>>
  /** List-row overrides merged over the defaults derived from `id`. */
  summary?: Partial<Omit<SessionSummary, 'id'>>
  /** Session behavior face: exactly the methods the feature under test calls (ISession subset + extras). */
  session?: SessionBehaviorOverrides
  /** Initial contiguous event window consumed by Conversation assembly. */
  events?: readonly SessionEventLikeEntry[]
  /** Whether the initial event window has an older page. */
  hasMore?: boolean
}

/**
 * A complete quiescent Session Controller snapshot.
 * @param sessionId - owning session id.
 * @returns the snapshot; spread fixture overrides on top.
 */
export function sessionSnapshot(sessionId: SessionId): SessionSnapshot {
  return {
    sessionId,
    pendingSubmissions: [],
    running: false,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  }
}

/**
 * A target-neutral Conversation snapshot.
 * @param overrides - target roster or activity overrides.
 * @returns an immutable fixture value.
 */
export function conversationSnapshot(
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot {
  return { ...EMPTY_CONVERSATION_SNAPSHOT, ...overrides }
}

/**
 * A Chat target snapshot.
 * @param overrides - Chat target overrides.
 * @returns an immutable fixture value.
 */
export function chatSnapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return { ...EMPTY_CHAT_SNAPSHOT, ...overrides }
}

/**
 * A ready Workspace Controller snapshot with no Workspace rows.
 * @returns the initial state of the test Workspace source.
 */
export function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    items: [],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  }
}
