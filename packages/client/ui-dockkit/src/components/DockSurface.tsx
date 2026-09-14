/**
 * The docked surface: the split tree plus the tab and divider gestures over it.
 * This is the whole kit as far as an embedder's layout column is concerned —
 * chrome around it (a rail, a header, a collapsed state) belongs to the embedder.
 *
 * A gesture only previews until it ends, then leaves through one intent, so the
 * embedder's operation sequence stays the single source of truth. Releasing a tab
 * clear of this surface floats it; releasing inside it but on no pane is not a
 * move at all.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DockIntents, DockLabels, TabMenuExtras, TabRenderer } from '../contract/adapter.ts'
import type { LayoutState, PaneId, SplitId, TabId } from '../contract/types.ts'
import { clampSizes, FLOAT_DEFAULT_SIZE, MIN_PANE_FRACTION } from '../engine/constraints.ts'
import { getSplit, topRightPaneId } from '../engine/tree.ts'
import type { DropTarget, HalvesFit } from '../engine/geometry.ts'
import {
  containsPoint, dividerSizes, floatRectAt, insertionIndex, passedThreshold, zoneInRect,
} from '../engine/geometry.ts'
import { fitOf, measurePaneFits, paneElements, sameFits } from './measure.ts'
import { useGesture } from './pointer.ts'
import { PaneTree, type SizePreview } from './PaneTree.tsx'
import type { PaneCallbacks, SplitBlock } from './render.ts'
import css from './dockkit.module.css'

/** What the docked surface needs: the layout, its limits, and the outward contracts. */
export interface DockSurfaceProps {
  readonly state: LayoutState
  /**
   * Whether another pane may still be created: the pane budget. Width is the
   * kit's own concern — a pane too narrow for two working halves keeps its
   * split control disabled with `labels.splitPaneNarrow` (see README).
   */
  readonly canSplit: boolean
  /** Hide a blocked split control — pane budget spent or pane too narrow — instead of rendering it disabled; defaults to false. */
  readonly hideSplitWhenBlocked?: boolean
  /** Body drop geometry: all edge bands, or left/right halves with whole-pane moves once splitting is unavailable. */
  readonly dropZones?: 'edges' | 'horizontal'
  /** Smallest share a divider may leave a pane; defaults to the kit's fraction. */
  readonly minPaneFraction?: number
  /**
   * Whether a pane's strip draws the add control. Called per docked pane on
   * every render; omit to draw one in every pane. `false` leaves the strip's
   * end controls where they are and the chips as the only shrinking part.
   */
  readonly canAddTab?: (paneId: PaneId) => boolean
  /**
   * Whether a tab draws its close control and its menu's close item. Called
   * per rendered chip on every render; omit to keep every tab closable.
   * `false` removes both routes without moving the chip: the close control
   * paints over the title's end rather than beside it, so the chip is the same
   * width either way. The menu still opens and carries the embedder's items.
   */
  readonly canCloseTab?: (tabId: TabId) => boolean
  readonly intents: DockIntents
  readonly labels: DockLabels
  readonly renderTab: TabRenderer
  /**
   * What a tab's chip shows as its title; omit to show the record's `title`
   * text. An embedder-internal seam: the Sidebar dispatches it to a per-kind
   * slot, and nothing outside that embedder is expected to supply it.
   */
  readonly renderTabTitle?: TabRenderer
  /** Extra items for a tab's context menu; omit for the kit's own item only. */
  readonly renderTabMenuItems?: TabMenuExtras
  /**
   * Surface-wide controls, drawn at the far end of the top-right pane's tab
   * strip so the surface needs no header of its own. The kit places them; what
   * they do is the embedder's.
   */
  readonly chrome?: ReactNode
  /**
   * Called with the room rule's latest readings whenever they change, so an
   * embedder driving splits programmatically can honour the same rule the
   * split control does. A pane absent from the map has not been measured.
   */
  readonly onRoom?: (fits: ReadonlyMap<PaneId, HalvesFit>) => void
}

/** A divider drag: the split it moves and the fractions it started from. */
interface DividerDrag {
  readonly splitId: SplitId
  /** The boundary being moved: between child `index` and `index + 1`. */
  readonly index: number
  readonly axis: 'row' | 'column'
  /** Pointer coordinate along the axis at the press. */
  readonly origin: number
  /** The split's pixel extent along the axis, so travel converts to fractions. */
  readonly extent: number
  readonly sizes: readonly number[]
}

