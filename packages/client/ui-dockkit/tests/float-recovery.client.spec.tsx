// @vitest-environment jsdom
/**
 * Floating-panel edge recovery through the rendered layer: resistance while a
 * move is past an edge, one legal `moveFloat` per release, the spring back to
 * it, cancellation, reduced motion, and the viewport projection. Frames and
 * the clock are driven by hand so every trajectory is deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { FloatLayer } from '../src/components/FloatLayer.tsx'
import type { DockIntents } from '../src/contract/adapter.ts'
import type { FloatRect, PaneId } from '../src/contract/types.ts'
import { floatRect, getPane } from '../src/engine/tree.ts'
import { seededController, TEST_LABELS } from './fixtures.client.ts'

let now = 0
let queued = new Map<number, FrameRequestCallback>()
let nextFrame = 1

beforeEach(() => {
  now = 0
  queued = new Map()
  nextFrame = 1
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    queued.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queued.delete(id) })
  viewport(1024, 768)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Set the window size the layer reads. */
function viewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

/** Advance the clock and run every frame callback that was waiting. */
function frame(ms = 16): void {
  now += ms
  const due = [...queued.values()]
  queued.clear()
  act(() => { for (const callback of due) callback(now) })
}

/** Run frames until no callback is waiting; returns the elapsed time. */
function runOut(): number {
  const started = now
  for (let guard = 0; queued.size > 0; guard++) {
    if (guard > 200) throw new Error('animation never ended')
    frame()
  }
  return now - started
}

/** One floating panel over a live controller whose recorded moves redraw the layer. */
function mounted(rect: FloatRect = { x: 100, y: 80, width: 300, height: 200 }) {
  const controller = seededController()
  const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
  const paneId = controller.floatTab(tabId, rect)
  const renderTab = vi.fn(() => null)
  const redraw = (): void => {
    view.rerender(<FloatLayer state={controller.getSnapshot().state} intents={intents} labels={TEST_LABELS} renderTab={renderTab} />)
  }
  const moveFloat = vi.fn((id: PaneId, x: number, y: number) => { controller.moveFloat(id, x, y); redraw() })
  const resizeFloat = vi.fn((id: PaneId, next: FloatRect) => { controller.resizeFloat(id, next); redraw() })
  const focusPane = vi.fn((id: PaneId) => { controller.focusPane(id); redraw() })
  const intents: DockIntents = {
    focusTab: vi.fn(), focusPane, splitPane: vi.fn(), addTab: vi.fn(), closeTab: vi.fn(), duplicateTab: vi.fn(),
    floatTab: vi.fn(), unfloatPane: vi.fn(), placeTab: vi.fn(), dropTab: vi.fn(), moveFloat, resizeFloat,
    resizeSplit: vi.fn(),
  }
  const view = render(<FloatLayer state={controller.getSnapshot().state} intents={intents} labels={TEST_LABELS} renderTab={renderTab} />)
  const panel = (): HTMLElement => view.container.querySelector<HTMLElement>(`[data-dockkit-float="${paneId}"]`) as HTMLElement
  const grip = (): HTMLElement => panel().querySelector<HTMLElement>('[data-dockkit-float-grip]') as HTMLElement
  // A lifted panel writes left and top inline; a resting one publishes them to the `.float` rule.
  const drawn = (side: 'left' | 'top', axis: 'x' | 'y'): number =>
    Number.parseFloat(panel().style.getPropertyValue(side) || panel().style.getPropertyValue(`--dsh-dockkit-float-${axis}`))
  const left = (): number => drawn('left', 'x')
  const top = (): number => drawn('top', 'y')
  const stored = (): FloatRect => floatRect(getPane(controller.getSnapshot().state, paneId))
  const corner = (): HTMLElement => panel().querySelector<HTMLElement>('[data-dockkit-float-resize]') as HTMLElement
  return { controller, tabId, paneId, view, redraw, renderTab, intents, moveFloat, resizeFloat, focusPane, left, top, grip, corner, stored }
}

/** Press the grip at `from`, move to `to`, and optionally release there. */
function drag(grip: HTMLElement, from: readonly [number, number], to: readonly [number, number], release = true): void {
  fireEvent.pointerDown(grip, { clientX: from[0], clientY: from[1], pointerId: 7, button: 0 })
  fireEvent.pointerMove(window, { pointerId: 7, clientX: to[0], clientY: to[1] })
  if (release) fireEvent.pointerUp(window, { pointerId: 7, clientX: to[0], clientY: to[1] })
}

