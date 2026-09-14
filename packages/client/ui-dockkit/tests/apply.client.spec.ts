/**
 * Model and operation-engine behavior: what each operation does to the tree, and
 * that applying its inverse returns the exact state it started from.
 */
import { describe, expect, it } from 'vitest'
import { applyOp, replay } from '../src/engine/operations.ts'
import { createIdMinter, createInitialState } from '../src/engine/initial.ts'
import { asPane, asSplit, asTab, childAt, fileTab, firstTab, seedTab } from './fixtures.client.ts'
import {
  assertNever, dockPaneIds, findParent, findTabPane, firstDockPaneId, floatIndex, floatRect, getNode, getPane, getSplit,
  getTab, normalizeSizes, onlyTabId, replaceInParent, topRightPaneId,
} from '../src/engine/tree.ts'
import type { IdMinter } from '../src/engine/initial.ts'
import type { LayoutOp, LayoutState, PaneId, PaneNode, TabId } from '../src/contract/types.ts'

interface Fixture {
  readonly state: LayoutState
  readonly minter: IdMinter
  readonly paneId: PaneId
  readonly guideTabId: TabId
}

function fixture(): Fixture {
  const minter = createIdMinter()
  const state = createInitialState(minter, seedTab)
  const paneId = getPane(state, state.rootId).id
  const guideTabId = getPane(state, paneId).tabs[0]
  if (guideTabId === undefined) throw new Error('fixture: initial pane has no guide tab')
  return { state, minter, paneId, guideTabId }
}

/** Apply `op`, then its inverse, and require the original state back. */
function expectRoundTrip(state: LayoutState, op: LayoutOp): LayoutState {
  const result = applyOp(state, op)
  const back = result.inverse.reduce((current, inverse) => applyOp(current, inverse).state, result.state)
  expect(back).toEqual(state)
  return result.state
}

/** Split `paneId` to the right, returning the state and the new pane id. */
function split(
  state: LayoutState,
  minter: IdMinter,
  paneId: PaneId,
  axis: 'row' | 'column' = 'row',
  direction: 'before' | 'after' = 'after',
): { state: LayoutState; newPaneId: PaneId } {
  const newPaneId = minter.next('pane')
  const op: LayoutOp = { type: 'split', paneId, axis, direction, newPaneId, newSplitId: minter.next('split') }
  return { state: expectRoundTrip(state, op), newPaneId }
}

describe('initial state', () => {
  it('starts collapsed with one docked pane holding an active guide tab', () => {
    const { state, paneId, guideTabId } = fixture()
    expect(state.expanded).toBe(false)
    expect(dockPaneIds(state)).toEqual([paneId])
    expect(state.floats).toEqual([])
    expect(state.activePaneId).toBe(paneId)
    const pane = getPane(state, paneId)
    expect(pane.tabs).toEqual([guideTabId])
    expect(pane.activeTabId).toBe(guideTabId)
    expect(state.tabs[guideTabId]?.kind).toBe('seed')
  })
})