/** What the gesture is currently showing, before anything settles. */
interface Preview {
  readonly draggingTabId: TabId | undefined
  readonly dropTarget: DropTarget | undefined
  readonly sizes: SizePreview | undefined
}

const NO_PREVIEW: Preview = { draggingTabId: undefined, dropTarget: undefined, sizes: undefined }

/** Nothing measured yet: every pane fits until a reading says otherwise. */
const NO_FITS: ReadonlyMap<PaneId, HalvesFit> = new Map()

/** The default policy for the omitted callbacks: every pane offers the add control, every tab its close. */
const ALWAYS = (): boolean => true

/**
 * Resolve where a pointer sits inside the docked surface. An edge zone is only
 * offered where the split it would make is allowed: within the pane budget and
 * with room for two halves; otherwise the release is not a move at all.
 */
function hitTest(
  root: HTMLElement,
  x: number,
  y: number,
  canSplit: boolean,
  fits: ReadonlyMap<PaneId, HalvesFit>,
  dropZones: 'edges' | 'horizontal',
): DropTarget | undefined {
  for (const [paneId, pane] of paneElements(root)) {
    const rect = pane.getBoundingClientRect()
    if (!containsPoint(rect, x, y)) continue
    const strip = pane.querySelector<HTMLElement>('[data-dockkit-strip]')
    if (strip !== null && containsPoint(strip.getBoundingClientRect(), x, y)) {
      const tabs = [...strip.querySelectorAll<HTMLElement>('[data-dockkit-tab]')]
      return { kind: 'strip', paneId, index: insertionIndex(tabs.map(tab => tab.getBoundingClientRect()), x) }
    }
    const zone = dropZones === 'horizontal'
      ? canSplit && fitOf(fits, paneId).row
        ? x < rect.x + rect.width / 2 ? 'left' : 'right'
        : 'center'
      : zoneInRect(rect, x, y)
    if (zone !== 'center') {
      const fit = fitOf(fits, paneId)
      const room = zone === 'left' || zone === 'right' ? fit.row : fit.column
      if (!canSplit || !room) return undefined
    }
    return { kind: 'zone', paneId, zone }
  }
  return undefined
}

/** Fractions a divider drag has reached, clamped to the pane minimum. */
function draggedSizes(drag: DividerDrag, x: number, y: number, minimum: number): readonly number[] {
  const moved = (drag.axis === 'row' ? x : y) - drag.origin
  const delta = drag.extent > 0 ? moved / drag.extent : 0
  return clampSizes(dividerSizes(drag.sizes, drag.index, delta), minimum)
}

/** Fractions closer than this are the same split: renormalizing recorded sizes moves them by no more. */
const SIZE_TOLERANCE = 1e-9

/** Whether two fraction lists describe the same split. */
function sameSizes(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((size, index) => {
    const other = b[index]
    return other !== undefined && Math.abs(size - other) < SIZE_TOLERANCE
  })
}

