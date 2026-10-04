/**
 * `ctx.sidebarRight`: what other plugins may ask of this column.
 *
 * The surface is per session and its state lives in that session's store
 * instance, which the slot runtime mints per session and a root service cannot
 * reach on its own. The plugin adopts each session's store instance as the
 * runtime mints it, so the controller reaches any session's store by id and
 * syncs the Tab domain from that store's commits, on screen or not.
 *
 * The plugin also names the Session on screen — the selected Session while the
 * Conversation fills the main column — from the selection and the main panel,
 * before React renders either change, and publishes it as `mounted`. Every
 * command on the public face acts on that Session through its adopted store; a
 * command with no Session on screen, or with one whose store the runtime has not
 * minted, has nothing to act on and fails loudly rather than writing into a
 * surface nobody is drawing. The seats never publish which Session they draw:
 * they report only what they render with, the room their docking kit measured
 * and the automatic fullscreen rule of their frame width.
 *
 * A tab's own actions (`tabActions`) aim at the session the tab is in, not at
 * the on-screen one: they run through that session's adopted store, so a callback
 * fired after the user switched sessions still lands where its tab is, and they
 * do nothing for a session whose store was never minted.
 *
 * `openResource` and `openTab` are the navigation controller, and every way
 * into the column is a call to one of them: the conversation's file links, a
 * tool row's line reference, the strip's add control, a guide entry box, a file
 * tree's rows. A resource is claimed through the registry by address; a page is
 * named by kind and recorded at the address this package composes for it. Both
 * hand the store one settled intent and record the navigation in the Tab
 * domain. Placement is the caller's option, never a type's property.
 *
 * The registration adopts Session stores, names the on-screen Session, and
 * forwards the seats' reports; callers use the service's navigation methods.
 */
import { sidebarTargetFromElement, type SidebarRightTarget } from './focus.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { FloatRect, PaneId, TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import { activeDockPaneId, canSplit, findContentTab, findPaneContentTab, dockPaneIds, findTabPane, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightNavigationParams, SidebarRightResourceParams, SidebarRightTabParamsFor } from './contract/params.ts'
import { pageAddress } from './contract/seed.ts'
import type { SidebarRightTabClaim, SidebarRightTabRegistry } from './tab-registry.ts'
import { canCloseTab, type SidebarRightState, type SurfaceState } from './stores.ts'
import type { createSidebarRightStore } from './stores.ts'
import { TabDomain, type PinResource } from './tab-domain.ts'
import { SidebarTabInventory } from './tab-inventory.ts'

/** The seat's bound action set. */
export type SurfaceActions = BoundActions<ReturnType<typeof createSidebarRightStore>>

/** One session's store instance as the slot runtime minted it: its actions and its observable snapshot. */
export interface SidebarRightSurfaceStore {
  readonly actions: SurfaceActions
  getSnapshot(): SidebarRightState
  subscribe(listener: () => void): () => void
}

/** One adoption of a session's store; the token a release compares against. */
interface Adoption {
  readonly store: SidebarRightSurfaceStore
  readonly unsubscribe: () => void
}

/** The room rule's verdict for a docked pane, as a seat's docking kit last measured it: whether two working halves would fit. */
type RoomRule = (paneId: PaneId) => boolean

/** Plugin-owned Session state the controller reads; the plugin writes it through the factory's callbacks. */
interface SidebarRightSessions {
  /** Each Session's latest adopted store. */
  readonly adopted: ReadonlyMap<SessionId, Adoption>
  /** Each Session's room rule as its seat last reported it; a Session without one has room in every pane. */
  readonly rooms: ReadonlyMap<SessionId, RoomRule>
  /** The Session the plugin names as on screen. */
  readonly onScreen: ObservableSnapshot<SessionId | undefined>
  /** Open tab metadata across saved and adopted Sessions. */
  readonly openTabs: SidebarTabInventory['source']
}

