/** Pointer, focus, and menu visibility shared by document preview toolbars. */
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'

/** Visibility state and handlers for a toolbar's containing document region. */
export interface FloatingToolbarState {
  readonly visible: boolean
  /** Reveal controls during a zoom gesture. */
  readonly show: () => void
  /** Schedule dismissal after interaction ends. */
  readonly scheduleHide: () => void
  /** Cancel pending dismissal when the owning view stops. */
  readonly clearHide: () => void
  /** @param active - Whether the toolbar owns hover, focus, or an open menu. */
  readonly onActiveChange: (active: boolean) => void
  /** @param event - Pointer movement over the document region. */
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void
  /** Schedule dismissal when the pointer leaves the document region. */
  readonly onPointerLeave: () => void
}

/**
 * Reveal a toolbar near the bottom of its document region and retain active controls.
 * @returns Visibility and handlers for the containing region and toolbar.
 */
export function useFloatingToolbar(): FloatingToolbarState {
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const inRevealZone = useRef(false)
  const active = useRef(false)
  const clearHide = useCallback((): void => {
    clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  const show = useCallback((): void => {
    clearHide()
    setVisible(true)
  }, [clearHide])
  const scheduleHide = useCallback((): void => {
    clearHide()
    if (inRevealZone.current || active.current) return
    timer.current = setTimeout(() => {
      timer.current = undefined
      setVisible(false)
    }, 420)
  }, [clearHide])
  const onActiveChange = useCallback((value: boolean): void => {
    active.current = value
    if (value) show()
    else scheduleHide()
  }, [show, scheduleHide])
  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>): void => {
    inRevealZone.current = event.pointerType === 'mouse'
      && event.clientY >= event.currentTarget.getBoundingClientRect().bottom - 72
    if (inRevealZone.current) show()
    else scheduleHide()
  }, [show, scheduleHide])
  const onPointerLeave = useCallback((): void => {
    inRevealZone.current = false
    scheduleHide()
  }, [scheduleHide])
  useEffect(() => clearHide, [clearHide])
  return { visible, show, scheduleHide, clearHide, onActiveChange, onPointerMove, onPointerLeave }
}
