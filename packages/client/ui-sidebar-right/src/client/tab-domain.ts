/**
 * The Tab domain: what a tab record carries that the layout does not.
 *
 * One `TabOccurrence` per open record, keyed by (session, tab id): where the
 * tab was navigated to, an abort signal spanning the record's life, and the
 * actions the tab may take on itself. Holding a record also pins its address in
 * the resource model, so switching tabs unmounts a body without dropping its
 * content.
 *
 * `sync` reconciles occurrences against one session's layout after every
 * commit: a record that appeared is pinned, one that vanished (closed, or its
 * open undone) is aborted and dropped. A record restored by undo is a new
 * occurrence and is fetched again if the resource model already let it go. The
 * controller syncs each session from that session's adopted store on every
 * commit, on screen or not, so a record closed from another session's seat is
 * aborted on that commit. The slot framework binds the navigation sources for
 * each record's `useTabInfo` reader.
 */
import type { LayoutState, PaneId, TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import { findTabPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightNavigationParams } from './contract/params.ts'
import type { SidebarRightTabActions, SidebarRightTabNavigation, SidebarRightTabPlacement } from './contract/slots.ts'
import type { SidebarRightOpenResourceOptions, SidebarRightOpenTabOptions, SidebarRightPlacement } from './service.ts'

/**
 * The navigation face a tab's actions call back into, aimed at the session the
 * tab is in; nothing happens for a session whose store is not adopted.
 */
export interface SidebarRightNavigator {
  /** Open a resource in one session; see `ISidebarRight.openResource`. */
  openResourceIn(sessionId: SessionId, address: string, options?: SidebarRightOpenResourceOptions): void
  /** Open a page type in one session; see `ISidebarRight.openTab`. */
  openTabIn(sessionId: SessionId, kind: string, options?: SidebarRightOpenTabOptions): void
  /** Close a tab of one session. */
  closeIn(sessionId: SessionId, tabId: TabId): void
}

/** `ctx.resources.pin`: hold an address's content open for as long as `signal` lives. */
export type PinResource = (address: string, signal: AbortSignal) => void

/** What one open tab record holds beyond its layout entry. */
export interface TabOccurrence {
  readonly sessionId: SessionId
  readonly tabId: TabId
  /** Aborted when the record disappears or this package unloads. */
  readonly signal: AbortSignal
  /** The latest navigation aimed at the record; `set` on every `navigate`. */
  readonly navigation: SnapshotStore<SidebarRightTabNavigation>
  /** Stable for the occurrence's life, so a body may hold it. */
  readonly tabActions: SidebarRightTabActions
}

/** An occurrence plus what only the domain touches. */
interface Held extends TabOccurrence {
  readonly controller: AbortController
  /** The docked pane holding the record at the last sync; `undefined` while it floats or before any sync. */
  paneId: PaneId | undefined
  /** Whether the resource model has been asked to hold the address. */
  pinned: boolean
}

/** Every session's occurrences. */
export class TabDomain {
  private readonly bySession = new Map<SessionId, Map<TabId, Held>>()

  /**
   * @param navigator - where tab actions go, aimed at the tab's session; the navigation controller.
   * @param pin - `ctx.resources.pin`, called once per occurrence at its first sync.
   */
  constructor(
    private readonly navigator: SidebarRightNavigator,
    private readonly pin: PinResource,
  ) {}

  /**
   * Reconcile one session's occurrences with its committed layout.
   *
   * Called by the seat after every commit, and only then: aborting a vanished
   * record runs the types' cleanup, which writes their stores.
   * @param sessionId - the session whose layout committed.
   * @param layout - that session's layout as committed.
   */
  sync(sessionId: SessionId, layout: LayoutState): void {
    const held = this.session(sessionId)
    for (const [tabId, occurrence] of held) {
      if (layout.tabs[tabId] !== undefined) continue
      held.delete(tabId)
      occurrence.controller.abort()
    }
    for (const tab of Object.values(layout.tabs)) {
      const occurrence = held.get(tab.id) ?? this.hold(sessionId, tab.id, { address: tab.contentId, params: undefined, revision: 0 })
      const pane = findTabPane(layout, tab.id)
      occurrence.paneId = pane.host === 'dock' ? pane.id : undefined
      if (occurrence.pinned) continue
      occurrence.pinned = true
      this.pin(occurrence.navigation.getSnapshot().address, occurrence.signal)
    }
  }

  /**
   * Read an occurrence created by navigation or committed-store reconciliation.
   * @param sessionId - the session the record is in.
   * @param tab - the record being drawn.
   * @returns its occurrence.
   * @throws when the record has not been reconciled or has disappeared.
   */
  occurrence(sessionId: SessionId, tab: Pick<TabRecord, 'id'>): TabOccurrence {
    const occurrence = this.bySession.get(sessionId)?.get(tab.id)
    if (occurrence === undefined) throw new Error(`sidebarRight: tab "${tab.id}" has no committed occurrence in session "${sessionId}"`)
    return occurrence
  }

  /**
   * Record that an `open` settled on a tab.
   *
   * A record the layout has not yet shown the seat gets its occurrence here, so
   * the body's first render already carries the opener's `params`.
   * @param sessionId - the session opened into.
   * @param tabId - the tab the open settled on.
   * @param target - the address and the opener's params.
   */
  navigate(sessionId: SessionId, tabId: TabId, target: { address: string; params: SidebarRightNavigationParams }): void {
    const existing = this.session(sessionId).get(tabId)
    if (existing === undefined) {
      this.hold(sessionId, tabId, { ...target, revision: 1 })
      return
    }
    existing.navigation.set({ ...target, revision: existing.navigation.getSnapshot().revision + 1 })
  }

  /** Abort every occurrence of every session; the package is unloading. */
  dispose(): void {
    for (const held of this.bySession.values()) {
      for (const occurrence of held.values()) occurrence.controller.abort()
    }
    this.bySession.clear()
  }

  private session(sessionId: SessionId): Map<TabId, Held> {
    let held = this.bySession.get(sessionId)
    if (held === undefined) {
      held = new Map()
      this.bySession.set(sessionId, held)
    }
    return held
  }

  private hold(sessionId: SessionId, tabId: TabId, navigation: SidebarRightTabNavigation): Held {
    const controller = new AbortController()
    const { navigator } = this
    // Where an open from this tab lands, read at call time because the tab may
    // have been dragged since: `replaceTab: true` names this tab; otherwise the
    // pane holding it, unless the caller named another.
    const place = (placement: SidebarRightTabPlacement): SidebarRightPlacement => ({
      ...placement.replaceTab === true
        ? { replaceTab: tabId }
        : held.paneId === undefined ? {} : { paneId: held.paneId },
      ...placement.paneId === undefined ? {} : { paneId: placement.paneId },
      ...placement.revealIfOpened === undefined ? {} : { revealIfOpened: placement.revealIfOpened },
    })
    const held: Held = {
      sessionId,
      tabId,
      controller,
      signal: controller.signal,
      navigation: createSnapshotStore(navigation),
      paneId: undefined,
      pinned: false,
      tabActions: {
        openResource: (address, options = {}) => {
          navigator.openResourceIn(sessionId, address, { ...place(options), params: options.params })
        },
        openTab: (kind, options = {}) => {
          navigator.openTabIn(sessionId, kind, { ...place(options), params: options.params })
        },
        close: () => { navigator.closeIn(sessionId, tabId) },
      },
    }
    this.session(sessionId).set(tabId, held)
    return held
  }
}
