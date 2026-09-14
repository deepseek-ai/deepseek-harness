/**
 * The store shell over the docking kit: one surface per session, held as plain
 * data so the kit's pure functions are the only thing that ever computes a
 * layout.
 *
 * Every action follows the same steps — mint the ids the intent needs, ask the
 * kit's planner what operations carry it out, let the settle planner keep every
 * pane populated, record it all as one history entry — and then assigns the
 * session's whole surface back in one go. Nothing here reaches into a draft to
 * edit a layout in place, which is what keeps the kit testable without a store
 * and keeps snapshot identity honest.
 *
 * The settle step is this product's rule, not the kit's: an intent never leaves
 * an expanded column with an empty pane — emptied side panes merge away, and an
 * empty root pane seeds the default page. A collapsed column may stand empty;
 * the seed waits for the expansion that would otherwise show nothing.
 *
 * A focus that changes nothing — a tab already active in its already-active
 * pane, a pane already active — plans nothing and records nothing, whoever
 * asks: the kit's chip click and `ctx.sidebarRight.focus` alike.
 *
 * So is page uniqueness: a pane holds at most one tab of each page kind (a tab
 * whose content is the kind's own page address — the guide, the explorer).
 * Opening a page into a pane that shows it focuses that tab, in that pane and
 * nowhere else, and a page dragged, dropped, or docked into such a pane merges
 * into the pane's own — the arriving tab closes and the pane's own is focused.
 * The kit plans none of this; it is decided here before its planners run.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type {
  DockMode, DockZone, FloatRect, History, LayoutOp, LayoutState, Mint, PaneId, SplitId, TabId, TabRecord,
} from '@deepseek-ai/dsh-client-ui-dockkit'
import {
  activeDockPaneId, createInitialState, dockPaneIds, EMPTY_HISTORY, findPaneContentTab, findTabPane, getPane,
  planDropTab, planDuplicateTab, planFloatTab, planOpenContent, planPlaceTab, planResizeSplit, planSetExpanded,
  planSetMode, planSettle, planSplitPane, planUnfloatPane, record, replay, stepBack, stepForward,
} from '@deepseek-ai/dsh-client-ui-dockkit'
import { GUIDE_KIND, pageAddress, type SidebarRightSeed } from './contract/seed.ts'

/** One session's docking surface: the layout, its sequence, and the id counter. */
export interface SurfaceState {
  readonly layout: LayoutState
  readonly history: History
  /** How many ids this surface has minted; carried so replay stays reproducible. */
  readonly minted: number
}

/**
 * Every session's surface, keyed by session id.
 *
 * Written mutable because an action receives this type as its draft; the
 * immutability that matters is behavioural — actions only ever assign a whole
 * new map, never reach into one.
 */
export interface SidebarRightState {
  bySession: Record<string, SurfaceState>
}

/** A planner call, as the store needs it: state and a mint in, operations out. */
type SurfacePlan = (state: LayoutState, mint: Mint, makeTab: (id: TabId) => TabRecord) => readonly LayoutOp[]

/**
 * Decide whether an explicit close may remove a tab.
 * @param surface - current surface.
 * @param tabId - tab requested for closing.
 * @returns false for a missing tab or the guide standing as the only docked tab.
 */
export function canCloseTab(surface: SurfaceState, tabId: TabId): boolean {
  const tab = surface.layout.tabs[tabId]
  return tab !== undefined && !(tab.kind === GUIDE_KIND && soleDockedTab(surface.layout, tabId))
}

/** Build the currently selected default tab. */
function seedRecord(id: TabId, seed: () => SidebarRightSeed): TabRecord {
  const initial = seed()
  return { id, kind: initial.kind, title: initial.title, contentId: pageAddress(initial.kind) }
}

/**
 * What the navigation controller asks the store to open, the address already
 * claimed. Placement is by `replaceTab` first, then `paneId`, then the active pane.
 */
export interface OpenContentIntent {
  readonly kind: string
  readonly contentId: string
  readonly title: string
  /** Land a new tab in this pane. */
  readonly paneId?: PaneId
  /** Take this tab's pane and slot, and close it in the same entry. */
  readonly replaceTab?: TabId
  /** Resource tabs reveal an existing identity by default; `false` permits duplicates. Pages always deduplicate within the target pane. */
  readonly revealIfOpened?: boolean
}

