/**
 * Sequence behavior: linear history, exact inverses, the focus-run undo step, and
 * the redo branch a new operation discards.
 */
import { describe, expect, it } from 'vitest'
import { replay } from '../src/engine/operations.ts'
import { createIdMinter, createInitialState } from '../src/engine/initial.ts'
import { asPane, asTab, fileTab, seedTab } from './fixtures.client.ts'
import { EMPTY_HISTORY, isFocusOp, record, Sequencer } from '../src/engine/sequence.ts'
import { dockPaneIds, getPane, getSplit } from '../src/engine/tree.ts'
import type { LayoutState, PaneId, TabId } from '../src/contract/types.ts'

interface Fixture {
  readonly initial: LayoutState
  readonly sequencer: Sequencer
  readonly minter: ReturnType<typeof createIdMinter>
  readonly paneId: PaneId
  readonly guideTabId: TabId
}

function fixture(): Fixture {
  const minter = createIdMinter()
  const initial = createInitialState(minter, seedTab)
  const guideTabId = getPane(initial, initial.rootId).tabs[0]
  if (guideTabId === undefined) throw new Error('fixture: initial pane has no guide tab')
  return { initial, sequencer: new Sequencer(initial), minter, paneId: getPane(initial, initial.rootId).id, guideTabId }
}

describe('isFocusOp', () => {
  it('names the operations that only move focus', () => {
    expect(isFocusOp({ type: 'focusPane', paneId: asPane('p') })).toBe(true)
    expect(isFocusOp({ type: 'focusTab', tabId: asTab('t') })).toBe(true)
    expect(isFocusOp({ type: 'restoreFocus', activePaneId: asPane('p'), floats: [], paneActiveTabs: {} })).toBe(true)
    expect(isFocusOp({ type: 'setExpanded', expanded: true })).toBe(false)
  })
})