/**
 * Create the public controller and the plugin-private Session callbacks.
 * Adoption reconciles restored records before any seat renders, then follows commits.
 * @param tabs - registered tab types.
 * @param pin - resource retention for an occurrence's lifetime.
 * @param host - the viewport rule and focus continuity the commands use.
 * @returns the controller; store adoption and scope removal; naming the on-screen Session; and recording a seat's room rule.
 */
export function createSidebarRightController(tabs: SidebarRightTabRegistry, pin: PinResource, host: SidebarRightHost): {
  controller: SidebarRightController
  adopt: (sessionId: SessionId, store: SidebarRightSurfaceStore) => () => void
  forget: (sessionId: SessionId) => void
  show: (sessionId: SessionId | undefined) => void
  measure: (sessionId: SessionId, canSplitPane: RoomRule) => void
} {
  const adopted = new Map<SessionId, Adoption>()
  const rooms = new Map<SessionId, RoomRule>()
  const onScreen = createSnapshotStore<SessionId | undefined>(undefined)
  const inventory = new SidebarTabInventory()
  const controller = new SidebarRightController(tabs, pin, host, { adopted, rooms, onScreen, openTabs: inventory.source })
  return {
    controller,
    forget: (sessionId) => {
      inventory.remove(sessionId)
      rooms.delete(sessionId)
    },
    show: (sessionId) => { if (onScreen.getSnapshot() !== sessionId) onScreen.set(sessionId) },
    measure: (sessionId, canSplitPane) => { rooms.set(sessionId, canSplitPane) },
    adopt(sessionId, store) {
      adopted.get(sessionId)?.unsubscribe()
      const sync = (): void => {
        const surface = store.getSnapshot().bySession[sessionId]
        inventory.update(sessionId, Object.values(surface?.layout.tabs ?? {}))
        if (surface !== undefined) controller.tabDomain.sync(sessionId, surface.layout)
      }
      const adoption: Adoption = { store, unsubscribe: store.subscribe(sync) }
      adopted.set(sessionId, adoption)
      sync()
      return () => {
        adoption.unsubscribe()
        if (adopted.get(sessionId) === adoption) adopted.delete(sessionId)
      }
    },
  }
}

/** What the controller needs from the page around it: the viewport rule and focus continuity. */
export interface SidebarRightHost {
  /**
   * Whether the viewport is narrow enough that an expanded panel is presented fullscreen.
   * @returns the rule's verdict for the frame width the seats last rendered at.
   */
  readonly autoFullscreen: () => boolean
  /**
   * Commit a page operation and focus the pane it selects.
   * @param sessionId - the Session whose page is opening.
   * @param open - the synchronous operation; returns the selected pane, or `undefined` when unchanged.
   */
  readonly openWithFocus: (sessionId: SessionId, open: () => PaneId | undefined) => void
  /**
   * Commit a keyboard/menu close and retain focus on a surviving visible pane.
   * @param sessionId - the Session whose page is closing.
   * @param paneId - the pane whose page is closing.
   * @param close - the synchronous cleanup and removal.
   */
  readonly closeWithFocus: (sessionId: SessionId, paneId: PaneId, close: () => void) => void
}

/** Where an open lands; every field is optional and the defaults are the common case. */
export interface SidebarRightPlacement {
  /** Land a new tab in this pane instead of the active docked one. */
  readonly paneId?: PaneId
  /** Prefer a new pane for new content; use the target pane when splitting is unavailable. */
  readonly preferNewPane?: boolean
  /** Take this tab's place — its pane and its strip slot — and close it in the same step. */
  readonly replaceTab?: TabId
  /**
   * Resource tabs reveal an existing (kind, contentId) by default; `false`
   * permits duplicates. Pages always deduplicate within the target pane.
   */
  readonly revealIfOpened?: boolean
}

/** How a caller wants a resource opened. */
export interface SidebarRightOpenResourceOptions extends SidebarRightPlacement {
  /** Name the opening type instead of letting the registry rank claims; its `canOpen` still applies. */
  readonly kind?: string
  /** The resource's navigation parameters, typed by resource type; delivered as `navigation.params`. */
  readonly params?: SidebarRightResourceParams
}

