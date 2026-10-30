// @vitest-environment jsdom
/** Isolated submenu placement work counts exclude Menu's separate root-position tracker. */
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { useMenuSubmenuPosition } from '../src/menu-submenu-position.ts'

let panelRect: DOMRect
let triggerRect: DOMRect
let childWidth: number
let childHeight: number
const intersections: ControlledIntersectionObserver[] = []
const resizes: ControlledResizeObserver[] = []

class ControlledIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin: string
  readonly scrollMargin = '0px 0px 0px 0px'
  readonly thresholds = [1]
  private target: Element | null = null
  constructor(private readonly callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.rootMargin = options?.rootMargin ?? ''
    intersections.push(this)
  }
  observe = vi.fn((element: Element) => { this.target = element })
  unobserve = vi.fn()
  disconnect = vi.fn()
  takeRecords = () => []
  emit(rect: DOMRect) {
    this.callback([{ target: this.target!, boundingClientRect: rect, intersectionRect: rect,
      rootBounds: rect, intersectionRatio: 1, isIntersecting: true, time: 0 }], this)
  }
}

class ControlledResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) { resizes.push(this) }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  emit() { this.callback([], this) }
}

function observers() {
  vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver)
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
}

async function flushPlacement() {
  await act(async () => { await Promise.resolve() })
  act(() => { vi.advanceTimersToNextFrame() })
}

function Placement({ active = true, contextual = false }: { active?: boolean; contextual?: boolean }) {
  const parent = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const child = useRef<HTMLDivElement>(null)
  const position = useMenuSubmenuPosition(active ? 'parent' : null, parent, trigger, child, contextual)
  return <>
    <div ref={parent} data-testid="parent"><button ref={trigger}>Parent</button></div>
    {active && <div ref={child} data-testid="child" style={position === null ? undefined : {
      left: position.left, top: position.top, maxHeight: position.maxHeight,
    }}>Choice</div>}
  </>
}

beforeEach(() => {
  vi.useFakeTimers()
  panelRect = new DOMRect(100, 100, 200, 100)
  triggerRect = new DOMRect(100, 100, 200, 100)
  childWidth = 200
  childHeight = 100
  intersections.length = 0
  resizes.length = 0
  vi.stubGlobal('innerWidth', 390)
  vi.stubGlobal('innerHeight', 768)
  vi.stubGlobal('ResizeObserver', undefined)
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'BUTTON' ? triggerRect : panelRect
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => childWidth)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => childHeight)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('does no geometry reads or width writes across 100 idle animation frames', async () => {
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
  const view = render(<Placement />)
  const writes = vi.spyOn(view.getByTestId('child').style, 'width', 'set')
  await flushPlacement()
  rect.mockClear(); width.mockClear(); height.mockClear(); writes.mockClear()
  act(() => { for (let frame = 0; frame < 100; frame++) vi.advanceTimersToNextFrame() })
  const counts = {
    rect: rect.mock.calls.length, width: width.mock.calls.length, height: height.mock.calls.length, widthWrites: writes.mock.calls.length,
  }
  console.info('submenu idle 100 frames', counts)
  expect(counts).toEqual({ rect: 0, width: 0, height: 0, widthWrites: 0 })
})

