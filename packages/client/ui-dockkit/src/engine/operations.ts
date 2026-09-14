/**
 * The operation engine: one pure `applyOp` that returns the next state plus the
 * operations that undo it. No React, no DOM, no ambient state — replaying the
 * same operations over the same initial state always yields the same result,
 * because every id an operation creates travels inside the operation.
 *
 * Interaction limits (pane count, drag preview coalescing) are not enforced
 * here; they belong to the interaction layer (`constraints.ts` and the UI).
 */
import type {
  ApplyResult, FloatRect, LayoutOp, LayoutState, NodeId, PaneId, PaneNode, TabId,
} from '../contract/types.ts'
import {
  assertNever, entriesOf, findParent, findTabPane, firstDockPaneId, floatIndex, floatRect, getPane, getSplit, getTab,
  insertAt, keysOf, neighbourTabId, normalizeSizes, onlyTabId, paneWithTabs, removeAt, replaceInParent, withNodes, withTabs,
} from './tree.ts'

/** Capture the focus facts of `paneIds` plus global focus, as the operation that restores them. */
function focusSnapshot(state: LayoutState, paneIds: readonly PaneId[]): LayoutOp {
  const paneActiveTabs: Record<PaneId, TabId | undefined> = {}
  for (const id of paneIds) paneActiveTabs[id] = getPane(state, id).activeTabId
  return {
    type: 'restoreFocus',
    activePaneId: state.activePaneId,
    floats: state.floats,
    paneActiveTabs,
  }
}

/** Move `paneId` to the top of the floating z order. */
function raise(floats: readonly PaneId[], paneId: PaneId): PaneId[] {
  return [...floats.filter(id => id !== paneId), paneId]
}

/** Keep `activePaneId` on a live pane after `state` lost the focused one. */
function reseatFocus(state: LayoutState, removedPaneId: PaneId): LayoutState {
  if (state.activePaneId !== removedPaneId) return state
  return { ...state, activePaneId: firstDockPaneId(state) }
}

/** A fresh empty docked pane. */
function emptyDockPane(id: PaneId): PaneNode {
  return { kind: 'pane', id, host: 'dock', tabs: [], activeTabId: undefined, rect: undefined }
}

/** Reject an id that a creating operation expects to be free. */
function assertFreeNode(state: LayoutState, id: NodeId): void {
  if (state.nodes[id] !== undefined) throw new Error(`layout: node ${id} already exists`)
}

/** Reject a tab id that an opening operation expects to be free. */
function assertFreeTab(state: LayoutState, id: TabId): void {
  if (state.tabs[id] !== undefined) throw new Error(`layout: tab ${id} already exists`)
}

/** Give `paneId` an empty sibling along `axis`. */
function applySplit(state: LayoutState, op: Extract<LayoutOp, { type: 'split' }>): ApplyResult {
  const pane = getPane(state, op.paneId)
  if (pane.host !== 'dock') throw new Error('layout: split requires a docked pane')
  assertFreeNode(state, op.newPaneId)
  const newPane = emptyDockPane(op.newPaneId)
  const parent = findParent(state, op.paneId)

  if (parent !== undefined && parent.axis === op.axis) {
    const index = parent.children.indexOf(op.paneId)
    const at = op.direction === 'after' ? index + 1 : index
    const children = insertAt(parent.children, at, op.newPaneId)
    // The reference pane's share is halved between it and the new pane; the two
    // halves are equal, so the sizes align with `children` whichever side it took.
    const sizes = parent.sizes.flatMap((size, i) => (i === index ? [size / 2, size / 2] : [size]))
    return {
      state: withNodes(state, { [op.newPaneId]: newPane, [parent.id]: { ...parent, children, sizes } }),
      inverse: [
        { type: 'merge', paneId: op.newPaneId },
        { type: 'resize', splitId: parent.id, sizes: parent.sizes },
      ],
    }
  }

  assertFreeNode(state, op.newSplitId)
  // The reference pane's slot takes the new split; compute that swap before the
  // split node exists, or `findParent` would find the split itself.
  const rehomed = replaceInParent(state, op.paneId, op.newSplitId)
  const children = op.direction === 'after' ? [op.paneId, op.newPaneId] : [op.newPaneId, op.paneId]
  return {
    state: withNodes(rehomed, {
      [op.newPaneId]: newPane,
      [op.newSplitId]: { kind: 'split', id: op.newSplitId, axis: op.axis, children, sizes: [0.5, 0.5] },
    }),
    inverse: [{ type: 'merge', paneId: op.newPaneId }],
  }
}

