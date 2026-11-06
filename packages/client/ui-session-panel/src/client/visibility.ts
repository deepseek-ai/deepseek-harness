/** Session panel visibility: the persisted docking preference, the transient overlay, the Chat View gutters, and their presentation. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPanelGutters, SessionPanelPresentation, SessionPanelVisibility } from './slots.ts'

/** localStorage key of the docking preference. */
export const PINNED_STORAGE_KEY = 'dsh.sessionPanel.pinned'

/**
 * Smallest end gutter that holds the docked panel, in CSS px: 48px clear of
 * the transcript column (past the width handle's 24px offset and 10px strip),
 * the panel's 280px minimum width, and a 16px edge margin.
 */
export const DOCK_MIN_GUTTER = 344

const NO_GUTTERS: SessionPanelGutters = new Map()

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
 * Visibility shared by every Session's toggle and panel, and the end gutter
 * each mounted panel reports from its Chat View. Docking follows one
 * preference for all Sessions; at most one Session's overlay is open, and it
 * closes once its Session's gutter can hold the docked panel or no Chat View
 * shows that Session any longer.
 */
export class SessionPanelState {
  // A stored value other than `false` keeps the default: the panel docks.
  private readonly pinned = createSnapshotStore<unknown>(true, { persist: { name: PINNED_STORAGE_KEY } })
  private readonly overlay = createSnapshotStore<SessionId | null>(null)
  private readonly widest = createSnapshotStore<SessionPanelGutters>(NO_GUTTERS)
  /** Gutter of every mounted panel, by Session and panel instance. */
  private readonly reports = new Map<SessionId, Map<string, number>>()
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

  /** The widest gutter of each Session with a mounted panel; the snapshot keeps its identity until one changes. */
  readonly gutters: ObservableSnapshot<SessionPanelGutters> = this.widest

  /**
   * Record the end gutter of one mounted panel, or that it unmounted.
   * @param sessionId - Session the panel's Chat View shows.
   * @param instance - identity of the panel within the page.
   * @param endGutter - the gutter in CSS px, or null when the panel unmounts or leaves the Session.
   */
  measure(sessionId: SessionId, instance: string, endGutter: number | null): void {
    const panels = this.reports.get(sessionId) ?? new Map<string, number>()
    if (endGutter === null) panels.delete(instance)
    else panels.set(instance, endGutter)
    if (panels.size === 0) this.reports.delete(sessionId)
    else this.reports.set(sessionId, panels)
    const widest = panels.size === 0 ? undefined : Math.max(...panels.values())
    const gutters = this.widest.getSnapshot()
    if (gutters.get(sessionId) === widest) return
    const next = new Map(gutters)
    if (widest === undefined) next.delete(sessionId)
    else next.set(sessionId, widest)
    this.widest.set(next)
  }

  /**
   * Show or hide the panel from a Session's toggle. With room to dock this
   * flips the docking preference and closes any overlay; otherwise it opens
   * or closes the Session's overlay. No effect while no Chat View shows the Session.
   * @param sessionId - Session whose header holds the toggle.
   */
  toggle(sessionId: SessionId): void {
    const gutter = this.widest.getSnapshot().get(sessionId)
    if (gutter === undefined) return
    if (fitsGutter(gutter)) {
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
      const gutter = this.widest.getSnapshot().get(sessionId)
      if (gutter === undefined || fitsGutter(gutter)) this.closeOverlay(sessionId)
    }
    this.unfollow = this.widest.subscribe(check)
  }
}
