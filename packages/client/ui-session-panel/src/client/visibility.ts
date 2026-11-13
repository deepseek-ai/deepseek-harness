/** Session panel visibility: the persisted docking preference, the transient overlay, the dock probes, and the presentation. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPanelDockable, SessionPanelPresentation, SessionPanelProbes, SessionPanelVisibility } from './slots.ts'

/** localStorage key of the docking preference. */
export const PINNED_STORAGE_KEY = 'dsh.sessionPanel.pinned'

const NO_SESSIONS: SessionPanelDockable = new Map()
const NO_PROBES: SessionPanelProbes = new Map()

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
 * mounted panel and each Session has room to dock. The panel's stylesheet
 * decides the room: each mounted panel renders a dock probe that is 1px wide
 * while its Chat View's end gutter holds the docked panel and 0 otherwise,
 * and this state observes only that probe, so it hears the decision flip
 * and nothing while the window resizes on one side of it or the transcript
 * grows. Docking follows one preference for all Sessions; at most one
 * Session's overlay is open, and it closes once its Session has room to dock
 * or no Chat View shows that Session any longer.
 */
export class SessionPanelState {
  // A stored value other than `false` keeps the default: the panel docks.
  private readonly pinned = createSnapshotStore<unknown>(true, { persist: { name: PINNED_STORAGE_KEY } })
  private readonly overlay = createSnapshotStore<SessionId | null>(null)
  private readonly room = createSnapshotStore<SessionPanelDockable>(NO_SESSIONS)
  private readonly fits = createSnapshotStore<SessionPanelProbes>(NO_PROBES)
  /** The Session of every attached probe. */
  private readonly owners = new Map<string, SessionId>()
  /** Stops observing each attached probe. */
  private readonly detachers = new Set<() => void>()
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
   * Whether each Session with a mounted panel has room to dock it: true while
   * any of its probes does. The snapshot keeps its identity until a Session
   * gains or loses its entry or its room changes.
   */
  readonly dockable: ObservableSnapshot<SessionPanelDockable> = this.room

  /**
   * Whether each attached probe's gutter holds the docked panel. The snapshot
   * keeps its identity until a probe attaches, detaches, or flips.
   */
  readonly probes: ObservableSnapshot<SessionPanelProbes> = this.fits

  /**
   * Create the element-ref lifecycle of one mounted panel's dock probe.
   * Attaching the element enters the probe without room and observes its
   * size; a probe at least 1px wide has room. Detaching stops the
   * observation and withdraws the probe. Without `ResizeObserver` the probe
   * stays without room, so the panel shows only as an overlay.
   * @param sessionId - Session the panel's Chat View shows.
   * @param probe - identity of the panel within the page.
   * @returns the ref callback for the probe element.
   */
  createProbeRef(sessionId: SessionId, probe: string): (element: HTMLElement | null) => void {
    let detach: (() => void) | undefined
    return (element) => {
      detach?.()
      detach = element === null ? undefined : this.attach(sessionId, probe, element)
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

  /** Stop following the open overlay's Session and stop observing every attached probe. */
  dispose(): void {
    this.stopFollowing()
    for (const detach of [...this.detachers]) detach()
  }

  private stopFollowing(): void {
    this.unfollow()
    this.unfollow = () => {}
  }

  private setOverlay(sessionId: SessionId | null): void {
    this.stopFollowing()
    this.overlay.set(sessionId)
    if (sessionId === null) return
    const check = (): void => {
      if (this.room.getSnapshot().get(sessionId) !== false) this.closeOverlay(sessionId)
    }
    this.unfollow = this.room.subscribe(check)
  }

  private attach(sessionId: SessionId, probe: string, element: HTMLElement): () => void {
    this.report(sessionId, probe, false)
    const measure: ResizeObserverCallback = (entries) => {
      for (const entry of entries) this.report(sessionId, probe, entry.contentRect.width >= 1)
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    const detach = (): void => {
      // The ref callback and dispose may both detach; the first one withdraws the probe.
      if (!this.detachers.delete(detach)) return
      observer?.disconnect()
      this.report(sessionId, probe, null)
    }
    this.detachers.add(detach)
    return detach
  }

  /** Record one probe's room, or its withdrawal, publishing only what changed. */
  private report(sessionId: SessionId, probe: string, dockable: boolean | null): void {
    const fits = this.fits.getSnapshot()
    if (fits.get(probe) !== (dockable ?? undefined)) {
      const next = new Map(fits)
      if (dockable === null) {
        next.delete(probe)
        this.owners.delete(probe)
      } else {
        next.set(probe, dockable)
        this.owners.set(probe, sessionId)
      }
      this.fits.set(next)
    }
    let any: boolean | undefined
    for (const [id, owner] of this.owners) {
      if (owner === sessionId) any = any === true || this.fits.getSnapshot().get(id) === true
    }
    const room = this.room.getSnapshot()
    if (room.get(sessionId) === any) return
    const next = new Map(room)
    if (any === undefined) next.delete(sessionId)
    else next.set(sessionId, any)
    this.room.set(next)
  }
}
