/**
 * Pure geometry for the drag interaction: point tests, dock-zone resolution
 * against a real element rectangle, and tab-strip insertion slots. Kept free of
 * React and DOM types so the drop rules can be asserted without a browser; the
 * component layer measures rectangles and calls in.
 */
import type { DockZone, FloatRect, PaneId } from '../contract/types.ts'
import { DOCK_EDGE_FRACTION, zoneAt } from './constraints.ts'

/** A measured rectangle in viewport coordinates. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Where a drag would land if released now. */
export type DropTarget =
  /** Into a tab strip at an explicit slot: a reorder or a cross-pane move. */
  | { readonly kind: 'strip'; readonly paneId: PaneId; readonly index: number }
  /** Onto a pane body: the centre moves the tab in, an edge splits the pane. */
  | { readonly kind: 'zone'; readonly paneId: PaneId; readonly zone: DockZone }

/**
 * Whether a point is inside a rectangle, edges included.
 * @param rect - the rectangle.
 * @param x - point x in the same coordinates.
 * @param y - point y in the same coordinates.
 * @returns whether the point lies on or inside the rectangle.
 */
export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

/**
 * Dock region a point falls in, relative to one pane's rectangle.
 * @param rect - the pane's measured box.
 * @param x - pointer x in the same coordinates.
 * @param y - pointer y in the same coordinates.
 * @param edge - edge band as a fraction; defaults to the model's value.
 * @returns the region; `'center'` when the point is not in an edge band.
 */
export function zoneInRect(rect: Rect, x: number, y: number, edge: number = DOCK_EDGE_FRACTION): DockZone {
  if (!(rect.width > 0) || !(rect.height > 0)) return 'center'
  return zoneAt((x - rect.x) / rect.width, (y - rect.y) / rect.height, edge)
}

/**
 * Slot a tab would take in a strip, by comparing the pointer with each tab's midpoint.
 * @param tabRects - the strip's tab boxes in strip order.
 * @param x - pointer x.
 * @returns the insertion index, from 0 to `tabRects.length`.
 */
export function insertionIndex(tabRects: readonly Rect[], x: number): number {
  let index = 0
  for (const rect of tabRects) {
    if (x < rect.x + rect.width / 2) break
    index += 1
  }
  return index
}

/** What one pane's strip measured, for the room rule. */
export interface PaneMeasure {
  /** The pane's box, borders included. */
  readonly pane: Rect
  /** The strip's box, inside the borders; its height is what a vertical half must carry. */
  readonly strip: Rect
  /** Width of the chip box, the strip's one shrinking part. */
  readonly chipsWidth: number
  /** Width of the fill: free space, not a control. */
  readonly fillWidth: number
  /**
   * Footprint of the rendered split control (its width plus the strip's gap)
   * for embedders that hide blocked split controls: a half too narrow to
   * split hides its own control, so the rule leaves the footprint out of the
   * fixed part. Leaving it out is also what keeps the reading stable — the
   * control hiding sheds the same footprint from the strip, and a reading
   * that counted it would flip with the control's visibility and re-render
   * forever. Absent or 0 keeps the control in the fixed part, for embedders
   * that render a blocked control disabled.
   */
  readonly splitControlWidth?: number
}

/** Pixel minimums the room rule holds each half to. */
export interface SplitMinimums {
  /** The divider a split puts between the halves. */
  readonly divider: number
  /** One chip at its minimum: the smallest strip that still names a tab. */
  readonly chip: number
  /** The smallest body under a strip: one secondary text line inside 12px of the body's own insets. */
  readonly body: number
}

/**
 * The minimums where no computed style can be read, mirroring
 * `dockkit.module.css`: `.splitRow > .divider` takes no layout width (its
 * hairline is painted over the seam); `.tab` is 80px of content plus
 * 10px + 10px of padding (content-box), 100px; 12px above and below one 13px
 * secondary line at 1.6 line-height — the inset a body draws for itself, as
 * `.empty` does — is 45px, held to 48px.
 */
export const SPLIT_MINIMUMS: SplitMinimums = { divider: 0, chip: 100, body: 48 }

/** Whether a pane's two halves after an equal split would each still work. */
export interface HalvesFit {
  /** A row split: each half holds the strip's fixed controls and one minimum chip. */
  readonly row: boolean
  /** A column split: each half holds the strip and a minimum body. */
  readonly column: boolean
}