/** How a caller wants a page type opened. */
export interface SidebarRightOpenTabOptions<K extends string = string> extends SidebarRightPlacement {
  /** That kind's navigation parameters, typed by kind; delivered as `navigation.params`. */
  readonly params?: SidebarRightTabParamsFor<K>
}

/** The scheme every resource address carries; anything else is not a resource this face opens. */
const RESOURCE_SCHEME = 'dsh-resource://'

/** Synchronous close/replacement hook; resource owners retain any background cleanup. */
export type SidebarRightCloseHandler = (sessionId: SessionId, tab: TabRecord) => void

/** The outward right-Sidebar face (`ctx.sidebarRight`). */
export interface ISidebarRight {
  /**
   * The Session on screen, or `undefined` while none is (a global panel fills
   * the main column, or no Session is selected). It changes before React
   * renders the selection or panel change that causes it, so every component
   * rendered in that commit reads the arriving Session, and the commands act on
   * it from that commit's effects: its seat mints its store in the same render.
   * Moves only when the on-screen Session changes; the Session's own store
   * commits are silent.
   */
  readonly mounted: ObservableSnapshot<SessionId | undefined>
  /**
   * Open a resource: claim it, place it, reveal the column, record the navigation.
   *
   * Without `options.kind` the registry ranks the types whose globs and
   * `canOpen` accept the address and the best band wins; with it, that kind's
   * type in force opens the address (its `canOpen` still applies). An address
   * outside `dsh-resource://`, or one no type will open, is a wiring mistake,
   * not a user error, so it throws. The column expands in the same step,
   * because content the user cannot see is not opened.
   * @param address - a `dsh-resource://<type>/…` address.
   * @param options - placement, the opening type, and navigation parameters.
   */
  openResource(address: string, options?: SidebarRightOpenResourceOptions): void
  /**
   * Open a page type by kind: the type in force for it, at the address this
   * package records pages under. A kind nothing registered throws.
   * @param kind - the page type's kind.
   * @param options - placement and that kind's navigation parameters.
   */
  openTab<K extends string>(kind: K, options?: SidebarRightOpenTabOptions<K>): void
  /**
   * Close one tab of the on-screen Session; the sole docked guide remains open.
   * @param tabId - the tab to close.
   */
  close(tabId: TabId): void
  /**
   * The active tab of the active pane.
   * @returns the record, or `undefined` with no Session on screen.
   */
  active(): TabRecord | undefined
  /**
   * Whether the column is currently showing its panel.
   * @returns `true` while expanded; `false` while collapsed to its rail.
   */
  isExpanded(): boolean
  /** Collapse the column, or expand it and focus its active dock pane. Recorded in the sequence. */
  toggleExpanded(): void
  /**
   * Focus a tab and the pane holding it, raising a floating one. Recorded.
   * @param tabId - the tab; one that does not exist is left alone.
   */
  focus(tabId: TabId): void
  /**
   * Split a docked pane to its right and seed the new pane, under the same
   * pane budget and room rule as the strip's split control. Recorded when it
   * splits.
   * @param paneId - the pane to split; defaults to the active docked pane.
   * @returns the new pane's id, or `undefined` when nothing was split: the pane
   *   is missing, floating, or empty, the budget is spent, or two halves would not fit.
   */
  split(paneId?: PaneId): PaneId | undefined
  /**
   * Take a docked tab out into a floating panel. Recorded.
   * @param tabId - the tab; one that is missing or already floating is left alone.
   * @param rect - the panel's rectangle; defaults to the cascade from the last panel.
   */
  float(tabId: TabId, rect?: FloatRect): void
  /**
   * Return a floating panel's tab to the active docked pane. Recorded.
   * @param paneId - the floating pane; one that is missing or docked is left alone.
   */
  dock(paneId: PaneId): void
}

/** Cross-plugin right-Sidebar face (ctx.sidebarRight). */
export class SidebarRightController implements ISidebarRight {
  /** Open tab metadata across saved and adopted Sessions, independent of visible seats. */
  readonly openTabs: SidebarTabInventory['source']
  /** The on-screen Session; see {@link ISidebarRight.mounted}. */
  readonly mounted: ObservableSnapshot<SessionId | undefined>
  private readonly adopted: ReadonlyMap<SessionId, Adoption>
  private readonly rooms: ReadonlyMap<SessionId, RoomRule>
  private readonly closeHandlers = new Map<string, SidebarRightCloseHandler>()

