// One trigger-anchored stat dialog seat shared by the Turn-stat pills
// (TurnUsagePanel) and the composer-dock session stats pills (StatsPills.tsx);
// the matching dialog surface skin lives in stat-dialog.module.css.

import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'

/** Open state, refs, and CSS anchor identity for one stat dialog. */
export interface StatDialogSeat {
  open: boolean
  setOpen: (open: boolean) => void
  rootRef: MutableRefObject<HTMLSpanElement | null>
  panelRef: MutableRefObject<HTMLDivElement | null>
  anchorName: string
}

/**
 * One trigger-anchored dialog seat: open state, CSS anchor placement, outside-close.
 * @returns the seat; assign the anchor name to the trigger and the portaled panel.
 */
export function useStatDialog(): StatDialogSeat {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const anchorName = `--dsh-stat-${useId().replaceAll(':', '')}`

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

  return { open, setOpen, rootRef, panelRef, anchorName }
}