/**
 * The room rule. After an equal split each half must hold what cannot shrink:
 * horizontally the strip's fixed part — its width minus the chip box, the
 * fill, and `splitControlWidth`, which is the padding, the gaps, and every
 * control a half would still draw — plus one chip at its minimum; vertically
 * the strip plus a minimum body. The
 * borders are what the pane's box exceeds the strip's by. An unmeasured pane
 * (no layout, as under jsdom) fits: the rule only blocks on a positive reading.
 * @param measure - the pane's rectangles.
 * @param minimums - the pixel minimums; defaults to the stylesheet's.
 * @returns whether a row and a column split each leave two working halves.
 */
export function halvesFit(measure: PaneMeasure, minimums: SplitMinimums = SPLIT_MINIMUMS): HalvesFit {
  const { pane, strip } = measure
  if (!(pane.width > 0) || !(pane.height > 0) || !(strip.width > 0)) return { row: true, column: true }
  const borders = Math.max(0, pane.width - strip.width)
  const fixed = Math.max(0, strip.width - measure.chipsWidth - measure.fillWidth - (measure.splitControlWidth ?? 0))
  const halfWidth = (pane.width - minimums.divider) / 2 - borders
  const halfHeight = (pane.height - minimums.divider) / 2 - borders
  return {
    row: halfWidth >= fixed + minimums.chip,
    column: halfHeight >= strip.height + minimums.body,
  }
}

/** How far a pointer must travel before a press becomes a drag, in pixels. */
export const DRAG_THRESHOLD = 4

/**
 * Whether a press has travelled far enough to be a drag.
 * @param startX - press x.
 * @param startY - press y.
 * @param x - current pointer x.
 * @param y - current pointer y.
 * @returns whether either axis moved at least `DRAG_THRESHOLD`.
 */
export function passedThreshold(startX: number, startY: number, x: number, y: number): boolean {
  return Math.abs(x - startX) >= DRAG_THRESHOLD || Math.abs(y - startY) >= DRAG_THRESHOLD
}

/**
 * Split fractions after a divider drag.
 * @param sizes - the split's current fractions.
 * @param index - divider position: the boundary between `index` and `index + 1`.
 * @param delta - pointer travel along the split axis, as a fraction of the split's extent.
 * @returns new fractions; the two neighbours absorb the whole change.
 */
export function dividerSizes(
  sizes: readonly number[],
  index: number,
  delta: number,
): number[] {
  const before = sizes[index]
  const after = sizes[index + 1]
  if (before === undefined || after === undefined) return [...sizes]
  const next = [...sizes]
  next[index] = before + delta
  next[index + 1] = after - delta
  return next
}

/** A width/height pair used as a floating-panel bound. */
export interface Size {
  readonly width: number
  readonly height: number
}

/**
 * A floating panel's rectangle after a drag.
 * @param rect - the rectangle the gesture started from.
 * @param dx - pointer travel on x.
 * @param dy - pointer travel on y.
 * @returns the moved rectangle; the size is unchanged.
 */
export function movedRect(rect: FloatRect, dx: number, dy: number): FloatRect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy }
}

/**
 * A floating panel's rectangle after a bottom-right resize.
 * @param rect - the rectangle the gesture started from.
 * @param dx - pointer travel on x.
 * @param dy - pointer travel on y.
 * @param min - smallest size the panel may take.
 * @returns the resized rectangle; the origin is unchanged.
 */
export function resizedRect(rect: FloatRect, dx: number, dy: number, min: Size): FloatRect {
  return {
    ...rect,
    width: Math.max(min.width, rect.width + dx),
    height: Math.max(min.height, rect.height + dy),
  }
}

/**
 * Where a panel should appear when a tab is dropped outside the docked area.
 * @param x - drop point x.
 * @param y - drop point y.
 * @param size - the panel's size.
 * @returns a rectangle whose header sits under the drop point.
 */
export function floatRectAt(x: number, y: number, size: Size): FloatRect {
  return { x: Math.max(0, x - GRAB_OFFSET.x), y: Math.max(0, y - GRAB_OFFSET.y), ...size }
}

/** How far the new panel's origin sits above and left of the drop point. */
const GRAB_OFFSET = { x: 60, y: 14 } as const
