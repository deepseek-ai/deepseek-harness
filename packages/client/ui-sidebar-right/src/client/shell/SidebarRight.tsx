/**
 * The Sidebar's seat in the frame, and the panel it draws.
 *
 * The frame owns the right column's geometry; this package owns one content
 * tree at the column width or spanning the viewport. A shown wide panel
 * retains its track in fullscreen, preserving the conversation width. Below
 * 768px fullscreen is derived from viewport width, without changing manual mode.
 *
 * Docked content stays mounted while collapsed, translated off the frame's right
 * edge, so opening and closing are one gesture in both presentations: a slide
 * from and to that edge. Normal presentation moves the frame's tracks with
 * the panel. A fullscreen opening reserves its underlying track only after
 * the panel covers the frame, without animating those hidden columns.
 *
 * The panel has no header of its own: its two controls — presentation switch
 * and collapse — ride the docking kit's chrome seat at the end of the top-right
 * pane's tab strip, so the strip is the panel's whole top edge. The way back in
 * while collapsed is not here either: it is one button in the conversation
 * header (`ExpandButton.tsx`), because it exists only while this panel is
 * hidden. Floating panels remain in the same content tree; untransformed
 * ancestors let their fixed-position frames cross the column and conversation.
 *
 * Tab bodies do not live here. Each one is a registration under its type's kind,
 * dispatched through the keyed `sidebar.right.pane.tab` seat (and a live chip
 * title through `sidebar.right.pane.tab.title`), so a new tab type needs no edit
 * to this file. What a body receives beyond the record — navigation, lifetime
 * signal, actions — is read through the slot-owned useTabInfo hook. The Tab
 * domain follows each session's store commits, including sessions off screen.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import { IconPanelLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'
import type { DockIntents, DockMode, FloatRect, TabId, TabRecord, TabRenderer } from '@deepseek-ai/dsh-client-ui-dockkit'
import { canSplit, dockPaneIds, DockLayout, findPaneContentTab } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HalvesFit, LayoutState, PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { GUIDE_KIND, pageAddress } from '../contract/seed.ts'
import { dockLabels } from '../labels.ts'
import type { SidebarRightOpenTabOptions } from '../service.ts'
import type { SidebarRightTabDefinition } from '../tab-registry.ts'
import type { createSidebarRightStore, SurfaceState } from '../stores.ts'
import { canCloseTab } from '../stores.ts'
import type { TabOccurrence } from '../tab-domain.ts'
import type { SidebarRightTabNavigation } from '../contract/slots.ts'
import type { TabHookContext } from '../tab-info.ts'
import css from './SidebarRight.module.css'
import { closeWithPaneFocus, openWithPaneFocus } from './close-focus.ts'

/** The store share the seat receives. */
type Store = PropsStore<ReturnType<typeof createSidebarRightStore>>

/** The child seats this component renders. */
type Children = PropsRenderSlots<'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title' | 'sidebar.right.tab.menu.item'>

/** What the panel reports to the frame: drawn or not, and whether it wants a track. */
export interface SidebarRightPresentation {
  /** Whether the panel is drawn at all. */
  readonly shown: boolean
  /** Whether the drawn panel wants the conversation to make room for it. */
  readonly track: boolean
  /** Whether the panel fills the viewport, independently of its retained track. */
  readonly fullscreen: boolean
}

