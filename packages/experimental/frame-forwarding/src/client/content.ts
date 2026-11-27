/** Content-coordinate validation and generation mapping shared by the mounted browser presenters. */
import type { FrameContentView, FrameContentWindow } from './api.ts'

/** A complete document snapshot: current and previous distinct windows, each at its latest submitted generation, in ascending order. */
export interface ContentState {
  readonly view: FrameContentView
  readonly windows: readonly (FrameContentWindow & { readonly generation: number })[]
}

/** Content coordinates and extents are bounded before they cross the geometry IPC. */
const MAX_CONTENT_COORDINATE = 2 ** 24

function coordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_CONTENT_COORDINATE
}

/** Validate a view without changing state or sending geometry.
 * @param view - Content origin and CSS pixels per content unit.
 * @throws TypeError for non-finite or out-of-range coordinates or a scale outside (0, 64].
 */
export function validateView(view: FrameContentView): void {
  if (!coordinate(view.x) || !coordinate(view.y) || !Number.isFinite(view.scale) || view.scale <= 0 || view.scale > 64) {
    throw new TypeError('Frame content view requires coordinates within ±2^24 and scale in (0, 64].')
  }
}

/** Validate a render window without changing state or sending a viewport.
 * @param window - Rectangle in the view's content units.
 * @throws TypeError for non-finite or out-of-range coordinates or extents, or non-positive extents.
 */
export function validateWindow(window: FrameContentWindow): void {
  if (!coordinate(window.x) || !coordinate(window.y) || !coordinate(window.width) || !coordinate(window.height)
    || window.width <= 0 || window.height <= 0) {
    throw new TypeError('Frame content window requires coordinates within ±2^24 and extents in (0, 2^24].')
  }
}

/** Map a frame's own window using the latest view, without clipping its content.
 * @param window - The immutable window bound to the frame's generation.
 * @param view - Latest content origin and scale.
 * @returns Mount-local CSS rectangle; placement clipping is applied separately.
 */
export function contentFrame(window: FrameContentWindow, view: FrameContentView): FrameContentWindow {
  return { x: (window.x - view.x) * view.scale, y: (window.y - view.y) * view.scale,
    width: window.width * view.scale, height: window.height * view.scale }
}