/** Drop an empty pane; a two-child split collapses into its surviving child. */
function applyMerge(state: LayoutState, op: Extract<LayoutOp, { type: 'merge' }>): ApplyResult {
  const pane = getPane(state, op.paneId)
  if (pane.tabs.length > 0) throw new Error('layout: merge requires an empty pane')
  const focus = focusSnapshot(state, [])

  if (pane.host === 'float') {
    const index = floatIndex(state, op.paneId)
    const dropped = withNodes({ ...state, floats: removeAt(state.floats, index) }, { [op.paneId]: null })
    return {
      state: reseatFocus(dropped, op.paneId),
      inverse: [{ type: 'insertPane', pane, tabs: [], attach: { mode: 'float', index } }, focus],
    }
  }

  const parent = findParent(state, op.paneId)
  if (parent === undefined) throw new Error('layout: the docked root pane cannot be merged')
  const index = parent.children.indexOf(op.paneId)

  if (parent.children.length > 2) {
    const children = removeAt(parent.children, index)
    const sizes = normalizeSizes(removeAt(parent.sizes, index))
    const dropped = withNodes(state, { [op.paneId]: null, [parent.id]: { ...parent, children, sizes } })
    return {
      state: reseatFocus(dropped, op.paneId),
      inverse: [
        {
          type: 'insertPane',
          pane,
          tabs: [],
          attach: { mode: 'child', parentId: parent.id, index, sizes: parent.sizes },
        },
        focus,
      ],
    }
  }

  const siblingId = parent.children[1 - index]
  /* v8 ignore next -- a split holds at least two children, so one survives the merged pane. */
  if (siblingId === undefined) throw new Error('layout: merge found a split without a sibling')
  const collapsed = withNodes(replaceInParent(state, parent.id, siblingId), {
    [op.paneId]: null,
    [parent.id]: null,
  })
  return {
    state: reseatFocus(collapsed, op.paneId),
    inverse: [
      { type: 'insertPane', pane, tabs: [], attach: { mode: 'wrap', targetId: siblingId, split: parent } },
      focus,
    ],
  }
}

/** Add a new tab to a docked pane and focus it. */
function applyOpenTab(state: LayoutState, op: Extract<LayoutOp, { type: 'openTab' }>): ApplyResult {
  const pane = getPane(state, op.paneId)
  if (pane.host !== 'dock') throw new Error('layout: openTab requires a docked pane')
  assertFreeTab(state, op.tab.id)
  const focus = focusSnapshot(state, [pane.id])
  const seated = withNodes(withTabs(state, { [op.tab.id]: op.tab }), {
    [pane.id]: paneWithTabs(pane, insertAt(pane.tabs, op.index, op.tab.id), op.tab.id),
  })
  return {
    state: { ...seated, activePaneId: pane.id },
    inverse: [{ type: 'closeTab', tabId: op.tab.id }, focus],
  }
}

/** Put one tab record back where it was, without stealing focus. */
function applyInsertTab(state: LayoutState, op: Extract<LayoutOp, { type: 'insertTab' }>): ApplyResult {
  const pane = getPane(state, op.paneId)
  if (pane.host !== 'dock') throw new Error('layout: insertTab requires a docked pane')
  assertFreeTab(state, op.tab.id)
  const focus = focusSnapshot(state, [pane.id])
  const tabs = insertAt(pane.tabs, op.index, op.tab.id)
  return {
    state: withNodes(withTabs(state, { [op.tab.id]: op.tab }), {
      [pane.id]: paneWithTabs(pane, tabs, pane.activeTabId ?? op.tab.id),
    }),
    inverse: [{ type: 'closeTab', tabId: op.tab.id }, focus],
  }
}