/** What this package needs from its host beyond the framework shares. */
export interface SidebarRightInjected {
  /**
   * Report the panel's presentation to the frame.
   *
   * The frame sizes the track and places the resize handle; this only tells it
   * the composition of the facts this package owns, and is called whenever that
   * composition changes.
   */
  readonly syncPresentation: (presentation: SidebarRightPresentation) => void
  /**
   * Publish this seat's session, actions, and the store's surfaces to `ctx.sidebarRight`.
   *
   * The service is root-scoped and cannot read a per-entry store, so the only
   * honest source is the mounted seat. Held for as long as the seat is mounted;
   * the service publishes the bound session through `ctx.sidebarRight.mounted`.
   * @param binding - what a command needs to act on this session, and what a tab's own action needs to act on its.
   * @returns a release callback.
   */
  readonly bindService: (binding: {
    sessionId: SessionId
    actions: Store['actions']
    /** Every session's surface as last committed; the mounted one is `surfaces[sessionId]`. */
    surfaces: Readonly<Record<string, SurfaceState>>
    /** The room rule's verdict for a docked pane, as the kit last measured it. */
    canSplitPane: (paneId: PaneId) => boolean
    /** Commit a keyboard/menu close and retain focus on a surviving visible pane. */
    closeWithFocus: (paneId: PaneId, close: () => void) => void
    /** Commit a page operation and focus the pane it selects. */
    openWithFocus: (open: () => PaneId | undefined) => void
    autoFullscreen?: boolean
  }) => () => void
  /**
   * The navigation face's `openTab`, for the strip's add control: a new tab is
   * the guide opened by kind, through the same path as every other open.
   */
  readonly openTab: (kind: string, options?: SidebarRightOpenTabOptions) => void
  /** Close through the resource owner's cleanup handler. */
  readonly closeTab: (tabId: TabId) => void
  /** Split through the same controller as keyboard commands. */
  readonly splitPane: (paneId: PaneId) => void
  /** Toggle the dock panel using its current display mode. */
  readonly toggleFullscreen: () => void
  readonly hooks: {
    readonly shortcuts: HostObservable<readonly ShortcutCatalogEntry[]>
    readonly tabTypes: HostObservable<readonly SidebarRightTabDefinition[]>
  }
  readonly keyedHooks: {
    readonly tabNavigation: (key: string) => HostObservable<SidebarRightTabNavigation>
  }
  /** Read a committed record's lifetime; never creates an occurrence. */
  readonly occurrence: (tab: Pick<TabRecord, 'id'>) => TabOccurrence
}

/** The column seat's props: session scope, so the session arrives as a standard prop. */
export type RightbarSeatProps =
  & PropsRuntime<'rightbar.session'>
  & Children
  & Store
  & PropsLocale<'sidebarRight'>
  & InjectFace<SidebarRightInjected>

/** Everything the panel needs, already bound to one session. */
interface PanelProps {
  readonly sessionId: SessionId
  readonly surface: SurfaceState
  readonly actions: Store['actions']
  readonly t: RightbarSeatProps['t']
  readonly renderSlot: Children['renderSlot']
  readonly openTab: SidebarRightInjected['openTab']
  readonly closeTab: SidebarRightInjected['closeTab']
  readonly splitPane: SidebarRightInjected['splitPane']
  readonly toggleFullscreen: SidebarRightInjected['toggleFullscreen']
  readonly shortcuts: readonly ShortcutCatalogEntry[]
  readonly useTabTypes: RightbarSeatProps['useTabTypes']
  readonly useTabNavigation: RightbarSeatProps['useTabNavigation']
  readonly useStore: Store['useStore']
  readonly occurrence: SidebarRightInjected['occurrence']
  readonly fullscreen: boolean
  readonly autoFullscreen: boolean
  readonly active: boolean
  readonly retainTab: RightbarSeatProps['retainTab']
  /** Receives the kit's room-rule readings for the service's `split`. */
  readonly reportRoom: (fits: ReadonlyMap<PaneId, HalvesFit>) => void
}

/** The guide tab one pane holds, if any: a pane holds at most one. */
function guideIn(layout: LayoutState, paneId: PaneId): TabId | undefined {
  return findPaneContentTab(layout, paneId, pageAddress(GUIDE_KIND), GUIDE_KIND)
}

/**
 * Build the kit's intent face for one session out of the store's actions.
 * @param sessionId - the session the seat draws; every action is bound to it.
 * @param actions - the seat's bound store actions.
 * @param openTab - the navigation face's `openTab`, which the strip's add control asks for a guide through.
 * @returns the intents the kit reports gestures to.
 */
export function intentsFor(sessionId: SessionId, actions: Store['actions'], openTab: PanelProps['openTab'], closeTab?: PanelProps['closeTab'], splitPane?: PanelProps['splitPane']): DockIntents {
  return {
    focusTab: (tabId) => { actions.focusTab(sessionId, tabId) },
    focusPane: (paneId) => { actions.focusPane(sessionId, paneId) },
    splitPane: splitPane ?? ((paneId) => { actions.splitPane(sessionId, paneId) }),
    // The guide is unique per pane: the control is drawn only while its pane
    // holds none (`canAddTab` below) and asks for one there without regard to
    // guides in other panes; the store settles the open on a guide the pane
    // already holds, so the ask is idempotent all the same.
    addTab: (paneId) => { openTab(GUIDE_KIND, { paneId, revealIfOpened: false }) },
    closeTab: closeTab ?? ((tabId) => { actions.closeTab(sessionId, tabId) }),
    duplicateTab: (tabId) => { actions.duplicateTab(sessionId, tabId) },
    floatTab: (tabId, rect?: FloatRect) => { actions.floatTab(sessionId, tabId, rect) },
    unfloatPane: (paneId) => { actions.unfloatPane(sessionId, paneId) },
    placeTab: (tabId, toPaneId, index) => { actions.placeTab(sessionId, tabId, toPaneId, index) },
    dropTab: (tabId, paneId, zone) => { actions.dropTab(sessionId, tabId, paneId, zone) },
    moveFloat: (paneId, x, y) => { actions.moveFloat(sessionId, paneId, x, y) },
    resizeFloat: (paneId, rect) => { actions.resizeFloat(sessionId, paneId, rect) },
    resizeSplit: (splitId, sizes) => { actions.resizeSplit(sessionId, splitId, sizes) },
  }
}