  /**
   * Register resource cleanup before explicit removal. Failure preserves the tab.
   * @param kind - tab kind owned by the registering plugin.
   * @param handler - saves any background cleanup before returning and allowing removal.
   * @returns an effect-scoped unregister callback.
   */
  registerCloseHandler(kind: string, handler: SidebarRightCloseHandler): () => void {
    if (this.closeHandlers.has(kind)) throw new Error(`sidebarRight: close handler already registered for ${kind}`)
    this.closeHandlers.set(kind, handler)
    return () => { if (this.closeHandlers.get(kind) === handler) this.closeHandlers.delete(kind) }
  }

  /**
   * The Tab domain this controller navigates into; synced from each adopted
   * store's commits, read by the seat for each body's owner share.
   */
  readonly tabDomain: TabDomain

  /**
   * @param tabs - the tab-type registry consulted to claim an address.
   * @param pin - `ctx.resources.pin`, which the Tab domain holds addresses with.
   * @param host - the viewport rule and focus continuity the commands use.
   * @param sessions - plugin-owned adopted stores, room rules, on-screen Session, and open tab metadata.
   */
  constructor(
    private readonly tabs: SidebarRightTabRegistry,
    pin: PinResource,
    private readonly host: SidebarRightHost,
    sessions: SidebarRightSessions,
  ) {
    this.adopted = sessions.adopted
    this.rooms = sessions.rooms
    this.mounted = sessions.onScreen
    this.openTabs = sessions.openTabs
    this.tabDomain = new TabDomain(this, pin)
  }

