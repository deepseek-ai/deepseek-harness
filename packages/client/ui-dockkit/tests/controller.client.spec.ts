/**
 * Controller behavior: the interaction vocabulary the UI calls, including tab
 * identity (focus an existing tab, or open an explicit copy), the guide tab a
 * split seats, drop resolution, floating, and the notification contract.
 */
import { describe, expect, it } from 'vitest'
import { DockController } from '../src/engine/controller.ts'
import { dockPaneCount, FLOAT_DEFAULT_SIZE } from '../src/engine/constraints.ts'
import { SEED_CONTENT_ID, childAt, firstTab, seededController } from './fixtures.client.ts'
import { dockPaneIds, findTabPane, getPane, getSplit } from '../src/engine/tree.ts'
import type { LayoutState, PaneId } from '../src/contract/types.ts'

/** Tab titles of one pane, in strip order. */
function titles(state: LayoutState, paneId: PaneId): string[] {
  return getPane(state, paneId).tabs.map(id => state.tabs[id]?.title ?? '?')
}

/** A controller expanded once, with its first pane id. */
function expanded(): { controller: DockController; paneId: PaneId } {
  const controller = seededController()
  controller.setExpanded(true)
  const { state } = controller.getSnapshot()
  return { controller, paneId: getPane(state, state.rootId).id }
}

describe('expand', () => {
  it('starts collapsed with a guide tab already seated', () => {
    const controller = seededController()
    const snapshot = controller.getSnapshot()
    expect(snapshot.state.expanded).toBe(false)
    expect(snapshot.canUndo).toBe(false)
    expect(snapshot.canSplit).toBe(true)
    expect(titles(snapshot.state, getPane(snapshot.state, snapshot.state.rootId).id)).toHaveLength(1)
    const guide = Object.values(snapshot.state.tabs)[0]
    expect(guide?.contentId).toBe(SEED_CONTENT_ID)
  })

  it('records a toggle and ignores a redundant set', () => {
    const controller = seededController()
    controller.toggleExpanded()
    expect(controller.getSnapshot().state.expanded).toBe(true)
    expect(controller.ops).toHaveLength(1)
    controller.setExpanded(true)
    expect(controller.ops).toHaveLength(1)
    controller.toggleExpanded()
    expect(controller.getSnapshot().state.expanded).toBe(false)
    expect(controller.ops).toHaveLength(2)
  })
})

describe('presentation', () => {
  it('records a mode switch once and ignores a redundant one', () => {
    const controller = seededController()
    controller.setMode('fullscreen')
    expect(controller.getSnapshot().state.mode).toBe('fullscreen')
    controller.setMode('fullscreen')
    expect(controller.ops.map(op => op.type)).toEqual(['setMode'])
  })
})

describe('splitting', () => {
  it('splits the active pane to the right and seats a guide tab there', () => {
    const { controller, paneId } = expanded()
    expect(controller.splitPane()).toBe(true)
    const state = controller.getSnapshot().state
    const root = getSplit(state, state.rootId)
    expect(root.axis).toBe('row')
    const newPaneId = getPane(state, childAt(root, 1)).id
    expect(newPaneId).not.toBe(paneId)
    expect(titles(state, newPaneId)).toHaveLength(1)
    expect(state.tabs[firstTab(getPane(state, newPaneId))]?.contentId).toBe(SEED_CONTENT_ID)
    expect(controller.ops.map(op => op.type)).toEqual(['setExpanded', 'split', 'openTab'])
  })

  it('seats the pane factory\'s tab at the end of a strip from the add control, and nothing without one', () => {
    const { controller, paneId } = expanded()
    expect(controller.addTab(paneId)).toBe(true)
    expect(titles(controller.getSnapshot().state, paneId)).toEqual(['Start', 'Start'])
    const bare = new DockController({ makeInitialTab: id => ({ id, kind: 'seed', contentId: SEED_CONTENT_ID, title: 'Start' }) })
    expect(bare.addTab(getPane(bare.getSnapshot().state, bare.getSnapshot().state.rootId).id)).toBe(false)
  })

  it('names the pane a new tab lands in: the active pane, or the first docked one while a panel floats', () => {
    const { controller, paneId } = expanded()
    expect(controller.activeDockPaneId()).toBe(paneId)
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const floatId = controller.floatTab(tabId)
    expect(controller.getSnapshot().state.activePaneId).toBe(floatId)
    expect(controller.activeDockPaneId()).toBe(paneId)
  })

  it('stops at four panes without recording anything', () => {
    const { controller } = expanded()
    expect(controller.splitPane()).toBe(true)
    expect(controller.splitPane()).toBe(true)
    expect(controller.splitPane()).toBe(true)
    expect(dockPaneCount(controller.getSnapshot().state)).toBe(4)
    const before = controller.ops.length
    expect(controller.splitPane()).toBe(false)
    expect(controller.ops).toHaveLength(before)
    expect(controller.getSnapshot().canSplit).toBe(false)
  })
})

