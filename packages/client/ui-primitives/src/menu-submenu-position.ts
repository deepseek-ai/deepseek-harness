/** Choose between a side child card and a single-panel child page from layout-viewport space. */

/** Gap between the parent card and a side child card, matching `.submenu` in Menu.module.css. */
export const SUBMENU_GAP = 4
/** Layout-viewport inset shared with every portalled Menu card. */
export const SUBMENU_MARGIN = 12

/**
 * Report whether neither side of the parent card can hold the child card.
 * CSS anchors place the side card and flip it; this decision only selects the page layout.
 * @param parent - Parent card rectangle in client coordinates.
 * @param width - Natural child card width.
 * @param viewportWidth - Layout viewport width.
 * @returns true when the child must replace the parent page.
 */
export function submenuNeedsPage(parent: DOMRect, width: number, viewportWidth: number): boolean {
  const right = parent.right + SUBMENU_GAP + width <= viewportWidth - SUBMENU_MARGIN
  const left = parent.left - SUBMENU_GAP - width >= SUBMENU_MARGIN
  return !right && !left
}
