import { useCallback, useEffect, useRef } from 'react'

/**
 * Grace before a pointer-dismissed popup closes. Covers the anchor->popup gap
 * (8px for HoverCard, 4px for Menu) at a hand's travel speed without leaving a
 * popup lingering once the pointer has genuinely moved on.
 */
export const POINTER_GRACE_MS = 200

/** Cancelable delayed close for a pointer-dismissed popup. */
export interface PointerGrace {
  /** Schedule the close {@link POINTER_GRACE_MS} from now, replacing any pending one. */
  arm: () => void
  /** Abort a pending close (the pointer came back). */
  cancel: () => void
}

/**
 * Delay a pointer-dismissed popup's close so the pointer can cross the gap
 * between anchor and popup. A pending close is dropped on unmount.
 * @param close - runs when the grace elapses with no re-entry; read at fire
 * time, so callers may pass a fresh closure each render.
 * @returns the {@link PointerGrace} handle.
 */
export function usePointerGrace(close: () => void): PointerGrace {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeRef = useRef(close)
  closeRef.current = close

  const cancel = useCallback(() => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const arm = useCallback(() => {
    cancel()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      closeRef.current()
    }, POINTER_GRACE_MS)
  }, [cancel])

  useEffect(() => cancel, [cancel])

  return { arm, cancel }
}
