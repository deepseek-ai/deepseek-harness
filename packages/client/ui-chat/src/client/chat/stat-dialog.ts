// One trigger-anchored stat dialog seat shared by the Turn-stat pills
// (TurnUsagePanel) and the composer-dock session stats pills (StatsPills);
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
 * @param controlled - external open state; when given the seat reads and writes
 * it instead of owning its own, letting sibling dialogs share one exclusive slot.
 * @returns the seat; spread `pos ?? MEASURE_STYLE` onto the portaled panel.
 */
export function useStatDialog(controlled?: Pick<StatDialogSeat, 'open' | 'setOpen'>): StatDialogSeat {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlled?.open ?? ownOpen
  const setOpen = controlled?.setOpen ?? setOwnOpen
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
  // panel counts as inside. Escape close stays local, one listener while open.
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, setOpen])

  return { open, setOpen, rootRef, panelRef, pos }
}
