/**
 * The window drag-region contract for the macOS desktop shell: Electron hands
 * the page's `-webkit-app-region` boxes to the native window, which hit-tests
 * them by geometry in DOM order, ignoring stacking. The property does not inherit:
 * Blink collects one box per element whose own computed value is not `none`,
 * skipping subtrees that are not visible, and the window applies them in that
 * order: `drag` adds geometry, `no-drag` removes it. The composition is therefore
 * equivalent to "the last matching box decides" — a point is draggable when the
 * last collected box containing it is `drag`.
 *
 * This module is the executable statement of that rule. Production CSS authors
 * the boxes; tests and the browser coverage scenario both decide points through
 * this module so a claim about coverage has one meaning.
 */

/**
 * One collected app-region box, in DOM order.
 *
 * Coordinates are viewport CSS pixels, the space `getBoundingClientRect`
 * reports, so collection and composition never rescale.
 */
export interface RegionRect {
  /** Left edge, viewport CSS pixels. */
  readonly x: number
  /** Top edge, viewport CSS pixels. */
  readonly y: number
  /** Box width in CSS pixels. */
  readonly width: number
  /** Box height in CSS pixels. */
  readonly height: number
  /** Whether this box declares `drag` (true) or `no-drag` (false). */
  readonly draggable: boolean
}

/**
 * The attribute a chrome row puts on the element that owns its window drag.
 * ui-web `base.css` turns the mark into the one darwin drag rule, so the row's
 * own box is the window's draggable geometry.
 */
export const DRAG_MARK = 'data-window-drag'

/**
 * The attribute the shell sets for one frame to make Electron recollect the
 * window's drag rects (electron#32341). While it is set, ui-web `base.css`
 * subtracts the marked box; the row marks inside it still declare drag and win in
 * document order, so the mark's only effect is that app-region values changed.
 */
export const RECALL_MARK = 'data-window-drag-recall'

/**
 * The interactive-element selector that subtracts a control from any drag row it
 * overlaps. ui-web `base.css` declares it for the darwin platform; this constant
 * is the single source both that sheet and its contract spec compare against, so
 * the two cannot drift.
 */
export const INTERACTIVE_SELECTOR = [
  'button', 'a', 'input', 'select', 'textarea', 'summary', "[contenteditable='true']", '[tabindex]',
  "[role='dialog']", "[role='alertdialog']", "[role='menu']", "[role='listbox']", "[role='tooltip']",
  "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']", "[role='menuitemcheckbox']",
  "[role='menuitemradio']", "[role='option']", "[role='checkbox']", "[role='radio']", "[role='switch']",
  "[role='slider']", "[role='combobox']", "[role='textbox']",
].join(', ')

/**
 * Whether a box contains a viewport point. Edges belong to the box, matching
 * the half-open rectangles the window hit test uses.
 * @param rect - the collected box.
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 * @returns true when the point lies inside the box.
 */
export function containsPoint(rect: RegionRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

/**
 * Decide whether the window would drag when pressed at a point.
 * @param regions - collected boxes in DOM order.
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 * @returns true when the last box containing the point is a drag box; false
 * when it is a no-drag box or no box contains the point.
 */
export function isDraggableAt(regions: readonly RegionRect[], x: number, y: number): boolean {
  let draggable = false
  for (const region of regions) {
    if (containsPoint(region, x, y)) draggable = region.draggable
  }
  return draggable
}