it.each([true, false])('fits the visual viewport in WebKit=%s coordinates and follows its events', (webkit) => {
  vi.stubGlobal('innerWidth', 1000)
  vi.stubGlobal('innerHeight', 900)
  vi.stubGlobal('CSS', { supports: () => webkit })
  const viewport = Object.assign(new EventTarget(), { width: 500, height: 400, offsetLeft: 40, offsetTop: 60 })
  vi.stubGlobal('visualViewport', viewport)
  const remove = vi.spyOn(viewport, 'removeEventListener')
  panelRect = webkit ? new DOMRect(100, 200, 200, 100) : new DOMRect(140, 260, 200, 100)
  triggerRect = webkit ? new DOMRect(104, 240, 192, 34) : new DOMRect(144, 300, 192, 34)
  const view = render(<Placement />)
  const card = view.getByTestId('child')
  expect(card.style.width).toBe('200px')
  expect(card.style.left).toBe('140px')
  expect(card.style.top).toBe('260px')
  expect(card.style.maxHeight).toBe('376px')
  act(() => { viewport.width = 900; viewport.dispatchEvent(new Event('resize')) })
  expect(card.style.width).toBe('')
  expect(card.style.left).toBe('344px')
  expect(card.style.top).toBe('300px')
  childHeight = 500
  act(() => { viewport.height = 180; viewport.offsetTop = 120; viewport.dispatchEvent(new Event('scroll')) })
  expect(card.style.maxHeight).toBe('156px')
  expect(card.style.top).toBe('132px')
  view.unmount()
  expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['resize', 'scroll']))
})

it('uses document client dimensions when there is no visual viewport', () => {
  vi.stubGlobal('visualViewport', undefined)
  vi.stubGlobal('innerWidth', 1000)
  vi.stubGlobal('innerHeight', 1000)
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390)
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600)
  const view = render(<Placement />)
  expect(view.getByTestId('child').style.width).toBe('200px')
  expect(view.getByTestId('child').style.maxHeight).toBe('576px')
})

it('tracks parent and row movement without idle polling and coalesces observer notifications', async () => {
  observers()
  vi.stubGlobal('innerWidth', 1024)
  const view = render(<Placement />)
  const card = view.getByTestId('child')
  const request = vi.spyOn(window, 'requestAnimationFrame')
  expect(card.style.left).toBe('304px')
  intersections[0]!.emit(panelRect)
  expect(request).not.toHaveBeenCalled()
  const original = [...intersections]
  panelRect = new DOMRect(400, 100, 200, 100)
  intersections[0]!.emit(panelRect)
  intersections[0]!.emit(panelRect)
  expect(request).toHaveBeenCalledTimes(1)
  await flushPlacement()
  expect(card.style.left).toBe('604px')
  expect(original.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true)
  triggerRect = new DOMRect(404, 740, 192, 34)
  intersections.at(-1)!.emit(triggerRect)
  await flushPlacement()
  expect(card.style.top).toBe('656px')
  expect(resizes[0]!.observe).toHaveBeenCalledTimes(3)
})

it('remeasures content and font changes while retaining page width and flipping when space becomes available', async () => {
  observers()
  const fonts = new EventTarget()
  const previousFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
  onTestFinished(() => {
    if (previousFonts === undefined) Reflect.deleteProperty(document, 'fonts')
    else Object.defineProperty(document, 'fonts', previousFonts)
  })
  panelRect = new DOMRect(40, 100, 300, 100)
  const view = render(<Placement />)
  const card = view.getByTestId('child')
  expect(card.style.width).toBe('300px')
  childWidth = 350
  card.textContent = 'A longer localized choice'
  await flushPlacement()
  expect(card.style.width).toBe('350px')
  expect(card.style.left).toBe('28px')
  childWidth = 200
  fonts.dispatchEvent(new Event('loadingdone'))
  await flushPlacement()
  expect(card.style.width).toBe('300px')
  childWidth = 320
  fonts.dispatchEvent(new Event('loadingerror'))
  await flushPlacement()
  expect(card.style.width).toBe('320px')
  vi.stubGlobal('innerWidth', 1024)
  act(() => { window.dispatchEvent(new Event('resize')) })
  expect(card.style.width).toBe('')
  expect(card.style.left).toBe('344px')
  panelRect = new DOMRect(700, 100, 300, 100)
  act(() => { window.dispatchEvent(new Event('scroll')) })
  expect(card.style.left).toBe('376px')
  childHeight = 1000
  resizes[0]!.emit()
  await flushPlacement()
  expect(card.style.maxHeight).toBe('744px')
  expect(card.style.top).toBe('12px')
  view.unmount()
  expect(resizes[0]!.disconnect).toHaveBeenCalledOnce()
  expect(intersections.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true)
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  rect.mockClear()
  fonts.dispatchEvent(new Event('loadingdone'))
  resizes[0]!.emit()
  intersections[0]!.emit(new DOMRect())
  await flushPlacement()
  expect(rect).not.toHaveBeenCalled()
})

