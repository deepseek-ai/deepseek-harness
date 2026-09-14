/**
 * Pointer ownership shared by the docking surface and the float layer.
 *
 * Capture is hardening, not the mechanism: the window listeners carry the
 * gesture either way. Capture is what stops a scroll container the pointer
 * crosses from claiming it, which Chromium reports as a cancelled pointer and
 * an abandoned drag. Environments without the API (jsdom) simply go unhardened.
 */
import { useEffect, useRef } from 'react'

/** The three window listeners one gesture installs. */
export interface PointerFollowers {
  readonly move: (event: PointerEvent) => void
  readonly up: (event: PointerEvent) => void
  readonly cancel: () => void
}

/**
 * Take ownership of the pointer for the rest of the gesture.
 * @param element - the element the gesture started on.
 * @param pointerId - the pointer to capture.
 */
export function capturePointer(element: HTMLElement, pointerId: number): void {
  if (typeof element.setPointerCapture !== 'function') return
  element.setPointerCapture(pointerId)
}

/**
 * Capture the pointer, then follow it on the window until release or cancel.
 * Only that pointer's events count: a second finger or a pen beside the mouse
 * neither moves nor ends the gesture. The listeners remove themselves before
 * `up` or `cancel` runs; the returned callback ends the gesture early, for an
 * unmount or a superseding press.
 * @param element - the element the gesture started on.
 * @param pointerId - the pointer to capture and follow.
 * @param followers - listeners for move, release, and cancel.
 * @returns detach callback removing the three listeners.
 */
export function followPointer(element: HTMLElement, pointerId: number, followers: PointerFollowers): () => void {
  capturePointer(element, pointerId)
  const controller = new AbortController()
  const { signal } = controller
  const own = (event: PointerEvent): boolean => event.pointerId === pointerId
  window.addEventListener('pointermove', (event) => { if (own(event)) followers.move(event) }, { signal })
  window.addEventListener('pointerup', (event) => {
    if (!own(event)) return
    controller.abort()
    followers.up(event)
  }, { signal })
  window.addEventListener('pointercancel', (event) => {
    if (!own(event)) return
    controller.abort()
    followers.cancel()
  }, { signal })
  return () => { controller.abort() }
}

/** What one gesture does while it lasts and when it settles. */
export interface GestureFollowers {
  readonly move: (event: PointerEvent) => void
  /** The release. The gesture has already ended, and its preview reset, when this runs. */
  readonly up: (event: PointerEvent) => void
}

/**
 * Start a gesture from the element a press landed on.
 * @param element - the pressed element; the pointer is captured on it.
 * @param pointerId - the pressing pointer.
 * @param followers - what the gesture does.
 */
export type BeginGesture = (element: HTMLElement, pointerId: number, followers: GestureFollowers) => void

/**
 * One pointer gesture at a time for a component. A gesture ends on release, on
 * cancel, or when a new press supersedes it; `reset` runs at each of those ends
 * so the component clears its preview. Unmounting mid-gesture removes the
 * listeners without resetting anything.
 * @param reset - clears the component's gesture preview.
 * @returns the gesture starter, called from a pointer-down handler.
 */
export function useGesture(reset: () => void): BeginGesture {
  const inFlight = useRef<{ readonly stop: () => void; readonly end: () => void } | undefined>(undefined)
  useEffect(() => () => { inFlight.current?.stop() }, [])
  return (element, pointerId, followers) => {
    inFlight.current?.end()
    const settle = (): void => {
      inFlight.current = undefined
      reset()
    }
    const stop = followPointer(element, pointerId, {
      move: followers.move,
      up: (event) => {
        settle()
        followers.up(event)
      },
      cancel: settle,
    })
    inFlight.current = {
      stop,
      end: () => {
        stop()
        settle()
      },
    }
  }
}