/** Destroy a tab and its content state; a floating host pane goes with its only tab. */
function applyCloseTab(state: LayoutState, op: Extract<LayoutOp, { type: 'closeTab' }>): ApplyResult {
  const tab = getTab(state, op.tabId)
  const pane = findTabPane(state, op.tabId)
  const index = pane.tabs.indexOf(op.tabId)
  const focus = focusSnapshot(state, [pane.id])

  if (pane.host === 'float') {
    const index = floatIndex(state, pane.id)
    const dropped = withTabs(
      withNodes({ ...state, floats: removeAt(state.floats, index) }, { [pane.id]: null }),
      { [op.tabId]: null },
    )
    return {
      state: reseatFocus(dropped, pane.id),
      inverse: [
        { type: 'insertPane', pane, tabs: [tab], attach: { mode: 'float', index } },
        focus,
      ],
    }
  }

  const activeTabId = pane.activeTabId === op.tabId ? neighbourTabId(pane.tabs, index) : pane.activeTabId
  return {
    state: withTabs(
      withNodes(state, { [pane.id]: paneWithTabs(pane, removeAt(pane.tabs, index), activeTabId) }),
      { [op.tabId]: null },
    ),
    inverse: [{ type: 'insertTab', paneId: pane.id, tab, index }, focus],
  }
}

/**
 * Put a pane back, with the tab records it owned. A docked pane returns empty
 * (its tabs return through `insertTab`, as `closeTab` records them); a floating
 * pane returns with its one tab, or empty.
 */
function applyInsertPane(state: LayoutState, op: Extract<LayoutOp, { type: 'insertPane' }>): ApplyResult {
  assertFreeNode(state, op.pane.id)
  if (op.pane.tabs.length !== op.tabs.length) throw new Error('layout: insertPane tab records do not match the pane')
  if (op.pane.host === 'dock' && op.tabs.length > 0) throw new Error('layout: insertPane returns a docked pane empty')
  const tabUpdates: Record<TabId, typeof op.tabs[number]> = {}
  for (const tab of op.tabs) {
    assertFreeTab(state, tab.id)
    tabUpdates[tab.id] = tab
  }
  const restoredTab = op.tabs[0]
  const inverse: LayoutOp[] = restoredTab === undefined
    ? [{ type: 'merge', paneId: op.pane.id }]
    : [{ type: 'closeTab', tabId: restoredTab.id }, focusSnapshot(state, [])]

  const attach = op.attach
  switch (attach.mode) {
    case 'child': {
      const parent = getSplit(state, attach.parentId)
      const children = insertAt(parent.children, attach.index, op.pane.id)
      if (attach.sizes.length !== children.length) throw new Error('layout: insertPane sizes do not match the split')
      inverse.push({ type: 'resize', splitId: parent.id, sizes: parent.sizes })
      return {
        state: withNodes(withTabs(state, tabUpdates), {
          [op.pane.id]: op.pane,
          [parent.id]: { ...parent, children, sizes: attach.sizes },
        }),
        inverse,
      }
    }
    case 'wrap': {
      if (!attach.split.children.includes(op.pane.id)) {
        throw new Error('layout: insertPane wrap split does not list the pane')
      }
      const rehomed = replaceInParent(state, attach.targetId, attach.split.id)
      return {
        state: withNodes(withTabs(rehomed, tabUpdates), {
          [op.pane.id]: op.pane,
          [attach.split.id]: attach.split,
        }),
        inverse,
      }
    }
    case 'float': {
      if (op.pane.host !== 'float') throw new Error('layout: float attachment requires a floating pane')
      const floats = insertAt(state.floats, attach.index, op.pane.id)
      return {
        state: withNodes(withTabs({ ...state, floats }, tabUpdates), { [op.pane.id]: op.pane }),
        inverse,
      }
    }
    /* v8 ignore next 2 -- closed-union backstop; the compiler rejects a new attachment mode here. */
    default:
      return assertNever(attach, 'layout: insertPane attachment')
  }
}

/** Move a tab to a different docked pane and focus it there. */
function applyMoveTab(state: LayoutState, op: Extract<LayoutOp, { type: 'moveTab' }>): ApplyResult {
  const from = findTabPane(state, op.tabId)
  if (from.host !== 'dock') throw new Error('layout: moveTab source must be docked; use unfloat')
  const to = getPane(state, op.toPaneId)
  if (to.host !== 'dock') throw new Error('layout: moveTab target must be docked')
  if (to.id === from.id) throw new Error('layout: moveTab across one pane; use reorderTab')
  const index = from.tabs.indexOf(op.tabId)
  const focus = focusSnapshot(state, [from.id, to.id])
  const activeTabId = from.activeTabId === op.tabId ? neighbourTabId(from.tabs, index) : from.activeTabId
  const moved = withNodes(state, {
    [from.id]: paneWithTabs(from, removeAt(from.tabs, index), activeTabId),
    [to.id]: paneWithTabs(to, insertAt(to.tabs, op.index, op.tabId), op.tabId),
  })
  return {
    state: { ...moved, activePaneId: to.id },
    inverse: [{ type: 'moveTab', tabId: op.tabId, toPaneId: from.id, index }, focus],
  }
}