/** A mint that counts, so the surface can carry its position forward. */
function counting(from: number): { mint: Mint; used: () => number } {
  let counter = from
  // The mint is where a string becomes a branded id: the prefix names the kind,
  // the counter keeps every id of this surface unique.
  const mint = ((prefix: string): string => {
    counter += 1
    return `${prefix}${counter}`
  }) as Mint
  return { mint, used: () => counter }
}

/**
 * The surface a session starts with: collapsed, one pane, no tabs. The default
 * page is not seeded here — the settle rule seeds it when the column first
 * expands still empty, so a collapsed column never holds a page nobody asked
 * for, and an open into a fresh surface shows only what it opened.
 * @returns the initial surface.
 */
export function createSurface(): SurfaceState {
  const counter = counting(0)
  return {
    layout: createInitialState({ next: counter.mint }),
    history: EMPTY_HISTORY,
    minted: counter.used(),
  }
}

/** The tab showing `kind`'s page in a pane, if any. */
function panePage(state: LayoutState, paneId: PaneId, kind: string): TabId | undefined {
  return findPaneContentTab(state, paneId, pageAddress(kind), kind)
}

/**
 * The kind whose page a tab shows, or `undefined` for a resource tab. A pane
 * holds at most one page of each kind, so a page tab is never copied.
 */
function pageKind(state: LayoutState, tabId: TabId): string | undefined {
  const tab = state.tabs[tabId]
  return tab !== undefined && tab.contentId === pageAddress(tab.kind) ? tab.kind : undefined
}

/**
 * Whether a tab stands alone on the docked surface: its pane is the sole docked
 * pane and holds nothing else. Floating panels do not count — they render
 * whether or not the column is expanded.
 * @param state - current layout.
 * @param tabId - the tab asked about.
 * @returns `true` for the docked surface's only tab.
 */
export function soleDockedTab(state: LayoutState, tabId: TabId): boolean {
  const pane = findTabPane(state, tabId)
  return pane.host === 'dock' && pane.tabs.length === 1 && dockPaneIds(state).length === 1
}

/** Focus a tab: nothing to plan while it is its pane's active tab and its pane is the active one. */
function planFocusTab(state: LayoutState, tabId: TabId): readonly LayoutOp[] {
  const pane = findTabPane(state, tabId)
  return pane.activeTabId === tabId && state.activePaneId === pane.id ? [] : [{ type: 'focusTab', tabId }]
}

/** Focus a pane: nothing to plan while it is the active one. */
function planFocusPane(state: LayoutState, paneId: PaneId): readonly LayoutOp[] {
  return state.activePaneId === paneId ? [] : [{ type: 'focusPane', paneId }]
}

/**
 * Plan a tab's arrival in a docked pane: a page arriving where its kind's page
 * already shows merges into it, anything else plans as the kit does.
 * @param state - current layout.
 * @param tabId - the arriving tab.
 * @param toPaneId - the pane it arrives in.
 * @param otherwise - the kit's plan for the move.
 * @returns the operations.
 */
function arriving(state: LayoutState, tabId: TabId, toPaneId: PaneId, otherwise: () => readonly LayoutOp[]): readonly LayoutOp[] {
  const kind = pageKind(state, tabId)
  if (kind === undefined) return otherwise()
  const existing = panePage(state, toPaneId, kind)
  if (existing === undefined || existing === tabId) return otherwise()
  return [{ type: 'closeTab', tabId }, { type: 'focusTab', tabId: existing }]
}

/**
 * Run one planner against a surface, settle what it left behind, and record the
 * whole intent as one history entry.
 * @param surface - the session's current surface.
 * @param plan - the kit planner to consult.
 * @param seed - the registered default page for an empty docked pane.
 * @returns the next surface, or the same one when the intent changes nothing.
 */
