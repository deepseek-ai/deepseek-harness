// @vitest-environment jsdom
/** Shared zoom fitting follows pane size until the reader selects a fixed scale. */
import { useState, type CSSProperties } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fitWidthZoom, ZoomViewport, zoomSurfaceClass } from '../src/client/zoom/ZoomViewport.tsx'
import { FIT_WIDTH, type ZoomPreference } from '../src/client/zoom/types.ts'

let width = 500
let resize: ResizeObserverCallback | undefined
let elementFromPointDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  width = 500
  elementFromPointDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  if (elementFromPointDescriptor === undefined) Reflect.deleteProperty(document, 'elementFromPoint')
  else Object.defineProperty(document, 'elementFromPoint', elementFromPointDescriptor)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('fits without upscaling, follows resize, and leaves fixed zoom unchanged', () => {
  const onRenderZoom = vi.fn()
  function View() {
    const [preference, setPreference] = useState<ZoomPreference>(FIT_WIDTH)
    return <ZoomViewport preference={preference} intrinsicWidth={1000} horizontalInset={20}
      labels={{ controls: 'Zoom controls', menu: 'Choose zoom', out: 'Zoom out', into: 'Zoom in',
        fitWidth: 'Fit width', value: percent => `${String(percent)}%` }} signal={new AbortController().signal}
      scrollportRef={() => {}} onPreference={setPreference} onRenderZoom={onRenderZoom}>
      <div className={zoomSurfaceClass} style={{ '--document-zoom-width': '1000px' } as CSSProperties} />
    </ZoomViewport>
  }
  const view = render(<View />)
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('48%')
  expect(onRenderZoom).toHaveBeenLastCalledWith(0.48)
  expect(view.container.querySelector('[data-document-zoom-mode]')?.getAttribute('data-document-zoom-mode')).toBe('fit-width')
  width = 320
  act(() => { resize?.([], {} as ResizeObserver) })
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('30%')
  expect(onRenderZoom).toHaveBeenLastCalledWith(0.3)
  fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '100%' }))
  width = 220
  act(() => { resize?.([], {} as ResizeObserver) })
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('100%')
  expect(onRenderZoom).toHaveBeenLastCalledWith(1)
  fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fit width' }))
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('20%')
  fireEvent.wheel(view.container.querySelector('[data-document-zoom-scrollport]') as HTMLDivElement,
    { ctrlKey: true, deltaY: 40 })
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('25%')
})

it('resolves missing and small content to 100 percent', () => {
  expect(fitWidthZoom(200, undefined, 24)).toBe(1)
  expect(fitWidthZoom(200, 0, 24)).toBe(1)
  expect(fitWidthZoom(200, 100, 24)).toBe(1)
})

it('fits the initial pane and allows fixed zoom without resize observation', () => {
  vi.stubGlobal('ResizeObserver', undefined)
  const onPreference = vi.fn()
  render(<ZoomViewport preference={FIT_WIDTH} intrinsicWidth={1000} horizontalInset={20}
    labels={{ controls: 'Zoom controls', menu: 'Choose zoom', out: 'Zoom out', into: 'Zoom in',
      fitWidth: 'Fit width', value: percent => `${String(percent)}%` }} signal={new AbortController().signal}
    scrollportRef={() => {}} onPreference={onPreference}>
    <div className={zoomSurfaceClass} />
  </ZoomViewport>)
  const menu = screen.getByRole('button', { name: 'Choose zoom' })
  expect(menu.textContent).toContain('48%')
  fireEvent.click(menu)
  fireEvent.click(screen.getByRole('menuitem', { name: '100%' }))
  expect(onPreference).toHaveBeenCalledExactlyOnceWith({ kind: 'fixed', scale: 1 })
  expect(menu.textContent).toContain('100%')
})

