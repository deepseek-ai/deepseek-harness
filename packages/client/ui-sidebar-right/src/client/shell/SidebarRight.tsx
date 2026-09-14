/**
 * The Sidebar's seat in the frame, and the panel it draws.
 *
 * The frame owns the right column's geometry; this package owns one content
 * tree at the column width or fixed across the viewport. A shown wide panel
 * retains its track in fullscreen, preserving the conversation width. Below
 * 768px fullscreen is derived from viewport width, without changing manual mode.
 *
 * The panel stays mounted while collapsed, translated off the frame's right
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
 * hidden. Floating panels portal out because they must cross the column and the
 * conversation, and the kit already positions them in viewport coordinates.
 *
 * Tab bodies do not live here. Each one is a registration under its type's kind,
 * dispatched through the keyed `sidebar.right.pane.tab` seat (and a live chip
 * title through `sidebar.right.pane.tab.title`), so a new tab type needs no edit
 * to this file. What a body receives beyond the record — navigation, lifetime
 * signal, actions — is read through the slot-owned useTabInfo hook. The Tab
 * domain follows each session's store commits, including sessions off screen.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconPanelLeftOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'
import type { DockIntents, DockMode, FloatRect, TabId, TabRecord, TabRenderer } from '@deepseek-ai/dsh-client-ui-dockkit'
import { canSplit, dockPaneIds, DockSurface, findPaneContentTab, FloatLayer } from '@deepseek-ai/dsh-client-ui-dockkit'
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
   * honest source is the mounted seat. Held for as long as the seat is mounted.
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
  }) => () => void
  /**
   * The navigation face's `openTab`, for the strip's add control: a new tab is
   * the guide opened by kind, through the same path as every other open.
   */
  readonly openTab: (kind: string, options?: SidebarRightOpenTabOptions) => void
  /** Close through the resource owner's cleanup handler. */
  readonly closeTab: (tabId: TabId) => void
  readonly hooks: {
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
  readonly useTabTypes: RightbarSeatProps['useTabTypes']
  readonly useTabNavigation: RightbarSeatProps['useTabNavigation']
  readonly useStore: Store['useStore']
  readonly occurrence: SidebarRightInjected['occurrence']
  readonly fullscreen: boolean
  readonly autoFullscreen: boolean
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
export function intentsFor(sessionId: SessionId, actions: Store['actions'], openTab: PanelProps['openTab'], closeTab?: PanelProps['closeTab']): DockIntents {
  return {
    focusTab: (tabId) => { actions.focusTab(sessionId, tabId) },
    focusPane: (paneId) => { actions.focusPane(sessionId, paneId) },
    splitPane: (paneId) => { actions.splitPane(sessionId, paneId) },
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
interface TabSlotProps extends Pick<PanelProps, 'renderSlot' | 'occurrence' | 'useTabTypes' | 'useTabNavigation' | 'useStore' | 'fullscreen'> {
  readonly tab: TabRecord
  readonly seat: 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title'
  readonly fallback: ReactNode
}

/**
 * Dispatch one tab's body or title with stable framework hooks and record lifetime.
 */
function TabSlot({
  renderSlot, occurrence, useTabTypes, useTabNavigation, useStore, fullscreen, tab, seat, fallback,
}: TabSlotProps): ReactNode {
  const { signal, tabActions } = occurrence(tab)
  const definition = useTabTypes(types => types.find(definition => definition.kind === tab.kind))
  const hookContext = useMemo((): TabHookContext => ({
    tabId: tab.id,
    title: seat === 'sidebar.right.pane.tab.title',
    fullscreen,
    signal,
    actions: tabActions,
    useStore,
    useTabNavigation,
  }), [tab.id, seat, fullscreen, signal, tabActions, useStore, useTabNavigation])
  return renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind, fallback, hookContext })
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
  // Keyed by record: the kit draws one body per pane in one place, and the
  // keyed slot below keys on the type, so two tabs of one kind would otherwise
  // share a component instance and its local state (a scroll position, a ref).
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

/** Expand-to-viewport glyph: four frame corners (figma extract). */
function FullscreenGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g fill="currentColor" stroke="currentColor" strokeWidth="0.105646" strokeLinecap="square">
        <path d="M6.04798 2.13627V0.815964H5.99549L5.36158 0.817345V0.815964L3.39978 0.815274C3.01892 0.815274 2.67749 0.814821 2.39919 0.844967C2.10813 0.87655 1.80506 0.949512 1.52981 1.14949C1.3822 1.25681 1.25251 1.38652 1.14518 1.53412C0.945217 1.80935 0.872245 2.11246 0.840659 2.4035C0.810509 2.68178 0.810965 3.02324 0.810966 3.40409L0.811656 5.36589V5.9998L0.810966 6.05297L0.864137 6.05228H2.13196L2.18513 6.05297L2.18444 5.9998V5.36589L2.18513 3.40409C2.18513 2.99322 2.18631 2.73978 2.20653 2.55266C2.22499 2.38234 2.25273 2.34575 2.25556 2.34204C2.27837 2.31066 2.30635 2.28267 2.33774 2.25987C2.34207 2.25657 2.37978 2.22911 2.54835 2.21084C2.73548 2.19063 2.98893 2.18944 3.39978 2.18944L5.36158 2.18875L5.9948 2.18944H6.04867L6.04798 2.13627Z" />
        <path d="M9.94031 13.86L9.94031 15.1803L9.99279 15.1803L10.6267 15.179L10.6267 15.1803L12.5885 15.181C12.9694 15.181 13.3108 15.1815 13.5891 15.1513C13.8801 15.1198 14.1832 15.0468 14.4585 14.8468C14.6061 14.7395 14.7358 14.6098 14.8431 14.4622C15.0431 14.187 15.116 13.8838 15.1476 13.5928C15.1778 13.3145 15.1773 12.9731 15.1773 12.5922L15.1766 10.6304L15.1766 9.9965L15.1773 9.94333L15.1241 9.94402L13.8563 9.94402L13.8032 9.94333L13.8038 9.9965L13.8038 10.6304L13.8032 12.5922C13.8032 13.0031 13.802 13.2565 13.7817 13.4437C13.7633 13.614 13.7355 13.6506 13.7327 13.6543C13.7099 13.6856 13.6819 13.7136 13.6505 13.7364C13.6462 13.7397 13.6085 13.7672 13.4399 13.7855C13.2528 13.8057 12.9993 13.8069 12.5885 13.8069L10.6267 13.8076L9.99348 13.8069L9.93962 13.8069L9.94031 13.86Z" />
        <path d="M13.8568 6.05243H15.1771V5.99995L15.1757 5.36604H15.1771L15.1778 3.40423C15.1778 3.02337 15.1783 2.68194 15.1481 2.40365C15.1165 2.11259 15.0436 1.80952 14.8436 1.53427C14.7363 1.38666 14.6066 1.25697 14.459 1.14964C14.1837 0.949672 13.8806 0.8767 13.5896 0.845114C13.3113 0.814965 12.9698 0.815421 12.589 0.815421L10.6272 0.816112H9.99329L9.94011 0.815421L9.9408 0.868592V2.13641L9.94011 2.18958L9.99329 2.18889H10.6272L12.589 2.18958C12.9999 2.18958 13.2533 2.19077 13.4404 2.21099C13.6107 2.22944 13.6473 2.25719 13.651 2.26002C13.6824 2.28282 13.7104 2.31081 13.7332 2.34219C13.7365 2.34653 13.764 2.38424 13.7822 2.5528C13.8025 2.73993 13.8037 2.99339 13.8037 3.40423L13.8043 5.36604L13.8037 5.99926V6.05312L13.8568 6.05243Z" />
        <path d="M2.12951 9.94389L0.809205 9.94389L0.809205 9.99637L0.810586 10.6303L0.809205 10.6303L0.808514 12.5921C0.808514 12.9729 0.808061 13.3144 0.838207 13.5927C0.86979 13.8837 0.942753 14.1868 1.14273 14.4621C1.25005 14.6097 1.37976 14.7394 1.52736 14.8467C1.80259 15.0467 2.1057 15.1196 2.39674 15.1512C2.67502 15.1814 3.01648 15.1809 3.39733 15.1809L5.35913 15.1802L5.99304 15.1802L6.04621 15.1809L6.04552 15.1277L6.04552 13.8599L6.04621 13.8067L5.99304 13.8074L5.35913 13.8074L3.39733 13.8067C2.98646 13.8067 2.73302 13.8056 2.5459 13.7853C2.37559 13.7669 2.33899 13.7391 2.33528 13.7363C2.3039 13.7135 2.27591 13.6855 2.25311 13.6541C2.24981 13.6498 2.22235 13.6121 2.20408 13.4435C2.18387 13.2564 2.18268 13.0029 2.18268 12.5921L2.18199 10.6303L2.18268 9.99706L2.18268 9.9432L2.12951 9.94389Z" />
      </g>
    </svg>
  )
}

