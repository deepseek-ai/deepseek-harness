/**
 * Floating-panel edge recovery geometry: the legal projection into the
 * viewport, the drag resistance past an edge and its inverse, and the
 * viewport-bounded resize.
 */
import { describe, expect, it } from 'vitest'
import {
  boundedResize, FLOAT_RESISTANCE, legalFloatRect, resistedRect, unresistedRect,
} from '../src/engine/geometry.ts'
import type { FloatBounds } from '../src/engine/geometry.ts'
import { FLOAT_MIN_SIZE } from '../src/index.ts'

const VIEWPORT: FloatBounds = { top: 0, width: 1000, height: 800 }
const PANEL = { x: 100, y: 80, width: 300, height: 200 }

describe('legalFloatRect', () => {
  it('keeps a panel that is already inside, and returns a fresh rectangle of the same size', () => {
    expect(legalFloatRect(PANEL, VIEWPORT)).toEqual(PANEL)
  })

  it.each([
    { edge: 'left', rect: { ...PANEL, x: -50 }, expected: { x: 0, y: 80 } },
    { edge: 'right', rect: { ...PANEL, x: 900 }, expected: { x: 700, y: 80 } },
    { edge: 'top', rect: { ...PANEL, y: -10 }, expected: { x: 100, y: 0 } },
    { edge: 'bottom', rect: { ...PANEL, y: 700 }, expected: { x: 100, y: 600 } },
    { edge: 'corner', rect: { ...PANEL, x: 2000, y: -400 }, expected: { x: 700, y: 0 } },
  ])('moves a panel past the $edge edge back by the overflow only', ({ rect, expected }) => {
    expect(legalFloatRect(rect, VIEWPORT)).toEqual({ ...rect, ...expected })
  })

  it('honours the top floor that keeps the header below window chrome', () => {
    expect(legalFloatRect({ ...PANEL, y: 10 }, { ...VIEWPORT, top: 60 }).y).toBe(60)
  })

  it('draws a panel larger than the viewport at the viewport size, so its header controls and corner stay reachable', () => {
    const big = { x: 300, y: 300, width: 1200, height: 900 }
    expect(legalFloatRect(big, { ...VIEWPORT, top: 20 })).toEqual({ x: 0, y: 20, width: 1000, height: 780 })
  })

  it('caps only the axis that does not fit', () => {
    expect(legalFloatRect({ ...PANEL, x: 900, width: 1200 }, VIEWPORT)).toEqual({ ...PANEL, x: 0, width: 1000 })
  })
})

describe('resistedRect', () => {
  it('is the desired rectangle while it is legal', () => {
    expect(resistedRect(PANEL, VIEWPORT)).toEqual(PANEL)
  })

  it.each([
    { overflow: 10, shown: 9.2308 },
    { overflow: 40, shown: 30 },
    { overflow: 120, shown: 60 },
    { overflow: 400, shown: 92.3077 },
  ])('draws $overflow px of pointer overflow as $shown px past the edge', ({ overflow, shown }) => {
    const right = resistedRect({ ...PANEL, x: 700 + overflow }, VIEWPORT)
    expect(right.x - 700).toBeCloseTo(shown, 3)
    const left = resistedRect({ ...PANEL, x: -overflow }, VIEWPORT)
    expect(left.x).toBeCloseTo(-shown, 3)
  })

  it('starts with slope 1 at the edge, grows monotonically, and never reaches the resistance limit', () => {
    let previous = 0
    for (let overflow = 1; overflow <= 5000; overflow *= 2) {
      const shown = resistedRect({ ...PANEL, y: 600 + overflow }, VIEWPORT).y - 600
      expect(shown).toBeGreaterThan(previous)
      expect(shown).toBeLessThan(FLOAT_RESISTANCE)
      previous = shown
    }
    expect(resistedRect({ ...PANEL, y: 600.001 }, VIEWPORT).y - 600).toBeCloseTo(0.001, 6)
  })

  it('resists each axis independently, leaving a legal axis untouched', () => {
    const shown = resistedRect({ ...PANEL, x: 820, y: 80 }, VIEWPORT)
    expect(shown.y).toBe(80)
    expect(shown.x).toBeCloseTo(760)
  })

  it('draws at the legal size when the desired rectangle no longer fits the viewport', () => {
    const narrow = { ...VIEWPORT, width: 500 }
    // 60 px of overflow past the legal x of 0 draws 40 px past it, at the 500 px the viewport allows.
    expect(resistedRect({ ...PANEL, x: 60, width: 700 }, narrow)).toEqual({ ...PANEL, x: 40, width: 500 })
    expect(unresistedRect({ ...PANEL, x: 0, width: 700 }, narrow)).toEqual({ ...PANEL, x: 0, width: 500 })
  })
})

describe('unresistedRect', () => {
  it('inverts the resistance, so a press on a drawn panel picks it up where it is', () => {
    for (const desired of [{ ...PANEL, x: 760 }, { ...PANEL, x: -300, y: 950 }, PANEL]) {
      const drawn = resistedRect(desired, VIEWPORT)
      const start = unresistedRect(drawn, VIEWPORT)
      expect(start.x).toBeCloseTo(desired.x, 6)
      expect(start.y).toBeCloseTo(desired.y, 6)
    }
  })

  it('caps a displacement at the resistance limit instead of producing an infinite overflow', () => {
    const start = unresistedRect({ ...PANEL, x: 700 + FLOAT_RESISTANCE * 2 }, VIEWPORT)
    expect(Number.isFinite(start.x)).toBe(true)
    expect(start.x - 700).toBeCloseTo(FLOAT_RESISTANCE * 99, 6)
  })
})

describe('boundedResize', () => {
  it('keeps the bottom-right corner inside the viewport', () => {
    expect(boundedResize({ ...PANEL, width: 2000, height: 2000 }, VIEWPORT, FLOAT_MIN_SIZE))
      .toEqual({ ...PANEL, width: 900, height: 720 })
  })

  it('never shrinks a panel below the minimum size', () => {
    expect(boundedResize({ x: 950, y: 780, width: 400, height: 400 }, VIEWPORT, FLOAT_MIN_SIZE))
      .toEqual({ x: 950, y: 780, ...FLOAT_MIN_SIZE })
  })

  it('leaves a size that fits unchanged', () => {
    expect(boundedResize(PANEL, VIEWPORT, FLOAT_MIN_SIZE)).toEqual(PANEL)
  })
})