describe('dragging past an edge', () => {
  it('draws the panel with resistance, records one legal move, and springs there', () => {
    const h = mounted()
    // The panel's legal x tops out at 1024 - 300 = 724; the pointer asks for 120 px beyond it.
    drag(h.grip(), [150, 90], [150 + 744, 90], false)
    expect(h.left()).toBeCloseTo(784)
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 894, clientY: 90 })
    expect(h.moveFloat).toHaveBeenCalledTimes(1)
    expect(h.moveFloat).toHaveBeenCalledWith(h.paneId, 724, 80)
    expect(h.stored()).toMatchObject({ x: 724, y: 80 })
    expect(h.left()).toBeCloseTo(784)

    const trail: number[] = []
    for (let guard = 0; queued.size > 0 && guard < 100; guard++) {
      frame()
      trail.push(h.left())
    }
    expect(queued.size).toBe(0)
    expect(now).toBeLessThan(900)
    expect(h.left()).toBe(724)
    // The return overshoots inward by a few pixels, never back outside.
    expect(Math.min(...trail)).toBeLessThan(724)
    expect(Math.min(...trail)).toBeGreaterThan(724 - 120 * 0.06)
    expect(h.top()).toBe(80)
  })

  it('does not re-render the body through the drag and the return, and re-renders it for a new renderer', () => {
    const h = mounted()
    const rendered = h.renderTab.mock.calls.length
    drag(h.grip(), [150, 90], [150 + 744, 90])
    runOut()
    expect(h.left()).toBe(724)
    // The release's moveFloat redraws the layer, but the tab record and the renderer stay the same.
    expect(h.renderTab).toHaveBeenCalledTimes(rendered)
    const next = vi.fn(() => null)
    h.view.rerender(<FloatLayer state={h.controller.getSnapshot().state} intents={h.intents} labels={TEST_LABELS} renderTab={next} />)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('undoes the whole gesture in one step', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [150 - 400, 90])
    runOut()
    expect(h.stored().x).toBe(0)
    expect(h.controller.undo()).toBe(true)
    expect(h.stored().x).toBe(100)
  })

  it('carries a fling: a fast release outward keeps travelling before it turns back', () => {
    const fast = mounted()
    fireEvent.pointerDown(fast.grip(), { clientX: 150, clientY: 90, pointerId: 7, button: 0 })
    now += 50
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 850, clientY: 90 })
    now += 20
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 894, clientY: 90 })
    const released = fast.left()
    frame()
    expect(fast.left()).toBeGreaterThan(released)
    runOut()
    expect(fast.left()).toBe(724)
  })

  it('starts a fling at the drawn speed, so even the fastest one stays within the resistance limit', () => {
    const h = mounted()
    fireEvent.pointerDown(h.grip(), { clientX: 150, clientY: 90, pointerId: 7, button: 0 })
    // A long push that ends in a fast flick: the samples older than the velocity window drop out.
    for (let x = 150; x <= 850; x += 50) {
      now += 50
      fireEvent.pointerMove(window, { pointerId: 7, clientX: x, clientY: 90 })
    }
    now += 10
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 3000, clientY: 90 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 3000, clientY: 90 })
    const trail = [h.left()]
    for (let guard = 0; queued.size > 0 && guard < 100; guard++) {
      frame()
      trail.push(h.left())
    }
    expect(Math.max(...trail)).toBeLessThan(724 + 120)
    expect(h.left()).toBe(724)
  })

  it('draws above the top edge while dragged and springs back below it', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [150, 90 - 200], false)
    expect(h.top()).toBeLessThan(0)
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 150, clientY: -110 })
    expect(h.moveFloat).toHaveBeenCalledWith(h.paneId, 100, 0)
    runOut()
    expect(h.top()).toBe(0)
  })

  it('springs straight back after a slow push, which has no release velocity', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [150 + 744, 90])
    const released = h.left()
    frame()
    expect(h.left()).toBeLessThan(released)
  })

  it('leaves a release inside the viewport where it landed, with no animation', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [170, 110])
    expect(h.moveFloat).toHaveBeenCalledWith(h.paneId, 120, 100)
    expect(queued.size).toBe(0)
    expect(h.left()).toBe(120)
  })

  it('records nothing for a push that ends where the panel already was, yet still springs back', () => {
    const h = mounted({ x: 724, y: 80, width: 300, height: 200 })
    drag(h.grip(), [800, 90], [900, 90])
    expect(h.moveFloat).not.toHaveBeenCalled()
    expect(queued.size).toBe(1)
    runOut()
    expect(h.left()).toBe(724)
  })
})

