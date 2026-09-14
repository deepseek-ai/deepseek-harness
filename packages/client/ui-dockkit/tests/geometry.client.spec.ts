/**
 * Drag geometry: point tests, dock-zone resolution against a real rectangle,
 * tab-strip insertion slots, the drag threshold, and divider arithmetic.
 */
import { describe, expect, it } from 'vitest'
import {
  containsPoint, dividerSizes, DRAG_THRESHOLD, floatRectAt, insertionIndex, movedRect,
  passedThreshold, resizedRect, zoneInRect,
} from '../src/engine/geometry.ts'
import type { PaneMeasure, Rect } from '../src/engine/geometry.ts'
import { halvesFit, SPLIT_MINIMUMS } from '../src/engine/geometry.ts'
import { FLOAT_DEFAULT_SIZE, FLOAT_MIN_SIZE } from '../src/index.ts'

const PANE: Rect = { x: 100, y: 200, width: 400, height: 300 }

describe('containsPoint', () => {
  it('includes the edges and excludes anything outside', () => {
    expect(containsPoint(PANE, 100, 200)).toBe(true)
    expect(containsPoint(PANE, 500, 500)).toBe(true)
    expect(containsPoint(PANE, 300, 350)).toBe(true)
    expect(containsPoint(PANE, 99, 350)).toBe(false)
    expect(containsPoint(PANE, 300, 501)).toBe(false)
  })
})

describe('zoneInRect', () => {
  it('reads the middle of a pane as its centre', () => {
    expect(zoneInRect(PANE, 300, 350)).toBe('center')
  })

  it('reads each edge band as its own region', () => {
    expect(zoneInRect(PANE, 110, 350)).toBe('left')
    expect(zoneInRect(PANE, 490, 350)).toBe('right')
    expect(zoneInRect(PANE, 300, 210)).toBe('top')
    expect(zoneInRect(PANE, 300, 490)).toBe('bottom')
  })

  it('treats a collapsed rectangle as all centre', () => {
    expect(zoneInRect({ x: 0, y: 0, width: 0, height: 0 }, 0, 0)).toBe('center')
  })
})

describe('insertionIndex', () => {
  const tabs: Rect[] = [
    { x: 0, y: 0, width: 100, height: 30 },
    { x: 100, y: 0, width: 100, height: 30 },
    { x: 200, y: 0, width: 100, height: 30 },
  ]

  it('places before a tab while left of its midpoint', () => {
    expect(insertionIndex(tabs, 10)).toBe(0)
    expect(insertionIndex(tabs, 49)).toBe(0)
  })

  it('places after a tab once past its midpoint', () => {
    expect(insertionIndex(tabs, 51)).toBe(1)
    expect(insertionIndex(tabs, 151)).toBe(2)
    expect(insertionIndex(tabs, 400)).toBe(3)
  })

  it('places at the start of an empty strip', () => {
    expect(insertionIndex([], 400)).toBe(0)
  })
})

describe('passedThreshold', () => {
  it('ignores travel under the threshold on both axes', () => {
    expect(passedThreshold(10, 10, 10, 10)).toBe(false)
    expect(passedThreshold(10, 10, 10 + DRAG_THRESHOLD - 1, 10)).toBe(false)
    expect(passedThreshold(10, 10, 10 + DRAG_THRESHOLD, 10)).toBe(true)
    expect(passedThreshold(10, 10, 10, 10 - DRAG_THRESHOLD)).toBe(true)
  })
})

describe('dividerSizes', () => {
  it('moves the change between the two neighbours only', () => {
    expect(dividerSizes([0.5, 0.5], 0, 0.1)).toEqual([0.6, 0.4])
    expect(dividerSizes([0.25, 0.25, 0.5], 1, -0.05)).toEqual([0.25, 0.2, 0.55])
  })

  it('leaves the fractions alone at a boundary that has no pair', () => {
    expect(dividerSizes([0.5, 0.5], 1, 0.1)).toEqual([0.5, 0.5])
  })
})

describe('floating rectangles', () => {
  const rect = { x: 100, y: 80, width: 300, height: 200 }

  it('moves without changing the size', () => {
    expect(movedRect(rect, 25, -15)).toEqual({ x: 125, y: 65, width: 300, height: 200 })
  })

  it('resizes from the origin and honours the minimum', () => {
    expect(resizedRect(rect, 40, 30, FLOAT_MIN_SIZE))
      .toEqual({ x: 100, y: 80, width: 340, height: 230 })
    expect(resizedRect(rect, -1000, -1000, FLOAT_MIN_SIZE))
      .toEqual({ x: 100, y: 80, ...FLOAT_MIN_SIZE })
  })

  it('places a new panel with its header under the drop point', () => {
    const dropped = floatRectAt(400, 300, FLOAT_DEFAULT_SIZE)
    expect(dropped.width).toBe(FLOAT_DEFAULT_SIZE.width)
    expect(dropped.x).toBeLessThan(400)
    expect(dropped.y).toBeLessThan(300)
    expect(floatRectAt(5, 5, FLOAT_DEFAULT_SIZE)).toMatchObject({ x: 0, y: 0 })
  })
})

describe('halvesFit — the room rule', () => {
  /** A pane whose strip shows `fixed` px of controls and one chip box of 60px; the fill takes the rest. */
  const measure = (width: number, height: number, fixed: number): PaneMeasure => {
    const strip = { x: 1, y: 1, width: width - 2, height: 36 }
    return { pane: { x: 0, y: 0, width, height }, strip, chipsWidth: 60, fillWidth: Math.max(0, strip.width - 60 - fixed) }
  }

  it('lets an unmeasured pane split: the rule only blocks on a positive reading', () => {
    expect(halvesFit(measure(0, 0, 104))).toEqual({ row: true, column: true })
  })

  it('needs each half to hold the strip\'s fixed controls plus one minimum chip', () => {
    // 520px: halves of 258px inside the borders, against 104 + 100.
    expect(halvesFit(measure(520, 600, 104)).row).toBe(true)
    // 208px: halves of 102px, short of 204.
    expect(halvesFit(measure(208, 600, 104)).row).toBe(false)
    // The boundary is inclusive: 2 * (204 + 2 borders) = 412; the divider takes no room.
    expect(halvesFit(measure(412, 600, 104)).row).toBe(true)
    expect(halvesFit(measure(411, 600, 104)).row).toBe(false)
    // A strip with fewer controls needs less: 2 * (144 + 2) = 292.
    expect(halvesFit(measure(291, 600, 44)).row).toBe(false)
    expect(halvesFit(measure(292, 600, 44)).row).toBe(true)
  })

  it('needs each half to hold the strip plus a minimum body for a column split', () => {
    // Halves of h / 2 - 2 against 36 + 48 = 84.
    expect(halvesFit(measure(420, 172, 104)).column).toBe(true)
    expect(halvesFit(measure(420, 171, 104)).column).toBe(false)
  })

  it('takes the minimums it is given, and the stylesheet\'s by default', () => {
    expect(SPLIT_MINIMUMS).toEqual({ divider: 0, chip: 100, body: 48 })
    expect(halvesFit(measure(208, 600, 104), { divider: 0, chip: 0, body: 0 }).row).toBe(false)
    expect(halvesFit(measure(220, 600, 104), { divider: 0, chip: 0, body: 0 }).row).toBe(true)
  })
})
