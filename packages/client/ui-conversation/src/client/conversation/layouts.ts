/** Per-Session geometry of the main Conversation body, published through `ctx.uiConversation.layouts`. */
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationLayout } from '../contract/slots.ts'

const NO_LAYOUT: ConversationLayout = Object.freeze({ endGutter: 0 })

interface LayoutEntry {
  /** Last end gutter the main body's width controls measured, in CSS px. */
  measured: number
  /** Whether the Session's active View follows the transcript column; false before the first activation. */
  followsTranscript: boolean
  readonly store: SnapshotStore<ConversationLayout>
}

/**
 * Layout facts of the main Conversation body, kept per Session for the
 * lifetime of the Conversation plugin. The Conversation shell writes them:
 * the main body's width controls report the measured end gutter, and View
 * activation reports whether the active View follows the transcript column.
 * The published gutter is zero while it does not, because such a View fills
 * the body. Floating chrome reads one Session's facts through `source`.
 */
export class ConversationLayouts {
  private readonly entries = new Map<SessionId, LayoutEntry>()

  /**
   * Read one Session's layout source.
   * @param sessionId - Session whose main body geometry is read.
   * @returns a source whose identity is stable per Session and whose snapshot keeps its identity until the gutter changes.
   */
  source(sessionId: SessionId): ObservableSnapshot<ConversationLayout> {
    return this.entryOf(sessionId).store
  }

  /**
   * Record the end gutter the main body measured while showing a Session.
   * @param sessionId - Session the main body shows.
   * @param endGutter - space between the transcript column's end edge and the body's end edge, in CSS px.
   */
  measure(sessionId: SessionId, endGutter: number): void {
    const entry = this.entryOf(sessionId)
    entry.measured = Math.max(0, endGutter)
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

  private entryOf(sessionId: SessionId): LayoutEntry {
    let entry = this.entries.get(sessionId)
    if (entry === undefined) {
      entry = { measured: 0, followsTranscript: false, store: createSnapshotStore(NO_LAYOUT) }
      this.entries.set(sessionId, entry)
    }
    return entry
  }

  private publish(entry: LayoutEntry): void {
    const endGutter = entry.followsTranscript ? entry.measured : 0
    if (entry.store.getSnapshot().endGutter === endGutter) return
    entry.store.set(endGutter === 0 ? NO_LAYOUT : { endGutter })
  }
}
