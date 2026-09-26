/** Shared inert ownership for overlapping account overlays. */
const owners = new WeakMap<HTMLElement, { count: number; previous: boolean }>()

/**
 * Disable background interaction until every account overlay releases the element.
 * @param element - background element covered by an overlay.
 * @returns an idempotent release restoring the original inert state after the last owner.
 */
export function acquireOverlayInert(element: HTMLElement): () => void {
  const state = owners.get(element) ?? { count: 0, previous: element.inert }
  state.count++
  owners.set(element, state)
  element.inert = true
  let released = false
  return () => {
    if (released) return
    released = true
    if (--state.count === 0) {
      element.inert = state.previous
      owners.delete(element)
    }
  }
}