  /**
   * Read the committed tabs of a Session so providers can restore their content.
   * @param sessionId - Session whose layout has been adopted.
   * @returns its open records, or an empty list before adoption.
   */
  tabsIn(sessionId: SessionId): readonly TabRecord[] {
    return Object.values(this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]?.layout.tabs ?? {})
  }

  /**
   * Open a resource: claim it, place it, reveal the column, record the navigation.
   * @param address - a `dsh-resource://<type>/…` address.
   * @param options - placement, the opening type, and navigation parameters.
   */
  openResource(address: string, options: SidebarRightOpenResourceOptions = {}): void {
    const { sessionId, actions } = this.require()
    this.placeResource(sessionId, actions, address, options)
  }

  /**
   * Open a page type by kind at the address this package records pages under.
   * @param kind - the page type's kind.
   * @param options - placement and that kind's navigation parameters.
   */
  openTab<K extends string>(kind: K, options: SidebarRightOpenTabOptions<K> = {}): void {
    const { sessionId, actions } = this.require()
    this.placeTab(sessionId, actions, kind, options)
  }

  /**
   * Open a resource in one session, for a tab's own action; nothing happens
   * for a session whose store was never adopted or whose adoption was released.
   * Not part of `ISidebarRight`: the Tab domain's path.
   * @param sessionId - the session the acting tab is in.
   * @param address - a `dsh-resource://<type>/…` address.
   * @param options - placement, the opening type, and navigation parameters.
   */
  openResourceIn(sessionId: SessionId, address: string, options: SidebarRightOpenResourceOptions = {}): void {
    const actions = this.actionsFor(sessionId)
    if (actions !== undefined) this.placeResource(sessionId, actions, address, options)
  }

  /**
   * Open a page type in one session, for a tab's own action; nothing happens
   * for a session whose store was never adopted or whose adoption was released.
   * Not part of `ISidebarRight`: the Tab domain's path.
   * @param sessionId - the session the acting tab is in.
   * @param kind - the page type's kind.
   * @param options - placement and that kind's navigation parameters.
   */
  openTabIn<K extends string>(sessionId: SessionId, kind: K, options: SidebarRightOpenTabOptions<K> = {}): void {
    const actions = this.actionsFor(sessionId)
    if (actions !== undefined) this.placeTab(sessionId, actions, kind, options)
  }

  /**
   * Close a tab of one session, preserving the sole docked guide; nothing happens
   * for a session whose store was never adopted or whose adoption was released.
   * Not part of `ISidebarRight`: the Tab domain's path.
   * @param sessionId - the session the tab is in.
   * @param tabId - the tab to close.
   */
  closeIn(sessionId: SessionId, tabId: TabId): void {
    const actions = this.actionsFor(sessionId)
    const surface = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]
    if (actions === undefined || surface === undefined) return
    const tab = surface.layout.tabs[tabId]
    if (tab === undefined || !canCloseTab(surface, tabId)) return
    this.removeAfterCleanup(sessionId, tab, () => { actions.closeTab(sessionId, tabId) })
  }

  private removeAfterCleanup(sessionId: SessionId, tab: TabRecord, commit: () => void): void {
    this.closeHandlers.get(tab.kind)?.(sessionId, tab)
    commit()
  }

  /** Claim a resource and place it in one session; an address outside the scheme or one no type claims throws. */
  private placeResource(
    sessionId: SessionId,
    actions: SurfaceActions,
    address: string,
    options: SidebarRightOpenResourceOptions,
  ): void {
    if (!address.startsWith(RESOURCE_SCHEME)) {
      throw new Error(`sidebarRight: no registered tab type claims "${address}"`)
    }
    this.place(sessionId, actions, this.tabs.claim(address, options.kind), address, options, options.params)
  }

  /** Place a page type in one session at the address pages are recorded under; an unregistered kind throws. */
  private placeTab<K extends string>(
    sessionId: SessionId,
    actions: SurfaceActions,
    kind: K,
    options: SidebarRightOpenTabOptions<K>,
  ): void {
    const definition = this.tabs.get(kind)
    if (definition === undefined) throw new Error(`sidebarRight: no tab type is registered as "${kind}"`)
    const address = definition.multiple === true ? `${pageAddress(kind)}/${randomUUID()}` : pageAddress(kind)
    this.place(sessionId, actions, { kind, contentId: address, title: definition.title(address) }, address, options, options.params)
  }

  /** The steps both opens share: one store intent, and the navigation record for the tab it settles on. */
  private place(
    sessionId: SessionId,
    actions: SurfaceActions,
    claim: SidebarRightTabClaim,
    address: string,
    placement: SidebarRightPlacement,
    params: SidebarRightNavigationParams,
  ): void {
    const surface = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]
    const targetPane = surface === undefined ? undefined : placement.paneId ?? activeDockPaneId(surface.layout)
    const target = targetPane === undefined ? undefined : surface?.layout.nodes[targetPane]
    const preferNewPane = placement.preferNewPane === true
      && placement.replaceTab === undefined
      && surface !== undefined
      && target?.kind === 'pane'
      && target.host === 'dock'
      && target.tabs.length > 0
      && canSplit(surface.layout)
      && dockPaneIds(surface.layout).length < 2
      && this.mounted.getSnapshot() === sessionId
      && this.canSplitPane(sessionId, target.id)
    const commit = (): void => { actions.openContent(sessionId, {
      kind: claim.kind,
      contentId: claim.contentId,
      title: claim.title,
      ...placement.paneId === undefined ? {} : { paneId: placement.paneId },
      ...preferNewPane ? { preferNewPane: true } : {},
      ...placement.replaceTab === undefined ? {} : { replaceTab: placement.replaceTab },
      ...placement.revealIfOpened === undefined ? {} : { revealIfOpened: placement.revealIfOpened },
    }, (tabId) => { this.tabDomain.navigate(sessionId, tabId, { address, params }) }) }
    const layout = surface?.layout
    const replaced = placement.replaceTab === undefined ? undefined : layout?.tabs[placement.replaceTab]
    const replacementPane = replaced === undefined || layout === undefined ? undefined : findTabPane(layout, replaced.id)
    const revealed = layout === undefined ? undefined
      : claim.contentId === pageAddress(claim.kind)
        ? findPaneContentTab(layout, replacementPane?.host === 'dock' ? replacementPane.id : placement.paneId ?? activeDockPaneId(layout), claim.contentId, claim.kind)
        : placement.revealIfOpened === false ? undefined : findContentTab(layout, claim.contentId, claim.kind)
    if (replaced === undefined || replaced.id === revealed) { commit(); return }
    this.removeAfterCleanup(sessionId, replaced, commit)
  }

  /**
   * Close one tab of the on-screen Session; the sole docked guide remains open.
   * @param tabId - the tab to close.
   */
  close(tabId: TabId): void {
    this.closeIn(this.require().sessionId, tabId)
  }

  /**
   * The active tab of the active pane.
   * @returns the record, or `undefined` without an on-screen surface.
   */
  active(): TabRecord | undefined {
    const layout = this.mountedSurface()?.layout
    if (layout === undefined) return undefined
    const { activeTabId } = getPane(layout, layout.activePaneId)
    return Object.values(layout.tabs).find(tab => tab.id === activeTabId)
  }

  /**
   * Whether the column is currently showing its panel.
   * @returns `true` while expanded; `false` while collapsed or without an on-screen surface.
   */
  isExpanded(): boolean {
    return this.mountedSurface()?.layout.expanded ?? false
  }

  /** Collapse the column, or expand it and focus its active dock pane after rendering. */
  toggleExpanded(): void {
    const { sessionId, actions } = this.require()
    this.host.openWithFocus(sessionId, () => {
      actions.toggleExpanded(sessionId)
      const layout = this.mountedSurface()?.layout
      return layout?.expanded ? activeDockPaneId(layout) : undefined
    })
  }

  /**
   * Focus a tab and the pane holding it; a missing tab is left alone.
   * @param tabId - the tab to focus.
   */
  focus(tabId: TabId): void {
    const { sessionId, actions } = this.require()
    if (this.mountedSurface()?.layout.tabs[tabId] === undefined) return
    actions.focusTab(sessionId, tabId)
  }

  /**
   * Capture the page owning current DOM focus; outside focus never uses layout history.
   * @param element - explicit input target, including an embedding iframe; defaults to live document focus.
   * @returns current focused page identity, or undefined outside a visible sidebar page.
   */
  focusedTarget(element: Element | null = document.activeElement): SidebarRightTarget | undefined {
    const screen = this.screen()
    return screen === undefined ? undefined
      : sidebarTargetFromElement(element, screen.sessionId, screen.surface.layout,
        tabId => this.tabDomain.occurrence(screen.sessionId, { id: tabId }))
  }

  /**
   * Choose a focused sidebar pane, or the on-screen Session's active dock pane for an outside open.
   * @param element - live command input target; stale sidebar markup never falls back to another pane.
   * @returns captured target, or undefined without an on-screen surface.
   */
  commandTarget(element: Element | null = document.activeElement): SidebarRightTarget | undefined {
    const focused = this.focusedTarget(element)
    if (focused !== undefined || element?.closest('[data-sidebar-right-session]')) return focused
    const screen = this.screen()
    if (screen === undefined) return undefined
    const { sessionId, surface: { layout } } = screen
    const pane = getPane(layout, activeDockPaneId(layout))
    const tabId = pane.activeTabId
    const held = tabId === undefined ? undefined : this.tabDomain.occurrence(sessionId, { id: tabId })
    return { sessionId, paneId: pane.id, host: pane.host, tabId,
      occurrence: held, navigationRevision: held?.navigation.getSnapshot().revision }
  }

  /**
   * Open from a captured pane using the guide's replacement and floating placement rules.
   * @param kind - registered page kind.
   * @param target - captured live pane and optional page.
   */
  openTabFromTarget(kind: string, target: SidebarRightTarget): void {
    if (!this.isTargetCurrent(target)) return
    const { sessionId, actions } = this.require()
    this.host.openWithFocus(sessionId, () => {
      const tab = target.tabId === undefined ? undefined : this.mountedSurface()?.layout.tabs[target.tabId]
      if (target.host === 'float' && tab?.kind === kind && this.tabs.get(kind)?.multiple !== true) {
        actions.setExpanded(sessionId, true)
        this.focus(tab.id)
      } else {
        this.openTab(kind, {
          ...target.host === 'dock' ? { paneId: target.paneId } : {},
          ...tab?.kind === 'guide' ? { replaceTab: tab.id } : {},
        })
      }
      return this.mountedSurface()?.layout.activePaneId
    })
  }

  /**
   * Test explicit close eligibility without using the last selected page.
   * @param target - captured focused page.
   * @returns whether this current page can be removed or its sole guide pane collapsed.
   */
  canCloseTarget(target: SidebarRightTarget): boolean {
    return this.isTargetCurrent(target) && target.tabId !== undefined
  }

  /**
   * Remove a captured page through its resource cleanup handler, or collapse the sole docked guide.
   * Cleanup errors propagate and preserve the page.
   * @param target - page captured while resolving the command.
   * @returns closed after removal or collapse, unavailable without a page, or stale after identity changes.
   */
  closeTarget(target: SidebarRightTarget): 'closed' | 'unavailable' | 'stale' {
    if (!this.isTargetCurrent(target)) return 'stale'
    const surface = this.mountedSurface()
    if (surface === undefined || target.tabId === undefined) return 'unavailable'
    const tabId = target.tabId
    const { sessionId, actions } = this.require()
    this.host.closeWithFocus(sessionId, target.paneId, () => {
      if (canCloseTab(surface, tabId)) this.close(tabId)
      else actions.setExpanded(sessionId, false)
    })
    return 'closed'
  }

  /**
   * Check a captured target before acting, including reopened records and intervening navigation.
   * @param target - identity captured while resolving the input.
   * @returns whether the on-screen Session, pane, tab lifetime and navigation still match.
   */
  isTargetCurrent(target: SidebarRightTarget): boolean {
    if (this.mounted.getSnapshot() !== target.sessionId) return false
    const layout = this.mountedSurface()?.layout
    const pane = layout?.nodes[target.paneId]
    if (pane?.kind !== 'pane' || pane.host !== target.host) return false
    if (target.tabId === undefined) return pane.activeTabId === undefined
    if (!pane.tabs.includes(target.tabId) || layout?.tabs[target.tabId] === undefined) return false
    const held = this.tabDomain.occurrence(target.sessionId, { id: target.tabId })
    return held === target.occurrence && !held.signal.aborted
      && held.navigation.getSnapshot().revision === target.navigationRevision
  }

  /**
   * Explain the same geometry and pane-budget rule used by the split control.
   * @param target - captured command or button target.
   * @returns a localizable block discriminator, or undefined when splitting is available.
   */
  splitBlock(target: SidebarRightTarget): 'stale' | 'collapsed' | 'float' | 'empty' | 'budget' | 'width' | undefined {
    const surface = this.mountedSurface()
    if (surface === undefined || !this.isTargetCurrent(target)) return 'stale'
    const { layout } = surface
    if (target.host === 'float') return 'float'
    if (!layout.expanded) return 'collapsed'
    if (getPane(layout, target.paneId).tabs.length === 0) return 'empty'
    if (!canSplit(layout) || dockPaneIds(layout).length >= 2) return 'budget'
    if (!this.canSplitPane(target.sessionId, target.paneId)) return 'width'
    return undefined
  }

  /**
   * Toggle the right panel's display mode through the same action as its chrome button.
   * @param target - captured dock pane; floating and stale targets are unchanged.
   */
  toggleFullscreen(target: SidebarRightTarget): void {
    if (!this.isTargetCurrent(target) || target.host === 'float' || !this.isExpanded()) return
    const { sessionId, actions } = this.require()
    const autoFullscreen = this.host.autoFullscreen()
    const fullscreen = autoFullscreen || this.mountedSurface()?.layout.mode === 'fullscreen'
    if (fullscreen && autoFullscreen) actions.setExpanded(sessionId, false)
    actions.setMode(sessionId, fullscreen ? 'push' : 'fullscreen')
  }

  /**
   * Split a docked pane to its right when the budget and the room rule allow.
   * @param paneId - the pane to split; defaults to the active docked pane.
   * @returns the new pane's id, or `undefined` when nothing was split.
   */
  split(paneId?: PaneId): PaneId | undefined {
    const { sessionId, actions } = this.require()
    const layout = this.mountedSurface()?.layout
    if (layout === undefined) return undefined
    const target = paneId ?? activeDockPaneId(layout)
    const node = layout.nodes[target]
    if (node === undefined || node.kind !== 'pane' || node.host !== 'dock') return undefined
    if (!canSplit(layout) || dockPaneIds(layout).length >= 2 || !this.canSplitPane(sessionId, target)) return undefined
    let created: PaneId | undefined
    this.host.openWithFocus(sessionId, () => {
      actions.splitPane(sessionId, target, (id) => { created = id })
      return created
    })
    return created
  }

  /**
   * Take a docked tab out into a floating panel; a missing or floating tab is left alone.
   * @param tabId - the tab to float.
   * @param rect - the panel's rectangle; defaults to the cascade from the last panel.
   */
  float(tabId: TabId, rect?: FloatRect): void {
    const { sessionId, actions } = this.require()
    const layout = this.mountedSurface()?.layout
    if (layout === undefined || layout.tabs[tabId] === undefined) return
    if (findTabPane(layout, tabId).host !== 'dock') return
    actions.floatTab(sessionId, tabId, rect)
  }

  /**
   * Return a floating panel's tab to the active docked pane; a missing or docked pane is left alone.
   * @param paneId - the floating pane.
   */
  dock(paneId: PaneId): void {
    const { sessionId, actions } = this.require()
    const node = this.mountedSurface()?.layout.nodes[paneId]
    if (node === undefined || node.kind !== 'pane' || node.host !== 'float') return
    actions.unfloatPane(sessionId, paneId)
  }

  /**
   * Step the on-screen Session's surface back one intent.
   *
   * @internal Not part of the product: the sequence is an architectural fact
   * with no user-facing control yet. Kept reachable for tests.
   */
  _undo(): void {
    const { sessionId, actions } = this.require()
    actions.undo(sessionId)
  }

  /**
   * Step the on-screen Session's surface forward one intent.
   *
   * @internal See `_undo`.
   */
  _redo(): void {
    const { sessionId, actions } = this.require()
    actions.redo(sessionId)
  }

  /**
   * The on-screen Session and its committed surface; `undefined` with no Session
   * on screen, before the runtime mints its store, or before its first open.
   */
  private screen(): { readonly sessionId: SessionId; readonly surface: SurfaceState } | undefined {
    const sessionId = this.mounted.getSnapshot()
    if (sessionId === undefined) return undefined
    const surface = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]
    return surface === undefined ? undefined : { sessionId, surface }
  }

  /** The on-screen Session's surface; see {@link SidebarRightController.screen}. */
  private mountedSurface(): SurfaceState | undefined {
    return this.screen()?.surface
  }

  /** Whether a Session's docked pane has room for two working halves, as its seat last measured; unmeasured panes do. */
  private canSplitPane(sessionId: SessionId, paneId: PaneId): boolean {
    return this.rooms.get(sessionId)?.(paneId) ?? true
  }

  /**
   * The store actions a tab's own action on `sessionId` runs through: that
   * session's adopted store. `undefined` — nothing to act on — for a session
   * whose store was never minted or whose adoption was released.
   */
  private actionsFor(sessionId: SessionId): SurfaceActions | undefined {
    return this.adopted.get(sessionId)?.store.actions
  }

  private require(): { readonly sessionId: SessionId; readonly actions: SurfaceActions } {
    // Reads answer for the no-session case (there is nothing expanded), but a
    // write has no session to write to. Callers are UI gestures and tool
    // results, both of which belong to a session that is on screen.
    const sessionId = this.mounted.getSnapshot()
    const actions = sessionId === undefined ? undefined : this.actionsFor(sessionId)
    if (sessionId === undefined || actions === undefined) {
      throw new Error('sidebarRight: no session surface is mounted')
    }
    return { sessionId, actions }
  }
}