describe('split', () => {
  it('wraps the reference pane in a new split and adds an empty sibling', () => {
    const { state, minter, paneId } = fixture()
    const after = split(state, minter, paneId).state
    const root = getSplit(after, after.rootId)
    expect(root.axis).toBe('row')
    expect(root.children).toHaveLength(2)
    expect(root.children[0]).toBe(paneId)
    expect(root.sizes).toEqual([0.5, 0.5])
    expect(dockPaneIds(after)).toHaveLength(2)
    const sibling = getPane(after, childAt(root, 1))
    expect(sibling.tabs).toEqual([])
    expect(sibling.activeTabId).toBeUndefined()
  })

  it('puts the new pane before the reference pane when asked', () => {
    const { state, minter, paneId } = fixture()
    const after = split(state, minter, paneId, 'row', 'before').state
    expect(getSplit(after, after.rootId).children[1]).toBe(paneId)
  })

  it('joins an existing split of the same axis instead of nesting', () => {
    const { state, minter, paneId } = fixture()
    const first = split(state, minter, paneId)
    const second = split(first.state, minter, paneId)
    const root = getSplit(second.state, second.state.rootId)
    expect(root.children).toHaveLength(3)
    expect(root.sizes).toEqual([0.25, 0.25, 0.5])
    expect(dockPaneIds(second.state)).toHaveLength(3)
  })

  it('joins an existing split before the reference pane when asked', () => {
    const { state, minter, paneId } = fixture()
    const first = split(state, minter, paneId)
    const second = split(first.state, minter, paneId, 'row', 'before')
    const root = getSplit(second.state, second.state.rootId)
    expect(root.children).toEqual([second.newPaneId, paneId, first.newPaneId])
    expect(root.sizes).toEqual([0.25, 0.25, 0.5])
  })

  it('nests when the parent split runs on the other axis', () => {
    const { state, minter, paneId } = fixture()
    const first = split(state, minter, paneId)
    const second = split(first.state, minter, first.newPaneId, 'column')
    const root = getSplit(second.state, second.state.rootId)
    expect(root.axis).toBe('row')
    expect(root.children).toHaveLength(2)
    const nested = getSplit(second.state, childAt(root, 1))
    expect(nested.axis).toBe('column')
    expect(nested.children).toEqual([first.newPaneId, second.newPaneId])
  })

  it('refuses an unknown pane and a floating pane', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    expect(() => applyOp(state, {
      type: 'split', paneId: asPane('nope'), axis: 'row', direction: 'after', newPaneId: asPane('p'), newSplitId: asSplit('s'),
    })).toThrow(/unknown node/)
    const floatId = minter.next('float')
    const floated = applyOp(state, {
      type: 'float', tabId: guideTabId, newPaneId: floatId, rect: { x: 0, y: 0, width: 100, height: 100 },
    }).state
    expect(() => applyOp(floated, {
      type: 'split', paneId: floatId, axis: 'row', direction: 'after', newPaneId: asPane('p'), newSplitId: asSplit('s'),
    })).toThrow(/docked pane/)
    expect(paneId).toBeDefined()
  })
})

describe('merge', () => {
  it('collapses a two-child split back into its surviving pane', () => {
    const { state, minter, paneId } = fixture()
    const after = split(state, minter, paneId)
    const merged = expectRoundTrip(after.state, { type: 'merge', paneId: after.newPaneId })
    expect(merged.rootId).toBe(paneId)
    expect(dockPaneIds(merged)).toEqual([paneId])
    expect(merged.nodes[after.newPaneId]).toBeUndefined()
  })

  it('drops one child of a wider split and renormalizes the rest', () => {
    const { state, minter, paneId } = fixture()
    const first = split(state, minter, paneId)
    const second = split(first.state, minter, paneId)
    const merged = expectRoundTrip(second.state, { type: 'merge', paneId: second.newPaneId })
    const root = getSplit(merged, merged.rootId)
    expect(root.children).toHaveLength(2)
    expect(root.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1)
  })

  it('refuses a non-empty pane and the docked root pane', () => {
    const { state, minter, paneId } = fixture()
    expect(() => applyOp(state, { type: 'merge', paneId })).toThrow(/empty pane/)
    const after = split(state, minter, paneId)
    expect(() => applyOp(after.state, { type: 'merge', paneId: asPane(after.newPaneId + 'x') })).toThrow(/unknown node/)
    const emptied = applyOp(after.state, { type: 'closeTab', tabId: firstTab(getPane(after.state, paneId)) }).state
    const collapsed = applyOp(emptied, { type: 'merge', paneId }).state
    expect(() => applyOp(collapsed, { type: 'merge', paneId: after.newPaneId })).toThrow(/root pane/)
  })

  it('reseats focus when the merged pane held it', () => {
    const { state, minter, paneId } = fixture()
    const after = split(state, minter, paneId)
    const focused = applyOp(after.state, { type: 'focusPane', paneId: after.newPaneId }).state
    expect(focused.activePaneId).toBe(after.newPaneId)
    const merged = expectRoundTrip(focused, { type: 'merge', paneId: after.newPaneId })
    expect(merged.activePaneId).toBe(paneId)
  })
})

