// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createScrollHandoff } from '../src/client/scroll-handoff.ts'

/** A scroll container whose scrollTop the browser would clamp to `[0, max]`; jsdom has no layout. */
function scrollable(max: number, clientHeight = 300): HTMLDivElement {
  const element = document.createElement('div')
  let top = 0
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = Math.min(max, Math.max(0, value)) },
  })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: clientHeight + max })
  document.body.append(element)
  return element
}

function wheel(target: HTMLElement, init: WheelEventInit, timeStamp?: number): WheelEvent {
  const event = new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init })
  if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  target.dispatchEvent(event)
  return event
}

/** A sidebar viewport with 130px of navigation to scroll away and a section scroller with 500px of rows. */
function bound() {
  const handoff = createScrollHandoff()
  const viewport = scrollable(130, 400)
  const scroller = scrollable(500)
  viewport.append(scroller)
  handoff.bindViewportRef(viewport)
  handoff.useSectionScroller().bindScrollerRef(scroller)
  return { handoff, viewport, scroller }
}

afterEach(() => { document.body.replaceChildren() })

describe('createScrollHandoff', () => {
  it('moves the navigation away before the section scroller in one downward event', () => {
    const { viewport, scroller } = bound()
    expect(wheel(scroller, { deltaY: 200 }).defaultPrevented).toBe(true)
    expect(viewport.scrollTop).toBe(130)
    expect(scroller.scrollTop).toBe(70)
  })

  it('leaves the section scroller untouched while the navigation absorbs the distance', () => {
    const { viewport, scroller } = bound()
    wheel(scroller, { deltaY: 40 })
    expect(viewport.scrollTop).toBe(40)
    expect(scroller.scrollTop).toBe(0)
  })

  it('keeps native scrolling inside the section scroller once the navigation is gone', () => {
    const { viewport, scroller } = bound()
    viewport.scrollTop = 130
    scroller.scrollTop = 70
    expect(wheel(scroller, { deltaY: 100 }).defaultPrevented).toBe(false)
    expect(wheel(scroller, { deltaY: -50 }).defaultPrevented).toBe(false)
    expect(viewport.scrollTop).toBe(130)
    expect(scroller.scrollTop).toBe(70)
  })

  it('scrolls the section scroller for wheel events that start outside it', () => {
    const { viewport, scroller } = bound()
    viewport.scrollTop = 130
    expect(wheel(viewport, { deltaY: 80 }).defaultPrevented).toBe(true)
    expect(scroller.scrollTop).toBe(80)
    wheel(viewport, { deltaY: -50 })
    expect(scroller.scrollTop).toBe(30)
    expect(viewport.scrollTop).toBe(130)
  })

  it('returns the section scroller to its top before the navigation reappears', () => {
    const { viewport, scroller } = bound()
    viewport.scrollTop = 130
    scroller.scrollTop = 70
    expect(wheel(scroller, { deltaY: -100 }).defaultPrevented).toBe(true)
    expect(scroller.scrollTop).toBe(0)
    expect(viewport.scrollTop).toBe(100)
    wheel(scroller, { deltaY: -30 })
    expect(viewport.scrollTop).toBe(70)
  })

  it('gives the viewport the rest of an uncancelable native gesture that reaches the section top', () => {
    const { viewport, scroller } = bound()
    viewport.scrollTop = 130
    scroller.scrollTop = 20
    expect(wheel(scroller, { deltaY: -50, cancelable: false }).defaultPrevented).toBe(false)
    expect(viewport.scrollTop).toBe(100)
    expect(scroller.scrollTop).toBe(20)
  })

  it('keeps a split gesture in JavaScript through its momentum, then returns new gestures to native scrolling', () => {
    const { viewport, scroller } = bound()
    viewport.scrollTop = 100
    expect(wheel(scroller, { deltaY: 60 }, 1000).defaultPrevented).toBe(true)
    expect(viewport.scrollTop).toBe(130)
    expect(scroller.scrollTop).toBe(30)
    expect(wheel(scroller, { deltaY: 40 }, 1016).defaultPrevented).toBe(true)
    expect(scroller.scrollTop).toBe(70)
    expect(wheel(scroller, { deltaY: 40 }, 1200).defaultPrevented).toBe(false)
    expect(scroller.scrollTop).toBe(70)
  })

  it('leaves other uncancelable events to native scrolling', () => {
    const { viewport, scroller } = bound()
    wheel(scroller, { deltaY: 40, cancelable: false })
    expect(viewport.scrollTop).toBe(0)
    expect(scroller.scrollTop).toBe(0)
  })

  it('converts line and page deltas to pixels', () => {
    const { viewport } = bound()
    wheel(viewport, { deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE })
    expect(viewport.scrollTop).toBe(32)
    wheel(viewport, { deltaY: -0.05, deltaMode: WheelEvent.DOM_DELTA_PAGE })
    expect(viewport.scrollTop).toBe(12)
  })

  it.each([
    ['pinch-zoom', { deltaY: 40, ctrlKey: true }],
    ['mostly horizontal', { deltaX: 60, deltaY: 40 }],
    ['zero', { deltaY: 0 }],
  ] satisfies [string, WheelEventInit][])('keeps native scrolling for %s events', (_name, init) => {
    const { viewport, scroller } = bound()
    expect(wheel(scroller, init).defaultPrevented).toBe(false)
    expect(viewport.scrollTop).toBe(0)
    expect(scroller.scrollTop).toBe(0)
  })

  it('leaves events another listener already canceled', () => {
    const { viewport, scroller } = bound()
    scroller.addEventListener('wheel', (event) => { event.preventDefault() }, { once: true })
    wheel(scroller, { deltaY: 40 })
    expect(viewport.scrollTop).toBe(0)
  })

  it('keeps native scrolling without a bound section scroller', () => {
    const { handoff, viewport } = bound()
    handoff.useSectionScroller().bindScrollerRef(null)
    expect(wheel(viewport, { deltaY: 40 }).defaultPrevented).toBe(false)
    expect(viewport.scrollTop).toBe(0)
  })

  it('moves its listener to a rebound viewport and removes it on unbind', () => {
    const { handoff, viewport } = bound()
    const next = scrollable(130)
    handoff.bindViewportRef(next)
    expect(wheel(viewport, { deltaY: 40 }).defaultPrevented).toBe(false)
    expect(wheel(next, { deltaY: 40 }).defaultPrevented).toBe(true)
    handoff.bindViewportRef(null)
    expect(wheel(next, { deltaY: 40 }).defaultPrevented).toBe(false)
  })

  it('hands every caller the same scroller binding', () => {
    const handoff = createScrollHandoff()
    expect(handoff.useSectionScroller()).toBe(handoff.useSectionScroller())
  })
})
