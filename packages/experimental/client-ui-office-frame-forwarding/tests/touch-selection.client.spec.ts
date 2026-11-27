// @vitest-environment jsdom
/** Hold recognition preserves browser scrolling and releases native selection across cancellation. */
import { afterEach, expect, test, vi } from 'vitest'
import { bindTouchSelection } from '../src/client/touch-selection.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren() })

function fixture() {
  vi.useFakeTimers()
  const viewport = document.createElement('div'), canvas = document.createElement('canvas')
  viewport.append(canvas); document.body.append(viewport)
  let enabled = true
  const pointer = vi.fn(), release = vi.fn()
  const dispose = bindTouchSelection(viewport, { target: canvas, enabled: () => enabled, pointer, release },
    { holdMs: 450, movementTolerance: 8 })
  const point = (clientX = 20, clientY = 30, identifier = 1) => ({ clientX, clientY, identifier })
  const touch = (type: string, points = [point()], cancelable = true, target: HTMLElement = canvas) => {
    const event = new TouchEvent(type, { touches: points as Touch[], bubbles: true, cancelable })
    target.dispatchEvent(event); return event
  }
  const menu = () => {
    const event = new Event('contextmenu', { bubbles: true, cancelable: true })
    canvas.dispatchEvent(event); return event
  }
  return { viewport, canvas, pointer, release, dispose, point, touch, menu, enabled: (value: boolean) => { enabled = value } }
}

test('450ms hold tolerates 8 CSS pixels, selects from the original anchor and consumes drag and release', () => {
  const f = fixture()
  try {
    expect(f.menu().defaultPrevented).toBe(false)
    expect(f.touch('touchstart').defaultPrevented).toBe(false)
    expect(f.menu().defaultPrevented).toBe(true)
    vi.advanceTimersByTime(449)
    expect(f.pointer).not.toHaveBeenCalled()
    expect(f.touch('touchmove', [f.point(28, 30)]).defaultPrevented).toBe(false)
    vi.advanceTimersByTime(1)
    expect(f.pointer).toHaveBeenCalledExactlyOnceWith(f.point(), 0)
    expect(f.touch('touchmove', [f.point(100, 80)]).defaultPrevented).toBe(true)
    expect(f.pointer).toHaveBeenLastCalledWith(f.point(100, 80), 2)
    expect(f.touch('touchend', []).defaultPrevented).toBe(true)
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.menu().defaultPrevented).toBe(false)
    f.touch('touchmove'); f.touch('touchend', [])
    expect(f.release).toHaveBeenCalledTimes(1)
  } finally { f.dispose() }
})

test.each(['movement', 'tap', 'cancel', 'blur', 'second finger', 'dispose'] as const)(
  '%s cancels a pending hold without preventing normal scrolling', (reason) => {
    const f = fixture()
    try {
      f.touch('touchstart')
      if (reason === 'movement') expect(f.touch('touchmove', [f.point(28, 31)]).defaultPrevented).toBe(false)
      if (reason === 'tap') expect(f.touch('touchend', []).defaultPrevented).toBe(false)
      if (reason === 'cancel') f.touch('touchcancel', [])
      if (reason === 'blur') window.dispatchEvent(new Event('blur'))
      if (reason === 'second finger') f.touch('touchstart', [f.point(), f.point(40, 30, 2)])
      if (reason === 'dispose') f.dispose()
      vi.advanceTimersByTime(450)
      expect(f.pointer).not.toHaveBeenCalled()
      expect(f.release).not.toHaveBeenCalled()
    } finally { f.dispose() }
  },
)

test.each(['cancel', 'blur', 'second finger', 'dispose', 'disabled', 'native scroll', 'different finger'] as const)(
  '%s releases an admitted native press exactly once', (reason) => {
    const f = fixture()
    try {
      f.touch('touchstart'); vi.advanceTimersByTime(450)
      if (reason === 'cancel') f.touch('touchcancel', [])
      if (reason === 'blur') window.dispatchEvent(new Event('blur'))
      if (reason === 'second finger') f.touch('touchstart', [f.point(), f.point(40, 30, 2)])
      if (reason === 'dispose') f.dispose()
      if (reason === 'disabled') { f.enabled(false); f.touch('touchmove') }
      if (reason === 'native scroll') f.touch('touchmove', [f.point()], false)
      if (reason === 'different finger') f.touch('touchmove', [f.point(30, 30, 2)])
      expect(f.release).toHaveBeenCalledTimes(1)
      f.touch('touchend', [], false); f.dispose()
      expect(f.release).toHaveBeenCalledTimes(1)
    } finally { f.dispose() }
  },
)

test('background touches, noncancelable input and unavailable selection do not start a hold', () => {
  const f = fixture()
  try {
    f.touch('touchstart', [f.point()], true, f.viewport); vi.advanceTimersByTime(450)
    f.touch('touchstart', [f.point()], false); vi.advanceTimersByTime(450)
    f.enabled(false); f.touch('touchstart'); vi.advanceTimersByTime(450)
    f.enabled(true); f.touch('touchstart'); f.enabled(false); vi.advanceTimersByTime(450)
    expect(f.pointer).not.toHaveBeenCalled()
    f.enabled(true); f.touch('touchstart'); f.touch('touchmove', [])
    vi.advanceTimersByTime(450)
    f.touch('touchstart'); f.touch('touchmove', [f.point(20, 30, 2)])
    vi.advanceTimersByTime(450)
    expect(f.pointer).not.toHaveBeenCalled()
    f.touch('touchstart'); vi.advanceTimersByTime(450)
    expect(f.touch('touchend', [], false).defaultPrevented).toBe(false)
    expect(f.release).toHaveBeenCalledTimes(1)
  } finally { f.dispose() }
})

test('disposed listeners cannot start another hold or suppress the context menu', () => {
  const f = fixture()
  f.dispose()
  f.touch('touchstart'); vi.advanceTimersByTime(450)
  expect(f.pointer).not.toHaveBeenCalled()
  expect(f.menu().defaultPrevented).toBe(false)
})

test('browser ownership of a touch pan cancels waiting; admitted touch selection uses touchcancel for release', () => {
  const f = fixture()
  const cancel = (pointerType: string) => {
    const event = new Event('pointercancel', { bubbles: true })
    Object.defineProperty(event, 'pointerType', { value: pointerType })
    f.canvas.dispatchEvent(event)
  }
  try {
    cancel('touch')
    f.touch('touchstart'); cancel('touch'); vi.advanceTimersByTime(450)
    expect(f.pointer).not.toHaveBeenCalled()
    f.touch('touchstart'); cancel('mouse'); vi.advanceTimersByTime(450)
    expect(f.pointer).toHaveBeenCalledTimes(1)
    cancel('touch')
    expect(f.release).not.toHaveBeenCalled()
    f.touch('touchcancel', [])
    expect(f.release).toHaveBeenCalledTimes(1)
  } finally { f.dispose() }
})
