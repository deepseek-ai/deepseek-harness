/**
 * Layout model and operation vocabulary. Types only: no runtime code, no React,
 * no DOM, and no host concepts — a tab's `kind` is an opaque string this kit
 * never interprets, so the embedder owns what content families exist.
 *
 * The model is a normalized recursive split tree. `nodes` holds every split and
 * pane keyed by id; `rootId` names the docked root; `floats` lists floating
 * panes bottom-to-top. A floating panel is not a second concept — it is a pane
 * whose `host` is `'float'`, capacity 1 tab, drawn without a tab strip.
 *
 * Ids are branded: a pane, a split, and a tab id never stand in for one another
 * or for a bare string, and only a mint (or a DOM round trip of an id the kit
 * wrote itself) produces one.
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of a pane node in `LayoutState.nodes`. */
export type PaneId = Branded<'PaneId'>

/** Identity of a split node in `LayoutState.nodes`. */
export type SplitId = Branded<'SplitId'>

/** Identity of any node in `LayoutState.nodes`. */
export type NodeId = PaneId | SplitId

/** Identity of one open tab; distinct copies of one content share `contentId`, never `TabId`. */
export type TabId = Branded<'TabId'>

/** Direction a split lays its children out in. */
export type SplitAxis = 'row' | 'column'

/** Which side of the reference pane a new pane takes. */
export type SplitDirection = 'before' | 'after'

/** The five drop regions a pane offers a dragged tab. */
export type DockZone = 'center' | 'top' | 'right' | 'bottom' | 'left'

/**
 * How the docked area is presented.
 *
 * `push` takes room from its neighbours; `fullscreen` covers the viewport. The kit
 * records the choice but does not implement either — the embedder reads this and
 * positions the surface. It lives here, beside `expanded`, because switching is a
 * recorded operation the user can step back through. The values are the kit's
 * own words and no service interface repeats them.
 */
export type DockMode = 'push' | 'fullscreen'

/** Viewport rectangle of a floating pane, in CSS pixels. */
export interface FloatRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Interior node: an ordered run of children along one axis with fractional sizes. */
export interface SplitNode {
  readonly kind: 'split'
  readonly id: SplitId
  readonly axis: SplitAxis
  /** At least two children; a one-child split collapses into that child. */
  readonly children: readonly NodeId[]
  /** Same length as `children`, each above zero, summing to 1. */
  readonly sizes: readonly number[]
}

/** Where a pane is drawn: inside the docked split tree, or as a viewport overlay. */
export type PaneHost = 'dock' | 'float'

/** Leaf node: an ordered tab list with at most one active tab. */
export interface PaneNode {
  readonly kind: 'pane'
  readonly id: PaneId
  readonly host: PaneHost
  readonly tabs: readonly TabId[]
  /** `undefined` exactly when `tabs` is empty. */
  readonly activeTabId: TabId | undefined
  /** Set exactly when `host` is `'float'`. */
  readonly rect: FloatRect | undefined
}

/** Either kind of tree node. */
export type LayoutNode = SplitNode | PaneNode

/**
 * One open tab.
 *
 * `kind` selects the embedder's content family and is never interpreted here.
 * `contentId` is the identity `openContent` de-duplicates against, so two tabs
 * sharing it are deliberate copies of one thing.
 */
export interface TabRecord {
  readonly id: TabId
  readonly kind: string
  readonly contentId: string
  readonly title: string
}

/**
 * The whole layout of one docking surface. Every field is replaced rather than
 * mutated, and untouched sub-objects keep their identity so consumers can
 * compare by reference.
 */
export interface LayoutState {
  readonly nodes: Readonly<Record<NodeId, LayoutNode>>
  readonly tabs: Readonly<Record<TabId, TabRecord>>
  /** Root of the docked tree; always a split or pane that exists in `nodes`. */
  readonly rootId: NodeId
  /** Floating panes, bottom-to-top; the last entry is on top. */
  readonly floats: readonly PaneId[]
  /** Focused pane, docked or floating. */
  readonly activePaneId: PaneId
  /** Whether the docked area is expanded; floating panes ignore it. */
  readonly expanded: boolean
  /** How the docked area is presented; floating panes ignore it. */
  readonly mode: DockMode
}

