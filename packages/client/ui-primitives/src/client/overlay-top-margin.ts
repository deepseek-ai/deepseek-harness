/** Shared viewport inset for overlays, derived from the desktop frame's reserved top strip. */

/**
 * Resolve the top margin an overlay keeps from the viewport edge.
 * @param min - the overlay's own viewport margin in px, used as the floor.
 * @param anchor - the overlay's anchor rect in viewport coordinates. While the anchor's top edge is inside the
 * viewport, the margin never exceeds `anchor.bottom + gap`, so an overlay opened from a control inside the top strip
 * stays next to it.
 * @param gap - the distance the overlay keeps below `anchor`.
 * @returns the frame clearance plus 20px (20px in fullscreen), capped by a visible `anchor`, but never below `min`.
 */
export function overlayTopMargin(min: number, anchor?: { readonly top: number; readonly bottom: number }, gap = 0): number {
  const root = document.documentElement
  const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'))
  if (Number.isNaN(clearance)) return min
  const cap = anchor !== undefined && anchor.top >= 0 ? anchor.bottom + gap : Number.POSITIVE_INFINITY
  return Math.max(min, Math.min((root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20, cap))
}
