// @vitest-environment jsdom
/** Sheet navigation stays separate from document input and follows available panel width. */
import { createElement, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { SheetTabs } from '../src/client/SheetTabs.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture(initial = 2) {
  const observers = new Set<() => void>()
  vi.stubGlobal('ResizeObserver', class {
    private readonly notify: () => void
    constructor(callback: ResizeObserverCallback) { this.notify = () => { callback([], this) }; observers.add(this.notify) }
    observe() {}
    unobserve() {}
    disconnect() { observers.delete(this.notify) }
  })
  const onSelect = vi.fn(), documentKey = vi.fn()
  const parts = [{ index: 2, name: 'Summary' }, { index: 4, name: 'Revenue and operating expenses' }, { index: 7, name: 'Forecast' }]
  function Harness() {
    const [selected, setSelected] = useState(initial)
    return createElement('div', { onKeyDown: documentKey }, createElement(SheetTabs, {
      parts, selected, panelId: 'sheet-panel', label: en.sheet, listLabel: en.sheetList,
      onSelect: (part) => { onSelect(part); setSelected(part) },
    }))
  }
  const view = render(createElement(Harness))
  const list = screen.getByRole('tablist', { name: en.sheet })
  const scroll = list.parentElement!, root = scroll.parentElement!
  const resize = (available: number, content: number) => {
    vi.spyOn(root, 'clientWidth', 'get').mockReturnValue(available)
    vi.spyOn(list, 'scrollWidth', 'get').mockReturnValue(content)
    act(() => { for (const notify of [...observers]) notify() })
  }
  return { view, resize, onSelect, documentKey, parts, observers }
}

test('name-only tabs switch by click and keyboard without sending navigation to the document', () => {
  const f = fixture()
  const tabs = screen.getAllByRole('tab')
  expect(tabs.map(tab => ({ name: tab.textContent, selected: tab.getAttribute('aria-selected'), tabIndex: tab.tabIndex }))).toMatchInlineSnapshot(`
    [
      {
        "name": "Summary",
        "selected": "true",
        "tabIndex": 0,
      },
      {
        "name": "Revenue and operating expenses",
        "selected": "false",
        "tabIndex": -1,
      },
      {
        "name": "Forecast",
        "selected": "false",
        "tabIndex": -1,
      },
    ]
  `)
  expect(tabs.every(tab => tab.querySelector('svg') === null)).toBe(true)
  expect(tabs[0]!.getAttribute('aria-controls')).toBe('sheet-panel')
  fireEvent.click(tabs[1]!)
  expect(f.onSelect).toHaveBeenLastCalledWith(4)
  expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, 0, -1])
  for (const [key, expected] of [['End', 2], ['ArrowRight', 0], ['ArrowLeft', 2], ['Home', 0]] as const) {
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key })
    expect(document.activeElement).toBe(tabs[expected])
    expect(f.onSelect).toHaveBeenLastCalledWith(f.parts[expected]!.index)
  }
  expect(f.documentKey).not.toHaveBeenCalled()
})

test('overflow menu selects sheets, dismisses, and disappears when the whole strip fits', async () => {
  const f = fixture()
  f.resize(500, 400)
  expect(screen.queryByRole('button', { name: en.sheetList })).toBeNull()
  f.resize(200, 400)
  const trigger = screen.getByRole('button', { name: en.sheetList })
  fireEvent.click(trigger)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(f.parts.map(part => part.name))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Forecast' }))
  await act(async () => {})
  expect(f.onSelect).toHaveBeenLastCalledWith(7)
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  // It fits only after reclaiming the menu button's width.
  f.resize(400, 400)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.queryByRole('button', { name: en.sheetList })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Forecast' }))
  f.resize(399, 400)
  expect(screen.getByRole('button', { name: en.sheetList })).toBeDefined()
  f.view.unmount()
  expect(f.observers.size).toBe(0)
})

test('full sheet names remain available through portaled tooltips', () => {
  const f = fixture()
  const longName = f.parts[1]!.name
  fireEvent.keyDown(window, { key: 'Tab' })
  act(() => { screen.getByRole('tab', { name: longName }).focus() })
  const tooltip = screen.getByRole('tooltip', { hidden: true })
  expect(tooltip.textContent).toBe(longName)
  expect(f.view.container.contains(tooltip)).toBe(false)
})

test('activating an offscreen sheet reveals either edge and leaves unrelated keys to the document', () => {
  const f = fixture()
  const tabs = screen.getAllByRole('tab')
  const scroll = screen.getByRole('tablist').parentElement!
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 200 } as DOMRect)
  vi.spyOn(tabs[0]!, 'getBoundingClientRect').mockReturnValue({ left: 50, right: 80 } as DOMRect)
  vi.spyOn(tabs[2]!, 'getBoundingClientRect').mockReturnValue({ left: 220, right: 250 } as DOMRect)
  fireEvent.keyDown(tabs[0]!, { key: 'End' })
  expect(scroll.scrollLeft).toBe(100)
  fireEvent.keyDown(tabs[2]!, { key: 'Home' })
  expect(scroll.scrollLeft).toBe(0)
  fireEvent.keyDown(tabs[0]!, { key: 'Enter' })
  expect(f.documentKey).toHaveBeenCalledOnce()
  f.resize(100, 300)
  screen.getByRole('button', { name: en.sheetList }).focus()
  f.resize(400, 300)
  expect(document.activeElement).toBe(tabs[0])
})


test('a part-list refresh can temporarily have no selected tab while the overflow menu retires', () => {
  const f = fixture(-1)
  f.resize(100, 300)
  fireEvent.click(screen.getByRole('button', { name: en.sheetList }))
  f.resize(400, 300)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getAllByRole('tab').every(tab => tab.getAttribute('aria-selected') === 'false')).toBe(true)
})
