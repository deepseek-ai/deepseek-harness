/**
 * Interaction limits: the four-pane cap, the five dock regions, and divider
 * clamping. The model itself stays unbounded; these rules gate dispatch.
 */
import { describe, expect, it } from 'vitest'
import { applyOp } from '../src/engine/operations.ts'
import {
  canSplit, clampSizes, DOCK_ZONES, dockPaneCount, MAX_DOCK_PANES, MIN_PANE_FRACTION, zoneAt, zoneSplit,
} from '../src/engine/constraints.ts'
import { createIdMinter, createInitialState } from '../src/engine/initial.ts'
import { seedTab } from './fixtures.client.ts'
import { getPane } from '../src/engine/tree.ts'
import type { LayoutState } from '../src/contract/types.ts'

/** Split the root pane repeatedly until the docked grid holds `count` panes. */
function grid(count: number): LayoutState {
  const minter = createIdMinter()
  let state = createInitialState(minter, seedTab)
  while (dockPaneCount(state) < count) {
    state = applyOp(state, {
      type: 'split',
      paneId: state.activePaneId,
      axis: 'row',
      direction: 'after',
      newPaneId: minter.next('pane'),
      newSplitId: minter.next('split'),
    }).state
  }
  return state
}

describe('pane cap', () => {
  it('allows splitting up to four docked panes and no further', () => {
    expect(MAX_DOCK_PANES).toBe(4)
    expect(canSplit(createInitialState(createIdMinter(), seedTab))).toBe(true)
    expect(dockPaneCount(grid(4))).toBe(4)
    expect(canSplit(grid(4))).toBe(false)
    expect(canSplit(grid(3))).toBe(true)
  })

  it('ignores floating panes when counting the grid', () => {
    const minter = createIdMinter()
    const state = createInitialState(minter, seedTab)
    const guideTabId = getPane(state, state.rootId).tabs[0]
    if (guideTabId === undefined) throw new Error('fixture: no guide tab')
    const floated = applyOp(state, {
      type: 'float', tabId: guideTabId, newPaneId: minter.next('float'), rect: { x: 0, y: 0, width: 10, height: 10 },
    }).state
    expect(floated.floats).toHaveLength(1)
    expect(dockPaneCount(floated)).toBe(1)
    expect(canSplit(floated)).toBe(true)
  })
})

describe('dock regions', () => {
  it('offers five regions', () => {
    expect([...DOCK_ZONES].sort()).toEqual(['bottom', 'center', 'left', 'right', 'top'])
  })

  it('reads the centre of a pane as a move, not a split', () => {
    expect(zoneAt(0.5, 0.5)).toBe('center')
    expect(zoneSplit('center')).toBeUndefined()
  })

  it('reads each edge band as its own region', () => {
    expect(zoneAt(0.05, 0.5)).toBe('left')
    expect(zoneAt(0.95, 0.5)).toBe('right')
    expect(zoneAt(0.5, 0.05)).toBe('top')
    expect(zoneAt(0.5, 0.95)).toBe('bottom')
  })

  it('takes the closest edge in a corner', () => {
    expect(zoneAt(0.02, 0.10)).toBe('left')
    expect(zoneAt(0.10, 0.02)).toBe('top')
  })

  it('maps regions to the split they create', () => {
    expect(zoneSplit('left')).toEqual({ axis: 'row', direction: 'before' })
    expect(zoneSplit('right')).toEqual({ axis: 'row', direction: 'after' })
    expect(zoneSplit('top')).toEqual({ axis: 'column', direction: 'before' })
    expect(zoneSplit('bottom')).toEqual({ axis: 'column', direction: 'after' })
  })
})

describe('divider clamping', () => {
  it('honours an embedder\'s twenty-percent minimum', () => {
    expect(clampSizes([0.01, 0.99], 0.2)).toEqual([0.2, 0.8])
    expect(clampSizes([0.99, 0.01], 0.2)).toEqual([0.8, 0.2])
    expect(clampSizes([0.5, 0.5], 0.2)).toEqual([0.5, 0.5])
  })

  it('keeps sizes summing to one', () => {
    const sizes = clampSizes([0.6, 0.4])
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1)
    expect(sizes[0]).toBeCloseTo(0.6)
  })

  it('lifts a pane dragged under the minimum', () => {
    const sizes = clampSizes([0.01, 0.99])
    expect(sizes[0]).toBeGreaterThanOrEqual(MIN_PANE_FRACTION * 0.9)
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1)
  })

  it('accepts unnormalized pixel-like input', () => {
    const sizes = clampSizes([300, 100])
    expect(sizes[0]).toBeCloseTo(0.75)
    expect(sizes[1]).toBeCloseTo(0.25)
  })

  it('treats a negative size as zero and shares an all-zero input equally', () => {
    expect(clampSizes([])).toEqual([])
    const lifted = clampSizes([-1, 1])
    expect(lifted[0]).toBeCloseTo(MIN_PANE_FRACTION)
    expect(lifted[1]).toBeCloseTo(1 - MIN_PANE_FRACTION)
    expect(clampSizes([0, 0])).toEqual([0.5, 0.5])
  })

  it('pins a share that drops under the minimum only after the first pass', () => {
    // 0.13 clears the floor until the first pin takes its 0.11 from everyone.
    const sizes = clampSizes([0.01, 0.13, 0.86])
    expect(sizes[0]).toBeCloseTo(MIN_PANE_FRACTION)
    expect(sizes[1]).toBeCloseTo(MIN_PANE_FRACTION)
    expect(sizes[2]).toBeCloseTo(1 - 2 * MIN_PANE_FRACTION)
  })

  it('never lifts a pane above an equal share when the minimum would not fit them all', () => {
    const sizes = clampSizes(Array.from({ length: 10 }, (_, index) => (index === 0 ? 0.001 : 1)))
    expect(sizes[0]).toBeCloseTo(0.1)
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1)
  })
})
