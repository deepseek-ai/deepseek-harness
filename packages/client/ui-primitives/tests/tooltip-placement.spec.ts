import { describe, expect, it } from 'vitest'
import { placeTooltip, type TooltipSide } from '../src/tooltip-placement.ts'

const input = {
  anchor: { left: 400, right: 422, top: 400, bottom: 422 },
  width: 118, height: 26, viewportWidth: 1280, viewportHeight: 900,
  side: 'right' as TooltipSide, align: 'center' as const, gap: 8,
}

function expectSeparated(options: typeof input, result: ReturnType<typeof placeTooltip>) {
  expect(result.left).toBeGreaterThanOrEqual(12)
  expect(result.top).toBeGreaterThanOrEqual(12)
  expect(result.left + result.width).toBeLessThanOrEqual(options.viewportWidth - 12)
  expect(result.top + result.height).toBeLessThanOrEqual(options.viewportHeight - 12)
  const a = options.anchor
  expect(result.left >= a.right || result.left + result.width <= a.left
    || result.top >= a.bottom || result.top + result.height <= a.top).toBe(true)
}

describe('tooltip placement', () => {
  it('moves the reported right-edge bubble left without covering its 22px trigger', () => {
    const options = { ...input, anchor: { left: 1150.5, right: 1172.5, top: 736.08, bottom: 758.08 } }
    const result = placeTooltip(options)
    expect(result).toMatchInlineSnapshot(`
      {
        "height": 26,
        "left": 1022.5,
        "overflow": false,
        "side": "left",
        "top": 734.08,
        "width": 118,
      }
    `)
    expectSeparated(options, result)
  })

  it.each([
    ['right', 432, 398], ['left', 272, 398], ['bottom', 352, 430], ['top', 352, 366],
  ] as const)('preserves normal %s coordinates and default gaps', (side, left, top) => {
    const options = { ...input, side }
    const result = placeTooltip(options)
    expect(result).toMatchObject({ side, left, top, overflow: false })
    expectSeparated(options, result)
  })

  it('flips left to right at the left edge', () => {
    const options = { ...input, side: 'left' as const, anchor: { left: 20, right: 42, top: 200, bottom: 222 } }
    const result = placeTooltip(options)
    expect(result.side).toBe('right')
    expectSeparated(options, result)
  })

  it.each(['top', 'bottom'] as const)('preserves end alignment and a custom gap on %s', (side) => {
    expect(placeTooltip({ ...input, side, align: 'end', gap: 17 })).toMatchObject({
      left: 304, top: side === 'top' ? 357 : 439, side,
    })
  })

  it.each(['right', 'left'] as const)('uses a perpendicular side when neither horizontal side fits (%s)', (side) => {
    const options = { ...input, side, viewportWidth: 390, width: 195, anchor: { left: 180, right: 202, top: 400, bottom: 422 } }
    const result = placeTooltip(options)
    expect(result.side).toBe('bottom')
    expectSeparated(options, result)
  })

  it.each(['top', 'bottom'] as const)('uses a horizontal side when neither vertical side fits (%s)', (side) => {
    const options = { ...input, side, height: 500 }
    const result = placeTooltip(options)
    expect(result.side).toBe('right')
    expectSeparated(options, result)
  })

  it('slides a horizontal bubble vertically without losing its trigger gap', () => {
    const options = { ...input, anchor: { left: 400, right: 422, top: 2, bottom: 24 } }
    const result = placeTooltip(options)
    expect(result).toMatchObject({ left: 432, top: 12, side: 'right' })
    expectSeparated(options, result)
  })

  it('bounds extreme text when no side fits and returns the same fallback repeatedly', () => {
    const options = { ...input, width: 4000, height: 8000 }
    const result = placeTooltip(options)
    expect(result).toEqual({ left: 12, top: 12, width: 1256, height: 876, side: 'right', overflow: true })
    for (let i = 0; i < 3; i++) expect(placeTooltip({ ...options, width: result.width, height: result.height })).toEqual(result)
  })

  it('returns to the preferred side after the viewport grows', () => {
    const options = { ...input, viewportWidth: 500 }
    expect(placeTooltip(options).side).toBe('left')
    expect(placeTooltip({ ...options, viewportWidth: 1280 }).side).toBe('right')
  })
})