describe('recording', () => {
  it('starts with nothing to step through', () => {
    const { sequencer, initial } = fixture()
    expect(sequencer.state).toBe(initial)
    expect(sequencer.canUndo).toBe(false)
    expect(sequencer.canRedo).toBe(false)
    expect(sequencer.undo()).toBe(false)
    expect(sequencer.redo()).toBe(false)
  })

  it('records every operation, focus moves included', () => {
    const { sequencer, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    sequencer.dispatch({ type: 'openTab', paneId, tab, index: 1 })
    sequencer.dispatch({ type: 'focusTab', tabId: guideTabId })
    sequencer.dispatch({ type: 'focusTab', tabId: tab.id })
    expect(sequencer.ops.map(op => op.type)).toEqual(['openTab', 'focusTab', 'focusTab'])
    expect(sequencer.cursor).toBe(3)
  })

  it('exposes the recorded sequence as plain history, and records nothing for an empty intent', () => {
    const { sequencer, initial, paneId } = fixture()
    expect(sequencer.history).toBe(EMPTY_HISTORY)
    sequencer.dispatch({ type: 'focusPane', paneId })
    expect(sequencer.history.entries).toHaveLength(1)
    expect(sequencer.history.cursor).toBe(1)
    const unchanged = record(EMPTY_HISTORY, initial, [])
    expect(unchanged.history).toBe(EMPTY_HISTORY)
    expect(unchanged.state).toBe(initial)
    expect(sequencer.dispatchAll([])).toBe(sequencer.state)
    expect(sequencer.history.entries).toHaveLength(1)
  })

  it('leaves the sequence untouched when an operation is invalid', () => {
    const { sequencer } = fixture()
    expect(() => sequencer.dispatch({ type: 'focusPane', paneId: asPane('nope') })).toThrow(/unknown node/)
    expect(sequencer.ops).toHaveLength(0)
    expect(sequencer.canUndo).toBe(false)
  })
})

describe('stepping back and forward', () => {
  it('returns to the exact previous state', () => {
    const { sequencer, initial, minter, paneId } = fixture()
    const newPaneId = minter.next('pane')
    sequencer.dispatch({
      type: 'split', paneId, axis: 'row', direction: 'after', newPaneId, newSplitId: minter.next('split'),
    })
    expect(dockPaneIds(sequencer.state)).toHaveLength(2)
    expect(sequencer.undo()).toBe(true)
    expect(sequencer.state).toEqual(initial)
    expect(sequencer.canUndo).toBe(false)
    expect(sequencer.canRedo).toBe(true)
    expect(sequencer.redo()).toBe(true)
    expect(dockPaneIds(sequencer.state)).toHaveLength(2)
  })

  it('collapses a run of consecutive focus moves into one step', () => {
    const { sequencer, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    sequencer.dispatch({ type: 'openTab', paneId, tab, index: 1 })
    const afterOpen = sequencer.state
    sequencer.dispatch({ type: 'focusTab', tabId: guideTabId })
    sequencer.dispatch({ type: 'focusTab', tabId: tab.id })
    sequencer.dispatch({ type: 'focusTab', tabId: guideTabId })
    expect(sequencer.cursor).toBe(4)

    expect(sequencer.undo()).toBe(true)
    expect(sequencer.cursor).toBe(1)
    expect(sequencer.state).toEqual(afterOpen)

    expect(sequencer.redo()).toBe(true)
    expect(sequencer.cursor).toBe(4)
    expect(getPane(sequencer.state, paneId).activeTabId).toBe(guideTabId)
  })

  it('steps one structural operation even when focus moves precede it', () => {
    const { sequencer, paneId, guideTabId } = fixture()
    sequencer.dispatch({ type: 'focusPane', paneId })
    sequencer.dispatch({ type: 'focusTab', tabId: guideTabId })
    sequencer.dispatch({ type: 'setExpanded', expanded: true })
    expect(sequencer.undo()).toBe(true)
    expect(sequencer.cursor).toBe(2)
    expect(sequencer.state.expanded).toBe(false)
    expect(sequencer.undo()).toBe(true)
    expect(sequencer.cursor).toBe(0)
  })

  it('undoes a whole session back to the initial state', () => {
    const { sequencer, initial, minter, paneId, guideTabId } = fixture()
    const newPaneId = minter.next('pane')
    const floatId = minter.next('float')
    sequencer.dispatch({ type: 'setExpanded', expanded: true })
    sequencer.dispatch({
      type: 'split', paneId, axis: 'row', direction: 'after', newPaneId, newSplitId: minter.next('split'),
    })
    sequencer.dispatch({ type: 'moveTab', tabId: guideTabId, toPaneId: newPaneId, index: 0 })
    sequencer.dispatch({
      type: 'float', tabId: guideTabId, newPaneId: floatId, rect: { x: 5, y: 6, width: 200, height: 100 },
    })
    sequencer.dispatch({ type: 'moveFloat', paneId: floatId, x: 50, y: 60 })
    while (sequencer.undo()) { /* step back to the beginning */ }
    expect(sequencer.state).toEqual(initial)
    expect(sequencer.cursor).toBe(0)
  })
})

describe('a floating panel\'s drag as one step', () => {
  it('raises and focuses the panel with the move, and steps both back and forward together', () => {
    const { sequencer, minter, paneId, guideTabId } = fixture()
    const tab = fileTab(minter.next('tab'), 'dsh-resource://file/session/s/a.txt', 'a.txt')
    const lower = minter.next('float')
    const upper = minter.next('float')
    sequencer.dispatch({ type: 'openTab', paneId, tab, index: 1 })
    sequencer.dispatch({ type: 'float', tabId: guideTabId, newPaneId: lower, rect: { x: 0, y: 0, width: 200, height: 100 } })
    sequencer.dispatch({ type: 'float', tabId: tab.id, newPaneId: upper, rect: { x: 20, y: 20, width: 200, height: 100 } })
    sequencer.dispatch({ type: 'focusPane', paneId })
    const before = sequencer.state
    expect(before.floats).toEqual([lower, upper])

    sequencer.dispatch({ type: 'moveFloat', paneId: lower, x: 50, y: 60 })
    expect(sequencer.state.floats).toEqual([upper, lower])
    expect(sequencer.state.activePaneId).toBe(lower)

    // One step back restores the rectangle, the z order, and the focus; the
    // preceding focus-only entry is its own step.
    expect(sequencer.undo()).toBe(true)
    expect(sequencer.state).toEqual(before)
    expect(sequencer.redo()).toBe(true)
    expect(sequencer.state.floats).toEqual([upper, lower])
    expect(getPane(sequencer.state, lower).rect).toEqual({ x: 50, y: 60, width: 200, height: 100 })
    expect(sequencer.state.activePaneId).toBe(lower)
  })
})

describe('linear history', () => {
  it('drops the redo branch when a new operation lands after an undo', () => {
    const { sequencer, minter, paneId } = fixture()
    sequencer.dispatch({ type: 'setExpanded', expanded: true })
    sequencer.dispatch({
      type: 'split', paneId, axis: 'row', direction: 'after', newPaneId: minter.next('pane'), newSplitId: minter.next('split'),
    })
    expect(sequencer.undo()).toBe(true)
    expect(sequencer.canRedo).toBe(true)
    sequencer.dispatch({ type: 'focusPane', paneId })
    expect(sequencer.canRedo).toBe(false)
    expect(sequencer.ops.map(op => op.type)).toEqual(['setExpanded', 'focusPane'])
    expect(dockPaneIds(sequencer.state)).toHaveLength(1)
  })

  it('keeps the applied prefix replayable at any cursor', () => {
    const { sequencer, initial, minter, paneId, guideTabId } = fixture()
    const newPaneId = minter.next('pane')
    sequencer.dispatch({ type: 'setExpanded', expanded: true })
    sequencer.dispatch({
      type: 'split', paneId, axis: 'row', direction: 'after', newPaneId, newSplitId: minter.next('split'),
    })
    sequencer.dispatch({ type: 'moveTab', tabId: guideTabId, toPaneId: newPaneId, index: 0 })
    sequencer.dispatch({ type: 'resize', splitId: getSplit(sequencer.state, sequencer.state.rootId).id, sizes: [0.7, 0.3] })
    sequencer.undo()
    sequencer.undo()
    expect(replay(initial, sequencer.ops.slice(0, sequencer.cursor))).toEqual(sequencer.state)
    sequencer.redo()
    expect(replay(initial, sequencer.ops.slice(0, sequencer.cursor))).toEqual(sequencer.state)
  })
})