/** Move a tab within its own pane. */
function applyReorderTab(state: LayoutState, op: Extract<LayoutOp, { type: 'reorderTab' }>): ApplyResult {
  const pane = findTabPane(state, op.tabId)
  const from = pane.tabs.indexOf(op.tabId)
  const tabs = insertAt(removeAt(pane.tabs, from), op.index, op.tabId)
  return {
    state: withNodes(state, { [pane.id]: { ...pane, tabs } }),
    inverse: [{ type: 'reorderTab', tabId: op.tabId, index: from }],
  }
}

/** Focus a tab, its pane, and raise that pane when floating. */
function applyFocusTab(state: LayoutState, op: Extract<LayoutOp, { type: 'focusTab' }>): ApplyResult {
  const pane = findTabPane(state, op.tabId)
  const focus = focusSnapshot(state, [pane.id])
  const focused = withNodes(state, { [pane.id]: { ...pane, activeTabId: op.tabId } })
  const floats = pane.host === 'float' ? raise(focused.floats, pane.id) : focused.floats
  return { state: { ...focused, activePaneId: pane.id, floats }, inverse: [focus] }
}

/** Focus a pane and raise it when floating. */
function applyFocusPane(state: LayoutState, op: Extract<LayoutOp, { type: 'focusPane' }>): ApplyResult {
  const pane = getPane(state, op.paneId)
  const focus = focusSnapshot(state, [])
  const floats = pane.host === 'float' ? raise(state.floats, pane.id) : state.floats
  return { state: { ...state, activePaneId: pane.id, floats }, inverse: [focus] }
}

/** Record the net result of a divider drag. */
function applyResize(state: LayoutState, op: Extract<LayoutOp, { type: 'resize' }>): ApplyResult {
  const split = getSplit(state, op.splitId)
  if (op.sizes.length !== split.children.length) throw new Error('layout: resize sizes do not match the split')
  if (op.sizes.some(size => !(size > 0))) throw new Error('layout: resize sizes must all be above zero')
  return {
    state: withNodes(state, { [split.id]: { ...split, sizes: normalizeSizes(op.sizes) } }),
    inverse: [{ type: 'resize', splitId: split.id, sizes: split.sizes }],
  }
}

/** Take a tab out of the docked tree into a new floating pane on top. */
function applyFloat(state: LayoutState, op: Extract<LayoutOp, { type: 'float' }>): ApplyResult {
  getTab(state, op.tabId)
  const from = findTabPane(state, op.tabId)
  if (from.host !== 'dock') throw new Error('layout: float requires a docked tab')
  assertFreeNode(state, op.newPaneId)
  const index = from.tabs.indexOf(op.tabId)
  const focus = focusSnapshot(state, [from.id])
  const activeTabId = from.activeTabId === op.tabId ? neighbourTabId(from.tabs, index) : from.activeTabId
  const floated = withNodes(state, {
    [from.id]: paneWithTabs(from, removeAt(from.tabs, index), activeTabId),
    [op.newPaneId]: {
      kind: 'pane',
      id: op.newPaneId,
      host: 'float',
      tabs: [op.tabId],
      activeTabId: op.tabId,
      rect: op.rect,
    },
  })
  return {
    state: { ...floated, floats: [...floated.floats, op.newPaneId], activePaneId: op.newPaneId },
    inverse: [{ type: 'unfloat', paneId: op.newPaneId, toPaneId: from.id, index }, focus],
  }
}

/** Return a floating pane's only tab to a docked pane and destroy the floating pane. */
function applyUnfloat(state: LayoutState, op: Extract<LayoutOp, { type: 'unfloat' }>): ApplyResult {
  const pane = getPane(state, op.paneId)
  const rect = floatRect(pane)
  const tabId = onlyTabId(pane)
  const to = getPane(state, op.toPaneId)
  if (to.host !== 'dock') throw new Error('layout: unfloat target must be docked')
  const focus = focusSnapshot(state, [to.id])
  const docked = withNodes({ ...state, floats: removeAt(state.floats, floatIndex(state, op.paneId)) }, {
    [op.paneId]: null,
    [to.id]: paneWithTabs(to, insertAt(to.tabs, op.index, tabId), tabId),
  })
  return {
    state: { ...docked, activePaneId: to.id },
    inverse: [{ type: 'float', tabId, newPaneId: op.paneId, rect }, focus],
  }
}

