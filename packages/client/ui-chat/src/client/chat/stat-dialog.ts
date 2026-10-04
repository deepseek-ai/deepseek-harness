// One trigger-anchored stat dialog seat shared by the Turn-stat pills
// (TurnUsagePanel) and the composer-dock session stats pills (StatsPills.tsx);
// the matching dialog surface skin lives in stat-dialog.module.css.

import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'

/** Viewport margin the placement clamp keeps (the Menu portal margin). */
const PANEL_MARGIN = 12

/** Distance between the trigger's top edge and the panel's bottom. */
const PANEL_GAP = 8

/**
 * Unplaced portal panel: hidden but laid out so the clamp measures real
 * dimensions (the `useAnchoredPosition` measure pass).
 */
export const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Open state, refs, and clamped placement for one stat dialog. */
export interface StatDialogSeat {
  open: boolean
  setOpen: (open: boolean) => void
  rootRef: MutableRefObject<HTMLSpanElement | null>
  panelRef: MutableRefObject<HTMLDivElement | null>
  pos: CSSProperties | null
}

/**
 * One trigger-anchored dialog seat: open state, viewport-clamped placement, outside-close.
 * @returns the seat; spread `pos ?? MEASURE_STYLE` onto the portaled panel.
 */
export function useStatDialog(): StatDialogSeat {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Portal placement: the dialog is fixed above the trigger and clamped inside
  // the viewport, so a trigger near the window edge cannot push it off-screen.
  const pos = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  })

  // Outside pointerdown closes through the shared primitive; the portaled
  // panel counts as inside. An outside click also closes, because keyboard
  // activation of a sibling trigger fires click without pointerdown; the
  // capture phase lets that click close this dialog before the sibling opens.
  // Escape closes.
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent): void => {
      if (e.target instanceof Node
        && rootRef.current?.contains(e.target) !== true
        && panelRef.current?.contains(e.target) !== true) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('click', onClick, true)
    }
  }, [open, setOpen])

  return { open, setOpen, rootRef, panelRef, pos }
}