describe('tabs', () => {
  it('opens a tab into a pane and focuses it', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const after = expectRoundTrip(state, { type: 'openTab', paneId, tab, index: 0 })
    const pane = getPane(after, paneId)
    expect(pane.tabs).toEqual([tab.id, guideTabId])
    expect(pane.activeTabId).toBe(tab.id)
    expect(after.activePaneId).toBe(paneId)
  })

  it('refuses to reopen a live tab id', () => {
    const { state, paneId, guideTabId } = fixture()
    const clash = { id: guideTabId, kind: 'guide' as const, contentId: 'x', title: 'x' }
    expect(() => applyOp(state, { type: 'openTab', paneId, tab: clash, index: 0 })).toThrow(/already exists/)
  })

  it('closes the active tab onto its previous neighbour', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const first = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const second = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/b.txt', 'b.txt')
    let current = applyOp(state, { type: 'openTab', paneId, tab: first, index: 1 }).state
    current = applyOp(current, { type: 'openTab', paneId, tab: second, index: 2 }).state
    expect(getPane(current, paneId).tabs).toEqual([guideTabId, first.id, second.id])
    const after = expectRoundTrip(current, { type: 'closeTab', tabId: second.id })
    const pane = getPane(after, paneId)
    expect(pane.tabs).toEqual([guideTabId, first.id])
    expect(pane.activeTabId).toBe(first.id)
    expect(after.tabs[second.id]).toBeUndefined()
  })

  it('closes a tab that is not the active one without moving focus', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const opened = applyOp(state, { type: 'openTab', paneId, tab, index: 1 }).state
    const after = expectRoundTrip(opened, { type: 'closeTab', tabId: guideTabId })
    expect(getPane(after, paneId).tabs).toEqual([tab.id])
    expect(getPane(after, paneId).activeTabId).toBe(tab.id)
  })

  it('leaves an empty pane with no active tab', () => {
    const { state, paneId, guideTabId } = fixture()
    const after = expectRoundTrip(state, { type: 'closeTab', tabId: guideTabId })
    const pane = getPane(after, paneId)
    expect(pane.tabs).toEqual([])
    expect(pane.activeTabId).toBeUndefined()
  })

  it('moves a tab across panes and focuses the destination', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const after = split(state, minter, paneId)
    const moved = expectRoundTrip(after.state, { type: 'moveTab', tabId: guideTabId, toPaneId: after.newPaneId, index: 0 })
    expect(getPane(moved, paneId).tabs).toEqual([])
    expect(getPane(moved, after.newPaneId).tabs).toEqual([guideTabId])
    expect(moved.activePaneId).toBe(after.newPaneId)
  })

  it('moves a tab that is not the active one, leaving the source focus alone', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const opened = applyOp(state, { type: 'openTab', paneId, tab, index: 1 }).state
    const after = split(opened, minter, paneId)
    const moved = expectRoundTrip(after.state, { type: 'moveTab', tabId: guideTabId, toPaneId: after.newPaneId, index: 0 })
    expect(getPane(moved, paneId).tabs).toEqual([tab.id])
    expect(getPane(moved, paneId).activeTabId).toBe(tab.id)
    expect(getPane(moved, after.newPaneId).activeTabId).toBe(guideTabId)
  })

  it('refuses a cross-pane move onto the tab own pane', () => {
    const { state, paneId, guideTabId } = fixture()
    expect(() => applyOp(state, { type: 'moveTab', tabId: guideTabId, toPaneId: paneId, index: 0 }))
      .toThrow(/reorderTab/)
  })

  it('reorders inside one pane without changing the active tab', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const opened = applyOp(state, { type: 'openTab', paneId, tab, index: 1 }).state
    const after = expectRoundTrip(opened, { type: 'reorderTab', tabId: tab.id, index: 0 })
    expect(getPane(after, paneId).tabs).toEqual([tab.id, guideTabId])
    expect(getPane(after, paneId).activeTabId).toBe(tab.id)
  })
})