describe('tab identity', () => {
  it('focuses the existing tab when the same content is opened twice', () => {
    const { controller, paneId } = expanded()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    controller.splitPane()
    const again = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    expect(again).toBe(first)
    const state = controller.getSnapshot().state
    expect(getPane(state, paneId).activeTabId).toBe(first)
    expect(state.activePaneId).toBe(paneId)
    expect(Object.values(state.tabs).filter(tab => tab.contentId === 'dsh-resource://file/session/s/a.txt')).toHaveLength(1)
  })

  it('opens an explicit second copy beside the original', () => {
    const { controller, paneId } = expanded()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const copy = controller.duplicateTab(first)
    expect(copy).not.toBe(first)
    const state = controller.getSnapshot().state
    expect(state.tabs[copy]?.contentId).toBe('dsh-resource://file/session/s/a.txt')
    expect(getPane(state, paneId).tabs.indexOf(copy)).toBe(getPane(state, paneId).tabs.indexOf(first) + 1)
  })

  it('closes a tab and leaves the pane in place', () => {
    const { controller, paneId } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    controller.closeTab(tabId)
    const state = controller.getSnapshot().state
    expect(state.tabs[tabId]).toBeUndefined()
    expect(dockPaneIds(state)).toEqual([paneId])
  })
})

describe('drops', () => {
  it('moves a tab into the pane under the pointer', () => {
    const { controller, paneId } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    controller.splitPane()
    const target = getSplit(controller.getSnapshot().state, controller.getSnapshot().state.rootId).children[1]
    if (target === undefined) throw new Error('expected a second pane')
    expect(controller.dropTab(tabId, getPane(controller.getSnapshot().state, target).id, 'center')).toBe(true)
    const state = controller.getSnapshot().state
    expect(getPane(state, target).tabs).toContain(tabId)
    expect(getPane(state, paneId).tabs).not.toContain(tabId)
    expect(state.activePaneId).toBe(target)
  })

  it('rejects a centre drop on the tab own pane', () => {
    const { controller, paneId } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const before = controller.ops.length
    expect(controller.dropTab(tabId, paneId, 'center')).toBe(false)
    expect(controller.ops).toHaveLength(before)
  })

  it('splits on an edge drop and lands the tab in the new pane', () => {
    const { controller, paneId } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    expect(controller.dropTab(tabId, paneId, 'bottom')).toBe(true)
    const state = controller.getSnapshot().state
    const root = getSplit(state, state.rootId)
    expect(root.axis).toBe('column')
    const created = root.children[1]
    if (created === undefined) throw new Error('expected a split child')
    expect(getPane(state, created).tabs).toEqual([tabId])
    expect(dockPaneCount(state)).toBe(2)
  })

  it('refuses an edge drop once the grid is full', () => {
    const { controller, paneId } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    controller.splitPane()
    controller.splitPane()
    controller.splitPane()
    const before = controller.ops.length
    expect(controller.dropTab(tabId, paneId, 'right')).toBe(false)
    expect(controller.ops).toHaveLength(before)
  })

  it('reorders inside one pane', () => {
    const { controller, paneId } = expanded()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    controller.reorderTab(first, 0)
    expect(getPane(controller.getSnapshot().state, paneId).tabs[0]).toBe(first)
  })
})

describe('explicit tab placement', () => {
  it('reorders when the slot is in the tab own pane', () => {
    const { controller, paneId } = expanded()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    expect(controller.placeTab(first, paneId, 0)).toBe(true)
    expect(getPane(controller.getSnapshot().state, paneId).tabs[0]).toBe(first)
    expect(controller.ops.at(-1)?.type).toBe('reorderTab')
  })

  it('reports no change when the slot is where the tab already sits', () => {
    const { controller, paneId } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const index = getPane(controller.getSnapshot().state, paneId).tabs.indexOf(tabId)
    const before = controller.ops.length
    expect(controller.placeTab(tabId, paneId, index)).toBe(false)
    expect(controller.ops).toHaveLength(before)
  })

  it('moves across panes into the requested slot', () => {
    const { controller, paneId } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    controller.splitPane()
    const target = getSplit(controller.getSnapshot().state, controller.getSnapshot().state.rootId).children[1]
    if (target === undefined) throw new Error('expected a second pane')
    expect(controller.placeTab(tabId, getPane(controller.getSnapshot().state, target).id, 0)).toBe(true)
    const state = controller.getSnapshot().state
    expect(getPane(state, target).tabs[0]).toBe(tabId)
    expect(getPane(state, paneId).tabs).not.toContain(tabId)
  })

  it('returns a floating tab when placed into a docked strip', () => {
    const { controller, paneId } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const floatId = controller.floatTab(tabId)
    expect(controller.placeTab(tabId, paneId, 0)).toBe(true)
    const state = controller.getSnapshot().state
    expect(state.floats).toEqual([])
    expect(state.nodes[floatId]).toBeUndefined()
    expect(getPane(state, paneId).tabs[0]).toBe(tabId)
  })

  it('refuses a floating pane as the destination', () => {
    const { controller } = expanded()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const second = controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'text-preview' })
    const floatId = controller.floatTab(first)
    const before = controller.ops.length
    expect(controller.placeTab(second, floatId, 0)).toBe(false)
    expect(controller.ops).toHaveLength(before)
  })
})