/** Give a floating pane a new rectangle, focus it, and raise it: the one operation a drag of it records. */
function reshapeFloat(state: LayoutState, pane: PaneNode, rect: FloatRect): LayoutState {
  const reshaped = withNodes(state, { [pane.id]: { ...pane, rect } })
  return { ...reshaped, activePaneId: pane.id, floats: raise(reshaped.floats, pane.id) }
}

/** Record the net result of dragging a floating pane, which also focuses and raises it. */
function applyMoveFloat(state: LayoutState, op: Extract<LayoutOp, { type: 'moveFloat' }>): ApplyResult {
  const pane = getPane(state, op.paneId)
  const rect = floatRect(pane)
  return {
    state: reshapeFloat(state, pane, { ...rect, x: op.x, y: op.y }),
    inverse: [{ type: 'moveFloat', paneId: op.paneId, x: rect.x, y: rect.y }, focusSnapshot(state, [])],
  }
}

/** Record the net result of resizing a floating pane, which also focuses and raises it. */
function applyResizeFloat(state: LayoutState, op: Extract<LayoutOp, { type: 'resizeFloat' }>): ApplyResult {
  const pane = getPane(state, op.paneId)
  const rect = floatRect(pane)
  if (!(op.rect.width > 0) || !(op.rect.height > 0)) throw new Error('layout: float size must be above zero')
  return {
    state: reshapeFloat(state, pane, op.rect),
    inverse: [{ type: 'resizeFloat', paneId: op.paneId, rect }, focusSnapshot(state, [])],
  }
}

/** Restore focus facts a previous operation displaced. */
function applyRestoreFocus(state: LayoutState, op: Extract<LayoutOp, { type: 'restoreFocus' }>): ApplyResult {
  const inverse = focusSnapshot(state, keysOf(op.paneActiveTabs))
  for (const paneId of op.floats) {
    const pane = getPane(state, paneId)
    if (pane.host !== 'float') throw new Error(`layout: restoreFocus lists docked pane ${paneId} as floating`)
  }
  let next = state
  for (const [paneId, activeTabId] of entriesOf(op.paneActiveTabs)) {
    const pane = getPane(next, paneId)
    next = withNodes(next, { [paneId]: { ...pane, activeTabId } })
  }
  getPane(next, op.activePaneId)
  return { state: { ...next, activePaneId: op.activePaneId, floats: op.floats }, inverse: [inverse] }
}

/**
 * Apply one operation.
 * @param state - state the operation reads; never mutated.
 * @param op - the operation, carrying every id it creates.
 * @returns the next state and the operations that undo it, applied in order.
 * @throws when the operation addresses missing nodes or breaks a model rule.
 */
export function applyOp(state: LayoutState, op: LayoutOp): ApplyResult {
  switch (op.type) {
    case 'split': return applySplit(state, op)
    case 'merge': return applyMerge(state, op)
    case 'openTab': return applyOpenTab(state, op)
    case 'insertTab': return applyInsertTab(state, op)
    case 'closeTab': return applyCloseTab(state, op)
    case 'insertPane': return applyInsertPane(state, op)
    case 'moveTab': return applyMoveTab(state, op)
    case 'reorderTab': return applyReorderTab(state, op)
    case 'focusTab': return applyFocusTab(state, op)
    case 'focusPane': return applyFocusPane(state, op)
    case 'resize': return applyResize(state, op)
    case 'float': return applyFloat(state, op)
    case 'unfloat': return applyUnfloat(state, op)
    case 'moveFloat': return applyMoveFloat(state, op)
    case 'resizeFloat': return applyResizeFloat(state, op)
    case 'setExpanded':
      return {
        state: { ...state, expanded: op.expanded },
        inverse: [{ type: 'setExpanded', expanded: state.expanded }],
      }
    case 'setMode':
      return {
        state: { ...state, mode: op.mode },
        inverse: [{ type: 'setMode', mode: state.mode }],
      }
    case 'restoreFocus': return applyRestoreFocus(state, op)
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new operation type here. */
    default: return assertNever(op, 'layout: operation')
  }
}

/**
 * Fold operations forward, discarding inverses.
 * @param state - starting state.
 * @param ops - operations in recorded order.
 * @returns the state after every operation.
 */
export function replay(state: LayoutState, ops: readonly LayoutOp[]): LayoutState {
  return ops.reduce((current, op) => applyOp(current, op).state, state)
}