describe('focus', () => {
  it('focuses a tab and its pane', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const opened = applyOp(state, { type: 'openTab', paneId, tab, index: 1 }).state
    const after = expectRoundTrip(opened, { type: 'focusTab', tabId: guideTabId })
    expect(getPane(after, paneId).activeTabId).toBe(guideTabId)
  })

  it('raises a floating pane when its tab takes focus', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    let current = applyOp(state, { type: 'openTab', paneId, tab, index: 1 }).state
    const firstFloat = minter.next('float')
    const secondFloat = minter.next('float')
    current = applyOp(current, {
      type: 'float', tabId: guideTabId, newPaneId: firstFloat, rect: { x: 0, y: 0, width: 100, height: 100 },
    }).state
    current = applyOp(current, {
      type: 'float', tabId: tab.id, newPaneId: secondFloat, rect: { x: 10, y: 10, width: 100, height: 100 },
    }).state
    const after = expectRoundTrip(current, { type: 'focusTab', tabId: guideTabId })
    expect(after.floats).toEqual([secondFloat, firstFloat])
    expect(after.activePaneId).toBe(firstFloat)
  })

  it('raises a floating pane when it takes focus', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    let current = applyOp(state, { type: 'openTab', paneId, tab, index: 1 }).state
    const firstFloat = minter.next('float')
    const secondFloat = minter.next('float')
    current = applyOp(current, {
      type: 'float', tabId: guideTabId, newPaneId: firstFloat, rect: { x: 0, y: 0, width: 100, height: 100 },
    }).state
    current = applyOp(current, {
      type: 'float', tabId: tab.id, newPaneId: secondFloat, rect: { x: 10, y: 10, width: 100, height: 100 },
    }).state
    expect(current.floats).toEqual([firstFloat, secondFloat])
    const after = expectRoundTrip(current, { type: 'focusPane', paneId: firstFloat })
    expect(after.floats).toEqual([secondFloat, firstFloat])
    expect(after.activePaneId).toBe(firstFloat)
  })
})

describe('resize', () => {
  it('replaces divider sizes', () => {
    const { state, minter, paneId } = fixture()
    const after = split(state, minter, paneId)
    const resized = expectRoundTrip(after.state, { type: 'resize', splitId: getSplit(after.state, after.state.rootId).id, sizes: [0.3, 0.7] })
    expect(getSplit(resized, resized.rootId).sizes).toEqual([0.3, 0.7])
  })

  it('rejects the wrong count and non-positive sizes', () => {
    const { state, minter, paneId } = fixture()
    const after = split(state, minter, paneId)
    const splitId = getSplit(after.state, after.state.rootId).id
    expect(() => applyOp(after.state, { type: 'resize', splitId, sizes: [1] })).toThrow(/do not match/)
    expect(() => applyOp(after.state, { type: 'resize', splitId, sizes: [0, 1] })).toThrow(/above zero/)
  })
})

