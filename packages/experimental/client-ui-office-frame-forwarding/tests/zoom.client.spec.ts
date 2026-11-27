// @vitest-environment jsdom
/** Pinch samples change document zoom without intercepting normal scrolling. */
import { afterEach, expect, test, vi } from 'vitest'
import { bindPinchZoom, documentViewport, fitZoom, restoreZoomAnchor } from '../src/client/zoom.ts'
import { headerCells } from '../src/client/headers.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

test('zoom and horizontal panning map to native document coordinates', () => {
  const scroll = { scrollLeft: 200, scrollTop: 120, clientWidth: 800, clientHeight: 600 }
  expect(documentViewport(scroll, 2, { pixelSize: 512, twipSize: 1920 })).toMatchInlineSnapshot(`
    {
      "height": 4500,
      "pixelSize": 512,
      "twipSize": 1920,
      "width": 6000,
      "x": 1500,
      "y": 900,
    }
  `)
})

test.each([1, 1.25, 1.333, 1.5, 2, 3])('headers consume the render window physical-to-CSS ratio at DPR %s', (dpr) => {
  const pixelSize = Math.round(1200 * dpr), twipSize = 18000
  const view = documentViewport({ scrollLeft: 0, scrollTop: 0, clientWidth: 1200, clientHeight: 800 }, 1, { pixelSize, twipSize })
  const ratio = view.pixelSize / (view.twipSize / 15)
  expect(headerCells([{ text: 0, size: 100 }, { text: 1, size: 120 }], ratio))
    .toEqual([{ text: '1', start: 100 / ratio, end: 120 / ratio }])
})

test('restoring a zoom anchor allows horizontal movement after a centered document expands', () => {
  const viewport = document.createElement('div'), content = document.createElement('div')
  viewport.append(content)
  document.body.append(viewport)
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 400, 600))
  restoreZoomAnchor(viewport, 0.5, { x: 600, y: 240, left: 300, top: 120 })
  expect(viewport.scrollLeft).toBe(100)
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(-100, 0, 1200, 1800))
  restoreZoomAnchor(viewport, 2, { x: 600, y: 240, left: 300, top: 120 })
  expect(viewport.scrollLeft).toBe(900)
  expect(viewport.scrollTop).toBe(360)
})

test('fit width preserves page scrolling while fit page contains both slide dimensions', () => {
  const document = { width: 12000, height: 18000 },
    viewport = { width: 600, height: 400 }
  expect(fitZoom(document, viewport, 'width')).toBe(0.75)
  expect(fitZoom(document, viewport, 'page')).toBeCloseTo(1 / 3)
  expect(fitZoom({ width: 18000, height: 9000 }, { width: 800, height: 600 }, 'page')).toBeCloseTo(2 / 3)
})

test('pinch coalesces around the pointer and follows the latest committed zoom', () => {
  const viewport = document.createElement('div')
  document.body.append(viewport)
  viewport.scrollTop = 200
  viewport.scrollLeft = 100
  let frame: FrameRequestCallback | undefined,
    zoom = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const update = vi.fn<Parameters<typeof bindPinchZoom>[2]>((next) => {
    zoom = next
  })
  const dispose = bindPinchZoom(viewport, () => ({ zoom, enabled: true }), update)
  const wheel = (ctrlKey: boolean): WheelEvent => {
    const event = new WheelEvent('wheel', { ctrlKey, deltaY: -30, clientX: 20, clientY: 40, cancelable: true })
    viewport.dispatchEvent(event)
    return event
  }
  try {
    expect(wheel(false).defaultPrevented).toBe(false)
    expect(update).not.toHaveBeenCalled()
    expect(wheel(true).defaultPrevented).toBe(true)
    wheel(true)
    frame!(0)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]?.[0]).toBeCloseTo(Math.exp(0.2))
    expect(update.mock.calls[0]?.[1]).toEqual({ x: 120, y: 240, left: 20, top: 40 })
    zoom = 2
    wheel(true)
    frame!(0)
    expect(update.mock.calls[1]?.[0]).toBeCloseTo(2 * Math.exp(0.1))
  } finally {
    dispose()
  }
  expect(wheel(true).defaultPrevented).toBe(false)
})

