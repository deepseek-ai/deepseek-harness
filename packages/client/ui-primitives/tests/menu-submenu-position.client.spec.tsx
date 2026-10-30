// @vitest-environment jsdom
/** Submenu geometry and shared overlay lifecycle; browser layout is verified in the Web lane. */
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { placeMenuSubmenu } from '../src/menu-submenu-position.ts'
import { usePositionedOverlay } from '../src/useAnchoredPosition.ts'

let panelRect: DOMRect
let triggerRect: DOMRect
let childWidth: number
let childHeight: number
const resizes: ControlledResizeObserver[] = []

class ControlledResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) { resizes.push(this) }
  observe = vi.fn<ResizeObserver['observe']>()
  unobserve = vi.fn()
  disconnect = vi.fn()
  emit() { this.callback([], this) }
}

function Placement({ active = true, contextual = false, revision = 0 }: { active?: boolean; contextual?: boolean; revision?: number }) {
  const parent = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const child = useRef<HTMLDivElement>(null)
  const position = usePositionedOverlay({ open: active, parentRef: parent, anchorRef: trigger, panelRef: child,
    gap: 4, margin: 12, frameClearance: !contextual, placement: placeMenuSubmenu, layoutKey: revision })
  return <>
    <div ref={parent} data-testid="parent"><button ref={trigger}>Parent</button></div>
    {active && <div ref={child} data-testid="child" data-page={position?.page} style={position?.style}>Choice</div>}
  </>
}

beforeEach(() => {
  vi.useFakeTimers()
  panelRect = new DOMRect(100, 100, 200, 100)
  triggerRect = new DOMRect(104, 140, 192, 34)
  childWidth = 200
  childHeight = 100
  resizes.length = 0
  vi.stubGlobal('innerWidth', 390)
  vi.stubGlobal('innerHeight', 768)
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'BUTTON' ? triggerRect : panelRect
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => childWidth)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => childHeight)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([
  { parentX: 100, right: 1012, width: 200, left: 304, top: 140, page: false },
  { parentX: 780, right: 1012, width: 200, left: 576, top: 140, page: false },
  { parentX: 100, right: 378, width: 200, left: 100, top: 100, page: true },
  { parentX: 100, right: 378, width: 500, left: 100, top: 100, page: true },
  { parentX: 12, right: 416, width: 200, left: 216, top: 140, page: false },
])('places a child at $left/$top with page=$page', ({ parentX, right, width, left, top, page }) => {
  expect(placeMenuSubmenu({ parent: new DOMRect(parentX, 100, 200, 100), anchor: triggerRect,
    width, gap: 4, bounds: { left: 12, right } })).toEqual({ left, top, page,
    ...(page ? { width: Math.min(Math.max(200, width), right - 12) } : {}) })
})

it.each([true, false])('fits the visual viewport in WebKit=%s coordinates and follows its events', (webkit) => {
  vi.stubGlobal('CSS', { supports: () => webkit })
  const viewport = Object.assign(new EventTarget(), { width: 500, height: 400, offsetLeft: 40, offsetTop: 60 })
  vi.stubGlobal('visualViewport', viewport)
  const remove = vi.spyOn(viewport, 'removeEventListener')
  panelRect = webkit ? new DOMRect(100, 200, 200, 100) : new DOMRect(140, 260, 200, 100)
  triggerRect = webkit ? new DOMRect(104, 240, 192, 34) : new DOMRect(144, 300, 192, 34)
  const view = render(<Placement />)
  const card = view.getByTestId('child')
  expect(card.style.getPropertyValue('--dsh-anchored-width')).toBe('200px')
  expect(card.style.left).toBe('140px')
  expect(card.style.top).toBe('260px')
  expect(card.style.getPropertyValue('--dsh-anchored-max-height')).toBe('376px')
  act(() => { viewport.width = 900; viewport.dispatchEvent(new Event('resize')) })
  expect(card.style.getPropertyValue('--dsh-anchored-width')).toBe('max-content')
  expect(card.style.left).toBe('344px')
  expect(card.style.top).toBe('300px')
  childHeight = 500
  act(() => { viewport.height = 180; viewport.offsetTop = 120; viewport.dispatchEvent(new Event('scroll')) })
  expect(card.style.getPropertyValue('--dsh-anchored-max-height')).toBe('156px')
  expect(card.style.top).toBe('132px')
  view.unmount()
  expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['resize', 'scroll']))
})

