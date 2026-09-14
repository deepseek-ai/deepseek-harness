// @vitest-environment jsdom
/**
 * The DOM side of the room rule, over a hand-built pane tree: which rectangles
 * and computed styles feed `halvesFit`, and what an unmeasured pane reads as.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { fitOf, measurePaneFits, paneElements, sameFits } from '../src/components/measure.ts'
import type { HalvesFit, Rect } from '../src/engine/geometry.ts'
import { asPane } from './fixtures.client.ts'

/** Give one element a fixed rectangle, as a browser's layout would. */
function lay(element: HTMLElement, rect: Rect): void {
  element.getBoundingClientRect = (): DOMRect => ({
    ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => ({}),
  })
}

/** A pane element with the parts the measurement reads; `width` is the pane's, `fixed` the strip's controls. */
function pane(id: string, width: number, fixed = 104): HTMLElement {
  const element = document.createElement('section')
  element.dataset.dockkitPane = id
  lay(element, { x: 0, y: 0, width, height: 600 })
  const strip = document.createElement('div')
  strip.dataset.dockkitStrip = id
  lay(strip, { x: 1, y: 1, width: width - 2, height: 36 })
  const chips = document.createElement('div')
  chips.dataset.dockkitStripTabs = id
  lay(chips, { x: 1, y: 1, width: 60, height: 34 })
  const fill = document.createElement('div')
  fill.dataset.dockkitStripFill = ''
  lay(fill, { x: 61, y: 1, width: Math.max(0, width - 2 - 60 - fixed), height: 34 })
  strip.append(chips, fill)
  element.append(strip)
  return element
}

/** A chip with the given inline box styles, appended to `strip`'s chip box. */
function chip(host: HTMLElement, style: Partial<CSSStyleDeclaration>): HTMLElement {
  const element = document.createElement('div')
  element.dataset.dockkitTab = 't'
  Object.assign(element.style, style)
  host.querySelector('[data-dockkit-strip-tabs]')?.append(element)
  return element
}

/** A surface root in the document, so computed styles resolve. */
function surface(): HTMLElement {
  const root = document.createElement('div')
  document.body.append(root)
  return root
}

afterEach(() => { document.body.replaceChildren() })

describe('measurePaneFits', () => {
  it('keys every pane by the id it carries, and reads an unlaid pane as fitting', () => {
    const root = surface()
    const bare = document.createElement('section')
    bare.dataset.dockkitPane = 'bare'
    root.append(pane('wide', 520), bare)
    expect(paneElements(root).map(([id]) => id)).toEqual(['wide', 'bare'])
    const fits = measurePaneFits(root)
    expect(fits.get(asPane('wide'))).toEqual({ row: true, column: true })
    expect(fits.get(asPane('bare'))).toEqual({ row: true, column: true })
  })

  // 308px: halves of 152px inside the borders, against 104px of controls plus one chip.
  it('reads the chip minimum from a rendered chip\'s computed style, padding included for a content box', () => {
    const root = surface()
    const narrow = pane('p', 308)
    root.append(narrow)
    // No chip rendered: the stylesheet's 100px, so 204 > 152.
    expect(measurePaneFits(root).get(asPane('p'))?.row).toBe(false)
    // 44px of content plus 4px + 4px of padding is 52: 156 > 152.
    const rendered = chip(narrow, { minWidth: '44px', paddingLeft: '4px', paddingRight: '4px', boxSizing: 'content-box' })
    expect(measurePaneFits(root).get(asPane('p'))?.row).toBe(false)
    // The same declaration as a border box is the whole footprint: 148 fits.
    rendered.style.boxSizing = 'border-box'
    expect(measurePaneFits(root).get(asPane('p'))?.row).toBe(true)
    // Unstyled or zero minimum: back to the stylesheet's figure.
    rendered.style.minWidth = '0px'
    expect(measurePaneFits(root).get(asPane('p'))?.row).toBe(false)
    rendered.style.minWidth = ''
    expect(measurePaneFits(root).get(asPane('p'))?.row).toBe(false)
  })

  // 416px: halves of 204px against 204 with the stylesheet's zero divider, 202 with an 8px one.
  it('reads the divider\'s thickness from a rendered divider, and the stylesheet\'s before one exists', () => {
    const root = surface()
    root.append(pane('p', 416))
    expect(measurePaneFits(root).get(asPane('p'))?.row).toBe(true)
    const divider = document.createElement('div')
    divider.dataset.dockkitDivider = 's:0'
    root.append(divider)
    lay(divider, { x: 0, y: 0, width: 8, height: 600 })
    expect(measurePaneFits(root).get(asPane('p'))?.row).toBe(false)
    // A divider without layout yet falls back too.
    lay(divider, { x: 0, y: 0, width: 0, height: 0 })
    expect(measurePaneFits(root).get(asPane('p'))?.row).toBe(true)
  })
})

describe('fitOf', () => {
  it('answers from the map, and takes an unmeasured pane to fit', () => {
    const blocked: HalvesFit = { row: false, column: true }
    const fits = new Map([[asPane('p'), blocked]])
    expect(fitOf(fits, asPane('p'))).toBe(blocked)
    expect(fitOf(fits, asPane('q'))).toEqual({ row: true, column: true })
  })
})

describe('sameFits', () => {
  const fit: HalvesFit = { row: true, column: false }

  it('agrees only when both name the same panes with the same readings', () => {
    expect(sameFits(new Map([[asPane('a'), fit]]), new Map([[asPane('a'), { ...fit }]]))).toBe(true)
    expect(sameFits(new Map([[asPane('a'), fit]]), new Map())).toBe(false)
    expect(sameFits(new Map([[asPane('a'), fit]]), new Map([[asPane('b'), fit]]))).toBe(false)
    expect(sameFits(new Map([[asPane('a'), fit]]), new Map([[asPane('a'), { row: false, column: false }]]))).toBe(false)
    expect(sameFits(new Map([[asPane('a'), fit]]), new Map([[asPane('a'), { row: true, column: true }]]))).toBe(false)
  })
})
