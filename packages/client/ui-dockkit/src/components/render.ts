/**
 * Prop shares the kit's own components pass among themselves. These are internal
 * to the package — the outward contracts are in `adapter.ts`.
 */
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { DockLabels, TabMenuExtras, TabRenderer } from '../contract/adapter.ts'
import type { PaneId, SplitId, TabId } from '../contract/types.ts'
import type { DropTarget } from '../engine/geometry.ts'

/** Why a pane's split control is disabled: the pane budget, or too little width for two halves. */
export type SplitBlock = 'budget' | 'width'

/** What a pane subtree needs: settled callbacks, gesture starters, and live preview. */
export interface PaneCallbacks {
  readonly onFocusTab: (tabId: TabId) => void
  readonly onFocusPane: (paneId: PaneId) => void
  readonly onSplitPane: (paneId: PaneId) => void
  readonly onAddTab: (paneId: PaneId) => void
  readonly onCloseTab: (tabId: TabId) => void
  /** Begin dragging a tab; the surface owns the gesture from here. */
  readonly onTabPressed: (tabId: TabId, event: ReactPointerEvent<HTMLElement>) => void
  /** Begin dragging a divider inside `splitId`, at the boundary after `index`. */
  readonly onDividerPressed: (splitId: SplitId, index: number, event: ReactPointerEvent<HTMLElement>) => void
  /** Why a pane cannot split right now, or `undefined` while it can. */
  readonly splitBlock: (paneId: PaneId) => SplitBlock | undefined
  /** Hide blocked split controls instead of rendering them disabled. */
  readonly hideSplitWhenBlocked?: boolean
  /** Whether a pane's strip draws the add control. */
  readonly canAddTab: (paneId: PaneId) => boolean
  /** Whether a tab draws its close control and its menu's close item. */
  readonly canCloseTab: (tabId: TabId) => boolean
  /** Live drop preview, or `undefined` while nothing is being dragged. */
  readonly dropTarget: DropTarget | undefined
  /** Show both horizontal landing regions while a body split is being targeted. */
  readonly horizontalDrops?: boolean
  /** Tab currently being dragged, so its chip can render as lifted. */
  readonly draggingTabId: TabId | undefined
  readonly labels: DockLabels
  readonly renderTab: TabRenderer
  /** A chip's or panel header's title content; absent means the record's `title` text. */
  readonly renderTabTitle: TabRenderer | undefined
  /** Embedder items appended to a tab's context menu; absent means the kit's item only. */
  readonly renderTabMenuItems: TabMenuExtras | undefined
  /** The pane whose strip hosts the embedder's surface-wide controls. */
  readonly chromePaneId: PaneId
  /** Those controls; absent means the strip ends at the kit's own split control. */
  readonly chrome: ReactNode
}