it('uses document dimensions and remeasures natural width on committed content changes', () => {
  vi.stubGlobal('visualViewport', undefined)
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390)
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600)
  panelRect = new DOMRect(40, 100, 300, 100)
  const view = render(<Placement />)
  const card = view.getByTestId('child')
  expect(card.style.getPropertyValue('--dsh-anchored-width')).toBe('300px')
  expect(card.style.getPropertyValue('--dsh-anchored-max-height')).toBe('576px')
  childWidth = 350
  view.rerender(<Placement revision={1} />)
  expect(card.style.getPropertyValue('--dsh-anchored-width')).toBe('350px')
  expect(card.style.left).toBe('28px')
  childWidth = 200
  view.rerender(<Placement revision={2} />)
  expect(card.style.getPropertyValue('--dsh-anchored-width')).toBe('300px')
})

it('follows parent and row movement through the shared animation-frame tracker', () => {
  vi.stubGlobal('innerWidth', 1024)
  const view = render(<Placement />)
  const card = view.getByTestId('child')
  panelRect = new DOMRect(400, 100, 200, 100)
  act(() => { vi.advanceTimersToNextFrame() })
  expect(card.style.left).toBe('604px')
  triggerRect = new DOMRect(404, 740, 192, 34)
  act(() => { vi.advanceTimersToNextFrame() })
  expect(card.style.top).toBe('656px')
  childHeight = 1000
  act(() => { resizes[0]!.emit() })
  expect(card.style.top).toBe('12px')
  expect(resizes[0]!.observe.mock.calls.map(([node]) => node)).toEqual([view.getByRole('button'), card, view.getByTestId('parent')])
})

it.each([true, false])('uses contextual=%s top clearance for a tall child', (contextual) => {
  const root = document.documentElement
  const previous = root.style.getPropertyValue('--dsh-frame-top-clearance')
  root.style.setProperty('--dsh-frame-top-clearance', '96px')
  onTestFinished(() => {
    if (previous === '') root.style.removeProperty('--dsh-frame-top-clearance')
    else root.style.setProperty('--dsh-frame-top-clearance', previous)
  })
  childHeight = 1000
  triggerRect = new DOMRect(100, 100, 200, 100)
  const view = render(<Placement contextual={contextual} />)
  expect(view.getByTestId('child').style.top).toBe(contextual ? '12px' : '116px')
  expect(view.getByTestId('child').style.getPropertyValue('--dsh-anchored-max-height')).toBe(contextual ? '744px' : '640px')
})

it('restores size variables and ignores queued observer and frame callbacks after close', () => {
  const callbacks: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callbacks.push(callback); return callbacks.length })
  const cancel = vi.spyOn(window, 'cancelAnimationFrame')
  const view = render(<Placement />)
  const card = view.getByTestId('child')
  view.rerender(<Placement active={false} />)
  expect(cancel).toHaveBeenCalledWith(1)
  expect(resizes[0]!.disconnect).toHaveBeenCalledOnce()
  for (const name of ['width', 'max-width', 'max-height']) expect(card.style.getPropertyValue(`--dsh-anchored-${name}`)).toBe('')
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  rect.mockClear()
  act(() => { callbacks[0]!(0); resizes[0]!.emit(); window.dispatchEvent(new Event('scroll')) })
  expect(rect).not.toHaveBeenCalled()
  expect(view.queryByTestId('child')).toBeNull()
})