test('pinch line/page units scale their delta and inactive gestures do not schedule a commit', () => {
  const viewport = document.createElement('div')
  Object.defineProperty(viewport, 'clientHeight', { value: 500 })
  let frame: FrameRequestCallback | undefined, enabled = false
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const update = vi.fn(), dispose = bindPinchZoom(viewport, () => ({ zoom: 1, enabled }), update)
  try {
    viewport.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 1, deltaMode: 1 }))
    expect(frame).toBeUndefined()
    enabled = true
    for (const deltaMode of [1, 2]) {
      viewport.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 1, deltaMode }))
      frame!(0)
    }
    expect(update.mock.calls.map(([zoom]) => zoom as number)).toEqual([Math.exp(-16 / 300), Math.max(0.25, Math.exp(-500 / 300))])
  } finally { dispose() }
})

test('touch pinch scales around the moving midpoint while single-finger scrolling stays native', () => {
  const viewport = document.createElement('div'), content = document.createElement('div')
  viewport.append(content); document.body.append(viewport)
  viewport.scrollLeft = 100; viewport.scrollTop = 200
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, -200, 400, 800))
  let frame: FrameRequestCallback | undefined, zoom = 1, enabled = true
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const update = vi.fn<Parameters<typeof bindPinchZoom>[2]>((next) => { zoom = next })
  const dispose = bindPinchZoom(viewport, () => ({ zoom, enabled }), update)
  const touch = (type: string, points: { identifier: number; clientX: number; clientY: number }[], cancelable = true) => {
    const event = new TouchEvent(type, { touches: points as Touch[], cancelable })
    viewport.dispatchEvent(event); return event
  }
  const points = (left: number, right: number, y = 40) => [
    { identifier: 1, clientX: left, clientY: y }, { identifier: 2, clientX: right, clientY: y },
  ]
  try {
    expect(touch('touchstart', points(0, 100).slice(0, 1)).defaultPrevented).toBe(false)
    expect(touch('touchmove', points(0, 100).slice(0, 1)).defaultPrevented).toBe(false)
    expect(frame).toBeUndefined()
    expect(touch('touchstart', points(0, 100)).defaultPrevented).toBe(true)
    expect(touch('touchmove', points(0, 150)).defaultPrevented).toBe(true)
    touch('touchmove', points(0, 200, 60))
    frame!(0)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenLastCalledWith(2, { x: 0, y: 240, left: 100, top: 60 })
    touch('touchmove', points(0, 800)); frame!(0)
    expect(update.mock.lastCall?.[0]).toBe(4)
    touch('touchmove', points(0, 1)); frame!(0)
    expect(update.mock.lastCall?.[0]).toBe(0.25)
    expect(touch('touchend', []).defaultPrevented).toBe(false)
    touch('touchstart', points(0, 100)); touch('touchmove', points(0, 200)); frame!(0)
    expect(update.mock.lastCall?.[0]).toBe(0.5)
    enabled = false
    expect(touch('touchmove', points(0, 300)).defaultPrevented).toBe(false)
    enabled = true
    expect(touch('touchmove', points(0, 300), false).defaultPrevented).toBe(false)
    touch('touchstart', points(0, 0)); touch('touchmove', points(0, 100))
    const calls = update.mock.calls.length
    touch('touchmove', points(0, 200)); enabled = false; frame!(0)
    expect(update).toHaveBeenCalledTimes(calls)
    enabled = true
    touch('touchcancel', [])
    touch('touchstart', points(0, 100)); touch('touchmove', points(0, 200))
    touch('touchcancel', [])
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
  } finally { dispose() }
  expect(touch('touchstart', points(0, 100)).defaultPrevented).toBe(false)
})