it('keeps a centred surface point under the pointer while crossing into overflow', () => {
  const onPreference = vi.fn()
  const view = render(<ZoomViewport preference={{ kind: 'fixed', scale: 0.5 }} intrinsicWidth={400}
    labels={{ controls: 'Zoom controls', menu: 'Choose zoom', out: 'Zoom out', into: 'Zoom in',
      fitWidth: 'Fit width', value: percent => `${String(percent)}%` }} signal={new AbortController().signal}
    scrollportRef={() => {}} onPreference={onPreference}>
    <div className={zoomSurfaceClass} data-document-zoom-surface
      style={{ '--document-zoom-width': '400px' } as CSSProperties} />
  </ZoomViewport>)
  const frame = view.container.querySelector('[data-document-zoom-frame]') as HTMLElement
  const scrollport = view.container.querySelector('[data-document-zoom-scrollport]') as HTMLDivElement
  const surface = view.container.querySelector('[data-document-zoom-surface]') as HTMLDivElement
  Object.defineProperties(scrollport, {
    clientWidth: { configurable: true, value: 600 },
    clientHeight: { configurable: true, value: 400 },
  })
  scrollport.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400,
    width: 600, height: 400, toJSON: () => ({}) })
  surface.getBoundingClientRect = () => {
    const scale = Number(frame.style.getPropertyValue('--document-zoom'))
    const surfaceWidth = 400 * scale
    const surfaceHeight = 200 * scale
    const left = (surfaceWidth < 600 ? (600 - surfaceWidth) / 2 : 0) - scrollport.scrollLeft
    const top = (400 - surfaceHeight) / 2 - scrollport.scrollTop
    return { x: left, y: top, left, top, right: left + surfaceWidth, bottom: top + surfaceHeight,
      width: surfaceWidth, height: surfaceHeight, toJSON: () => ({}) }
  }
  const elementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => surface })
  try {
    for (let index = 0; index < 3; index++) {
      scrollport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
        deltaY: -40, clientX: 300, clientY: 200 }))
    }
    const scale = 0.5 * Math.exp(1.2)
    expect(Number(frame.style.getPropertyValue('--document-zoom'))).toBeCloseTo(scale)
    expect(scrollport.scrollLeft).toBeCloseTo((400 * scale - 600) / 2)
    expect(scrollport.scrollTop).toBeCloseTo(0)
    expect(onPreference).not.toHaveBeenCalled()
  } finally {
    if (elementFromPoint === undefined) Reflect.deleteProperty(document, 'elementFromPoint')
    else Object.defineProperty(document, 'elementFromPoint', elementFromPoint)
  }
})

it('reveals from the bottom zone and delays hiding while controls stay active', async () => {
  vi.useFakeTimers()
  const view = render(<ZoomViewport preference={FIT_WIDTH} intrinsicWidth={400}
    labels={{ controls: 'Zoom controls', menu: 'Choose zoom', out: 'Zoom out', into: 'Zoom in',
      fitWidth: 'Fit width', value: percent => `${String(percent)}%` }} signal={new AbortController().signal}
    scrollportRef={() => {}} onPreference={() => {}}>
    <div className={zoomSurfaceClass} style={{ '--document-zoom-width': '400px' } as CSSProperties} />
  </ZoomViewport>)
  const frame = view.container.querySelector('[data-document-zoom-frame]') as HTMLElement
  const controls = view.container.querySelector('[data-document-zoom-controls]') as HTMLElement
  frame.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 400,
    width: 500, height: 400, toJSON: () => ({}) })
  expect(controls.hasAttribute('data-document-zoom-visible')).toBe(false)
  fireEvent.pointerMove(frame, { pointerType: 'mouse', clientY: 350 })
  expect(controls.getAttribute('data-document-zoom-visible')).toBe('true')
  fireEvent.pointerMove(frame, { pointerType: 'mouse', clientY: 100 })
  await act(async () => { await vi.advanceTimersByTimeAsync(419) })
  expect(controls.getAttribute('data-document-zoom-visible')).toBe('true')
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(controls.hasAttribute('data-document-zoom-visible')).toBe(false)

  fireEvent.pointerMove(frame, { pointerType: 'mouse', clientY: 350 })
  fireEvent.pointerEnter(controls)
  fireEvent.pointerMove(frame, { pointerType: 'mouse', clientY: 100 })
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(controls.getAttribute('data-document-zoom-visible')).toBe('true')
  fireEvent.pointerLeave(controls)
  await act(async () => { await vi.advanceTimersByTimeAsync(420) })
  expect(controls.hasAttribute('data-document-zoom-visible')).toBe(false)

  const menuButton = screen.getByRole('button', { name: 'Choose zoom' })
  fireEvent.focus(menuButton)
  expect(controls.getAttribute('data-document-zoom-visible')).toBe('true')
  fireEvent.pointerLeave(frame)
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(controls.getAttribute('data-document-zoom-visible')).toBe('true')
  fireEvent.blur(menuButton)
  await act(async () => { await vi.advanceTimersByTimeAsync(420) })
  expect(controls.hasAttribute('data-document-zoom-visible')).toBe(false)

  fireEvent.pointerMove(frame, { pointerType: 'mouse', clientY: 350 })
  fireEvent.click(menuButton)
  fireEvent.pointerLeave(frame)
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(controls.getAttribute('data-document-zoom-visible')).toBe('true')
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  await act(async () => { await vi.advanceTimersByTimeAsync(420) })
  expect(controls.hasAttribute('data-document-zoom-visible')).toBe(false)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
