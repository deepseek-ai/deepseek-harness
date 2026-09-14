/**
 * The kit's outward contracts: state in, intents out.
 *
 * Everything host-specific arrives through these — every rendered string, every
 * tab body, and every net gesture result. The kit itself holds no copy, no icon
 * set, and no knowledge of what a tab's `kind` means.
 */
import type { ReactNode } from 'react'
import type { DockZone, FloatRect, PaneId, SplitId, TabId, TabRecord } from './types.ts'

/**
 * Every string the kit renders, already localized by the embedder.
 *
 * Accessible names are included: a control with no visible text still needs
 * one, and the kit must not invent it.
 */
export interface DockLabels {
  /** Body of a pane holding no tabs. */
  readonly emptyPane: string
  /** The split control, while splitting is allowed. */
  readonly splitPane: string
  /** The split control, once the pane budget is spent. */
  readonly splitPaneDisabled: string
  /** The split control, while the pane is too narrow for two working halves. */
  readonly splitPaneNarrow: string
  /** Destroy a tab: the chip's close control and the menu's close item. */
  readonly closeTab: string
  /** The strip's add control, which seats the embedder's seeded tab. */
  readonly addTab: string
  /** Send a floating panel back into the docked tree. */
  readonly dockFloat: string
  /** Close a floating panel. */
  readonly closeFloat: string
  /** The drop hint's caption for each body zone a dragged tab can land on. */
  readonly dropZone: Readonly<Record<DockZone, string>>
}

/**
 * Renders one tab's body. The embedder dispatches on `tab.kind`, which is the
 * only place that string carries meaning.
 */
export type TabRenderer = (tab: TabRecord) => ReactNode

/**
 * Renders extra items at the end of one tab's context menu (opened by a
 * secondary press on the chip).
 *
 * The kit's own item is the close gesture; anything that means something about
 * the tab's content comes from here. An item that acts MUST call `dismiss`,
 * because the menu closes on its own items only. Every rendered item MUST
 * carry `role="menuitem"`: the kit probes for that role to dismiss a menu
 * that would paint empty, so items without it count as an empty menu.
 * @param tab - the tab whose menu is open.
 * @param dismiss - close the menu without acting.
 * @returns extra actions with ARIA menuitem, menuitemcheckbox, or menuitemradio roles, or nothing.
 */
export type TabMenuExtras = (tab: TabRecord, dismiss: () => void) => ReactNode

/**
 * Net gesture results the kit reports. Each call is one settled intent — never a
 * drag frame — so an embedder recording them produces one operation per gesture.
 *
 * `DockController` satisfies this contract as-is; an embedder that routes
 * through its own store implements the same names.
 */
export interface DockIntents {
  /** Focus a tab and its pane. */
  readonly focusTab: (tabId: TabId) => void
  /** Focus a pane, raising it when it floats. */
  readonly focusPane: (paneId: PaneId) => void
  /** Split a pane and seed the new one. */
  readonly splitPane: (paneId: PaneId) => void
  /** Add the embedder's seeded tab to a pane (the strip's `+`). */
  readonly addTab: (paneId: PaneId) => void
  /** Destroy a tab. */
  readonly closeTab: (tabId: TabId) => void
  /** Copy a tab beside itself. No kit control drives this; embedders reach it through their own API. */
  readonly duplicateTab: (tabId: TabId) => void
  /** Float a tab, at `rect` when the release point decided one (a drag released clear of the surface). */
  readonly floatTab: (tabId: TabId, rect?: FloatRect) => void
  /** Return a floating panel's tab to the docked tree. */
  readonly unfloatPane: (paneId: PaneId) => void
  /**
   * Put a tab at an explicit strip slot: a reorder, a move, or a return. `index`
   * is the caret slot counted over the destination strip's chips as drawn, the
   * dragged chip included when the strip is its own.
   */
  readonly placeTab: (tabId: TabId, toPaneId: PaneId, index: number) => void
  /** Resolve a release on a pane body: the centre moves in, an edge splits. */
  readonly dropTab: (tabId: TabId, paneId: PaneId, zone: DockZone) => void
  /** Net position of a floating-panel drag; the operation it records focuses and raises the panel too. */
  readonly moveFloat: (paneId: PaneId, x: number, y: number) => void
  /** Net rectangle of a floating-panel resize; the operation it records focuses and raises the panel too. */
  readonly resizeFloat: (paneId: PaneId, rect: FloatRect) => void
  /** Net fractions of a divider drag. */
  readonly resizeSplit: (splitId: SplitId, sizes: readonly number[]) => void
}