describe('floating panes', () => {
  it('takes a tab out of the docked tree onto the top of the z order', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const floatId = minter.next('float')
    const rect = { x: 40, y: 50, width: 300, height: 200 }
    const after = expectRoundTrip(state, { type: 'float', tabId: guideTabId, newPaneId: floatId, rect })
    expect(getPane(after, paneId).tabs).toEqual([])
    expect(after.floats).toEqual([floatId])
    expect(after.activePaneId).toBe(floatId)
    const pane = getPane(after, floatId)
    expect(pane.host).toBe('float')
    expect(pane.tabs).toEqual([guideTabId])
    expect(pane.rect).toEqual(rect)
    expect(findParent(after, floatId)).toBeUndefined()
  })

  it('returns a floating tab to a docked pane and drops the floating pane', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const floatId = minter.next('float')
    const floated = applyOp(state, {
      type: 'float', tabId: guideTabId, newPaneId: floatId, rect: { x: 0, y: 0, width: 100, height: 100 },
    }).state
    const docked = expectRoundTrip(floated, { type: 'unfloat', paneId: floatId, toPaneId: paneId, index: 0 })
    expect(docked.floats).toEqual([])
    expect(docked.nodes[floatId]).toBeUndefined()
    expect(getPane(docked, paneId).tabs).toEqual([guideTabId])
    expect(docked.activePaneId).toBe(paneId)
  })

  it('destroys the floating pane together with its only tab', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const floatId = minter.next('float')
    const floated = applyOp(state, {
      type: 'float', tabId: guideTabId, newPaneId: floatId, rect: { x: 0, y: 0, width: 100, height: 100 },
    }).state
    const closed = expectRoundTrip(floated, { type: 'closeTab', tabId: guideTabId })
    expect(closed.floats).toEqual([])
    expect(closed.nodes[floatId]).toBeUndefined()
    expect(closed.tabs[guideTabId]).toBeUndefined()
    expect(closed.activePaneId).toBe(paneId)
  })

  it('records net drag and resize results, focusing and raising the pane they reshape', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const floatId = minter.next('float')
    const topId = minter.next('float')
    let current = applyOp(state, { type: 'openTab', paneId, tab, index: 1 }).state
    current = applyOp(current, {
      type: 'float', tabId: guideTabId, newPaneId: floatId, rect: { x: 0, y: 0, width: 100, height: 100 },
    }).state
    current = applyOp(current, {
      type: 'float', tabId: tab.id, newPaneId: topId, rect: { x: 10, y: 10, width: 100, height: 100 },
    }).state
    current = applyOp(current, { type: 'focusPane', paneId }).state
    expect(current.floats).toEqual([floatId, topId])
    expect(current.activePaneId).toBe(paneId)

    // The lower, unfocused panel is dragged: it ends on top and focused; undo puts both facts back.
    const moved = expectRoundTrip(current, { type: 'moveFloat', paneId: floatId, x: 25, y: 35 })
    expect(getPane(moved, floatId).rect).toEqual({ x: 25, y: 35, width: 100, height: 100 })
    expect(moved.floats).toEqual([topId, floatId])
    expect(moved.activePaneId).toBe(floatId)

    const lowered = applyOp(moved, { type: 'focusPane', paneId: topId }).state
    const resized = expectRoundTrip(lowered, {
      type: 'resizeFloat', paneId: floatId, rect: { x: 25, y: 35, width: 420, height: 260 },
    })
    expect(getPane(resized, floatId).rect).toEqual({ x: 25, y: 35, width: 420, height: 260 })
    expect(resized.floats).toEqual([topId, floatId])
    expect(resized.activePaneId).toBe(floatId)
    expect(() => applyOp(moved, {
      type: 'resizeFloat', paneId: floatId, rect: { x: 0, y: 0, width: 0, height: 10 },
    })).toThrow(/above zero/)
  })

  it('refuses to float a tab that already floats', () => {
    const { state, minter, guideTabId } = fixture()
    const floatId = minter.next('float')
    const floated = applyOp(state, {
      type: 'float', tabId: guideTabId, newPaneId: floatId, rect: { x: 0, y: 0, width: 100, height: 100 },
    }).state
    expect(() => applyOp(floated, {
      type: 'float', tabId: guideTabId, newPaneId: minter.next('float'), rect: { x: 0, y: 0, width: 10, height: 10 },
    })).toThrow(/docked tab/)
  })
})

