/**
 * Overlay clearance from the window's top strip. On macOS desktop the frame
 * publishes `--dsh-frame-top-clearance` on the root element — the constant
 * step below the traffic-light strip, where clicks drag the window instead of
 * the overlay. JS-clamped overlays keep at least that much air above them.
 * Elsewhere the property is absent and the caller's own margin applies.
 */

/**
 * Resolve the top margin an overlay keeps from the viewport edge.
 * @param min - the overlay's own viewport margin in px, used as the floor.
 * @returns the larger of `min` and the frame's published top clearance.
 */
export function overlayTopMargin(min: number): number {
  const clearance = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance'),
  )
  return Number.isNaN(clearance) ? min : Math.max(min, clearance)
}