describe('interrupting a return', () => {
  it('stops on a new press and picks the panel up where it is drawn', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [150 + 744, 90])
    frame()
    frame()
    const drawn = h.left()
    expect(drawn).toBeGreaterThan(724)
    fireEvent.pointerDown(h.grip(), { clientX: 800, clientY: 90, pointerId: 8, button: 0 })
    expect(queued.size).toBe(0)
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 800, clientY: 90 })
    expect(h.left()).toBeCloseTo(drawn, 6)
    // Released in place, outside the viewport: no second move, and the spring resumes.
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 800, clientY: 90 })
    expect(h.moveFloat).toHaveBeenCalledTimes(1)
    runOut()
    expect(h.left()).toBe(724)
  })

  it('ends at the target when the frames stall', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [150 + 744, 90])
    frame(300)
    expect(queued.size).toBe(0)
    expect(h.left()).toBe(724)
  })

  it('ends at the target at the deadline even while still moving', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [150 + 744, 90])
    // Each 200 ms frame advances the spring by the 64 ms frame cap, so it is still moving at 900 ms.
    for (let elapsed = 0; elapsed < 800; elapsed += 200) frame(200)
    expect(queued.size).toBe(1)
    frame(200)
    expect(queued.size).toBe(0)
    expect(h.left()).toBe(724)
  })

  it('yields to an undo: the panel draws at the restored record at once', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [150 + 744, 90])
    frame()
    act(() => {
      h.controller.undo()
      h.redraw()
    })
    frame()
    expect(queued.size).toBe(0)
    expect(h.left()).toBe(100)
  })

  it('picks the panel up where it is drawn on a corner press, and a release in place resumes the return', () => {
    const h = mounted({ x: 0, y: 80, width: 300, height: 200 })
    drag(h.grip(), [150, 90], [150 - 400, 90])
    frame()
    const drawn = h.left()
    expect(drawn).toBeLessThan(0)
    fireEvent.pointerDown(h.corner(), { clientX: 250, clientY: 275, pointerId: 8, button: 0 })
    expect(queued.size).toBe(0)
    expect(h.left()).toBe(drawn)
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 250, clientY: 275 })
    expect(h.left()).toBe(drawn)
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 250, clientY: 275 })
    expect(h.left()).toBe(drawn)
    expect(h.resizeFloat).not.toHaveBeenCalled()
    runOut()
    expect(h.left()).toBe(0)
  })

  it('resizes a panel caught during a return from where it is drawn, then springs it inside', () => {
    const h = mounted({ x: 0, y: 80, width: 300, height: 200 })
    drag(h.grip(), [150, 90], [150 - 400, 90])
    frame()
    const drawn = h.left()
    fireEvent.pointerDown(h.corner(), { clientX: 250, clientY: 275, pointerId: 8, button: 0 })
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 270, clientY: 295 })
    // The origin stays where it was drawn; only the size follows the corner.
    expect(h.left()).toBe(drawn)
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 270, clientY: 295 })
    expect(h.resizeFloat).toHaveBeenCalledWith(h.paneId, { x: 0, y: 80, width: 320, height: 220 })
    expect(h.left()).toBe(drawn)
    runOut()
    expect(h.left()).toBe(0)
  })

  it('yields when its panel closes', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [150 + 744, 90])
    act(() => {
      h.controller.closeTab(h.tabId)
      h.redraw()
    })
    frame()
    expect(queued.size).toBe(0)
  })

  it('ends at its target when another panel is pressed', () => {
    const h = mounted()
    const other = h.controller.floatTab(
      h.controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'file' }),
      { x: 100, y: 400, width: 300, height: 200 },
    )
    act(() => { h.redraw() })
    drag(h.grip(), [150, 90], [150 + 744, 90])
    frame()
    expect(h.left()).toBeGreaterThan(724)
    const otherGrip = h.view.container.querySelector<HTMLElement>(`[data-dockkit-float="${other}"] [data-dockkit-float-grip]`) as HTMLElement
    fireEvent.pointerDown(otherGrip, { clientX: 150, clientY: 410, pointerId: 8, button: 0 })
    expect(queued.size).toBe(0)
    expect(h.left()).toBe(724)
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 150, clientY: 410 })
  })

  it('cancels its frame when the layer unmounts', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [150 + 744, 90])
    expect(queued.size).toBe(1)
    h.view.unmount()
    expect(queued.size).toBe(0)
  })
})