/** One tab's slot dispatch: which seat, and what to render when no type registered. */
interface TabSlotProps extends Pick<PanelProps, 'renderSlot' | 'occurrence' | 'useTabTypes' | 'useTabNavigation' | 'useStore' | 'fullscreen' | 'active' | 'retainTab' | 'shortcuts'> {
  readonly tab: TabRecord
  readonly seat: 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title'
  readonly fallback: ReactNode
}

/**
 * Dispatch one tab's body or title with stable framework hooks and record lifetime.
 */
function TabSlot({
  renderSlot, occurrence, useTabTypes, useTabNavigation, useStore, fullscreen, shortcuts, active, retainTab, tab, seat, fallback,
}: TabSlotProps): ReactNode {
  const { id, signal, tabActions } = occurrence(tab)
  const definition = useTabTypes(types => types.find(definition => definition.kind === tab.kind))
  const retained = seat === 'sidebar.right.pane.tab' && definition?.keepMounted === true
  useLayoutEffect(() => retained ? retainTab(tab.id, signal) : undefined, [retained, retainTab, tab.id, signal])
  const hookContext = useMemo((): TabHookContext => ({
    tabId: tab.id,
    shortcuts,
    title: seat === 'sidebar.right.pane.tab.title',
    fullscreen,
    active,
    signal,
    actions: tabActions,
    useStore,
    useTabNavigation,
  }), [tab.id, seat, fullscreen, active, signal, tabActions, useStore, useTabNavigation, shortcuts])
  const content = renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind, fallback, hookContext })
  return seat === 'sidebar.right.pane.tab.title'
    ? <span className={css.tabTitle} data-sidebar-right-tab={tab.id} data-sidebar-right-occurrence={id}>{content}</span>
    : <div className={css.tabBody} data-sidebar-right-tab={tab.id} data-sidebar-right-occurrence={id}>{content}</div>
}

/**
 * Dispatch a tab's body to its registered type.
 *
 * A kind with no registrant is a real state, not a defect: a session log can
 * carry a tab whose type shipped in a plugin that is no longer mounted. Saying so
 * is better than an empty pane.
 */
function bodiesFor(panel: PanelProps): TabRenderer {
  const { t, ...rest } = panel
  // Slot dispatch selects a type; the record key separates bodies of that type.
  return tab => (
    <TabSlot
      key={tab.id}
      {...rest}
      tab={tab}
      seat="sidebar.right.pane.tab"
      fallback={<p className={css.unavailable} data-sidebar-right-unavailable>{t('tab.unavailable')}</p>}
    />
  )
}

/** Dispatch a tab's title to its registered type; without one the chip shows the title captured at open time. */
function titlesFor(panel: PanelProps): TabRenderer {
  return tab => <TabSlot key={tab.id} {...panel} tab={tab} seat="sidebar.right.pane.tab.title" fallback={tab.title} />
}

/** Expand-to-viewport glyph from the shared product artwork. */
function FullscreenGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.33203 10.4054V13.1681C2.33229 13.444 2.55605 13.6681 2.83203 13.6681H5.49512V14.6681H2.83203C2.00376 14.6681 1.33229 13.9963 1.33203 13.1681V10.4054H2.33203ZM14.6689 13.1681C14.6687 13.996 13.9968 14.6676 13.1689 14.6681H10.4951V13.6681H13.1689C13.4445 13.6676 13.6687 13.4437 13.6689 13.1681V10.4054H14.6689V13.1681ZM13.1689 1.33118C13.9969 1.33163 14.6688 2.00315 14.6689 2.83118V5.4054H13.6689V2.83118C13.6688 2.55544 13.4446 2.33162 13.1689 2.33118H10.4951V1.33118H13.1689ZM5.49512 2.33118H2.83203C2.55598 2.33118 2.33218 2.55516 2.33203 2.83118V5.4054H1.33203V2.83118C1.33218 2.00288 2.00369 1.33118 2.83203 1.33118H5.49512V2.33118Z" fill="currentColor" />
    </svg>
  )
}