function advance(surface: SurfaceState, plan: SurfacePlan, seed: () => SidebarRightSeed): SurfaceState {
  const counter = counting(surface.minted)
  const makeTab = (id: TabId): TabRecord => seedRecord(id, seed)
  const planned = plan(surface.layout, counter.mint, makeTab)
  if (planned.length === 0) return surface
  // The settle planner reads the state the intent produces, so it is applied
  // to a scratch copy first; the record then applies both parts once. The
  // seed factory is withheld while the intent leaves the column collapsed:
  // an empty collapsed column stays empty until the expansion that shows it.
  const after = replay(surface.layout, planned)
  const settled = planSettle(after, counter.mint, after.expanded ? makeTab : undefined)
  const stepped = record(surface.history, surface.layout, [...planned, ...settled])
  return { layout: stepped.state, history: stepped.history, minted: counter.used() }
}

/**
 * Replace one session's surface, leaving every other session by reference.
 *
 * A session with no surface yet gets its initial one even when the intent
 * changes nothing: materializing is itself the change.
 */
function seat(
  state: SidebarRightState,
  sessionId: string,
  next: (surface: SurfaceState) => SurfaceState,
): Record<string, SurfaceState> {
  const existing = state.bySession[sessionId]
  const updated = next(existing ?? createSurface())
  return updated === existing ? state.bySession : { ...state.bySession, [sessionId]: updated }
}

/** Declared write set; each entry is one settled intent. */
type SidebarRightActions = {
  open: (draft: SidebarRightState, sessionId: string) => void
  setExpanded: (draft: SidebarRightState, sessionId: string, expanded: boolean) => void
  toggleExpanded: (draft: SidebarRightState, sessionId: string) => void
  setMode: (draft: SidebarRightState, sessionId: string, mode: DockMode) => void
  splitPane: (draft: SidebarRightState, sessionId: string, paneId?: PaneId, settled?: (paneId: PaneId) => void) => void
  openContent: (
    draft: SidebarRightState,
    sessionId: string,
    intent: OpenContentIntent,
    settled: (tabId: TabId) => void,
  ) => void
  duplicateTab: (draft: SidebarRightState, sessionId: string, tabId: TabId) => void
  closeTab: (draft: SidebarRightState, sessionId: string, tabId: TabId) => void
  focusTab: (draft: SidebarRightState, sessionId: string, tabId: TabId) => void
  focusPane: (draft: SidebarRightState, sessionId: string, paneId: PaneId) => void
  placeTab: (draft: SidebarRightState, sessionId: string, tabId: TabId, toPaneId: PaneId, index: number) => void
  dropTab: (draft: SidebarRightState, sessionId: string, tabId: TabId, paneId: PaneId, zone: DockZone) => void
  floatTab: (draft: SidebarRightState, sessionId: string, tabId: TabId, rect?: FloatRect) => void
  unfloatPane: (draft: SidebarRightState, sessionId: string, paneId: PaneId) => void
  moveFloat: (draft: SidebarRightState, sessionId: string, paneId: PaneId, x: number, y: number) => void
  resizeFloat: (draft: SidebarRightState, sessionId: string, paneId: PaneId, rect: FloatRect) => void
  resizeSplit: (draft: SidebarRightState, sessionId: string, splitId: SplitId, sizes: readonly number[]) => void
  undo: (draft: SidebarRightState, sessionId: string) => void
  redo: (draft: SidebarRightState, sessionId: string) => void
}

/** One direction through the recorded sequence. */
type HistoryStepper =
  (history: History, state: LayoutState) => { history: History; state: LayoutState } | undefined

/** Step a surface through the history in one direction. */
function stepped(surface: SurfaceState, step: HistoryStepper): SurfaceState {
  const moved = step(surface.history, surface.layout)
  return moved === undefined ? surface : { ...surface, layout: moved.state, history: moved.history }
}

/**
 * Create the Sidebar store handle.
 *
 * The default page arrives as a thunk: a pane is seeded when a split or an
 * expansion of an empty column needs one, which can be long after the store was
 * built and in a language the user has since changed to.
 * @param seed - the registered default page, read at each mint.
 * @returns the handle (spec, type, identity, and factory in one).
 */
