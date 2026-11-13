/** Session panel visibility: the persisted docking preference, the transient overlay, each Session's room to dock, and the presentation. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPanelDockable, SessionPanelPresentation, SessionPanelVisibility } from './slots.ts'

/** localStorage key of the docking preference. */
export const PINNED_STORAGE_KEY = 'dsh.sessionPanel.pinned'

/**
 * Smallest end gutter that holds the docked panel, in CSS px: 48px clear of
 * the transcript column (past the width handle's 24px offset and 10px strip),
 * the panel's 280px minimum width, and a 16px edge margin.
 */
export const DOCK_MIN_GUTTER = 344

const NO_ENTRIES: SessionPanelDockable = new Map()

/**
 * Whether a Chat View's end gutter can hold the docked panel.
 * @param endGutter - the gutter in CSS px.
 * @returns true when the panel can dock without covering the transcript.
 */
export function fitsGutter(endGutter: number): boolean {
  return endGutter >= DOCK_MIN_GUTTER
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
 * Visibility shared by every Session's toggle and panel, and whether each
 * Session has room to dock, derived from the end gutters of the Chat Views
 * whose panels are mounted. Docking follows one preference for all Sessions;
 * at most one Session's overlay is open, and it closes once its Session has
 * room to dock or no Chat View shows that Session any longer.
 */
export class SessionPanelState {
  // A stored value other than `false` keeps the default: the panel docks.
  private readonly pinned = createSnapshotStore<unknown>(true, { persist: { name: PINNED_STORAGE_KEY } })
  private readonly overlay = createSnapshotStore<SessionId | null>(null)
  private readonly room = createSnapshotStore<SessionPanelDockable>(NO_ENTRIES)
  /** The Chat View gutter source of every mounted panel, by Session; each registration is its own entry. */
  private readonly sources = new Map<SessionId, Set<{ readonly gutter: ObservableSnapshot<number> }>>()
  private current: SessionPanelVisibility = { pinned: this.pinned.getSnapshot() !== false, overlay: null }
  /** Stops following the open overlay's gutter. */
  private unfollow: () => void = () => {}

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
   * Whether each Session with a mounted panel has room to dock it. The
   * snapshot keeps its identity until a Session gains or loses its entry or
   * crosses the docking threshold, so a resize that stays on one side of the
   * threshold publishes nothing.
   */
  readonly dockable: ObservableSnapshot<SessionPanelDockable> = this.room

  /**
   * Follow the Chat View gutter of one mounted panel until the returned
   * disposer runs; a Session has room to dock while any of its sources does.
   * @param sessionId - Session the panel's Chat View shows.
   * @param gutter - the Chat View's end gutter source.
   * @returns stops following the source.
   */
  track(sessionId: SessionId, gutter: ObservableSnapshot<number>): () => void {
    const entry = { gutter }
    const sources = this.sources.get(sessionId) ?? new Set()
    sources.add(entry)
    this.sources.set(sessionId, sources)
    const off = gutter.subscribe(() => { this.publish(sessionId) })
    this.publish(sessionId)
    return () => {
      off()
      sources.delete(entry)
      if (sources.size === 0) this.sources.delete(sessionId)
      this.publish(sessionId)
    }
  }

  /**
   * Show or hide the panel from a Session's toggle. With room to dock this
   * flips the docking preference and closes any overlay; otherwise it opens
   * or closes the Session's overlay. No effect while no Chat View shows the Session.
   * @param sessionId - Session whose header holds the toggle.
   */
  toggle(sessionId: SessionId): void {
    const dockable = this.room.getSnapshot().get(sessionId)
    if (dockable === undefined) return
    if (dockable) {
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

  /** Stop following the open overlay's gutter. */
  dispose(): void {
    this.unfollow()
    this.unfollow = () => {}
  }

  private setOverlay(sessionId: SessionId | null): void {
    this.dispose()
    this.overlay.set(sessionId)
    if (sessionId === null) return
    const check = (): void => {
      if (this.room.getSnapshot().get(sessionId) !== false) this.closeOverlay(sessionId)
    }
    this.unfollow = this.room.subscribe(check)
  }

  /** Recompute one Session's room to dock from its sources, publishing only a changed entry. */
  private publish(sessionId: SessionId): void {
    const sources = this.sources.get(sessionId)
    const dockable = sources === undefined ? undefined : [...sources].some(source => fitsGutter(source.gutter.getSnapshot()))
    const room = this.room.getSnapshot()
    if (room.get(sessionId) === dockable) return
    const next = new Map(room)
    if (dockable === undefined) next.delete(sessionId)
    else next.set(sessionId, dockable)
    this.room.set(next)
  }
}
