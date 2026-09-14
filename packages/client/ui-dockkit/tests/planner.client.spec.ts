/**
 * The two properties the intent layer must not lose in refactoring.
 *
 * Determinism: a planner reads only the state and the minter it is handed, so the
 * same inputs plan the same operations and replay stays exact. Nothing here may
 * reach a clock or a random source.
 *
 * One undo behaviour: focus-run merging and redo-branch discarding live in the
 * pure history functions, so the stateful `Sequencer` embedding and an embedder
 * driving `record`/`stepBack` directly cannot drift apart.
 */
import { describe, expect, it } from 'vitest'
import { applyOp } from '../src/engine/operations.ts'
import { DockController } from '../src/engine/controller.ts'
import { createIdMinter, createInitialState } from '../src/engine/initial.ts'
import {
  activeDockPaneId, findContentTab, findPaneContentTab, planDropTab, planDuplicateTab, planFloatTab, planOpenContent,
  planPlaceTab, planSetExpanded, planSetMode, planSettle, planSplitPane, planUnfloatPane, planAddTab,
} from '../src/engine/planner.ts'
import {
  EMPTY_HISTORY, record, recordedOps, stepBack, stepForward, type History,
} from '../src/engine/sequence.ts'
import { dockPaneIds, findTabPane, getPane, getSplit } from '../src/engine/tree.ts'
import type { LayoutOp, LayoutState, PaneId, TabId } from '../src/contract/types.ts'
import type { Mint } from '../src/engine/planner.ts'
import { asTab, fileTab, firstTab, seedTab, seededState } from './fixtures.client.ts'

/** A deep snapshot, for proving a planner left its input alone. */
function frozen(state: LayoutState): string {
  return JSON.stringify(state)
}

/** Apply a plan the way any embedder does, and return the resulting state. */
function applyAll(state: LayoutState, ops: readonly LayoutOp[]): LayoutState {
  return ops.reduce((current, op) => applyOp(current, op).state, state)
}

