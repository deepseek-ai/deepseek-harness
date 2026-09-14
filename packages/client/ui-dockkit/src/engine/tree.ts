/**
 * Pure tree helpers over `LayoutState`. Every reader throws on a dangling id
 * (the operation vocabulary is closed, so a miss is a caller defect), and every
 * writer returns a new state that keeps untouched nodes at their old identity.
 */
import type {
  FloatRect, LayoutNode, LayoutState, NodeId, PaneId, PaneNode, SplitNode, TabId, TabRecord,
} from '../contract/types.ts'

/**
 * Reject an unhandled discriminant at the end of a closed switch.
 * @param value - the discriminant the switch did not handle.
 * @param what - the union being switched on, for the message.
 * @returns never; it throws.
 */
export function assertNever(value: never, what: string): never {
  throw new Error(`${what}: unhandled ${JSON.stringify(value)}`)
}

/**
 * Read any node.
 * @param state - current layout.
 * @param id - the node.
 * @returns the split or pane.
 * @throws when `id` is not in the tree.
 */
export function getNode(state: LayoutState, id: NodeId): LayoutNode {
  const node = state.nodes[id]
  if (node === undefined) throw new Error(`layout: unknown node ${id}`)
  return node
}

/**
 * Read a pane.
 * @param state - current layout.
 * @param id - the pane.
 * @returns the pane node.
 * @throws when `id` is missing or names a split.
 */
export function getPane(state: LayoutState, id: NodeId): PaneNode {
  const node = getNode(state, id)
  if (node.kind !== 'pane') throw new Error(`layout: ${id} is not a pane`)
  return node
}

/**
 * Read a split.
 * @param state - current layout.
 * @param id - the split.
 * @returns the split node.
 * @throws when `id` is missing or names a pane.
 */
export function getSplit(state: LayoutState, id: NodeId): SplitNode {
  const node = getNode(state, id)
  if (node.kind !== 'split') throw new Error(`layout: ${id} is not a split`)
  return node
}

/**
 * Read a tab record.
 * @param state - current layout.
 * @param id - the tab.
 * @returns the record.
 * @throws when `id` is not open.
 */
export function getTab(state: LayoutState, id: TabId): TabRecord {
  const tab = state.tabs[id]
  if (tab === undefined) throw new Error(`layout: unknown tab ${id}`)
  return tab
}

/**
 * A floating pane's rectangle.
 * @param pane - the pane.
 * @returns its viewport rectangle.
 * @throws when `pane` is docked.
 */
export function floatRect(pane: PaneNode): FloatRect {
  if (pane.host !== 'float' || pane.rect === undefined) throw new Error(`layout: ${pane.id} is not floating`)
  return pane.rect
}

/**
 * A floating pane's position in the z order.
 * @param state - current layout.
 * @param id - the floating pane.
 * @returns its index in `floats`, bottom first.
 * @throws when `id` is not listed in `floats`.
 */
export function floatIndex(state: LayoutState, id: PaneId): number {
  const index = state.floats.indexOf(id)
  if (index < 0) throw new Error(`layout: floating pane ${id} is not in the z order`)
  return index
}

/**
 * The one tab a pane holds.
 * @param pane - the pane.
 * @returns its tab's id.
 * @throws when `pane` holds any other number of tabs.
 */
export function onlyTabId(pane: PaneNode): TabId {
  const tabId = pane.tabs[0]
  if (tabId === undefined || pane.tabs.length !== 1) throw new Error(`layout: ${pane.id} does not hold exactly one tab`)
  return tabId
}

/**
 * The split holding a node.
 * @param state - current layout.
 * @param id - the node.
 * @returns its parent split, or `undefined` for the docked root and floating panes.
 */
export function findParent(state: LayoutState, id: NodeId): SplitNode | undefined {
  for (const node of Object.values(state.nodes)) {
    if (node.kind === 'split' && node.children.includes(id)) return node
  }
  return undefined
}

/**
 * The pane holding a tab.
 * @param state - current layout.
 * @param tabId - the tab.
 * @returns the pane whose strip lists it.
 * @throws when no pane lists it.
 */
export function findTabPane(state: LayoutState, tabId: TabId): PaneNode {
  for (const node of Object.values(state.nodes)) {
    if (node.kind === 'pane' && node.tabs.includes(tabId)) return node
  }
  throw new Error(`layout: tab ${tabId} has no pane`)
}

/**
 * Docked pane ids in visual order (depth-first through the split tree).
 * @param state - current layout.
 * @returns every docked pane's id; floating panes are absent.
 */
export function dockPaneIds(state: LayoutState): PaneId[] {
  const out: PaneId[] = []
  const walk = (id: NodeId): void => {
    const node = getNode(state, id)
    if (node.kind === 'pane') {
      out.push(node.id)
      return
    }
    for (const child of node.children) walk(child)
  }
  walk(state.rootId)
  return out
}

/**
 * Scale `sizes` so they sum to 1. Input that already sums to 1 is copied
 * unchanged, so restoring recorded sizes never drifts.
 * @param sizes - fractions or any positive weights.
 * @returns the fractions, summing to 1.
 * @throws when the input cannot be normalized.
 */
export function normalizeSizes(sizes: readonly number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (!(total > 0)) throw new Error('layout: sizes must sum above zero')
  if (Math.abs(total - 1) < 1e-12) return [...sizes]
  return sizes.map(size => size / total)
}

/**
 * `Object.entries` keeping the record's own key type: the keys were written from
 * ids, so reading them back as ids is exact.
 * @param record - an id-keyed record.
 * @returns its entries with typed keys.
 */
