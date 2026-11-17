/** Session panel visibility: the persisted docking preference and pin, the transient overlay, the room probes, and the presentation. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  SessionPanelDockable, SessionPanelPresentation, SessionPanelProbes, SessionPanelRoom, SessionPanelVisibility,
} from './slots.ts'

/** localStorage key of the docking preference; stored choices keep the name they were saved under. */
export const DOCKS_STORAGE_KEY = 'dsh.sessionPanel.pinned'
/** localStorage key of the pin. */
export const PINNED_STORAGE_KEY = 'dsh.sessionPanel.held'

const NO_SESSIONS: SessionPanelDockable = new Map()
const NO_PROBES: SessionPanelProbes = new Map()
const NO_ROOM: SessionPanelRoom = { gutter: false, reserve: false }

/**
 * Decide whether a panel has a place beside the transcript: its gutter holds
 * it, or the pin is on and the transcript can make room.
 * @param room - the room of the panel's Chat View or of its Session; absent while no Chat View reports it.
 * @param visibility - shared visibility state.
 * @returns whether the panel can dock.
 */
export function hasRoom(room: SessionPanelRoom | undefined, visibility: SessionPanelVisibility): boolean {
  return room !== undefined && (room.gutter || (visibility.pinned && room.reserve))
}

/**
 * Decide how the panel shows for one Session.
 * @param room - the room of the panel's Chat View or of its Session; absent while no Chat View reports it.
 * @param visibility - shared visibility state.
 * @param sessionId - Session whose panel is decided.
 * @returns the presentation, or `hidden` when the panel renders nothing.
 */
export function presentationOf(
  room: SessionPanelRoom | undefined, visibility: SessionPanelVisibility, sessionId: SessionId,
): SessionPanelPresentation | 'hidden' {
  if (hasRoom(room, visibility)) return visibility.docks ? 'docked' : 'hidden'
  return visibility.overlay === sessionId ? 'overlay' : 'hidden'
}

function sameRoom(a: SessionPanelRoom | undefined, b: SessionPanelRoom | undefined): boolean {
  return a?.gutter === b?.gutter && a?.reserve === b?.reserve
}

/**
 * Visibility shared by every Session's toggle and panel, and the room each
 * mounted panel and each Session has to dock. The stylesheets decide the
 * room: each mounted panel renders two probes that are 1px wide while a
 * condition holds and 0 otherwise, one while its Chat View's end gutter
 * holds the docked panel and one while the transcript can make that room,
 * and this state observes only the probes, so it hears a decision flip and
 * nothing while the window resizes on one side of it or the transcript
 * grows. Docking follows one preference and one pin for all Sessions; at
 * most one Session's overlay is open, and it closes once its Session can
 * dock or no Chat View shows that Session any longer.
 */
export class SessionPanelState {
  // A stored value other than `false` keeps the default: the panel docks.
  private readonly docks = createSnapshotStore<unknown>(true, { persist: { name: DOCKS_STORAGE_KEY } })
  // A stored value other than `true` keeps the default: the panel is not pinned.
  private readonly pinned = createSnapshotStore<unknown>(false, { persist: { name: PINNED_STORAGE_KEY } })
  private readonly overlay = createSnapshotStore<SessionId | null>(null)
  private readonly room = createSnapshotStore<SessionPanelDockable>(NO_SESSIONS)
  private readonly fits = createSnapshotStore<SessionPanelProbes>(NO_PROBES)
  /** The Session of every panel with an attached probe, and which of its probes are attached. */
  private readonly owners = new Map<string, { readonly sessionId: SessionId; readonly attached: Set<keyof SessionPanelRoom> }>()
  /** Stops observing each attached probe. */
  private readonly detachers = new Set<() => void>()
  private current: SessionPanelVisibility = {
    docks: this.docks.getSnapshot() !== false, pinned: this.pinned.getSnapshot() === true, overlay: null,
  }

  /** Stops following the open overlay's Session. */
  private unfollow: () => void = () => {}

  /** Combined visibility; the snapshot keeps its identity until a member changes. */
  readonly visibility: ObservableSnapshot<SessionPanelVisibility> = {
    getSnapshot: () => {
      const docks = this.docks.getSnapshot() !== false
      const pinned = this.pinned.getSnapshot() === true
      const overlay = this.overlay.getSnapshot()
      if (docks !== this.current.docks || pinned !== this.current.pinned || overlay !== this.current.overlay) {
        this.current = { docks, pinned, overlay }
      }
      return this.current
    },
    subscribe: (listener) => {
      const offs = [this.docks.subscribe(listener), this.pinned.subscribe(listener), this.overlay.subscribe(listener)]
      return () => {
        for (const off of offs) off()
      }
    },
  }

  /**
   * The room each Session with a mounted panel has to dock it: each member is
   * true while any of the Session's Chat Views reports it. The snapshot keeps
   * its identity until a Session gains or loses its entry or its room changes.
   */
  readonly dockable: ObservableSnapshot<SessionPanelDockable> = this.room

