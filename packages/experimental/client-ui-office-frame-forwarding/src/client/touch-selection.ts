/** Long-press selection leaves single-finger scrolling native until the hold is accepted. */

interface PendingHold {
  kind: 'pending'
  touch: Touch
  timer: ReturnType<typeof setTimeout>
}

/**
 * Bind one-finger holds to the existing native selection input; a second finger cancels the hold.
 * @param element - Scrolling viewport allowing pan-x and pan-y.
 * @param selection - Canvas target, current input availability, and native pointer handlers.
 * @param options - Hold duration in milliseconds and maximum movement in CSS pixels before selection starts.
 * @returns Removes listeners, cancels a pending hold, and releases an admitted native press.
 */
export function bindTouchSelection(
  element: HTMLDivElement,
  selection: {
    target: HTMLCanvasElement
    enabled(this: void): boolean
    pointer(this: void, touch: Touch, type: 0 | 2): void
    release(this: void): void
  },
  options: { holdMs: number; movementTolerance: number },
): () => void {
  let gesture: PendingHold | { kind: 'selecting'; identifier: number } | undefined
  const reset = (): void => {
    const previous = gesture
    gesture = undefined
    if (previous?.kind === 'pending') clearTimeout(previous.timer)
    else if (previous?.kind === 'selecting') selection.release()
  }
  const start = (event: TouchEvent): void => {
    reset()
    if (event.touches.length !== 1 || event.target !== selection.target || !event.cancelable || !selection.enabled()) return
    const touch = event.touches[0] as Touch
    const pending: PendingHold = { kind: 'pending', touch, timer: setTimeout(() => {
      if (!selection.enabled()) { reset(); return }
      gesture = { kind: 'selecting', identifier: touch.identifier }
      selection.pointer(touch, 0)
    }, options.holdMs) }
    gesture = pending
  }
  const move = (event: TouchEvent): void => {
    const held = gesture
    if (held === undefined) return
    if (event.touches.length !== 1 || !event.cancelable || !selection.enabled()) { reset(); return }
    const touch = event.touches[0] as Touch
    if (touch.identifier !== (held.kind === 'pending' ? held.touch.identifier : held.identifier)) { reset(); return }
    if (held.kind === 'pending') {
      if (Math.hypot(touch.clientX - held.touch.clientX, touch.clientY - held.touch.clientY) > options.movementTolerance) reset()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    selection.pointer(touch, 2)
  }
  const end = (event: TouchEvent): void => {
    if (gesture?.kind === 'selecting' && event.cancelable) {
      event.preventDefault()
      event.stopPropagation()
    }
    reset()
  }
  const contextMenu = (event: Event): void => {
    if (gesture !== undefined) event.preventDefault()
  }
  const pointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' && gesture?.kind === 'pending') reset()
  }
  element.addEventListener('touchstart', start, { passive: false })
  element.addEventListener('touchmove', move, { passive: false })
  element.addEventListener('touchend', end, { passive: false })
  element.addEventListener('touchcancel', reset)
  element.addEventListener('contextmenu', contextMenu)
  element.addEventListener('pointercancel', pointerCancel)
  window.addEventListener('blur', reset)
  return () => {
    element.removeEventListener('touchstart', start)
    element.removeEventListener('touchmove', move)
    element.removeEventListener('touchend', end)
    element.removeEventListener('touchcancel', reset)
    element.removeEventListener('contextmenu', contextMenu)
    element.removeEventListener('pointercancel', pointerCancel)
    window.removeEventListener('blur', reset)
    reset()
  }
}