/** Restore-from-fullscreen glyph from the shared product artwork. */
function ExitFullscreenGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9 2.5V6C9 6.26522 9.10536 6.51957 9.29289 6.70711C9.48043 6.89464 9.73478 7 10 7H13.5" stroke="currentColor" />
      <path d="M7 13.5V10C7 9.73478 6.89464 9.48043 6.70711 9.29289C6.51957 9.10536 6.26522 9 6 9H2.5" stroke="currentColor" />
    </svg>
  )
}

/** The panel's two controls, placed by the kit at the top-right pane's strip end. */
function PanelChrome({ sessionId, fullscreen, actions, t, shortcuts, toggleFullscreen }: Pick<PanelProps, 'sessionId' | 'actions' | 't' | 'fullscreen' | 'shortcuts' | 'toggleFullscreen'>): ReactNode {
  const next: DockMode = fullscreen ? 'push' : 'fullscreen'
  const modeLabel = fullscreen ? t('chrome.exitFullscreen') : t('chrome.toFullscreen')
  const mode = shortcuts.find(entry => entry.id === 'pane.fullscreen.toggle')
  const toggle = shortcuts.find(entry => entry.id === 'sidebar.right.toggle')
  return (
    <>
      <Tooltip label={modeLabel} shortcutKeys={mode?.keys} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={modeLabel}
          aria-keyshortcuts={mode?.aria}
          data-sidebar-right-mode={next}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}
        </button>
      </Tooltip>
      <Tooltip label={t('chrome.collapse')} shortcutKeys={toggle?.keys} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('chrome.collapseAria')}
          aria-keyshortcuts={toggle?.aria}
          data-sidebar-right-toggle
          onClick={() => { actions.toggleExpanded(sessionId) }}
        >
          <IconPanelLeftOutlineRegular className={css.collapseGlyph} />
        </button>
      </Tooltip>
    </>
  )
}

/**
 * The panel: the docked surface with the two controls in its top-right strip,
 * anchored to the frame's right edge and slid off it while collapsed.
 */
function SidebarPanel(panel: PanelProps & { width: number; panelRef: RefObject<HTMLDivElement> }): ReactNode {
  const { sessionId, surface, actions, t, renderSlot, openTab, width, reportRoom, fullscreen, panelRef } = panel
  const { expanded } = surface.layout
  const types = panel.useTabTypes(value => value)
  return (
    <div
      ref={panelRef}
      className={css.panel}
      style={{ width: fullscreen ? '100vw' : width,
        '--dsh-sidebar-width': fullscreen ? '100vw' : `${width}px` } as CSSProperties}
      data-sidebar-right-session={sessionId}
      data-sidebar-right-panel={fullscreen ? 'fullscreen' : 'push'}
      data-sidebar-right-open={expanded || undefined}
      // Off-edge is out of reach: the stylesheet's visibility flip takes the
      // hidden panel out of the tab order, and this takes it out of the
      // accessibility tree.
      aria-hidden={!expanded || undefined}
    >
      <div className={css.panelBody}>
        <DockLayout
          state={surface.layout}
          canSplit={canSplit(surface.layout) && dockPaneIds(surface.layout).length < 2}
          dropZones="horizontal"
          minPaneFraction={0.2}
          canAddTab={paneId => guideIn(surface.layout, paneId) === undefined}
          canCloseTab={tabId => canCloseTab(surface, tabId)}
          intents={intentsFor(sessionId, actions, openTab, panel.closeTab, panel.splitPane)}
          labels={dockLabels(t, panel.shortcuts.find(entry => entry.id === 'pane.split'), panel.shortcuts.find(entry => entry.id === 'page.close'))}
          renderTab={bodiesFor(panel)}
          renderTabTitle={titlesFor(panel)}
          active={panel.active}
          keepMounted={tab => types.find(type => type.kind === tab.kind)?.keepMounted === true}
          renderTabMenuItems={(tab, dismiss) =>
            renderSlot('sidebar.right.tab.menu.item', { tab, dismiss })}
          chrome={<PanelChrome
            sessionId={sessionId} fullscreen={fullscreen} actions={actions} t={t}
            shortcuts={panel.shortcuts} toggleFullscreen={panel.toggleFullscreen}
          />}
          onRoom={reportRoom}
        />
      </div>
    </div>
  )
}

