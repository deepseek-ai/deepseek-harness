/** Document pinch zoom from trackpads and touchscreens; single-finger scrolling remains native. */
import type { OfficeViewport } from '../types.ts'

interface Anchor {
  x: number
  y: number
  left: number
  top: number
}

function contentOffset(element: HTMLDivElement): { x: number; y: number } {
  const bounds = element.getBoundingClientRect(),
    content = element.firstElementChild?.getBoundingClientRect()
  return content
    ? { x: content.left - bounds.left + element.scrollLeft, y: content.top - bounds.top + element.scrollTop }
    : { x: 0, y: 0 }
}

/**
 * Restore a pinch anchor after the document's CSS size and centering have changed.
 * @param element - Scrolling viewport with its document as the first child.
 * @param zoom - Newly committed scale.
 * @param anchor - Document point and pointer position captured before zooming.
 */
export function restoreZoomAnchor(element: HTMLDivElement, zoom: number, anchor: Anchor): void {
  const offset = contentOffset(element)
  element.scrollLeft = anchor.x * zoom + offset.x - anchor.left
  element.scrollTop = anchor.y * zoom + offset.y - anchor.top
}

/**
 * Map the scrolled viewport to native document coordinates.
 * @param scroll - Viewport dimensions and offsets in CSS pixels.
 * @param zoom - CSS pixels per document pixel at 96 DPI.
 * @param scale - Physical pixel and twip lengths along the render window axis.
 * @returns Actual visible document area and client scale.
 */
export function documentViewport(
  scroll: Pick<HTMLDivElement, 'scrollLeft' | 'scrollTop' | 'clientWidth' | 'clientHeight'>,
  zoom: number,
  scale: { pixelSize: number; twipSize: number },
): OfficeViewport {
  return {
    x: Math.round(scroll.scrollLeft * 15 / zoom),
    y: Math.round(scroll.scrollTop * 15 / zoom),
    width: Math.max(1, Math.round(scroll.clientWidth * 15 / zoom)),
    height: Math.max(1, Math.round(scroll.clientHeight * 15 / zoom)),
    pixelSize: scale.pixelSize,
    twipSize: scale.twipSize,
  }
}

/**
 * Fit native document dimensions to the available CSS area.
 * @param document - Native document dimensions in twips.
 * @param viewport - Available CSS dimensions after layout padding.
 * @param mode - Width-only pages or one complete slide.
 * @returns Scale relative to 96 DPI document pixels.
 */
export function fitZoom(
  document: { width: number; height: number },
  viewport: { width: number; height: number },
  mode: 'width' | 'page',
): number {
  const width = (viewport.width * 15) / document.width
  return Math.max(0.01, mode === 'width' ? width : Math.min(width, (viewport.height * 15) / document.height))
}

/**
 * Coalesce trackpad and two-finger touch samples while keeping the document point under the fingers.
 * Single-finger touch leaves scrolling to the browser.
 * @param element - Document scrolling viewport with touch-action: pan-x pan-y.
 * @param read - Current zoom and whether input is accepting gestures.
 * @param update - Commits the next zoom and its document anchor.
 * @returns Removes the listener and cancels an uncommitted animation frame.
 */
export function bindPinchZoom(
  element: HTMLDivElement,
  read: () => { zoom: number; enabled: boolean },
  update: (zoom: number, anchor: Anchor) => void,
): () => void {
  let frame = 0,
    pending = 1,
    anchor: Anchor | undefined
  let pinch: { first: number; second: number; distance: number; zoom: number; anchor: Anchor } | undefined
  const captureAnchor = (clientX: number, clientY: number, zoom: number): Anchor => {
    const bounds = element.getBoundingClientRect(),
      left = clientX - bounds.left,
      top = clientY - bounds.top,
      offset = contentOffset(element)
    return { x: (element.scrollLeft + left - offset.x) / zoom,
      y: (element.scrollTop + top - offset.y) / zoom, left, top }
  }
  const schedule = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (read().enabled) update(pending, anchor as NonNullable<typeof anchor>)
    })
  }
  const wheel = (event: WheelEvent): void => {
    const current = read()
    if (!event.ctrlKey || !current.enabled) return
    event.preventDefault()
    event.stopPropagation()
    if (frame === 0) {
      pending = current.zoom
      anchor = captureAnchor(event.clientX, event.clientY, current.zoom)
    }
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1)
    pending = Math.max(0.25, Math.min(4, pending * Math.exp(-delta / 300)))
    schedule()
  }
  const touch = (event: TouchEvent): void => {
    const current = read()
    if (event.touches.length !== 2 || !current.enabled || !event.cancelable) { pinch = undefined; return }
    const first = event.touches[0] as Touch, second = event.touches[1] as Touch,
      distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY),
      clientX = (first.clientX + second.clientX) / 2,
      clientY = (first.clientY + second.clientY) / 2
    event.preventDefault()
    event.stopPropagation()
    if (distance === 0) { pinch = undefined; return }
    if (pinch === undefined || pinch.first !== first.identifier || pinch.second !== second.identifier) {
      pinch = { first: first.identifier, second: second.identifier, distance, zoom: current.zoom,
        anchor: captureAnchor(clientX, clientY, current.zoom) }
      return
    }
    const bounds = element.getBoundingClientRect()
    pending = Math.max(0.25, Math.min(4, pinch.zoom * distance / pinch.distance))
    anchor = { ...pinch.anchor, left: clientX - bounds.left, top: clientY - bounds.top }
    schedule()
  }
  const cancel = (): void => { pinch = undefined; cancelAnimationFrame(frame); frame = 0 }
  element.addEventListener('wheel', wheel, { passive: false })
  element.addEventListener('touchstart', touch, { passive: false })
  element.addEventListener('touchmove', touch, { passive: false })
  element.addEventListener('touchend', touch, { passive: false })
  element.addEventListener('touchcancel', cancel)
  return () => {
    element.removeEventListener('wheel', wheel)
    element.removeEventListener('touchstart', touch)
    element.removeEventListener('touchmove', touch)
    element.removeEventListener('touchend', touch)
    element.removeEventListener('touchcancel', cancel)
    cancel()
  }
}
