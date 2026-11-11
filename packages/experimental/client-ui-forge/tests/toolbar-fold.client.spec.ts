// @vitest-environment jsdom
/** The changes toolbar's fold measurement: the shallowest level that fits, and every change that measures again. */
import './fonts-dom.client.ts'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { DEEPEST_FOLD, foldOf, observeToolbarFold } from '../src/client/toolbar-fold.ts'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

/** A row whose items take the widths of the level it shows: line totals and view toggles fold first, then the bar, then refresh. */
function fixture() {
  const row = document.createElement('div')
  row.style.padding = '0 8px'
  row.style.columnGap = '4px'
  const level = (): number => Number(row.getAttribute('data-fold'))
  const item = (width: () => number, spacer = false): HTMLElement => {
    const element = document.createElement('span')
    if (spacer) element.setAttribute('data-fold-spacer', '')
    element.getBoundingClientRect = () => new DOMRect(0, 0, width(), 28)
    row.append(element)
    return element
  }
  const sizes = { row: 460, files: 100 }
  const files = item(() => sizes.files)
  item(() => 999, true)
  item(() => level() < 2 ? 150 : 50)
  item(() => level() === 0 ? 60 : 0)
  item(() => (level() < 3 ? 28 : 0) + (level() === 0 ? 84 : 30))
  row.getBoundingClientRect = () => new DOMRect(0, 0, sizes.row, 38)
  document.body.append(row)
  const observe = vi.fn()
  const disconnect = vi.fn()
  let resized: () => void = () => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe = observe
    disconnect = disconnect
  })
  const dispose = observeToolbarFold(row)
  onTestFinished(dispose)
  return { row, files, sizes, observe, disconnect, dispose, level, resize: (width: number) => { sizes.row = width; resized() } }
}

it('shows the shallowest level whose items fit and the deepest when none does', () => {
  const { level, resize, observe } = fixture()
  expect(level()).toBe(0)
  // Row, then its five items.
  expect(observe).toHaveBeenCalledTimes(6)
  for (const [width, expected] of [[454, 0], [453, 1], [336, 1], [335, 2], [236, 2], [235, 3], [100, DEEPEST_FOLD], [460, 0]] as const) {
    resize(width)
    expect([width, level()]).toEqual([width, expected])
  }
})

it('measures again when text changes, items arrive, or fonts load, and stops after disposal', async () => {
  const { row, files, sizes, level, observe, disconnect, dispose } = fixture()
  sizes.files = 140
  files.textContent = 'All 1,204 files'
  await Promise.resolve()
  expect(level()).toBe(1)
  const added = document.createElement('span')
  added.getBoundingClientRect = () => new DOMRect(0, 0, 150, 28)
  row.append(added)
  await Promise.resolve()
  expect(level()).toBe(2)
  expect(observe).toHaveBeenCalledWith(added)
  sizes.files = 100
  document.fonts.dispatchEvent(new Event('loadingdone'))
  expect(level()).toBe(2)
  added.remove()
  await Promise.resolve()
  expect(level()).toBe(0)
  dispose()
  expect(disconnect).toHaveBeenCalled()
  sizes.files = 400
  document.fonts.dispatchEvent(new Event('loadingdone'))
  files.textContent = 'All files'
  await Promise.resolve()
  expect(level()).toBe(0)
})

it('reads the level of the toolbar around an element, and the deepest level outside one', () => {
  const row = document.createElement('div')
  const inside = document.createElement('button')
  row.append(inside)
  expect(foldOf(inside)).toBe(DEEPEST_FOLD)
  row.setAttribute('data-fold', '1')
  expect(foldOf(inside)).toBe(1)
})