describe('presentation flags', () => {
  it('round-trips the collapsed flag', () => {
    const { state } = fixture()
    const after = expectRoundTrip(state, { type: 'setExpanded', expanded: true })
    expect(after.expanded).toBe(true)
  })

  it('round-trips the presentation mode', () => {
    const { state } = fixture()
    expect(state.mode).toBe('push')
    const after = expectRoundTrip(state, { type: 'setMode', mode: 'fullscreen' })
    expect(after.mode).toBe('fullscreen')
    // The two flags are independent: switching one leaves the other alone.
    expect(after.expanded).toBe(state.expanded)
  })

  it('starts in the presentation the embedder seeded', () => {
    const minter = createIdMinter()
    expect(createInitialState(minter, seedTab, 'fullscreen').mode).toBe('fullscreen')
  })
})

describe('tree readers', () => {
  /** The seeded pane floated out, leaving the root pane empty. */
  function floated(): { state: LayoutState; paneId: PaneId; floatId: PaneId; guideTabId: TabId } {
    const { state, minter, paneId, guideTabId } = fixture()
    const floatId = minter.next('float')
    const next = applyOp(state, {
      type: 'float', tabId: guideTabId, newPaneId: floatId, rect: { x: 0, y: 0, width: 100, height: 100 },
    }).state
    return { state: next, paneId, floatId, guideTabId }
  }

  it('throw on a dangling id or a node of the other kind', () => {
    const { state, minter, paneId } = fixture()
    const after = split(state, minter, paneId).state
    expect(() => getNode(after, asPane('nope'))).toThrow(/unknown node nope/)
    expect(() => getPane(after, after.rootId)).toThrow(/is not a pane/)
    expect(() => getSplit(after, paneId)).toThrow(/is not a split/)
    expect(() => getTab(after, asTab('nope'))).toThrow(/unknown tab nope/)
    expect(() => findTabPane(after, asTab('nope'))).toThrow(/has no pane/)
    expect(() => replaceInParent(after, asPane('nope'), paneId)).toThrow(/neither rooted nor parented/)
  })

  it('read a floating pane\'s rectangle, z position, and only tab, and refuse a docked one', () => {
    const { state, paneId, floatId, guideTabId } = floated()
    const pane = getPane(state, floatId)
    expect(floatRect(pane)).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    expect(floatIndex(state, floatId)).toBe(0)
    expect(onlyTabId(pane)).toBe(guideTabId)
    const docked = getPane(state, paneId)
    expect(() => floatRect(docked)).toThrow(/is not floating/)
    expect(() => floatIndex(state, paneId)).toThrow(/not in the z order/)
    expect(() => onlyTabId(docked)).toThrow(/exactly one tab/)
    const two: PaneNode = { ...pane, tabs: [guideTabId, asTab('other')] }
    expect(() => onlyTabId(two)).toThrow(/exactly one tab/)
  })

  it('name the first and the top-right docked pane however the tree is divided', () => {
    const { state, minter, paneId } = fixture()
    expect(firstDockPaneId(state)).toBe(paneId)
    expect(topRightPaneId(state)).toBe(paneId)
    const right = split(state, minter, paneId)
    const below = split(right.state, minter, right.newPaneId, 'column')
    expect(firstDockPaneId(below.state)).toBe(paneId)
    expect(topRightPaneId(below.state)).toBe(right.newPaneId)
    const above = split(below.state, minter, paneId, 'column', 'before')
    expect(firstDockPaneId(above.state)).toBe(above.newPaneId)
  })

  it('normalize sizes without drifting an exact sum, and refuse a zero total', () => {
    const exact = [0.25, 0.75]
    expect(normalizeSizes(exact)).toEqual(exact)
    expect(normalizeSizes(exact)).not.toBe(exact)
    expect(normalizeSizes([1, 3])).toEqual([0.25, 0.75])
    expect(() => normalizeSizes([0, 0])).toThrow(/sum above zero/)
  })

  it('assertNever names the value a closed switch failed to handle', () => {
    expect(() => { assertNever('nope' as never, 'layout: thing') }).toThrow('layout: thing: unhandled "nope"')
  })
})

