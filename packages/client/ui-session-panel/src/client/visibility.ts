/** Session panel visibility: the persisted docking preference, the transient overlay, and their presentation. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationLayout } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionPanelPresentation, SessionPanelVisibility } from './slots.ts'

/** localStorage key of the docking preference. */
export const PINNED_STORAGE_KEY = 'dsh.sessionPanel.pinned'

/**
 * Smallest end gutter that holds the docked panel, in CSS px: 48px clear of
 * the transcript column (past the width handle's 24px offset and 10px strip),
 * the panel's 280px minimum width, and a 16px edge margin.
 */
export const DOCK_MIN_GUTTER = 344

/**
 * Whether the main body's end gutter can hold the docked panel.
 * @param layout - main body geometry of the Session.
 * @returns true when the panel can dock without covering the transcript.
 */
export function fitsLayout(layout: ConversationLayout): boolean {
  return layout.endGutter >= DOCK_MIN_GUTTER
}

/**
 * Decide how the panel shows for one Session.
 * @param fits - whether the gutter can hold the docked panel.
 * @param visibility - shared visibility state.
 * @param sessionId - Session whose panel is decided.
 * @returns the presentation, or `hidden` when the panel renders nothing.
 */
export function presentationOf(
  fits: boolean, visibility: SessionPanelVisibility, sessionId: SessionId,
): SessionPanelPresentation | 'hidden' {
  if (fits) return visibility.pinned ? 'docked' : 'hidden'
  return visibility.overlay === sessionId ? 'overlay' : 'hidden'
}

/**
 * Visibility shared by every Session's toggle and panel. Docking follows one
 * preference for all Sessions; at most one Session's overlay is open, and it
 * closes once its Session's gutter can hold the docked panel or the main body
 * stops showing that Session.
 */
export class SessionPanelState {
  // A stored value other than `false` keeps the default: the panel docks.
  private readonly pinned = createSnapshotStore<unknown>(true, { persist: { name: PINNED_STORAGE_KEY } })
  private readonly overlay = createSnapshotStore<SessionId | null>(null)
  private current: SessionPanelVisibility = { pinned: this.pinned.getSnapshot() !== false, overlay: null }
  /** Stops following the open overlay's layout. */
  private unfollow: () => void = () => {}

  /** @param layoutOf - main body layout of a Session, which an open overlay follows. */
  constructor(private readonly layoutOf: (sessionId: SessionId) => ObservableSnapshot<ConversationLayout>) {}

  /** Combined visibility; the snapshot keeps its identity until a member changes. */
  readonly visibility: ObservableSnapshot<SessionPanelVisibility> = {
    getSnapshot: () => {
      const pinned = this.pinned.getSnapshot() !== false
      const overlay = this.overlay.getSnapshot()
      if (pinned !== this.current.pinned || overlay !== this.current.overlay) this.current = { pinned, overlay }
      return this.current
    },
    subscribe: (listener) => {
      const offPinned = this.pinned.subscribe(listener)
      const offOverlay = this.overlay.subscribe(listener)
      return () => {
        offPinned()
        offOverlay()
      }
    },
  }

  /**
   * Show or hide the panel from a Session's toggle.
   * @param sessionId - Session whose header holds the toggle.
   * @param fits - whether the gutter can hold the docked panel now.
   */
  toggle(sessionId: SessionId, fits: boolean): void {
    if (fits) {
      this.pinned.set(!this.visibility.getSnapshot().pinned)
      this.setOverlay(null)
      return
    }
    this.setOverlay(this.overlay.getSnapshot() === sessionId ? null : sessionId)
  }

  /**
   * Close a Session's overlay.
   * @param sessionId - Session whose overlay closes; another Session's overlay stays open.
   */
  closeOverlay(sessionId: SessionId): void {
    if (this.overlay.getSnapshot() === sessionId) this.setOverlay(null)
  }

  /** Stop following the open overlay's layout. */
  dispose(): void {
    this.unfollow()
    this.unfollow = () => {}
  }

  private setOverlay(sessionId: SessionId | null): void {
    this.dispose()
    this.overlay.set(sessionId)
    if (sessionId === null) return
    const layout = this.layoutOf(sessionId)
    const check = (): void => {
      const current = layout.getSnapshot()
      if (fitsLayout(current) || !current.shown) this.closeOverlay(sessionId)
    }
    this.unfollow = layout.subscribe(check)
  }
}
