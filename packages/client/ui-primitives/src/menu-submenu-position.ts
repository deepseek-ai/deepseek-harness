/** Event-driven viewport placement and width ownership for Menu's portaled child card. */
import { useLayoutEffect, useState, type RefObject } from 'react'
import { overlayTopMargin } from './overlay-top-margin.ts'

interface SubmenuPosition {
  left: number
  top: number
  maxHeight: number
  width?: number
  page: boolean
}

/**
 * Fit a child beside its parent, or over the parent's panel when neither side fits
 * the visual viewport, using the root Menu's WebKit coordinate normalization.
 * CSS cannot choose a sibling portal's placement from both measured card widths.
 * This hook owns the child's inline width; callers must not also render that style.
 * Scroll and viewport resize place immediately. Observer and font changes share one
 * requested frame; relevant running animations track frames until they settle.
 * @param active - The mounted parent's row ID, or null while closed.
 * @param parent - Parent card, including its scroll region.
 * @param trigger - The parent row opening the child.
 * @param child - Child card, measured before its first paint.
 * @param contextual - Whether frame clearance is excluded for a context menu.
 * @returns Viewport coordinates and the single-panel navigation mode, or null before placement.
 */
export function useMenuSubmenuPosition(
  active: string | null,
  parent: RefObject<HTMLDivElement>,
  trigger: RefObject<HTMLButtonElement>,
  child: RefObject<HTMLDivElement>,
  contextual: boolean,
): SubmenuPosition | null {
  const [position, setPosition] = useState<SubmenuPosition | null>(null)
  useLayoutEffect(() => {
    if (active === null) { setPosition(null); return }
    const parentElement = parent.current
    const triggerElement = trigger.current
    const childElement = child.current
    /* v8 ignore next -- Menu mounts all three refs before activating this layout effect; cleanup disconnects their observers. */
    if (parentElement === null || triggerElement === null || childElement === null) return
    const initialWidth = childElement.style.width
    const viewport = window.visualViewport
    // Match useAnchoredPosition: WebKit client rects start at the visual origin,
    // while fixed CSS coordinates and viewport bounds use the layout origin.
    const visualOrigin = typeof window.CSS !== 'undefined' && window.CSS.supports('-webkit-backdrop-filter', 'none')
    let disposed = false
    let frame: number | null = null
    let movement: IntersectionObserver[] = []
    let previousBoxes = ''
    const motionTargets: HTMLElement[] = [parentElement, triggerElement]
    // Shrinking transforms can stay wholly inside an intersection root. Track
    // their active animation only; a settled menu schedules no idle frame.
    const moving = () => motionTargets.some(element => typeof element.getAnimations === 'function'
      && element.getAnimations().some(animation => animation.playState === 'running'))
    const schedule = () => {
      if (disposed || frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        place()
        if (!disposed && moving()) schedule()
      })
    }
    // A tight observer root detects position changes, including transforms and
    // layout shifts that change neither the element's size nor scroll offsets.
    const observeMovement = (element: Element, rect: DOMRect) => {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some(entry => entry.boundingClientRect.left !== rect.left || entry.boundingClientRect.top !== rect.top
          || entry.boundingClientRect.width !== rect.width || entry.boundingClientRect.height !== rect.height)) schedule()
      }, { rootMargin: `${-rect.top}px ${rect.right - window.innerWidth}px ${rect.bottom - window.innerHeight}px ${-rect.left}px`, threshold: 1 })
      observer.observe(element)
      movement.push(observer)
    }
    const place = () => {
      if (disposed) return
      const panel = parentElement.getBoundingClientRect()
      const row = triggerElement.getBoundingClientRect()
      const margin = 12
      const gap = 4
      const viewportLeft = viewport?.offsetLeft ?? 0
      const viewportTop = viewport?.offsetTop ?? 0
      const vw = viewport?.width ?? (document.documentElement.clientWidth || window.innerWidth)
      const vh = viewport?.height ?? (document.documentElement.clientHeight || window.innerHeight)
      const offsetX = visualOrigin ? viewportLeft : 0
      const offsetY = visualOrigin ? viewportTop : 0
      const topMargin = contextual ? margin : overlayTopMargin(margin, row, gap)
      const maxHeight = Math.max(0, vh - topMargin - margin)
      // Intrinsic width is refreshed only on placement invalidation, not idle frames.
      if (childElement.style.width !== '') childElement.style.width = ''
      const width = childElement.offsetWidth
      const right = offsetX + panel.right + gap
      const left = offsetX + panel.left - gap - width
      const page = right + width > viewportLeft + vw - margin && left < viewportLeft + margin
      const pageWidth = Math.min(Math.max(panel.width, width), vw - margin * 2)
      const actualWidth = page ? pageWidth : width
      const x = page ? offsetX + panel.left : right + width <= viewportLeft + vw - margin ? right : left
      const height = Math.min(childElement.offsetHeight, maxHeight)
      const y = offsetY + (page ? panel.top : row.top)
      const next: SubmenuPosition = {
        left: Math.max(viewportLeft + margin, Math.min(x, viewportLeft + vw - actualWidth - margin)),
        top: Math.max(viewportTop + topMargin, Math.min(y, viewportTop + vh - height - margin)),
        maxHeight,
        ...(page ? { width: pageWidth } : {}),
        page,
      }
      if (page) childElement.style.width = `${pageWidth}px`
      setPosition(current => current?.left === next.left && current.top === next.top
        && current.maxHeight === next.maxHeight && current.width === next.width && current.page === next.page ? current : next)
      const boxes = [
        panel.left, panel.top, panel.width, panel.height, row.left, row.top, row.width, row.height, vw, vh, viewportLeft, viewportTop,
      ].join(',')
      if (typeof IntersectionObserver !== 'undefined' && boxes !== previousBoxes) {
        for (const observer of movement) observer.disconnect()
        movement = []
        previousBoxes = boxes
        observeMovement(parentElement, panel)
        observeMovement(triggerElement, row)
      }
    }
    place()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resize?.observe(parentElement)
    resize?.observe(triggerElement)
    resize?.observe(childElement)
    const mutation = new MutationObserver((records) => {
      if (records.some(record => record.target !== childElement || record.attributeName !== 'style')) schedule()
    })
    const attributes = { attributes: true, attributeFilter: ['class', 'style', 'hidden'], childList: true }
    mutation.observe(parentElement, { ...attributes, subtree: true, characterData: true })
    mutation.observe(childElement, { ...attributes, subtree: true, characterData: true })
    for (let ancestor = parentElement.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      mutation.observe(ancestor, attributes)
      motionTargets.push(ancestor)
    }
    const onMotion = (event: Event) => {
      if (event.target instanceof HTMLElement && motionTargets.includes(event.target)) schedule()
    }
    const motionEvents = ['animationstart', 'animationend', 'animationcancel', 'transitionrun', 'transitionend', 'transitioncancel']
    for (const event of motionEvents) document.addEventListener(event, onMotion, true)
    if (moving()) schedule()
    const fonts = 'fonts' in document ? document.fonts : undefined
    fonts?.addEventListener('loadingdone', schedule)
    fonts?.addEventListener('loadingerror', schedule)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    viewport?.addEventListener('resize', place)
    viewport?.addEventListener('scroll', place)
    return () => {
      disposed = true
      if (frame !== null) cancelAnimationFrame(frame)
      resize?.disconnect()
      mutation.disconnect()
      for (const event of motionEvents) document.removeEventListener(event, onMotion, true)
      for (const observer of movement) observer.disconnect()
      fonts?.removeEventListener('loadingdone', schedule)
      fonts?.removeEventListener('loadingerror', schedule)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      viewport?.removeEventListener('resize', place)
      viewport?.removeEventListener('scroll', place)
      childElement.style.width = initialWidth
    }
  }, [active, parent, trigger, child, contextual])
  return position
}