export function createSidebarRightStore(
  seed: () => SidebarRightSeed,
): EngineStoreHandle<SidebarRightState, SidebarRightActions> {
  return defineStore({
    init: (): SidebarRightState => ({ bySession: {} }),
    actions: {
      // Materialize a session's surface without changing it, so the first read
      // after a session switch sees the collapsed empty column rather than nothing.
      open: (d, sessionId: string) => { d.bySession = seat(d, sessionId, surface => surface) },
      setExpanded: (d, sessionId: string, expanded: boolean) => {
        d.bySession = seat(d, sessionId, s => advance(s, state => planSetExpanded(state, expanded), seed))
      },
      toggleExpanded: (d, sessionId: string) => {
        d.bySession = seat(d, sessionId, s => advance(s, state => planSetExpanded(state, !state.expanded), seed))
      },
      // Switching presentation is recorded like any other change, so stepping
      // back through the sequence puts the surface back the way it was drawn.
      setMode: (d, sessionId: string, mode: DockMode) => {
        d.bySession = seat(d, sessionId, s => advance(s, state => planSetMode(state, mode), seed))
      },
      // `settled` reports the pane the split created, synchronously, because
      // actions return nothing; it is not called when nothing was split.
      splitPane: (d, sessionId: string, paneId?: PaneId, settled?: (paneId: PaneId) => void) => {
        d.bySession = seat(d, sessionId, (s) => {
          const next = advance(s, (state, mint, makeTab) => dockPaneIds(state).length >= 2
            || getPane(state, paneId ?? activeDockPaneId(state)).tabs.length === 0
            ? []
            : planSplitPane(state, mint, paneId, makeTab), seed)
          if (settled !== undefined && next !== s) {
            const before = new Set(dockPaneIds(s.layout))
            for (const id of dockPaneIds(next.layout)) {
              if (!before.has(id)) settled(id)
            }
          }
          return next
        })
      },
      // One entry carries the whole open: revealing the column (an open behind
      // a collapsed panel is not an open), focusing or seating the tab, and
      // closing the tab it replaces. `settled` reports the tab the planner
      // landed on, synchronously, because actions return nothing.
      openContent: (d, sessionId: string, intent, settled) => {
        d.bySession = seat(d, sessionId, s => advance(s, (state, mint) => {
          const { kind, contentId, title, replaceTab: replace } = intent
          const ops: LayoutOp[] = [...planSetExpanded(state, true)]
          // A replaced tab lends its pane and slot; one that floats cannot (a
          // floating pane holds one tab), so the new tab lands as if unplaced.
          const replaced = replace === undefined ? undefined : findTabPane(state, replace)
          const lent = replace !== undefined && replaced !== undefined && replaced.host === 'dock' ? replaced : undefined
          const paneId = lent?.id ?? intent.paneId
          const index = lent === undefined || replace === undefined ? undefined : lent.tabs.indexOf(replace)
          // A page is unique per pane, not per surface: the pane it would land
          // in may already show it, which is then the tab this open settles on.
          // The same page in another pane never draws the open away — the kit's
          // cross-pane reveal is for resources only.
          const page = contentId === pageAddress(kind)
          const held = page ? panePage(state, paneId ?? activeDockPaneId(state), kind) : undefined
          const planned = held !== undefined
            ? { ops: [{ type: 'focusTab' as const, tabId: held }], tabId: held }
            : planOpenContent(state, mint, {
              kind,
              contentId,
              title,
              ...paneId === undefined ? {} : { paneId },
              ...index === undefined ? {} : { index },
              ...page
                ? { revealIfOpened: false }
                : intent.revealIfOpened === undefined ? {} : { revealIfOpened: intent.revealIfOpened },
            })
          ops.push(...planned.ops)
          if (replace !== undefined && replace !== planned.tabId) ops.push({ type: 'closeTab', tabId: replace })
          settled(planned.tabId)
          return ops
        }, seed))
      },
      // A page is never copied: the copy would sit beside it in the same pane.
      duplicateTab: (d, sessionId: string, tabId: TabId) => {
        d.bySession = seat(d, sessionId, s =>
          advance(s, (state, mint) => pageKind(state, tabId) !== undefined ? [] : planDuplicateTab(state, mint, tabId).ops, seed))
      },
      // A tab already gone — closed twice by a racing callback and the user — is
      // left alone rather than handed to the kit, which refuses an unknown tab.
      // The docked surface's last tab follows the close rule, whoever asks: the
      // guide stays (the kit hides its close routes through `canCloseTab`, and
      // this plan refuses the programmatic path), and anything else closes
      // together with the column, which stays empty until an expansion seeds
      // the then-current default page.
      closeTab: (d, sessionId: string, tabId: TabId) => {
        d.bySession = seat(d, sessionId, s => advance(s, (state) => {
          if (!canCloseTab(s, tabId)) return []
          if (!soleDockedTab(state, tabId)) return [{ type: 'closeTab', tabId }]
          // The collapse also leaves fullscreen: the reopened column shows only
          // the reseeded default page, which never earns the whole window.
          return [{ type: 'closeTab', tabId }, ...planSetMode(state, 'push'), ...planSetExpanded(state, false)]
        }, seed))
      },
      focusTab: (d, sessionId: string, tabId: TabId) => {
        d.bySession = seat(d, sessionId, s => advance(s, state => planFocusTab(state, tabId), seed))
      },
      focusPane: (d, sessionId: string, paneId: PaneId) => {
        d.bySession = seat(d, sessionId, s => advance(s, state => planFocusPane(state, paneId), seed))
      },
      placeTab: (d, sessionId: string, tabId: TabId, toPaneId: PaneId, index: number) => {
        d.bySession = seat(d, sessionId, s =>
          advance(s, state => arriving(state, tabId, toPaneId, () => planPlaceTab(state, tabId, toPaneId, index)), seed))
      },
      // Only a centre release lands in the target pane; an edge release makes a
      // new pane, where nothing can already be — and when the release drags a
      // pane's only tab to that pane's own edge, the default page backfills it.
      dropTab: (d, sessionId: string, tabId: TabId, paneId: PaneId, zone: DockZone) => {
        d.bySession = seat(d, sessionId, s => advance(s, (state, mint, makeTab) => {
          if (zone === 'top' || zone === 'bottom') return []
          if (zone !== 'center' && dockPaneIds(state).length >= 2) return []
          const plan = (): readonly LayoutOp[] => planDropTab(state, mint, tabId, paneId, zone, makeTab)
          return zone === 'center' ? arriving(state, tabId, paneId, plan) : plan()
        }, seed))
      },
      floatTab: (d, sessionId: string, tabId: TabId, rect?: FloatRect) => {
        d.bySession = seat(d, sessionId, s =>
          advance(s, (state, mint) => planFloatTab(state, mint, tabId, rect).ops, seed))
      },
      // A floating pane holds one tab; docking it back lands in the active
      // docked pane, and only a page is subject to the merge rule there.
      unfloatPane: (d, sessionId: string, paneId: PaneId) => {
        d.bySession = seat(d, sessionId, s => advance(s, (state) => {
          const floated = getPane(state, paneId).tabs[0]
          const plan = (): readonly LayoutOp[] => planUnfloatPane(state, paneId)
          /* v8 ignore next -- a floating pane holds exactly one tab. */
          return floated === undefined ? plan() : arriving(state, floated, activeDockPaneId(state), plan)
        }, seed))
      },
      moveFloat: (d, sessionId: string, paneId: PaneId, x: number, y: number) => {
        d.bySession = seat(d, sessionId, s => advance(s, () => [{ type: 'moveFloat', paneId, x, y }], seed))
      },
      resizeFloat: (d, sessionId: string, paneId: PaneId, rect: FloatRect) => {
        d.bySession = seat(d, sessionId, s => advance(s, () => [{ type: 'resizeFloat', paneId, rect }], seed))
      },
      resizeSplit: (d, sessionId: string, splitId: SplitId, sizes: readonly number[]) => {
        d.bySession = seat(d, sessionId, s => advance(s, () => planResizeSplit(splitId, sizes, 0.2), seed))
      },
      undo: (d, sessionId: string) => {
        d.bySession = seat(d, sessionId, s => stepped(s, stepBack))
      },
      redo: (d, sessionId: string) => {
        d.bySession = seat(d, sessionId, s => stepped(s, stepForward))
      },
    },
  })
}