export function entriesOf<K extends string, V>(record: Readonly<Record<K, V>>): readonly (readonly [K, V])[] {
  return Object.entries(record) as [K, V][]
}

/**
 * `Object.keys` keeping the record's own key type; see {@link entriesOf}.
 * @param record - an id-keyed record.
 * @returns its keys, typed.
 */
export function keysOf<K extends string>(record: Readonly<Record<K, unknown>>): readonly K[] {
  return Object.keys(record) as K[]
}

/**
 * Replace or delete nodes.
 * @param state - current layout.
 * @param updates - nodes by id; a `null` update deletes that id.
 * @returns the layout with those nodes replaced; untouched nodes keep their identity.
 */
export function withNodes(
  state: LayoutState,
  updates: Readonly<Record<NodeId, LayoutNode | null>>,
): LayoutState {
  const nodes: Record<NodeId, LayoutNode> = {}
  for (const [id, node] of entriesOf(state.nodes)) {
    if (!(id in updates)) nodes[id] = node
  }
  for (const [id, node] of entriesOf(updates)) {
    if (node !== null) nodes[id] = node
  }
  return { ...state, nodes }
}

/**
 * Replace or delete tab records.
 * @param state - current layout.
 * @param updates - records by id; a `null` update deletes that id.
 * @returns the layout with those records replaced; untouched records keep their identity.
 */
export function withTabs(
  state: LayoutState,
  updates: Readonly<Record<TabId, TabRecord | null>>,
): LayoutState {
  const tabs: Record<TabId, TabRecord> = {}
  for (const [id, tab] of entriesOf(state.tabs)) {
    if (!(id in updates)) tabs[id] = tab
  }
  for (const [id, tab] of entriesOf(updates)) {
    if (tab !== null) tabs[id] = tab
  }
  return { ...state, tabs }
}

/**
 * Insert a value into a list.
 * @param items - the list.
 * @param index - the slot, clamped to the list's bounds.
 * @param value - what to insert.
 * @returns a new list with the value at the slot.
 */
export function insertAt<T>(items: readonly T[], index: number, value: T): T[] {
  const at = Math.max(0, Math.min(index, items.length))
  return [...items.slice(0, at), value, ...items.slice(at)]
}

/**
 * Remove one entry from a list.
 * @param items - the list.
 * @param index - the entry to drop.
 * @returns a new list without it.
 */
export function removeAt<T>(items: readonly T[], index: number): T[] {
  return [...items.slice(0, index), ...items.slice(index + 1)]
}

/**
 * Which tab a pane focuses after one leaves it.
 * @param tabs - the strip before the removal.
 * @param removedIndex - the leaving tab's slot.
 * @returns the previous neighbour when one exists, otherwise the next, otherwise `undefined`.
 */
export function neighbourTabId(tabs: readonly TabId[], removedIndex: number): TabId | undefined {
  const remaining = removeAt(tabs, removedIndex)
  if (remaining.length === 0) return undefined
  return remaining[Math.max(0, removedIndex - 1)]
}

/**
 * Copy a pane with a new tab list.
 * @param pane - the pane.
 * @param tabs - its new strip.
 * @param activeTabId - the active tab, which the caller keeps consistent with `tabs`.
 * @returns the copied pane.
 */
export function paneWithTabs(pane: PaneNode, tabs: readonly TabId[], activeTabId: TabId | undefined): PaneNode {
  return { ...pane, tabs, activeTabId }
}

/**
 * Swap a node for another in its parent's slot, or make the replacement the docked root.
 * @param state - current layout.
 * @param targetId - the node to swap out.
 * @param replacementId - the node taking its slot.
 * @returns the layout with the slot rewritten.
 * @throws when `targetId` is neither rooted nor parented.
 */
export function replaceInParent(state: LayoutState, targetId: NodeId, replacementId: NodeId): LayoutState {
  const parent = findParent(state, targetId)
  if (parent === undefined) {
    if (state.rootId !== targetId) throw new Error(`layout: ${targetId} is neither rooted nor parented`)
    return { ...state, rootId: replacementId }
  }
  const children = parent.children.map(child => child === targetId ? replacementId : child)
  return withNodes(state, { [parent.id]: { ...parent, children } })
}

/** Walk from the docked root to a pane, taking the child `choose` names at every split. */
function descend(state: LayoutState, choose: (split: SplitNode) => NodeId | undefined): PaneId {
  let node = getNode(state, state.rootId)
  while (node.kind === 'split') {
    const next = choose(node)
    /* v8 ignore next -- a split holds at least two children, so every choice names one. */
    if (next === undefined) throw new Error(`layout: split ${node.id} has no children`)
    node = getNode(state, next)
  }
  return node.id
}

/**
 * The first docked pane in visual order: the docked root, or the first leaf
 * under it. Focus falls back here when the focused pane is removed, and a new
 * tab lands here when the focused pane floats.
 * @param state - current layout.
 * @returns the first docked pane's id.
 */
export function firstDockPaneId(state: LayoutState): PaneId {
  return descend(state, split => split.children[0])
}

/**
 * The docked pane in the top-right corner: from the root, the last child of
 * every row split and the first child of every column split. Its tab strip is
 * where an embedder's surface-wide controls sit, so they read as the surface's
 * own top-right corner however the tree is divided.
 * @param state - current layout.
 * @returns the top-right docked pane's id.
 */
export function topRightPaneId(state: LayoutState): PaneId {
  return descend(state, split => (split.axis === 'row' ? split.children.at(-1) : split.children[0]))
}