describe('operations refuse', () => {
  /** A second docked pane plus a floating one holding a content tab. */
  function mixed(): {
    state: LayoutState
    minter: IdMinter
    paneId: PaneId
    secondPaneId: PaneId
    floatId: PaneId
    guideTabId: TabId
    floatTabId: TabId
  } {
    const { state, minter, paneId, guideTabId } = fixture()
    const second = split(state, minter, paneId)
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const opened = applyOp(second.state, { type: 'openTab', paneId, tab, index: 1 }).state
    const floatId = minter.next('float')
    const floated = applyOp(opened, {
      type: 'float', tabId: tab.id, newPaneId: floatId, rect: { x: 0, y: 0, width: 100, height: 100 },
    }).state
    return { state: floated, minter, paneId, secondPaneId: second.newPaneId, floatId, guideTabId, floatTabId: tab.id }
  }

  it('opening or inserting a tab into a floating pane', () => {
    const { state, minter, floatId } = mixed()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/b.txt', 'b.txt')
    expect(() => applyOp(state, { type: 'openTab', paneId: floatId, tab, index: 0 })).toThrow(/docked pane/)
    expect(() => applyOp(state, { type: 'insertTab', paneId: floatId, tab, index: 0 })).toThrow(/docked pane/)
  })

  it('moving a tab out of or into a floating pane, which is what unfloat and float are for', () => {
    const { state, paneId, floatId, guideTabId, floatTabId } = mixed()
    expect(() => applyOp(state, { type: 'moveTab', tabId: floatTabId, toPaneId: paneId, index: 0 })).toThrow(/use unfloat/)
    expect(() => applyOp(state, { type: 'moveTab', tabId: guideTabId, toPaneId: floatId, index: 0 })).toThrow(/target must be docked/)
  })

  it('returning a floating tab anywhere but a docked pane, and treating a docked pane as floating', () => {
    const { state, minter, paneId, floatId, guideTabId } = mixed()
    const otherFloat = minter.next('float')
    const twoFloats = applyOp(state, {
      type: 'float', tabId: guideTabId, newPaneId: otherFloat, rect: { x: 5, y: 5, width: 100, height: 100 },
    }).state
    expect(() => applyOp(twoFloats, { type: 'unfloat', paneId: floatId, toPaneId: otherFloat, index: 0 }))
      .toThrow(/target must be docked/)
    expect(() => applyOp(state, { type: 'unfloat', paneId, toPaneId: paneId, index: 0 })).toThrow(/is not floating/)
    expect(() => applyOp(state, { type: 'moveFloat', paneId, x: 1, y: 1 })).toThrow(/is not floating/)
    expect(() => applyOp(state, { type: 'resizeFloat', paneId, rect: { x: 0, y: 0, width: 10, height: 10 } }))
      .toThrow(/is not floating/)
  })

  it('creating a node under an id that is already taken', () => {
    const { state, minter, paneId, secondPaneId } = mixed()
    expect(() => applyOp(state, {
      type: 'split', paneId, axis: 'column', direction: 'after', newPaneId: secondPaneId, newSplitId: minter.next('split'),
    })).toThrow(/already exists/)
    expect(() => applyOp(state, {
      type: 'split', paneId, axis: 'column', direction: 'after', newPaneId: minter.next('pane'), newSplitId: asSplit(state.rootId),
    })).toThrow(/already exists/)
  })

  it('putting a pane back with records that do not match the pane or the split', () => {
    const { state, minter, paneId, secondPaneId, floatId } = mixed()
    const pane = getPane(state, secondPaneId)
    const stray = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/c.txt', 'c.txt')
    const fresh: PaneNode = { ...pane, id: minter.next('pane') }
    const parent = getSplit(state, state.rootId)
    expect(() => applyOp(state, {
      type: 'insertPane', pane, tabs: [], attach: { mode: 'child', parentId: parent.id, index: 1, sizes: parent.sizes },
    })).toThrow(/already exists/)
    expect(() => applyOp(state, {
      type: 'insertPane', pane: fresh, tabs: [stray], attach: { mode: 'child', parentId: parent.id, index: 1, sizes: parent.sizes },
    })).toThrow(/do not match the pane/)
    expect(() => applyOp(state, {
      type: 'insertPane', pane: fresh, tabs: [], attach: { mode: 'child', parentId: parent.id, index: 1, sizes: parent.sizes },
    })).toThrow(/sizes do not match the split/)
    expect(() => applyOp(state, {
      type: 'insertPane', pane: fresh, tabs: [], attach: { mode: 'wrap', targetId: paneId, split: parent },
    })).toThrow(/does not list the pane/)
    expect(() => applyOp(state, {
      type: 'insertPane', pane: fresh, tabs: [], attach: { mode: 'float', index: 0 },
    })).toThrow(/requires a floating pane/)
    expect(floatId).toBeDefined()
  })

  it('restoring focus facts that name a docked pane as floating or an unknown pane', () => {
    const { state, paneId } = mixed()
    expect(() => applyOp(state, { type: 'restoreFocus', activePaneId: paneId, floats: [paneId], paneActiveTabs: {} }))
      .toThrow(/as floating/)
    expect(() => applyOp(state, { type: 'restoreFocus', activePaneId: paneId, floats: [], paneActiveTabs: { [asPane('nope')]: undefined } }))
      .toThrow(/unknown node/)
  })
})

