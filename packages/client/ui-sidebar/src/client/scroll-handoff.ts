/**
 * Wheel hand-off between the sidebar viewport and the section scroller below its navigation.
 * Scrolling down moves the navigation away before the section scroller moves; scrolling up
 * returns the section scroller to its top before the navigation reappears. A gesture whose
 * first event must move the viewport, or starts outside the section scroller, is split in
 * JavaScript until it ends, including its momentum; both elements are then written
 * synchronously in each event, so one gesture continues across the boundary. A gesture the
 * section scroller can take alone keeps native scrolling.
 */
import type { RefCallback } from 'react'
import type { SectionScroller, UseSectionScroller } from './contract/slots.ts'

/** Sidebar-owned state of one hand-off. */
export interface ScrollHandoff {
  /** Ref callback for the sidebar's own viewport; binds the wheel listener. */
  readonly bindViewportRef: RefCallback<HTMLElement>
  /** Hook handed to the `sidebar.workspaces` occupant through the slot's hookContext. */
  readonly useSectionScroller: UseSectionScroller
}

/**
 * Wheel events closer together than this belong to one gesture, including its momentum phase.
 * DOM wheel events carry no gesture phase, so the gap stands in for it.
 */
const GESTURE_GAP_MS = 100

/**
 * Vertical wheel distance in pixels. Pinch-zoom and mostly horizontal events return undefined
 * and keep native scrolling.
 */
function verticalWheelPixels(event: WheelEvent, page: number): number | undefined {
  if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return undefined
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * page
  return event.deltaY
}

/** Scroll by `delta`; the browser clamps the write, and the moved distance is returned. */
function scrollClamped(element: HTMLElement, delta: number): number {
  const before = element.scrollTop
  element.scrollTop = before + delta
  return element.scrollTop - before
}

/** Whether the viewport has scrolled the navigation away; sub-pixel remainders count as the end. */
function atEnd(viewport: HTMLElement): boolean {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1
}

/**
 * Create the hand-off for one sidebar render tree.
 * @returns The viewport ref callback and the occupant hook; both keep their identity.
 */
export function createScrollHandoff(): ScrollHandoff {
  let scroller: HTMLElement | null = null
  let releaseViewport: (() => void) | undefined
  let lastSplit = Number.NEGATIVE_INFINITY
  const handle = (viewport: HTMLElement, event: WheelEvent): void => {
    if (scroller === null || event.defaultPrevented) return
    const delta = verticalWheelPixels(event, viewport.clientHeight)
    if (delta === undefined || delta === 0) return
    // A gesture split here stays here: native scrolling does not resume within its momentum.
    const continuing = event.cancelable && event.timeStamp - lastSplit < GESTURE_GAP_MS
    if (!continuing) {
      // With the navigation gone, the section scroller under the pointer takes this step natively.
      const native = atEnd(viewport) && scroller.contains(event.target as Node | null)
      if (native && (delta > 0 || scroller.scrollTop + delta >= 0)) return
      if (!event.cancelable) {
        // A native gesture latched to the section scroller stops at its top; the viewport takes the rest.
        if (native) scrollClamped(viewport, delta + scroller.scrollTop)
        return
      }
    }
    event.preventDefault()
    lastSplit = event.timeStamp
    if (delta > 0) {
      const rest = delta - scrollClamped(viewport, delta)
      if (rest > 0) scrollClamped(scroller, rest)
      return
    }
    const rest = delta - scrollClamped(scroller, delta)
    if (rest < 0) scrollClamped(viewport, rest)
  }
  const sectionScroller: SectionScroller = {
    bindScrollerRef: (element) => { scroller = element },
  }
  return {
    bindViewportRef: (element) => {
      releaseViewport?.()
      releaseViewport = undefined
      if (element === null) return
      const onWheel = (event: WheelEvent): void => { handle(element, event) }
      element.addEventListener('wheel', onWheel, { passive: false })
      releaseViewport = () => { element.removeEventListener('wheel', onWheel) }
    },
    useSectionScroller: () => sectionScroller,
  }
}
