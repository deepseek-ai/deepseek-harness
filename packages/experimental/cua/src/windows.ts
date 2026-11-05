/** WindowServer visibility used for model observations and app-level target selection. */
import type { CuaWindowInfo } from './types.ts'

/**
 * Whether the window can appear in default discovery on the current desktop.
 * @param window - WindowServer record; unavailable Space membership remains unknown.
 * @returns Whether a positive-size window is on screen and not known to be on another Space.
 */
export function isVisibleWindow(window: CuaWindowInfo): boolean {
  return window.isOnScreen && window.onCurrentSpace !== false && window.bounds.width > 0 && window.bounds.height > 0
}
