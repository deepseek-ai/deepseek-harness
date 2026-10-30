/** Pure placement for Menu's child card; shared overlay geometry uses layout-origin coordinates. */
import type { OverlayGeometry, OverlayPlacement } from './useAnchoredPosition.ts'

/**
 * Prefer the parent's right edge, then its left, then a single-panel child page.
 * @param geometry - Parent and row rectangles, natural child width, gap, and visible bounds.
 * @returns Preferred coordinates, page mode, and page width for the shared positioning core.
 */
export function placeMenuSubmenu(geometry: OverlayGeometry): OverlayPlacement {
  const { anchor, parent, width, gap, bounds } = geometry
  const right = parent.right + gap
  const left = parent.left - gap - width
  const page = right + width > bounds.right && left < bounds.left
  return {
    left: page ? parent.left : right + width <= bounds.right ? right : left,
    top: page ? parent.top : anchor.top,
    ...(page ? { width: Math.min(Math.max(parent.width, width), Math.max(0, bounds.right - bounds.left)) } : {}),
    page,
  }
}
