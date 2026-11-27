// @vitest-environment jsdom
/** Writer's DOM gaps share the displayed content coordinates for every presenter. */
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { officeViewFixture } from './helpers/office-view.client.tsx'
import { en } from '../src/client/locales.ts'
import css from '../src/client/Editor.module.css'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

test('video keeps Word page gaps aligned at half and full zoom through scrolling', async () => {
  await using f = officeViewFixture('text')
  await f.flush()
  const scroll = f.area(), content = scroll.firstElementChild as HTMLElement
  const surface = scroll.querySelector<HTMLElement>('[data-office-surface]')!
  expect(surface.dataset.dshFrameMount).toBe('video')
  const layer = scroll.querySelector<HTMLElement>('[data-office-page-gaps]')!
  expect(layer).not.toBeNull()
  expect(layer.parentElement).toBe(content)
  expect(layer.getAttribute('aria-hidden')).toBe('true')
  expect(getComputedStyle(layer).pointerEvents).toBe('none')
  expect(getComputedStyle(layer).zIndex).toBe('1')
  expect(content.querySelector(`.${css.surface}`)!.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  const gap = layer.querySelector<HTMLElement>('[data-office-page-gap]')!
  const rule = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
    .find((rule): rule is CSSStyleRule => 'selectorText' in rule && rule.selectorText === `.${css.pageGap}`)!
  expect(rule.style.getPropertyValue('background')).toBe('var(--dsw-alias-bg-document-preview)')
  expect(getComputedStyle(gap).pointerEvents).toBe('none')
  expect(getComputedStyle(gap).width).toBe('100%')
  for (const [zoom, top, height, left] of [[0.5, 600, 10, 200], [1, 1200, 20, 0]] as const) {
    fireEvent.click(screen.getByRole('button', { name: en.zoom }))
    fireEvent.click(screen.getByText(`${zoom * 100}%`, { selector: '[role="menuitem"] *' }))
    await f.flush()
    const scale = Number(content.style.getPropertyValue('--office-content-scale'))
    expect(scale).toBeCloseTo(zoom / 15)
    expect(gap.style.top).toBe('calc(18000px * var(--office-content-scale))')
    expect(gap.style.height).toBe('calc(300px * var(--office-content-scale))')
    expect(18000 * scale).toBeCloseTo(top)
    expect(300 * scale).toBeCloseTo(height)
    for (const offset of [0, top - 100, top + 5]) {
      scroll.scrollTop = offset
      scroll.scrollLeft = 0
      fireEvent.scroll(scroll); await f.flush()
      const bounds = content.getBoundingClientRect()
      expect(bounds.top + 18000 * scale).toBeCloseTo(top - offset)
      expect(bounds.left).toBeCloseTo(left)
      expect(surface.dataset.dshFrameMount).toBe('video')
    }
  }
  await f.emit({ kind: 'callback', type: 2, payload: '150,17900,900,600' })
  const selection = content.querySelector<HTMLElement>('[data-office-selection]')!
  expect(selection).not.toBeNull()
  expect(layer.contains(selection)).toBe(false)
  expect(getComputedStyle(selection.parentElement!).zIndex).toBe('2')
  expect(content.querySelector('[data-office-interaction-overlay]')!.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0)
})

test('single, touching and overlapping Writer pages never receive an opaque band over page content', async () => {
  await using f = officeViewFixture('text', true)
  await f.flush()
  for (const rectangles of ['0,0,12000,18000', '0,0,12000,18000;0,18000,12000,18000',
    '0,17000,12000,18000;0,0,12000,18000']) {
    await act(async () => {
      f.setInfo({ ...f.opened.info, rectangles })
      f.connection.dispatch({ documentId: f.opened.documentId, event: { kind: 'callback', type: 13, payload: '' } })
    })
    expect(f.area().querySelectorAll('[data-office-page-gap]')).toHaveLength(0)
  }
})

test.each(['spreadsheet', 'presentation'] as const)('%s has no Writer page-gap overlay', async (kind) => {
  await using f = officeViewFixture(kind, true)
  await f.flush()
  expect(f.area().querySelector('[data-office-page-gaps]')).toBeNull()
})