describe('reduced motion', () => {
  it('clamps at the edge with no resistance and never schedules a frame', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }))
    const h = mounted()
    drag(h.grip(), [150, 90], [150 + 744, 90], false)
    expect(h.left()).toBe(724)
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 894, clientY: 90 })
    expect(h.moveFloat).toHaveBeenCalledWith(h.paneId, 724, 80)
    expect(queued.size).toBe(0)
  })

  it('draws a resize at its legal rectangle, so a viewport that shrank past its origin animates nothing', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }))
    const h = mounted({ x: 700, y: 80, width: 300, height: 200 })
    fireEvent.pointerDown(h.corner(), { clientX: 1000, clientY: 280, pointerId: 7, button: 0 })
    viewport(500, 768)
    act(() => { window.dispatchEvent(new Event('resize')) })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 990, clientY: 280 })
    expect(h.left()).toBe(280)
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 990, clientY: 280 })
    expect(h.resizeFloat).toHaveBeenCalledWith(h.paneId, { x: 280, y: 80, width: 220, height: 200 })
    expect(queued.size).toBe(0)
  })

  it('keeps the resistance when the platform states no preference', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const h = mounted()
    drag(h.grip(), [150, 90], [150 + 744, 90], false)
    expect(h.left()).toBeCloseTo(784)
  })
})

describe('the viewport projection', () => {
  it('pushes a panel in when the window shrinks and returns it when the window grows, recording nothing', () => {
    const h = mounted()
    viewport(350, 768)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(h.left()).toBe(50)
    viewport(1024, 768)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(h.left()).toBe(100)
    expect(h.moveFloat).not.toHaveBeenCalled()
    expect(h.focusPane).not.toHaveBeenCalled()
  })

  it('ends a running return at its recorded rectangle when the window resizes', () => {
    const h = mounted()
    drag(h.grip(), [150, 90], [150 + 744, 90])
    frame()
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(queued.size).toBe(0)
    expect(h.left()).toBe(724)
  })

  it('treats a click on a projected panel as a raise, keeping its record for a larger window', () => {
    const h = mounted()
    viewport(350, 768)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(h.left()).toBe(50)
    drag(h.grip(), [100, 90], [100, 90])
    drag(h.corner(), [340, 270], [340, 270])
    expect(h.moveFloat).not.toHaveBeenCalled()
    expect(h.resizeFloat).not.toHaveBeenCalled()
    viewport(1024, 768)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(h.left()).toBe(100)
  })

  it('bounds a gesture by the viewport the window resized to mid-gesture', () => {
    const h = mounted()
    fireEvent.pointerDown(h.corner(), { clientX: 400, clientY: 280, pointerId: 7, button: 0 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 800, clientY: 280 })
    viewport(500, 768)
    act(() => { window.dispatchEvent(new Event('resize')) })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 800, clientY: 280 })
    expect(h.resizeFloat).toHaveBeenCalledWith(h.paneId, { x: 100, y: 80, width: 400, height: 200 })
  })

  it('keeps a resize origin inside a viewport that shrank past it mid-gesture', () => {
    const h = mounted({ x: 700, y: 80, width: 300, height: 200 })
    fireEvent.pointerDown(h.corner(), { clientX: 1000, clientY: 280, pointerId: 7, button: 0 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 990, clientY: 280 })
    viewport(500, 768)
    act(() => { window.dispatchEvent(new Event('resize')) })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 990, clientY: 280 })
    expect(h.resizeFloat).toHaveBeenCalledWith(h.paneId, { x: 280, y: 80, width: 220, height: 200 })
  })

  it('keeps the 20px floor on a Windows root that publishes no caption height', () => {
    document.documentElement.setAttribute('data-windows-titlebar', '')
    onTestFinished(() => { document.documentElement.removeAttribute('data-windows-titlebar') })
    const h = mounted({ x: 100, y: 0, width: 300, height: 200 })
    expect(h.top()).toBe(20)
  })

  it('draws a stored rectangle from outside the viewport inside it', () => {
    const h = mounted({ x: 2000, y: 900, width: 300, height: 200 })
    expect(h.left()).toBe(724)
    expect(h.top()).toBe(568)
  })
})
