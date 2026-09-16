/**
 * `ctx.sidebarRight`: what other plugins may ask of this column.
 *
 * The surface is per session and its state lives in that session's store
 * instance, which the slot runtime mints per session and a root service cannot
 * reach on its own. Two paths lead in. The mounted seat publishes its binding —
 * session id, bound actions, its surface — for exactly as long as it is mounted,
 * and every command on the public face goes through that binding; a command
 * arriving with no seat mounted has no session to act on and fails loudly rather
 * than writing into a surface nobody is drawing. And the plugin adopts each
 * session's store instance as the runtime mints it, so the controller reaches
 * any session's store by id and syncs the Tab domain from that store's commits.
 *
 * A tab's own actions (`tabActions`) aim at the session the tab is in, not at
 * the mounted one: they run through that session's adopted store, so a callback
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
 * The registration adopts Session stores and injects the mounted seat binding;
 * callers use the service's navigation methods.
 */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { FloatRect, PaneId, TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import { activeDockPaneId, canSplit, findContentTab, dockPaneIds, findTabPane, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
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

/**
 * Create the public controller and the plugin-private store adoption callback.
 * Adoption reconciles restored records before any seat renders, then follows commits.
 * @param tabs - registered tab types.
 * @param pin - resource retention for an occurrence's lifetime.
 * @returns the controller and plugin-owned adoption and scope-removal callbacks.
 */
export function createSidebarRightController(tabs: SidebarRightTabRegistry, pin: PinResource): {
  controller: SidebarRightController
  adopt: (sessionId: SessionId, store: SidebarRightSurfaceStore) => () => void
  forget: (sessionId: SessionId) => void
} {
  const adopted = new Map<SessionId, Adoption>()
  const inventory = new SidebarTabInventory()
  const controller = new SidebarRightController(tabs, pin, adopted, inventory.source)
  return {
    controller,
    forget: (sessionId) => { inventory.remove(sessionId) },
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

/** Everything a command needs, as the mounted seat sees it. */
export interface SidebarRightBinding {
  /** The session the mounted seat is drawing. */
  readonly sessionId: SessionId
  /** The seat's store's bound actions; every action names the session it acts on. */
  readonly actions: SurfaceActions
  /**
   * The seat's store surfaces as last committed, keyed by session id; the
   * mounted session's is `surfaces[sessionId]`, absent before the seat's first
   * open. The runtime mints one store per session, so this holds that session.
   */
  readonly surfaces: Readonly<Record<string, SurfaceState>>
  /**
   * The room rule's verdict for a docked pane, as the kit last measured it:
   * whether two working halves would fit. Unmeasured panes fit.
   */
  readonly canSplitPane: (paneId: PaneId) => boolean
}

/** Where an open lands; every field is optional and the defaults are the common case. */
export interface SidebarRightPlacement {
  /** Land a new tab in this pane instead of the active docked one. */
  readonly paneId?: PaneId
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
   * Close one tab of the mounted session; the sole docked guide remains open.
   * @param tabId - the tab to close.
   */
  close(tabId: TabId): void
  /**
   * The active tab of the active pane.
   * @returns the record, or `undefined` when no seat is mounted.
   */
  active(): TabRecord | undefined
  /**
   * Whether the column is currently showing its panel.
   * @returns `true` while expanded; `false` while collapsed to its rail.
   */
  isExpanded(): boolean
  /** Collapse an expanded column, or expand a collapsed one. Recorded in the sequence. */
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
  private binding: SidebarRightBinding | undefined
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
   * @param adopted - plugin-owned session stores used by occurrence actions.
   * @param openTabs - plugin-owned metadata source across saved and adopted layouts.
   */
  constructor(
    private readonly tabs: SidebarRightTabRegistry,
    pin: PinResource,
    private readonly adopted = new Map<SessionId, Adoption>(),
    openTabs: SidebarTabInventory['source'] = new SidebarTabInventory().source,
  ) {
    this.openTabs = openTabs
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
   * Adopt the mounted seat's binding, replacing any previous one.
   *
   * Called from the seat while it is mounted, and released when it leaves.
   * @param binding - the mounted seat's session, actions, and the store's surfaces.
   * @returns a release callback that clears exactly this binding.
   */
  bind(binding: SidebarRightBinding): () => void {
    this.binding = binding
    return () => {
      // A newer seat may already have taken over; only the binding that is
      // still ours may be cleared.
      if (this.binding === binding) this.binding = undefined
    }
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
    const commit = (): void => { actions.openContent(sessionId, {
      kind: claim.kind,
      contentId: claim.contentId,
      title: claim.title,
      ...placement.paneId === undefined ? {} : { paneId: placement.paneId },
      ...placement.replaceTab === undefined ? {} : { replaceTab: placement.replaceTab },
      ...placement.revealIfOpened === undefined ? {} : { revealIfOpened: placement.revealIfOpened },
    }, (tabId) => { this.tabDomain.navigate(sessionId, tabId, { address, params }) }) }
    const layout = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]?.layout
    const replaced = placement.replaceTab === undefined ? undefined : layout?.tabs[placement.replaceTab]
    const revealed = layout === undefined || placement.revealIfOpened === false
      ? undefined : findContentTab(layout, claim.contentId, claim.kind)
    if (replaced === undefined || replaced.id === revealed) { commit(); return }
    this.removeAfterCleanup(sessionId, replaced, commit)
  }

  /**
   * Close one tab of the mounted session; the sole docked guide remains open.
   * @param tabId - the tab to close.
   */
  close(tabId: TabId): void {
    const { sessionId, actions } = this.require()
    if (this.adopted.has(sessionId)) { this.closeIn(sessionId, tabId); return }
    actions.closeTab(sessionId, tabId)
  }

  /**
   * The active tab of the active pane.
   * @returns the record, or `undefined` with no mounted surface.
   */
  active(): TabRecord | undefined {
    const layout = this.mounted()?.layout
    if (layout === undefined) return undefined
    const { activeTabId } = getPane(layout, layout.activePaneId)
    return Object.values(layout.tabs).find(tab => tab.id === activeTabId)
  }

  /**
   * Whether the column is currently showing its panel.
   * @returns `true` while expanded; `false` while collapsed or with no mounted surface.
   */
  isExpanded(): boolean {
    return this.mounted()?.layout.expanded ?? false
  }

  /** Collapse an expanded column, or expand a collapsed one. */
  toggleExpanded(): void {
    const { sessionId, actions } = this.require()
    actions.toggleExpanded(sessionId)
  }

  /**
   * Focus a tab and the pane holding it; a missing tab is left alone.
   * @param tabId - the tab to focus.
   */
  focus(tabId: TabId): void {
    const { sessionId, actions } = this.require()
    if (this.mounted()?.layout.tabs[tabId] === undefined) return
    actions.focusTab(sessionId, tabId)
  }

  /**
   * Split a docked pane to its right when the budget and the room rule allow.
   * @param paneId - the pane to split; defaults to the active docked pane.
   * @returns the new pane's id, or `undefined` when nothing was split.
   */
  split(paneId?: PaneId): PaneId | undefined {
    const { sessionId, actions, canSplitPane } = this.require()
    const layout = this.mounted()?.layout
    if (layout === undefined) return undefined
    const target = paneId ?? activeDockPaneId(layout)
    const node = layout.nodes[target]
    if (node === undefined || node.kind !== 'pane' || node.host !== 'dock') return undefined
    if (!canSplit(layout) || dockPaneIds(layout).length >= 2 || !canSplitPane(target)) return undefined
    let created: PaneId | undefined
    actions.splitPane(sessionId, target, (id) => { created = id })
    return created
  }

  /**
   * Take a docked tab out into a floating panel; a missing or floating tab is left alone.
   * @param tabId - the tab to float.
   * @param rect - the panel's rectangle; defaults to the cascade from the last panel.
   */
  float(tabId: TabId, rect?: FloatRect): void {
    const { sessionId, actions } = this.require()
    const layout = this.mounted()?.layout
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
    const node = this.mounted()?.layout.nodes[paneId]
    if (node === undefined || node.kind !== 'pane' || node.host !== 'float') return
    actions.unfloatPane(sessionId, paneId)
  }

  /**
   * Step the mounted session's surface back one intent.
   *
   * @internal Not part of the product: the sequence is an architectural fact
   * with no user-facing control yet. Kept reachable for tests.
   */
  _undo(): void {
    const { sessionId, actions } = this.require()
    actions.undo(sessionId)
  }

  /**
   * Step the mounted session's surface forward one intent.
   *
   * @internal See `_undo`.
   */
  _redo(): void {
    const { sessionId, actions } = this.require()
    actions.redo(sessionId)
  }

  /** The mounted session's surface; `undefined` without a seat or before its first open. */
  private mounted(): SurfaceState | undefined {
    const { binding } = this
    return binding === undefined ? undefined : binding.surfaces[binding.sessionId]
  }

  /**
   * The store actions a tab's own action on `sessionId` runs through: that
   * session's adopted store. `undefined` — nothing to act on — for a session
   * whose store was never minted or whose adoption was released.
   */
  private actionsFor(sessionId: SessionId): SurfaceActions | undefined {
    return this.adopted.get(sessionId)?.store.actions
  }

  private require(): SidebarRightBinding {
    // Reads answer for the no-session case (there is nothing expanded), but a
    // write has no session to write to. Callers are UI gestures and tool
    // results, both of which belong to a session that is on screen.
    if (this.binding === undefined) {
      throw new Error('sidebarRight: no session surface is mounted')
    }
    return this.binding
  }
}