describe('floating', () => {
  it('takes a tab out and cascades each new panel', () => {
    const { controller, paneId } = expanded()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const second = controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'text-preview' })
    const firstFloat = controller.floatTab(first)
    const secondFloat = controller.floatTab(second)
    const state = controller.getSnapshot().state
    expect(state.floats).toEqual([firstFloat, secondFloat])
    const one = getPane(state, firstFloat)
    const two = getPane(state, secondFloat)
    expect(one.rect?.width).toBe(FLOAT_DEFAULT_SIZE.width)
    expect(two.rect?.x).toBeGreaterThan(one.rect?.x ?? 0)
    expect(getPane(state, paneId).tabs).toHaveLength(1)
  })

  it('is unaffected by collapsing the column', () => {
    const { controller } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const floatId = controller.floatTab(tabId)
    controller.setExpanded(false)
    const state = controller.getSnapshot().state
    expect(state.expanded).toBe(false)
    expect(state.floats).toEqual([floatId])
    expect(getPane(state, floatId).tabs).toEqual([tabId])
  })

  it('sends a floating panel back into the grid', () => {
    const { controller, paneId } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const floatId = controller.floatTab(tabId)
    controller.unfloatPane(floatId)
    const state = controller.getSnapshot().state
    expect(state.floats).toEqual([])
    expect(findTabPane(state, tabId).id).toBe(paneId)
  })

  it('treats a centre drop from a floating panel as a return', () => {
    const { controller, paneId } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const floatId = controller.floatTab(tabId)
    expect(controller.dropTab(tabId, paneId, 'center')).toBe(true)
    const state = controller.getSnapshot().state
    expect(state.floats).toEqual([])
    expect(state.nodes[floatId]).toBeUndefined()
    expect(findTabPane(state, tabId).id).toBe(paneId)
  })

  it('records net drag and resize results', () => {
    const { controller } = expanded()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const floatId = controller.floatTab(tabId)
    controller.moveFloat(floatId, 300, 210)
    controller.resizeFloat(floatId, { x: 300, y: 210, width: 500, height: 400 })
    expect(getPane(controller.getSnapshot().state, floatId).rect)
      .toEqual({ x: 300, y: 210, width: 500, height: 400 })
    expect(controller.ops.map(op => op.type).slice(-2)).toEqual(['moveFloat', 'resizeFloat'])
  })

  it('raises a panel to the top when focused', () => {
    const { controller } = expanded()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'text-preview' })
    const second = controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'text-preview' })
    const firstFloat = controller.floatTab(first)
    const secondFloat = controller.floatTab(second)
    controller.focusPane(firstFloat)
    expect(controller.getSnapshot().state.floats).toEqual([secondFloat, firstFloat])
  })
})

describe('dividers', () => {
  it('clamps a drag that would starve a pane', () => {
    const { controller } = expanded()
    controller.splitPane()
    const splitId = getSplit(controller.getSnapshot().state, controller.getSnapshot().state.rootId).id
    controller.resizeSplit(splitId, [0.01, 0.99])
    const sizes = getSplit(controller.getSnapshot().state, splitId).sizes
    expect(sizes[0]).toBeGreaterThan(0.05)
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1)
  })
})

describe('notification', () => {
  it('notifies subscribers and keeps the snapshot stable between changes', () => {
    const controller = seededController()
    let notifications = 0
    const dispose = controller.subscribe(() => { notifications += 1 })
    const before = controller.getSnapshot()
    expect(controller.getSnapshot()).toBe(before)

    controller.setExpanded(true)
    expect(notifications).toBe(1)
    expect(controller.getSnapshot()).not.toBe(before)

    controller.setExpanded(true)
    expect(notifications).toBe(1)

    dispose()
    controller.setExpanded(false)
    expect(notifications).toBe(1)
  })

  it('steps one compound command as one entry, however many operations it recorded', () => {
    expect(seededController().undo()).toBe(false)
    const { controller } = expanded()
    const before = controller.ops.length
    controller.splitPane()
    // The split and the seeded tab are two operations of one intent.
    expect(controller.ops.length - before).toBe(2)
    expect(controller.getSnapshot().canUndo).toBe(true)
    expect(controller.undo()).toBe(true)
    expect(dockPaneCount(controller.getSnapshot().state)).toBe(1)
    expect(controller.redo()).toBe(true)
    expect(dockPaneCount(controller.getSnapshot().state)).toBe(2)
    expect(controller.redo()).toBe(false)
  })
})