/**
 * The right column's occupant: stable tab containers, docked or floating.
 * It is also where the
 * frame learns the panel's presentation, and where `ctx.sidebarRight` learns
 * which session it is acting on, because this is the seat that knows both.
 */
export function RightbarSeat({
  sessionId, width, viewportWidth, canShow, useStore, actions, t, renderSlot, syncPresentation, bindService, openTab, closeTab,
  useTabTypes, useTabNavigation, occurrence, retainTab, active, useShortcuts, splitPane, toggleFullscreen,
}: RightbarSeatProps): ReactNode {
  // One store instance per session, so this map holds this session's surface.
  // The binding published below serves the public face's commands on the
  // mounted session; a tab's own actions route through the controller's
  // adopted stores instead.
  const shortcuts = useShortcuts(entries => entries)
  const surfaces = useStore(state => state.bySession)
  const surface = surfaces[sessionId]
  const shown = active && surface !== undefined && surface.layout.expanded
  const autoFullscreen = viewportWidth < 768
  const fullscreen = autoFullscreen || surface?.layout.mode === 'fullscreen'
  const panelRef = useRef<HTMLDivElement | null>(null)
  // The kit's room-rule readings, kept in a ref: the service reads them at
  // call time through the binding, and a reading never re-renders anything.
  const room = useRef<ReadonlyMap<PaneId, HalvesFit>>(new Map())
  const reportRoom = useCallback((fits: ReadonlyMap<PaneId, HalvesFit>): void => { room.current = fits }, [])
  const track = shown && !autoFullscreen

  useEffect(() => {
    if (active && surface === undefined) actions.open(sessionId)
  }, [actions, sessionId, surface, active])

  useLayoutEffect(() => {
    if (shown && !fullscreen && !canShow) actions.setExpanded(sessionId, false)
  }, [actions, sessionId, shown, fullscreen, canShow])

  // The open/close slide needs no pulse of its own: the shell's window drag
  // watcher (ui-web) measures the marked rows every frame the surface moves and
  // sets the recall mark itself (electron#32341).

  // Fullscreen leaves the previous column report in force until its own slide
  // completes. Normal presentation and zero-duration transitions report before paint.
  useLayoutEffect(() => {
    if (!active) return
    let disposed = false
    const reportWhenCovered = (): void => {
      if (disposed) return
      // A shown panel renders unconditionally and attaches its ref before this effect.
      const entering = shown && fullscreen
        ? (panelRef.current as HTMLDivElement).getAnimations({ subtree: true }).filter(animation =>
          'transitionProperty' in animation && animation.transitionProperty === 'transform'
          && animation.playState !== 'finished' && animation.playState !== 'idle')
        : []
      if (entering.length === 0) {
        syncPresentation({ shown, track, fullscreen })
        return
      }
      // Cancellation can replace the transition or remove it for reduced motion.
      void Promise.allSettled(entering.map(animation => animation.finished)).then(reportWhenCovered)
    }
    reportWhenCovered()
    return () => { disposed = true }
  }, [sessionId, shown, track, fullscreen, syncPresentation, active])
  // Leaving is part of that report: a seat that unmounts with its session must
  // hand the track back rather than leave one sized for a surface nobody draws.
  useLayoutEffect(() => active
    ? () => { syncPresentation({ shown: false, track: false, fullscreen: false }) }
    : undefined, [syncPresentation, active])

  // Republished on every committed change: the service's readers answer from the
  // last commit, and its commands act on the session actually on screen.
  useEffect(
    () => active
      ? bindService({ sessionId, actions, surfaces, autoFullscreen,
        closeWithFocus: (paneId, close) => { closeWithPaneFocus(document, sessionId, paneId, close) },
        openWithFocus: (open) => { openWithPaneFocus(document, sessionId, open) },
        canSplitPane: paneId => room.current.get(paneId)?.row !== false })
      : undefined,
    [bindService, sessionId, actions, surfaces, autoFullscreen, active],
  )
  // The Tab domain is not synced here: the controller adopted this session's
  // store as the runtime minted it and reconciles on the store's own commits,
  // on screen or not.

  if (surface === undefined) return null
  const panel: PanelProps = {
    sessionId, actions, t, renderSlot, surface, openTab, closeTab, useTabTypes, useTabNavigation, useStore, occurrence,
    fullscreen, autoFullscreen, reportRoom, active, retainTab, shortcuts, splitPane, toggleFullscreen,
  }
  return <SidebarPanel {...panel} width={width} panelRef={panelRef} />
}