/** Restore-from-fullscreen glyph: two corners drawn inward (figma extract). */
function ExitFullscreenGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g fill="currentColor" stroke="currentColor" strokeWidth="0.105646" strokeLinecap="square">
        <path d="M10.698 0.379607H9.43015L9.37698 0.378916L9.37767 0.432087V1.066L9.37698 4.0277C9.37698 4.40856 9.37653 4.74998 9.40667 5.02828C9.43826 5.31934 9.51053 5.62311 9.71051 5.89835C9.81779 6.04587 9.94762 6.1757 10.0951 6.28298C10.3704 6.48296 10.6741 6.55523 10.9652 6.58682C11.2435 6.61696 11.5849 6.61651 11.9658 6.61651L14.9275 6.61582H15.5614L15.6146 6.61651L15.6139 6.56334V5.29552L15.6146 5.24235L15.5614 5.24304H14.9275L11.9658 5.24235C11.5545 5.24235 11.3009 5.24191 11.1137 5.22163C10.9443 5.20329 10.9078 5.17501 10.9038 5.17191C10.8724 5.14911 10.8444 5.12112 10.8216 5.08974C10.8185 5.08566 10.7902 5.04908 10.7719 4.87982C10.7516 4.69263 10.7511 4.439 10.7511 4.0277L10.7505 1.066V0.432087L10.7511 0.378916L10.698 0.379607Z" />
        <path d="M5.29031 15.6167L6.55813 15.6167L6.6113 15.6174L6.61061 15.5642L6.61061 14.9303L6.6113 11.9686C6.6113 11.5878 6.61176 11.2463 6.58161 10.968C6.55003 10.677 6.47775 10.3732 6.27777 10.098C6.17049 9.95045 6.04067 9.82062 5.89315 9.71334C5.6179 9.51336 5.31413 9.44109 5.02307 9.40951C4.74478 9.37936 4.40335 9.37981 4.02249 9.37981L1.06079 9.3805L0.426879 9.3805L0.373708 9.37981L0.374398 9.43298L0.374398 10.7008L0.373708 10.754L0.426879 10.7533L1.06079 10.7533L4.02249 10.754C4.43379 10.754 4.68742 10.7544 4.87461 10.7747C5.04393 10.793 5.08047 10.8213 5.08453 10.8244C5.11591 10.8472 5.1439 10.8752 5.1667 10.9066C5.16982 10.9107 5.19808 10.9472 5.21642 11.1165C5.2367 11.3037 5.23714 11.5573 5.23714 11.9686L5.23783 14.9303L5.23783 15.5642L5.23714 15.6174L5.29031 15.6167Z" />
      </g>
    </svg>
  )
}