describe('inverses the engine itself never records', () => {
  it('refuse to return a docked pane with tab records: closeTab records those through insertTab', () => {
    const { state, minter, paneId } = fixture()
    const after = split(state, minter, paneId)
    const parent = getSplit(after.state, after.state.rootId)
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const pane: PaneNode = { kind: 'pane', id: minter.next('pane'), host: 'dock', tabs: [tab.id], activeTabId: tab.id, rect: undefined }
    expect(() => applyOp(after.state, {
      type: 'insertPane', pane, tabs: [tab], attach: { mode: 'child', parentId: parent.id, index: 2, sizes: [0.25, 0.25, 0.5] },
    })).toThrow(/returns a docked pane empty/)
  })

  it('merge away an empty floating pane and restore it at its z position', () => {
    const { state, minter } = fixture()
    const pane: PaneNode = {
      kind: 'pane', id: minter.next('float'), host: 'float', tabs: [], activeTabId: undefined, rect: { x: 1, y: 2, width: 50, height: 40 },
    }
    const inserted = expectRoundTrip(state, { type: 'insertPane', pane, tabs: [], attach: { mode: 'float', index: 0 } })
    expect(inserted.floats).toEqual([pane.id])
    const merged = expectRoundTrip(inserted, { type: 'merge', paneId: pane.id })
    expect(merged.floats).toEqual([])
    expect(merged.nodes[pane.id]).toBeUndefined()
  })
})

describe('replay', () => {
  it('rebuilds the same tree from the recorded operations', () => {
    const { state, minter, paneId, guideTabId } = fixture()
    const preview = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const secondPaneId = minter.next('pane')
    const floatId = minter.next('float')
    const ops: LayoutOp[] = [
      { type: 'setExpanded', expanded: true },
      { type: 'openTab', paneId, tab: preview, index: 1 },
      { type: 'split', paneId, axis: 'row', direction: 'after', newPaneId: secondPaneId, newSplitId: minter.next('split') },
      { type: 'moveTab', tabId: preview.id, toPaneId: secondPaneId, index: 0 },
      { type: 'focusTab', tabId: guideTabId },
      { type: 'float', tabId: preview.id, newPaneId: floatId, rect: { x: 10, y: 20, width: 200, height: 150 } },
      { type: 'moveFloat', paneId: floatId, x: 60, y: 70 },
    ]
    const direct = ops.reduce((current, op) => applyOp(current, op).state, state)
    expect(replay(state, ops)).toEqual(direct)
    expect(replay(state, ops)).toEqual(replay(state, ops))
    expect(findTabPane(direct, preview.id).id).toBe(floatId)
  })
})
