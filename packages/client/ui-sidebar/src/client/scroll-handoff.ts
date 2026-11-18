/**
 * Wheel hand-off between the sidebar viewport and the section scroller below its navigation.
 * Scrolling down moves the navigation away before the section scroller moves; scrolling up
 * returns the section scroller to its top before the navigation reappears. A gesture whose
 * first event must move the viewport, or starts outside the section scroller, is split in
 * JavaScript until it ends, including its momentum; both elements are then written
 * synchronously in each event, so one gesture continues across the boundary. A gesture the
 * section scroller can take alone keeps native scrolling.
 *
 * A drag over the viewport scrolls the same way when the pointer nears the top or bottom edge
 * of the visible scrolling area, because wheel scrolling is unreliable during a native drag and
 * WebKit and Firefox do not autoscroll a section scroller nested in the viewport.
 */
import type { RefCallback } from 'react'
import type { SectionScroller, UseSectionScroller } from './contract/slots.ts'

/** Sidebar-owned state of one hand-off. */
export interface ScrollHandoff {
  /** Ref callback for the sidebar's own viewport; binds the wheel hand-off and the drag edge-scrolling listeners. */
  readonly bindViewportRef: RefCallback<HTMLElement>
  /** Hook handed to the `sidebar.workspaces` occupant through the slot's hookContext. */
  readonly useSectionScroller: UseSectionScroller
}

/**
 * Wheel events closer together than this belong to one gesture, including its momentum phase.
 * DOM wheel events carry no gesture phase, so the gap stands in for it.
 */
const GESTURE_GAP_MS = 100

/** Distance from the visible scrolling area's top or bottom edge within which a drag scrolls. */
const DRAG_EDGE_PX = 48

/** Drag scrolling speed with the pointer on or past an edge; it falls linearly to zero across the edge band. */
const DRAG_MAX_SPEED_PX_PER_MS = 1

/**
 * A drag that sends no `dragover` for this long has left without `dragleave`, `drop`, or `dragend`.
 * HTML drag processing repeats `dragover` every 350ms ±200ms while the pointer rests over a target.
 */
const DRAG_STALE_MS = 600

/** Longest interval one drag frame scrolls for, so a delayed frame does not jump. */
const DRAG_MAX_STEP_MS = 50

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

/**
 * Scroll `delta` across both elements: down moves the viewport before the section scroller,
 * up moves the section scroller before the viewport.
 */
function scrollSplit(viewport: HTMLElement, scroller: HTMLElement | null, delta: number): void {
  if (scroller === null) {
    scrollClamped(viewport, delta)
    return
  }
  if (delta > 0) {
    const rest = delta - scrollClamped(viewport, delta)
    if (rest > 0) scrollClamped(scroller, rest)
    return
  }
  const rest = delta - scrollClamped(scroller, delta)
  if (rest < 0) scrollClamped(viewport, rest)
}

/**
 * Drag scrolling velocity in pixels per millisecond for a pointer at `y`; positive scrolls down.
 * The edges are those of the section scroller's part inside the viewport, or of the viewport alone.
 */
function dragVelocity(viewport: HTMLElement, scroller: HTMLElement | null, y: number): number {
  const outer = viewport.getBoundingClientRect()
  const inner = scroller?.getBoundingClientRect() ?? outer
  const top = Math.max(outer.top, inner.top)
  const bottom = Math.min(outer.bottom, inner.bottom)
  const band = Math.min(DRAG_EDGE_PX, (bottom - top) / 2)
  if (band <= 0) return 0
  const speed = (depth: number): number => DRAG_MAX_SPEED_PX_PER_MS * Math.min(1, depth / band)
  if (y < top + band) return -speed(top + band - y)
  if (y > bottom - band) return speed(y - (bottom - band))
  return 0
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
    scrollSplit(viewport, scroller, delta)
  }
  // The pointer of the latest dragover and the frame loop that scrolls toward it.
  let drag: { y: number; at: number } | undefined
  let frame: number | undefined
  let lastFrame = 0
  const stopDrag = (): void => {
    drag = undefined
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  const step = (viewport: HTMLElement, now: number): void => {
    frame = undefined
    if (drag === undefined || now - drag.at > DRAG_STALE_MS) {
      drag = undefined
      return
    }
    const velocity = dragVelocity(viewport, scroller, drag.y)
    if (velocity === 0) return
    // A frame timestamp can precede the performance.now() of the dragover that requested it.
    scrollSplit(viewport, scroller, velocity * Math.min(Math.max(now - lastFrame, 0), DRAG_MAX_STEP_MS))
    lastFrame = now
    frame = requestAnimationFrame((time) => { step(viewport, time) })
  }
  const dragOver = (viewport: HTMLElement, event: DragEvent): void => {
    drag = { y: event.clientY, at: performance.now() }
    if (frame !== undefined || dragVelocity(viewport, scroller, event.clientY) === 0) return
    lastFrame = drag.at
    frame = requestAnimationFrame((time) => { step(viewport, time) })
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
      const onDragOver = (event: DragEvent): void => { dragOver(element, event) }
      const onDragLeave = (event: DragEvent): void => {
        if (!element.contains(event.relatedTarget as Node | null)) stopDrag()
      }
      element.addEventListener('wheel', onWheel, { passive: false })
      // Capture: drop targets inside the viewport stop dragover propagation.
      element.addEventListener('dragover', onDragOver, true)
      element.addEventListener('dragleave', onDragLeave, true)
      element.addEventListener('drop', stopDrag, true)
      element.addEventListener('dragend', stopDrag, true)
      releaseViewport = () => {
        stopDrag()
        element.removeEventListener('wheel', onWheel)
        element.removeEventListener('dragover', onDragOver, true)
        element.removeEventListener('dragleave', onDragLeave, true)
        element.removeEventListener('drop', stopDrag, true)
        element.removeEventListener('dragend', stopDrag, true)
      }
    },
    useSectionScroller: () => sectionScroller,
  }
}
