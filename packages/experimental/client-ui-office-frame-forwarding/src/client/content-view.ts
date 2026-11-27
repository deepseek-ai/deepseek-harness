/** One twip-to-CSS mapping for the mounted image, pointer input and document overlays. */
import type { FrameContentView } from '@deepseek-ai/dsh-frame-forwarding/client'

/** Measure the document origin, including centering and scroll offsets.
 * @param mount - Stationary image viewport.
 * @param document - Scrolled, sized document element.
 * @param zoom - CSS pixels per document pixel at 96 DPI.
 * @returns Content coordinates at the mount origin and CSS pixels per twip.
 */
export function measureContentView(mount: HTMLElement, document: HTMLElement, zoom: number): FrameContentView {
  const bounds = mount.getBoundingClientRect(), content = document.getBoundingClientRect(), scale = zoom / 15
  return { x: (bounds.left - content.left) / scale, y: (bounds.top - content.top) / scale, scale }
}

/** Invert the same view last submitted to the presenter, including uncovered content.
 * @param view - Latest submitted content mapping.
 * @param mount - Mount bounds in client CSS pixels.
 * @param clientX - Pointer client X.
 * @param clientY - Pointer client Y.
 * @returns Unrounded document coordinates in twips.
 */
export function contentPoint(view: FrameContentView, mount: Pick<DOMRect, 'left' | 'top'>, clientX: number, clientY: number): { x: number; y: number } {
  return { x: view.x + (clientX - mount.left) / view.scale, y: view.y + (clientY - mount.top) / view.scale }
}