/** The split tree and the gestures over it. */
export function DockSurface({
  state, canSplit, canAddTab, canCloseTab, intents, labels, renderTab, renderTabTitle, renderTabMenuItems, chrome, onRoom,
  dropZones = 'edges', minPaneFraction = MIN_PANE_FRACTION, hideSplitWhenBlocked = false,
}: DockSurfaceProps): ReactNode {
  const surface = useRef<HTMLDivElement | null>(null)
  const [preview, setPreview] = useState<Preview>(NO_PREVIEW)
  const [fits, setFits] = useState(NO_FITS)
  const begin = useGesture(() => { setPreview(NO_PREVIEW) })

  /** Run `use` on the surface element, which every commit and every press inside it has mounted. */
  const withSurface = useCallback((use: (root: HTMLElement) => void): void => {
    const root = surface.current
    /* v8 ignore next -- ref-null guard: the surface div renders unconditionally. */
    if (root === null) return
    use(root)
  }, [])

  // The room rule reads pixels, which the layout state does not carry: measure
  // after every commit (a split, a divider drag, a closed tab all move panes)
  // and whenever the surface itself is resized (the embedder's column dragged
  // wider or narrower). A reading that changed nothing renders nothing.
  const remeasure = useCallback((): void => {
    withSurface((root) => {
      const next = measurePaneFits(root, hideSplitWhenBlocked)
      setFits(current => sameFits(current, next) ? current : next)
    })
  }, [withSurface, hideSplitWhenBlocked])
  useLayoutEffect(() => { remeasure() })
  useEffect(() => { onRoom?.(fits) }, [fits, onRoom])
  useEffect(() => {
    const root = surface.current
    if (root === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => { remeasure() })
    observer.observe(root)
    return () => { observer.disconnect() }
  }, [remeasure])

  /** Why a pane cannot split right now: the budget first, then its own width. */
  const splitBlock = (paneId: PaneId): SplitBlock | undefined => {
    if (!canSplit) return 'budget'
    return fitOf(fits, paneId).row ? undefined : 'width'
  }

  const callbacks: PaneCallbacks = {
    onFocusTab: intents.focusTab.bind(intents),
    onFocusPane: intents.focusPane.bind(intents),
    onSplitPane: intents.splitPane.bind(intents),
    onAddTab: intents.addTab.bind(intents),
    onCloseTab: intents.closeTab.bind(intents),
    // A press is not yet a drag: the chip lifts, and the drop preview follows,
    // once the pointer has travelled the threshold. A release before that is a
    // click and reports nothing here.
    onTabPressed: (tabId, event) => {
      withSurface((root) => {
        const startX = event.clientX
        const startY = event.clientY
        let dragging = false
        begin(event.currentTarget, event.pointerId, {
          move: (moved) => {
            if (!dragging) {
              if (!passedThreshold(startX, startY, moved.clientX, moved.clientY)) return
              dragging = true
            }
            setPreview({
              ...NO_PREVIEW,
              draggingTabId: tabId,
              dropTarget: hitTest(root, moved.clientX, moved.clientY, canSplit, fits, dropZones),
            })
          },
          up: (released) => {
            if (!dragging) return
            const target = hitTest(root, released.clientX, released.clientY, canSplit, fits, dropZones)
            if (target === undefined) {
              if (containsPoint(root.getBoundingClientRect(), released.clientX, released.clientY)) return
              intents.floatTab(tabId, floatRectAt(released.clientX, released.clientY, FLOAT_DEFAULT_SIZE))
              return
            }
            if (target.kind === 'strip') intents.placeTab(tabId, target.paneId, target.index)
            else intents.dropTab(tabId, target.paneId, target.zone)
          },
        })
      })
    },
    onDividerPressed: (splitId, index, event) => {
      const container = event.currentTarget.parentElement
      /* v8 ignore next -- a divider is rendered as a child of its split's element. */
      if (container === null) return
      const split = getSplit(state, splitId)
      const box = container.getBoundingClientRect()
      const drag: DividerDrag = {
        splitId,
        index,
        axis: split.axis,
        origin: split.axis === 'row' ? event.clientX : event.clientY,
        extent: split.axis === 'row' ? box.width : box.height,
        sizes: split.sizes,
      }
      // A release that left the fractions where they were — a click on the
      // divider, a drag returned to its start, or one pushed further into the
      // clamp — is not a resize and reports nothing.
      begin(event.currentTarget, event.pointerId, {
        move: (moved) => {
          setPreview({ ...NO_PREVIEW, sizes: { splitId, sizes: draggedSizes(drag, moved.clientX, moved.clientY, minPaneFraction) } })
        },
        up: (released) => {
          const sizes = draggedSizes(drag, released.clientX, released.clientY, minPaneFraction)
          if (sameSizes(sizes, drag.sizes)) return
          intents.resizeSplit(splitId, sizes)
        },
      })
    },
    splitBlock,
    hideSplitWhenBlocked,
    canAddTab: canAddTab ?? ALWAYS,
    canCloseTab: canCloseTab ?? ALWAYS,
    dropTarget: preview.dropTarget,
    horizontalDrops: dropZones === 'horizontal',
    draggingTabId: preview.draggingTabId,
    labels,
    renderTab,
    renderTabTitle,
    renderTabMenuItems,
    chromePaneId: topRightPaneId(state),
    chrome,
  }

  return (
    <div className={css.surface} ref={surface} data-dockkit-surface data-dockkit-drop-zones={dropZones}>
      <PaneTree state={state} nodeId={state.rootId} callbacks={callbacks} preview={preview.sizes} />
    </div>
  )
}
