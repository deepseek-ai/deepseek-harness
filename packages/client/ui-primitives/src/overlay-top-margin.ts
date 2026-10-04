/** Shared viewport inset for overlays, derived from the desktop frame's reserved top strip. */

/**
 * Resolve the top margin an overlay keeps from the viewport edge.
 * @param min - the overlay's own viewport margin in px, used as the floor.
 * @returns the larger of `min` and the frame clearance plus 20px; fullscreen keeps only the 20px gap.
 */
export function overlayTopMargin(min: number): number {
  const root = document.documentElement
  const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'))
  if (Number.isNaN(clearance)) return min
  return Math.max(min, (root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20)
}