describe('planner determinism', () => {
  it('plans the same operations from the same state and a fresh minter', () => {
    const first = seededState()
    const second = seededState()
    const planOne = planSplitPane(first.state, first.minter.next, undefined, seedTab)
    const planTwo = planSplitPane(second.state, second.minter.next, undefined, seedTab)
    expect(planOne).toEqual(planTwo)
    expect(planOne.length).toBeGreaterThan(0)
  })

  it('leaves the state it was handed untouched', () => {
    const { state, minter } = seededState()
    const before = frozen(state)
    const mint = minter.next

    planSetExpanded(state, true)
    planSplitPane(state, mint, undefined, seedTab)
    planOpenContent(state, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    planFloatTab(state, mint, firstTab(getPane(state, state.rootId)))
    expect(frozen(state)).toBe(before)
  })

  it('plans nothing for an intent that changes nothing', () => {
    const { state, minter } = seededState()
    const mint = minter.next
    const tabId = getPane(state, state.rootId).tabs[0]
    if (tabId === undefined) throw new Error('fixture: seeded tab missing')

    // Already collapsed; already in that mode; already in that slot; centre
    // release on its own pane.
    expect(planSetExpanded(state, false)).toEqual([])
    expect(planSetMode(state, 'push')).toEqual([])
    expect(planSetMode(state, 'fullscreen')).toEqual([{ type: 'setMode', mode: 'fullscreen' }])
    expect(planPlaceTab(state, tabId, getPane(state, state.rootId).id, 0)).toEqual([])
    expect(planDropTab(state, mint, tabId, getPane(state, state.rootId).id, 'center')).toEqual([])
  })

  it('refuses to plan past the pane budget', () => {
    const seeded = seededState()
    let { state } = seeded
    const { minter } = seeded
    const mint = minter.next
    for (let index = 0; index < 3; index += 1) {
      state = applyAll(state, planSplitPane(state, mint, state.activePaneId, seedTab))
    }
    expect(planSplitPane(state, mint, state.activePaneId, seedTab)).toEqual([])
    // The root is a split once panes exist, so address a real pane.
    const firstPane = dockPaneIds(state)[0]
    if (firstPane === undefined) throw new Error('fixture: no docked pane')
    const tabId = getPane(state, firstPane).tabs[0]
    if (tabId === undefined) throw new Error('fixture: seeded tab missing')
    expect(planDropTab(state, mint, tabId, firstPane, 'right')).toEqual([])
  })
})

describe('planPlaceTab', () => {
  /** One docked pane holding three tabs, in strip order. */
  function threeTabs(): { state: LayoutState; paneId: PaneId; tabs: readonly [TabId, TabId, TabId] } {
    const { state, minter } = seededState()
    const mint = minter.next
    const paneId = getPane(state, state.rootId).id
    const b = planOpenContent(state, mint, { contentId: 'dsh-resource://file/session/s/b.txt', title: 'b', kind: 'file' })
    const withB = applyAll(state, b.ops)
    const c = planOpenContent(withB, mint, { contentId: 'dsh-resource://file/session/s/c.txt', title: 'c', kind: 'file' })
    const withC = applyAll(withB, c.ops)
    const a = getPane(withC, paneId).tabs[0]
    if (a === undefined) throw new Error('fixture: seeded tab missing')
    return { state: withC, paneId, tabs: [a, b.tabId, c.tabId] }
  }

  /** Strip order after placing `tabId` at caret slot `index` in its own pane. */
  function after(tabId: TabId, index: number): readonly TabId[] {
    const { state, paneId } = threeTabs()
    return getPane(applyAll(state, planPlaceTab(state, tabId, paneId, index)), paneId).tabs
  }

  it('reads the slot as the caret over the strip as drawn, the dragged chip included', () => {
    const { tabs: [a, b, c] } = threeTabs()
    // Rightward: the caret between b and c is slot 2, and a lands between them.
    expect(after(a, 2)).toEqual([b, a, c])
    expect(after(a, 3)).toEqual([b, c, a])
    // Leftward: the chip sits after the caret, so the slot is the final index.
    expect(after(c, 0)).toEqual([c, a, b])
    expect(after(c, 1)).toEqual([a, c, b])
  })

  it('plans nothing for the slot on either side of the dragged chip', () => {
    const { state, paneId, tabs: [a, b, c] } = threeTabs()
    expect(planPlaceTab(state, a, paneId, 0)).toEqual([])
    expect(planPlaceTab(state, a, paneId, 1)).toEqual([])
    expect(planPlaceTab(state, b, paneId, 1)).toEqual([])
    expect(planPlaceTab(state, b, paneId, 2)).toEqual([])
    expect(planPlaceTab(state, c, paneId, 2)).toEqual([])
    expect(planPlaceTab(state, c, paneId, 3)).toEqual([])
  })
})

describe('planDropTab on the tab\'s own pane', () => {
  it('plans nothing for a pane\'s only tab released on any of its own edges without a factory', () => {
    const { state, minter } = seededState()
    const mint = minter.next
    const tabId = getPane(state, state.rootId).tabs[0]
    if (tabId === undefined) throw new Error('fixture: seeded tab missing')
    for (const zone of ['left', 'right', 'top', 'bottom'] as const) {
      expect(planDropTab(state, mint, tabId, getPane(state, state.rootId).id, zone)).toEqual([])
    }
  })

  it('splits on a sole tab\'s own edge when a factory backfills the pane it vacates', () => {
    const { state, minter } = seededState()
    const mint = minter.next
    const paneId = getPane(state, state.rootId).id
    const tabId = getPane(state, paneId).tabs[0]
    if (tabId === undefined) throw new Error('fixture: seeded tab missing')
    const ops = planDropTab(state, mint, tabId, paneId, 'right', seedTab)
    expect(ops.map(op => op.type)).toEqual(['split', 'openTab', 'moveTab'])
    const split = applyAll(state, ops)
    const [home, destination] = dockPaneIds(split)
    if (home === undefined || destination === undefined) throw new Error('expected two panes')
    expect(getPane(split, home).tabs).toHaveLength(1)
    expect(getPane(split, home).tabs[0]).not.toBe(tabId)
    expect(getPane(split, destination).tabs).toEqual([tabId])
    // The backfill seats first, so the moved tab ends focused.
    expect(split.activePaneId).toBe(destination)
  })

  it('splits without a backfill when the pane keeps another tab, factory or not', () => {
    const { state, minter } = seededState()
    const mint = minter.next
    const opened = planOpenContent(state, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const two = applyAll(state, opened.ops)
    const target = getPane(two, two.rootId).id
    expect(planDropTab(two, mint, opened.tabId, target, 'right')
      .map(op => op.type)).toEqual(['split', 'moveTab'])
    const ops = planDropTab(two, mint, opened.tabId, target, 'right', seedTab)
    expect(ops.map(op => op.type)).toEqual(['split', 'moveTab'])
    const split = applyAll(two, ops)
    expect(dockPaneIds(split)).toHaveLength(2)
    expect(getPane(split, two.rootId).tabs).toHaveLength(1)
  })
})

describe('floating panes as planner arguments', () => {
  /** A docked pane holding the seed, plus one content tab floated out of it. */
  function withFloat(): { state: LayoutState; mint: Mint; floatId: PaneId; tabId: TabId } {
    const { state, minter } = seededState()
    const mint = minter.next
    const opened = planOpenContent(state, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const docked = applyAll(state, opened.ops)
    const floated = planFloatTab(docked, mint, opened.tabId)
    return { state: applyAll(docked, floated.ops), mint, floatId: floated.paneId, tabId: opened.tabId }
  }

  it('plans nothing into a floating pane: no split, no seeded tab, no drop', () => {
    const { state, mint, floatId } = withFloat()
    expect(planSplitPane(state, mint, floatId, seedTab)).toEqual([])
    expect(planAddTab(state, mint, floatId, seedTab)).toEqual([])
    const seeded = getPane(state, state.rootId).tabs[0]
    if (seeded === undefined) throw new Error('fixture: seeded tab missing')
    expect(planDropTab(state, mint, seeded, floatId, 'center')).toEqual([])
  })

  it('copies a floating tab into the active docked pane, at its end', () => {
    const { state, mint, tabId } = withFloat()
    expect(state.activePaneId).not.toBe(state.rootId)
    expect(activeDockPaneId(state)).toBe(state.rootId)
    const copy = planDuplicateTab(state, mint, tabId)
    expect(copy.ops[0]).toMatchObject({ type: 'openTab', paneId: state.rootId, index: 1 })
    expect(getPane(applyAll(state, copy.ops), state.rootId).tabs.at(-1)).toBe(copy.tabId)
  })
})

describe('planSettle', () => {
  /** Two seeded docked panes side by side. */
  function twoPanes(): { state: LayoutState; mint: Mint; left: PaneId; right: PaneId } {
    const { state, minter } = seededState()
    const mint = minter.next
    const split = applyAll(state, planSplitPane(state, mint, undefined, seedTab))
    const [left, right] = dockPaneIds(split)
    if (left === undefined || right === undefined) throw new Error('fixture: expected two panes')
    return { state: split, mint, left, right }
  }

  it('plans nothing while every docked pane holds a tab', () => {
    const { state, mint } = twoPanes()
    expect(planSettle(state, mint, seedTab)).toEqual([])
  })

  it('merges away each pane an intent emptied, one after another', () => {
    const { state, mint, left, right } = twoPanes()
    const third = applyAll(state, planSplitPane(state, mint, right, seedTab))
    const emptied = dockPaneIds(third).flatMap(id => getPane(third, id).tabs)
      .filter(tabId => findTabPane(third, tabId).id !== left)
      .reduce((current, tabId) => applyAll(current, [{ type: 'closeTab', tabId }]), third)
    const ops = planSettle(emptied, mint, seedTab)
    expect(ops.map(op => op.type)).toEqual(['merge', 'merge'])
    expect(dockPaneIds(applyAll(emptied, ops))).toEqual([left])
  })

  it('reseeds an emptied root pane through the factory, and leaves it empty without one', () => {
    const { state, minter } = seededState()
    const mint = minter.next
    const tabId = getPane(state, state.rootId).tabs[0]
    if (tabId === undefined) throw new Error('fixture: seeded tab missing')
    const emptied = applyAll(state, [{ type: 'closeTab', tabId }])
    const reseeded = planSettle(emptied, mint, seedTab)
    expect(reseeded.map(op => op.type)).toEqual(['openTab'])
    expect(getPane(applyAll(emptied, reseeded), emptied.rootId).tabs).toHaveLength(1)
    expect(planSettle(emptied, mint)).toEqual([])
  })
})

describe('planOpenContent placement and identity', () => {
  it('identifies content by (kind, contentId): the same address under another kind opens another tab', () => {
    const { state, minter } = seededState()
    const mint = minter.next
    const first = planOpenContent(state, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const opened = applyAll(state, first.ops)
    expect(findContentTab(opened, 'dsh-resource://file/session/s/a.txt')).toBe(first.tabId)
    expect(findContentTab(opened, 'dsh-resource://file/session/s/a.txt', 'file')).toBe(first.tabId)
    expect(findContentTab(opened, 'dsh-resource://file/session/s/a.txt', 'hex')).toBeUndefined()
    // The pane-level lookup answers for one pane only.
    const [pane] = dockPaneIds(opened)
    if (pane === undefined) throw new Error('expected a docked pane')
    expect(findPaneContentTab(opened, pane, 'dsh-resource://file/session/s/a.txt')).toBe(first.tabId)
    expect(findPaneContentTab(opened, pane, 'dsh-resource://file/session/s/a.txt', 'hex')).toBeUndefined()
    expect(findPaneContentTab(opened, pane, 'dsh-resource://file/session/s/nowhere.txt')).toBeUndefined()
    const again = planOpenContent(opened, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    expect(again.ops.map(op => op.type)).toEqual(['focusTab'])
    const other = planOpenContent(opened, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'hex' })
    expect(other.ops.map(op => op.type)).toEqual(['openTab'])
  })

  it('opens another tab when told not to reveal the existing one', () => {
    const { state, minter } = seededState()
    const mint = minter.next
    const opened = applyAll(state, planOpenContent(state, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' }).ops)
    const copy = planOpenContent(opened, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file', revealIfOpened: false })
    expect(copy.ops.map(op => op.type)).toEqual(['openTab'])
    const both = applyAll(opened, copy.ops)
    expect(Object.values(both.tabs).filter(tab => tab.contentId === 'dsh-resource://file/session/s/a.txt')).toHaveLength(2)
  })

  it('seats a new tab at an explicit strip slot', () => {
    const { state, minter } = seededState()
    const mint = minter.next
    const paneId = getPane(state, state.rootId).id
    const planned = planOpenContent(state, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file', paneId, index: 0 })
    expect(planned.ops[0]).toMatchObject({ type: 'openTab', paneId, index: 0 })
    expect(getPane(applyAll(state, planned.ops), paneId).tabs[0]).toBe(planned.tabId)
  })
})

describe('planAddTab', () => {
  it('seats the factory\'s tab at the end of the pane, and plans nothing without a factory', () => {
    const { state, minter } = seededState()
    const mint = minter.next
    const paneId = getPane(state, state.rootId).id
    const ops = planAddTab(state, mint, paneId, seedTab)
    expect(ops.map(op => op.type)).toEqual(['openTab'])
    expect(ops[0]).toMatchObject({ paneId, index: getPane(state, paneId).tabs.length })
    expect(planAddTab(state, mint, paneId)).toEqual([])
  })
})

describe('one undo behaviour across both embeddings', () => {
  /** Drive a script of intents through the pure history functions. */
  function driveByHand(): { history: History; state: LayoutState } {
    const minter = createIdMinter()
    const mint = minter.next
    let state = createInitialState(minter, seedTab)
    let history = EMPTY_HISTORY
    const run = (ops: readonly LayoutOp[]): void => {
      const stepped = record(history, state, ops)
      history = stepped.history
      state = stepped.state
    }
    run(planSetExpanded(state, true))
    run(planSplitPane(state, mint, undefined, seedTab))
    const opened = planOpenContent(state, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    run(opened.ops)
    const copy = planDuplicateTab(state, mint, opened.tabId)
    run(copy.ops)
    run([{ type: 'focusTab', tabId: opened.tabId }])
    run([{ type: 'focusTab', tabId: copy.tabId }])
    run([{ type: 'focusTab', tabId: opened.tabId }])
    return { history, state }
  }

  /** The same script through the stateful embedding. */
  function driveByController(): DockController {
    const controller = new DockController({ makeInitialTab: seedTab, makePaneTab: seedTab })
    controller.setExpanded(true)
    controller.splitPane()
    const opened = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const copy = controller.duplicateTab(opened)
    controller.focusTab(opened)
    controller.focusTab(copy)
    controller.focusTab(opened)
    return controller
  }

  it('records the same sequence either way', () => {
    const byHand = driveByHand()
    const controller = driveByController()
    expect(recordedOps(byHand.history)).toEqual(controller.ops)
    expect(byHand.state).toEqual(controller.getSnapshot().state)
  })

  it('merges a focus run into one step in both embeddings', () => {
    const byHand = driveByHand()
    const controller = driveByController()

    const stepped = stepBack(byHand.history, byHand.state)
    if (stepped === undefined) throw new Error('expected a step back')
    expect(controller.undo()).toBe(true)
    // Three consecutive focus moves collapse to one step on both paths.
    expect(byHand.history.cursor - stepped.history.cursor).toBe(3)
    expect(stepped.history.cursor).toBe(controller.getSnapshot().cursor)
    expect(stepped.state).toEqual(controller.getSnapshot().state)

    const forward = stepForward(stepped.history, stepped.state)
    if (forward === undefined) throw new Error('expected a step forward')
    expect(controller.redo()).toBe(true)
    expect(forward.history.cursor).toBe(controller.getSnapshot().cursor)
    expect(forward.state).toEqual(controller.getSnapshot().state)
  })

  it('discards the redo branch on both paths when a new operation lands', () => {
    const byHand = driveByHand()
    const controller = driveByController()
    const stepped = stepBack(byHand.history, byHand.state)
    if (stepped === undefined) throw new Error('expected a step back')
    expect(controller.undo()).toBe(true)

    const reopened = record(stepped.history, stepped.state, [{ type: 'setExpanded', expanded: false }])
    controller.setExpanded(false)
    expect(recordedOps(reopened.history)).toEqual(controller.ops)
    expect(stepForward(reopened.history, reopened.state)).toBeUndefined()
    expect(controller.getSnapshot().canRedo).toBe(false)
  })
})

describe('planned intents survive replay', () => {
  it('rebuilds the same tree from the operations a planner produced', () => {
    const { state, minter } = seededState()
    const mint = minter.next
    const ops: LayoutOp[] = []
    let current = state

    const push = (planned: readonly LayoutOp[]): void => {
      ops.push(...planned)
      current = applyAll(current, planned)
    }
    push(planSetExpanded(current, true))
    push(planSplitPane(current, mint, undefined, seedTab))
    const opened = planOpenContent(current, mint, { contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    push(opened.ops)
    const second = getSplit(current, current.rootId).children[1]
    if (second === undefined) throw new Error('expected a second pane')
    push(planPlaceTab(current, opened.tabId, getPane(current, second).id, 0))
    const floated = planFloatTab(current, mint, opened.tabId)
    push(floated.ops)
    push(planUnfloatPane(current, floated.paneId))

    expect(applyAll(state, ops)).toEqual(current)
    expect(fileTab(asTab('t'), 'dsh-resource://file/session/s/a.txt', 'a.txt').kind).toBe('file')
  })
})
