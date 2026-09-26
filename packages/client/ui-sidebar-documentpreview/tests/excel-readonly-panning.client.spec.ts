// @vitest-environment jsdom
/** Read-only spreadsheet panning keeps the workbook context equal to the clamped scrollbar offsets. */
import { expect, it } from 'vitest'
import { defaultContext, handleGlobalWheel, type Context, type GlobalCache } from '@fortune-sheet/core'

/**
 * Model one browser scroll container: jsdom stores out-of-range offsets verbatim, while a browser
 * clamps them to the scrollable range that starts at zero.
 * @returns a scroll container whose offsets clamp on assignment.
 */
function scrollbar(): HTMLDivElement {
  const element = document.createElement('div')
  let left = 0
  let top = 0
  Object.defineProperty(element, 'scrollLeft', {
    get: () => left,
    set: (value: number) => { left = Math.max(0, value) },
  })
  Object.defineProperty(element, 'scrollTop', {
    get: () => top,
    set: (value: number) => { top = Math.max(0, value) },
  })
  return element
}

/**
 * @returns read-only workbook state scrolled to a non-zero offset.
 */
function readOnlyContext(): Context {
  const context = defaultContext({
    globalCache: { undoList: [], redoList: [] },
    cellInput: { current: null }, fxInput: { current: null }, canvas: { current: null },
    cellArea: { current: null }, workbookContainer: { current: null },
  })
  context.allowEdit = false
  context.scrollLeft = 240
  context.scrollTop = 240
  return context
}

/**
 * @param deltaX - horizontal pixel delta of the gesture.
 * @param deltaY - vertical pixel delta of the gesture.
 * @returns the trackpad wheel event the browser delivers for that gesture.
 */
function wheel(deltaX: number, deltaY: number): WheelEvent {
  return new WheelEvent('wheel', { deltaX, deltaY, deltaMode: 0, cancelable: true })
}

it('leaves the workbook context on the clamped scrollbar offsets after read-only panning', () => {
  const context = readOnlyContext()
  const cache: GlobalCache = { undoList: [], redoList: [] }
  const scrollbarX = scrollbar()
  const scrollbarY = scrollbar()
  scrollbarX.scrollLeft = 240
  scrollbarY.scrollTop = 240
  handleGlobalWheel(context, wheel(0, -10000), cache, scrollbarX, scrollbarY)
  expect(scrollbarY.scrollTop).toBe(0)
  expect(context.scrollTop).toBe(0)
  handleGlobalWheel(context, wheel(-10000, 0), cache, scrollbarX, scrollbarY)
  expect(scrollbarX.scrollLeft).toBe(0)
  expect(context.scrollLeft).toBe(0)
})

it('keeps a reversed gesture after the read-only scrollbar clamps at the leading edge', () => {
  const context = readOnlyContext()
  const cache: GlobalCache = { undoList: [], redoList: [] }
  const scrollbarX = scrollbar()
  const scrollbarY = scrollbar()
  scrollbarX.scrollLeft = 240
  scrollbarY.scrollTop = 240
  handleGlobalWheel(context, wheel(-10000, -10000), cache, scrollbarX, scrollbarY)
  handleGlobalWheel(context, wheel(20, 20), cache, scrollbarX, scrollbarY)
  expect(scrollbarX.scrollLeft).toBe(20)
  expect(scrollbarY.scrollTop).toBe(20)
  expect(context.scrollLeft).toBe(20)
  expect(context.scrollTop).toBe(20)
})