/** The panel's two controls, placed by the kit at the top-right pane's strip end. */
function PanelChrome({ sessionId, fullscreen, autoFullscreen, actions, t }: Pick<PanelProps, 'sessionId' | 'actions' | 't' | 'fullscreen' | 'autoFullscreen'>): ReactNode {
  const next: DockMode = fullscreen ? 'push' : 'fullscreen'
  const modeLabel = fullscreen ? t('chrome.exitFullscreen') : t('chrome.toFullscreen')
  return (
    <>
      <Tooltip label={modeLabel} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={modeLabel}
          data-sidebar-right-mode={next}
          onClick={() => {
            if (fullscreen && autoFullscreen) actions.setExpanded(sessionId, false)
            actions.setMode(sessionId, next)
          }}
        >
          {fullscreen ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}
        </button>
      </Tooltip>
      <Tooltip label={t('chrome.collapse')} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('chrome.collapseAria')}
          data-sidebar-right-toggle
          onClick={() => { actions.toggleExpanded(sessionId) }}
        >
          <IconPanelLeftOutline16 className={css.collapseGlyph} />
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
  const { sessionId, surface, actions, t, renderSlot, openTab, width, reportRoom, fullscreen, autoFullscreen, panelRef } = panel
  const { expanded } = surface.layout
  return (
    <div
      ref={panelRef}
      className={css.panel}
      style={{ width: fullscreen ? '100%' : width }}
      data-sidebar-right-panel={fullscreen ? 'fullscreen' : 'push'}
      data-sidebar-right-open={expanded || undefined}
      // Off-edge is out of reach: the stylesheet's visibility flip takes the
      // hidden panel out of the tab order, and this takes it out of the
      // accessibility tree.
      aria-hidden={!expanded || undefined}
    >
      <div className={css.panelBody}>
        <DockSurface
          state={surface.layout}
          canSplit={canSplit(surface.layout) && dockPaneIds(surface.layout).length < 2}
          hideSplitWhenBlocked
          dropZones="horizontal"
          minPaneFraction={0.2}
          canAddTab={paneId => guideIn(surface.layout, paneId) === undefined}
          canCloseTab={tabId => canCloseTab(surface, tabId)}
          intents={intentsFor(sessionId, actions, openTab, panel.closeTab)}
          labels={dockLabels(t)}
          renderTab={bodiesFor(panel)}
          renderTabTitle={titlesFor(panel)}
          renderTabMenuItems={(tab, dismiss) =>
            renderSlot('sidebar.right.tab.menu.item', { tab, dismiss })}
          chrome={<PanelChrome sessionId={sessionId} fullscreen={fullscreen} autoFullscreen={autoFullscreen} actions={actions} t={t} />}
          onRoom={reportRoom}
        />
      </div>
    </div>
  )
}