/** Recipe for putting a pane back where it was, used by `insertPane`. */
export type PaneAttachment =
  /** Re-insert as a child of an existing split, restoring that split's sizes verbatim. */
  | { readonly mode: 'child'; readonly parentId: SplitId; readonly index: number; readonly sizes: readonly number[] }
  /** Re-create a collapsed split in `targetId`'s slot; `split` already lists both children. */
  | { readonly mode: 'wrap'; readonly targetId: NodeId; readonly split: SplitNode }
  /** Re-insert a floating pane at its former z index. */
  | { readonly mode: 'float'; readonly index: number }

/**
 * One recorded layout mutation. Ids that an operation creates are carried in
 * the operation itself, so replaying a sequence from the same initial state
 * reproduces the same ids without any minting during apply.
 *
 * `insertPane`, `insertTab`, and `restoreFocus` exist to express inverses
 * exactly; they are applied like any other operation.
 */
export type LayoutOp =
  /** Give `paneId` a new empty sibling pane along `axis`. */
  | {
    readonly type: 'split'
    readonly paneId: PaneId
    readonly axis: SplitAxis
    readonly direction: SplitDirection
    readonly newPaneId: PaneId
    /** Used only when the reference pane's parent cannot host `axis` directly. */
    readonly newSplitId: SplitId
  }
  /** Drop an empty docked pane and collapse the split it leaves behind. */
  | { readonly type: 'merge'; readonly paneId: PaneId }
  /** Add a new tab to a docked pane and focus it. */
  | { readonly type: 'openTab'; readonly paneId: PaneId; readonly tab: TabRecord; readonly index: number }
  /** Destroy a tab and its content state; a floating host pane goes with it. */
  | { readonly type: 'closeTab'; readonly tabId: TabId }
  /** Move a tab to a different docked pane. */
  | { readonly type: 'moveTab'; readonly tabId: TabId; readonly toPaneId: PaneId; readonly index: number }
  /** Move a tab within its own pane. */
  | { readonly type: 'reorderTab'; readonly tabId: TabId; readonly index: number }
  /** Focus a tab, its owning pane, and raise that pane when floating. */
  | { readonly type: 'focusTab'; readonly tabId: TabId }
  /** Focus a pane and raise it when floating. */
  | { readonly type: 'focusPane'; readonly paneId: PaneId }
  /** Net result of a divider drag. */
  | { readonly type: 'resize'; readonly splitId: SplitId; readonly sizes: readonly number[] }
  /** Take a tab out of the docked tree into a new floating pane. */
  | { readonly type: 'float'; readonly tabId: TabId; readonly newPaneId: PaneId; readonly rect: FloatRect }
  /** Return a floating pane's only tab to a docked pane and destroy the floating pane. */
  | { readonly type: 'unfloat'; readonly paneId: PaneId; readonly toPaneId: PaneId; readonly index: number }
  /** Net result of dragging a floating pane; the pane is focused and raised with it. */
  | { readonly type: 'moveFloat'; readonly paneId: PaneId; readonly x: number; readonly y: number }
  /** Net result of resizing a floating pane; the pane is focused and raised with it. */
  | { readonly type: 'resizeFloat'; readonly paneId: PaneId; readonly rect: FloatRect }
  /** Expand or collapse the docked area. */
  | { readonly type: 'setExpanded'; readonly expanded: boolean }
  /** Switch how the docked area is presented. */
  | { readonly type: 'setMode'; readonly mode: DockMode }
  /** Put a pane back, with the tab records it owned. */
  | {
    readonly type: 'insertPane'
    readonly pane: PaneNode
    readonly tabs: readonly TabRecord[]
    readonly attach: PaneAttachment
  }
  /** Put one tab record back into a docked pane. */
  | { readonly type: 'insertTab'; readonly paneId: PaneId; readonly tab: TabRecord; readonly index: number }
  /** Restore focus facts an operation displaced. */
  | {
    readonly type: 'restoreFocus'
    readonly activePaneId: PaneId
    readonly floats: readonly PaneId[]
    /** Active tab per pane, for the panes the inverted operation touched. */
    readonly paneActiveTabs: Readonly<Record<PaneId, TabId | undefined>>
  }

/** Operation kinds that only move focus; `Sequencer` collapses runs of these into one undo step. */
export type FocusOpType = 'focusTab' | 'focusPane' | 'restoreFocus'

/** Result of applying one operation: the next state plus the operations that undo it, in order. */
export interface ApplyResult {
  readonly state: LayoutState
  readonly inverse: readonly LayoutOp[]
}