it.each([true, false])('uses the contextual=%s top clearance for a tall child', (contextual) => {
  const root = document.documentElement
  const previous = root.style.getPropertyValue('--dsh-frame-top-clearance')
  root.style.setProperty('--dsh-frame-top-clearance', '96px')
  onTestFinished(() => {
    if (previous === '') root.style.removeProperty('--dsh-frame-top-clearance')
    else root.style.setProperty('--dsh-frame-top-clearance', previous)
  })
  childHeight = 1000
  const view = render(<Placement contextual={contextual} />)
  expect(view.getByTestId('child').style.top).toBe(contextual ? '12px' : '116px')
  expect(view.getByTestId('child').style.maxHeight).toBe(contextual ? '744px' : '640px')
})

it('observes ancestor attributes and ignores its own width writes', async () => {
  const view = render(<Placement />)
  const card = view.getByTestId('child')
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  await flushPlacement()
  rect.mockClear()
  card.style.width = '200px'
  await flushPlacement()
  expect(rect).not.toHaveBeenCalled()
  panelRect = new DOMRect(20, 150, 200, 100)
  view.container.style.transform = 'translateY(50px)'
  await flushPlacement()
  expect(card.style.top).toBe('150px')
  card.className = 'compact'
  await flushPlacement()
  expect(rect).toHaveBeenCalled()
})

it.each([true, false])('tracks a finite ancestor animation alreadyRunning=%s, then stops scheduling frames', (alreadyRunning) => {
  observers()
  vi.stubGlobal('innerWidth', 1024)
  let running = alreadyRunning
  const body = document.body
  const original = Object.getOwnPropertyDescriptor(body, 'getAnimations')
  Object.defineProperty(body, 'getAnimations', { configurable: true, value: () => [{ playState: running ? 'running' : 'finished' }] })
  onTestFinished(() => {
    if (original === undefined) Reflect.deleteProperty(body, 'getAnimations')
    else Object.defineProperty(body, 'getAnimations', original)
  })
  const view = render(<Placement />)
  const card = view.getByTestId('child')
  running = true
  act(() => { body.dispatchEvent(new Event('transitionrun', { bubbles: true })) })
  panelRect = new DOMRect(100, 100, 180, 100)
  act(() => { vi.advanceTimersToNextFrame() })
  expect(card.style.left).toBe('284px')
  panelRect = new DOMRect(100, 100, 160, 100)
  act(() => { vi.advanceTimersToNextFrame() })
  expect(card.style.left).toBe('264px')
  running = false
  act(() => { body.dispatchEvent(new Event('transitionend', { bubbles: true })); vi.advanceTimersToNextFrame() })
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  rect.mockClear()
  act(() => {
    document.dispatchEvent(new Event('animationstart'))
    card.dispatchEvent(new Event('animationstart', { bubbles: true }))
    for (let frame = 0; frame < 100; frame++) vi.advanceTimersToNextFrame()
  })
  expect(rect).not.toHaveBeenCalled()
  view.unmount()
  body.dispatchEvent(new Event('animationstart', { bubbles: true }))
  act(() => { vi.advanceTimersToNextFrame() })
  expect(rect).not.toHaveBeenCalled()
})

it('cancels pending placement and ignores already queued frames after close', () => {
  observers()
  const callbacks: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callbacks.push(callback); return callbacks.length })
  const cancel = vi.spyOn(window, 'cancelAnimationFrame')
  const view = render(<Placement />)
  resizes[0]!.emit()
  view.rerender(<Placement active={false} />)
  expect(cancel).toHaveBeenCalledWith(1)
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  rect.mockClear()
  act(() => { callbacks[0]!(0) })
  expect(rect).not.toHaveBeenCalled()
  expect(view.queryByTestId('child')).toBeNull()
})