  /**
   * The room each mounted panel's probes report. The snapshot keeps its
   * identity until a panel's probes attach, detach, or flip.
   */
  readonly probes: ObservableSnapshot<SessionPanelProbes> = this.fits

  /**
   * Create the element-ref lifecycle of one probe of a mounted panel.
   * Attaching the element enters the probe without room and observes its
   * size; a probe at least 1px wide has room. Detaching stops the
   * observation and withdraws the probe. Without `ResizeObserver` the probe
   * stays without room, so the panel shows only as an overlay.
   * @param sessionId - Session the panel's Chat View shows.
   * @param probe - identity of the panel within the page.
   * @param member - the room the probe's stylesheet width decides.
   * @returns the ref callback for the probe element.
   */
  createProbeRef(sessionId: SessionId, probe: string, member: keyof SessionPanelRoom): (element: HTMLElement | null) => void {
    let detach: (() => void) | undefined
    return (element) => {
      detach?.()
      detach = element === null ? undefined : this.attach(sessionId, probe, member, element)
    }
  }

  /**
   * Show or hide the panel from a Session's toggle. With room to dock this
   * flips the docking preference and closes any overlay; otherwise it opens
   * or closes the Session's overlay. No effect while no Chat View shows the Session.
   * @param sessionId - Session whose header holds the toggle.
   */
  toggle(sessionId: SessionId): void {
    const room = this.room.getSnapshot().get(sessionId)
    if (room === undefined) return
    const visibility = this.visibility.getSnapshot()
    if (hasRoom(room, visibility)) {
      this.docks.set(!visibility.docks)
      this.setOverlay(null)
      return
    }
    this.setOverlay(visibility.overlay === sessionId ? null : sessionId)
  }

  /**
   * Pin or unpin the panel from a Session's panel. Pinning also sets the
   * docking preference, so the panel docks wherever the transcript can make
   * room, and an open overlay then closes as its Session docks. Unpinning a
   * panel that only the pin kept beside the transcript leaves it open as the
   * Session's overlay.
   * @param sessionId - Session whose panel holds the pin.
   * @param pinned - the new pin.
   */
  setPinned(sessionId: SessionId, pinned: boolean): void {
    if (pinned) {
      this.docks.set(true)
      this.pinned.set(true)
      return
    }
    const room = this.room.getSnapshot().get(sessionId)
    const held = room?.gutter === false && presentationOf(room, this.visibility.getSnapshot(), sessionId) === 'docked'
    this.pinned.set(false)
    if (held) this.setOverlay(sessionId)
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
      const room = this.room.getSnapshot().get(sessionId)
      if (room === undefined || hasRoom(room, this.visibility.getSnapshot())) this.closeOverlay(sessionId)
    }
    const offs = [this.room.subscribe(check), this.pinned.subscribe(check)]
    this.unfollow = () => {
      for (const off of offs) off()
    }
  }

  private attach(sessionId: SessionId, probe: string, member: keyof SessionPanelRoom, element: HTMLElement): () => void {
    this.report(sessionId, probe, member, false)
    const measure: ResizeObserverCallback = (entries) => {
      for (const entry of entries) this.report(sessionId, probe, member, entry.contentRect.width >= 1)
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    const detach = (): void => {
      // The ref callback and dispose may both detach; the first one withdraws the probe.
      if (!this.detachers.delete(detach)) return
      observer?.disconnect()
      this.report(sessionId, probe, member, null)
    }
    this.detachers.add(detach)
    return detach
  }

  /** Record what one probe decided, or its withdrawal, publishing only what changed. */
  private report(sessionId: SessionId, probe: string, member: keyof SessionPanelRoom, has: boolean | null): void {
    const owner = this.owners.get(probe) ?? { sessionId, attached: new Set<keyof SessionPanelRoom>() }
    if (has === null) owner.attached.delete(member)
    else owner.attached.add(member)
    const fits = this.fits.getSnapshot()
    const before = fits.get(probe)
    // A panel keeps its entry while either of its probes is attached; a withdrawn probe reports no room.
    const after = owner.attached.size === 0 ? undefined : { ...before ?? NO_ROOM, [member]: has === true }
    if (after === undefined) this.owners.delete(probe)
    else this.owners.set(probe, owner)
    if (!sameRoom(before, after)) {
      const next = new Map(fits)
      if (after === undefined) next.delete(probe)
      else next.set(probe, after)
      this.fits.set(next)
    }
    let any: SessionPanelRoom | undefined
    for (const [id, own] of this.fits.getSnapshot()) {
      if (this.owners.get(id)?.sessionId !== sessionId) continue
      any = { gutter: any?.gutter === true || own.gutter, reserve: any?.reserve === true || own.reserve }
    }
    const room = this.room.getSnapshot()
    if (sameRoom(room.get(sessionId), any)) return
    const next = new Map(room)
    if (any === undefined) next.delete(sessionId)
    else next.set(sessionId, any)
    this.room.set(next)
  }
}