/** Portal the floating layer out of whichever seat rendered it. */
function Floats(panel: PanelProps): ReactNode {
  const { sessionId, surface, actions, t, openTab } = panel
  if (surface.layout.floats.length === 0) return null
  return createPortal(
    <div className={css.floatHost} data-sidebar-right-float-host>
      <FloatLayer
        state={surface.layout}
        canCloseTab={tabId => canCloseTab(surface, tabId)}
        intents={intentsFor(sessionId, actions, openTab, panel.closeTab)}
        labels={dockLabels(t)}
        renderTab={bodiesFor(panel)}
        renderTabTitle={titlesFor(panel)}
      />
    </div>,
    document.body,
  )
}

/**
 * The right column's occupant: the panel, anchored to the column's edge and
 * shown or hidden by sliding, plus the floating layer. It is also where the
 * frame learns the panel's presentation, and where `ctx.sidebarRight` learns
 * which session it is acting on, because this is the seat that knows both.
 */
export function RightbarSeat({
  sessionId, width, viewportWidth, canShow, useStore, actions, t, renderSlot, syncPresentation, bindService, openTab, closeTab,
  useTabTypes, useTabNavigation, occurrence,
}: RightbarSeatProps): ReactNode {
  // One store instance per session, so this map holds this session's surface.
  // The binding published below serves the public face's commands on the
  // mounted session; a tab's own actions route through the controller's
  // adopted stores instead.
  const surfaces = useStore(state => state.bySession)
  const surface = surfaces[sessionId]
  const shown = surface !== undefined && surface.layout.expanded
  const autoFullscreen = viewportWidth < 768
  const fullscreen = autoFullscreen || surface?.layout.mode === 'fullscreen'
  const panelRef = useRef<HTMLDivElement | null>(null)
  // The kit's room-rule readings, kept in a ref: the service reads them at
  // call time through the binding, and a reading never re-renders anything.
  const room = useRef<ReadonlyMap<PaneId, HalvesFit>>(new Map())
  const reportRoom = useCallback((fits: ReadonlyMap<PaneId, HalvesFit>): void => { room.current = fits }, [])
  const track = shown && !autoFullscreen

  useEffect(() => {
    if (surface === undefined) actions.open(sessionId)
  }, [actions, sessionId, surface])

  useLayoutEffect(() => {
    if (shown && !fullscreen && !canShow) actions.setExpanded(sessionId, false)
  }, [actions, sessionId, shown, fullscreen, canShow])

  // Fullscreen leaves the previous column report in force until its own slide
  // completes. Normal presentation and zero-duration transitions report before paint.
  useLayoutEffect(() => {
    let disposed = false
    const reportWhenCovered = (): void => {
      if (disposed) return
      // A shown panel renders unconditionally and attaches its ref before this effect.
      const entering = shown && fullscreen
        ? (panelRef.current as HTMLDivElement).getAnimations().filter(animation =>
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
  }, [sessionId, shown, track, fullscreen, syncPresentation])
  // Leaving is part of that report: a seat that unmounts with its session must
  // hand the track back rather than leave one sized for a surface nobody draws.
  useLayoutEffect(() => () => { syncPresentation({ shown: false, track: false, fullscreen: false }) }, [syncPresentation])

  // Republished on every committed change: the service's readers answer from the
  // last commit, and its commands act on the session actually on screen.
  useEffect(
    () => bindService({ sessionId, actions, surfaces, canSplitPane: paneId => room.current.get(paneId)?.row !== false }),
    [bindService, sessionId, actions, surfaces],
  )
  // The Tab domain is not synced here: the controller adopted this session's
  // store as the runtime minted it and reconciles on the store's own commits,
  // on screen or not.

  if (surface === undefined) return null
  const panel: PanelProps = {
    sessionId, actions, t, renderSlot, surface, openTab, closeTab, useTabTypes, useTabNavigation, useStore, occurrence,
    fullscreen, autoFullscreen, reportRoom,
  }
  return (
    <>
      <SidebarPanel {...panel} width={width} panelRef={panelRef} />
      <Floats {...panel} />
    </>
  )
}
