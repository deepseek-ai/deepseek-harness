/** Per-Session geometry of the main Conversation body, published through `ctx.uiConversation.layouts`. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationLayout } from '../contract/slots.ts'

const NO_LAYOUT: ConversationLayout = Object.freeze({ endGutter: 0, shown: false })

interface LayoutEntry {
  /** Last end gutter the main body's width controls measured, in CSS px. */
  measured: number
  /** Whether the main body shows the Session. */
  shown: boolean
  /** Whether the Session's active View follows the transcript column; false before the first activation. */
  followsTranscript: boolean
  readonly store: SnapshotStore<ConversationLayout>
  /** Withdraw the release registered on the Session's scope. */
  release: () => void
}

/**
 * Layout facts of the main Conversation body, kept per Session until the
 * Session's binding scope is released. The Conversation shell writes them:
 * the main body's width controls report the measured end gutter and when the
 * body stops showing the Session, and View activation reports whether the
 * active View follows the transcript column (only Chat does). The published
 * gutter is zero while it does not, because such a View fills the body.
 * Floating chrome reads one Session's facts through `source`.
 */
export class ConversationLayouts {
  private readonly entries = new Map<SessionId, LayoutEntry>()

  /**
   * @param scopeOf - the binding scope of a Session, whose release drops the
   * Session's layout; undefined keeps the layout until `dispose`.
   */
  constructor(private readonly scopeOf: (sessionId: SessionId) => Context | undefined) {}

  /**
   * Read one Session's layout source.
   * @param sessionId - Session whose main body geometry is read.
   * @returns a source whose identity is stable while the Session stays bound and whose snapshot keeps its identity until a fact changes.
   */
  source(sessionId: SessionId): ObservableSnapshot<ConversationLayout> {
    return this.entryOf(sessionId).store
  }

  /**
   * Record the end gutter the main body measured while showing a Session, or that it stopped showing it.
   * @param sessionId - Session the main body shows or showed.
   * @param endGutter - space between the transcript column's end edge and the body's end edge, in CSS px;
   * null when the body stops showing the Session.
   */
  measure(sessionId: SessionId, endGutter: number | null): void {
    // A Session already released is not shown; recording that would only recreate its entry.
    if (endGutter === null && !this.entries.has(sessionId)) return
    const entry = this.entryOf(sessionId)
    entry.shown = endGutter !== null
    entry.measured = endGutter === null ? 0 : Math.max(0, endGutter)
    this.publish(entry)
  }

  /**
   * Record whether the View a Session activated follows the transcript column.
   * @param sessionId - Session whose View changed.
   * @param followsTranscript - true for a View laid out on the transcript column.
   */
  activate(sessionId: SessionId, followsTranscript: boolean): void {
    const entry = this.entryOf(sessionId)
    entry.followsTranscript = followsTranscript
    this.publish(entry)
  }

  /** Drop every Session's layout and withdraw the releases registered on their scopes. */
  dispose(): void {
    for (const entry of [...this.entries.values()]) entry.release()
    this.entries.clear()
  }

  private entryOf(sessionId: SessionId): LayoutEntry {
    const existing = this.entries.get(sessionId)
    if (existing !== undefined) return existing
    const entry: LayoutEntry = {
      measured: 0, shown: false, followsTranscript: false, store: createSnapshotStore(NO_LAYOUT), release: () => {},
    }
    this.entries.set(sessionId, entry)
    const scope = this.scopeOf(sessionId)
    if (scope !== undefined) {
      // Readers holding the source learn that a released Session is no longer shown.
      const dispose = scope.effect(() => () => {
        this.entries.delete(sessionId)
        entry.store.set(NO_LAYOUT)
      }, 'ui-conversation layout')
      entry.release = () => { void dispose() }
    }
    return entry
  }

  private publish(entry: LayoutEntry): void {
    const endGutter = entry.followsTranscript ? entry.measured : 0
    const current = entry.store.getSnapshot()
    if (current.endGutter === endGutter && current.shown === entry.shown) return
    entry.store.set(endGutter === 0 && !entry.shown ? NO_LAYOUT : { endGutter, shown: entry.shown })
  }
}
