/** Anchored, outside-dismissed popover shell the timing pickers share. */
import { useRef } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PickerPopover.module.css'

/** Unplaced portal frame: laid out at the viewport origin but unpainted until measured. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Inputs of the picker shell. */
export interface PickerPopoverProps {
  /** Whether the panel is mounted. */
  readonly open: boolean
  /** The row's trigger button, which anchors the panel and counts as inside for dismissal. */
  readonly anchorRef: RefObject<HTMLElement | null>
  /** Accessible name of the panel. */
  readonly label: string
  /** Layout class of this picker's contents.
   * (`| undefined` for exactOptionalPropertyTypes: the CSS module types every class as optional.) */
  readonly className: string | undefined
  /** Dismiss the panel. */
  readonly onClose: () => void
  /** The picker's columns or month grid. */
  readonly children: ReactNode
}

/**
 * Render one picker panel into `document.body`, fixed below its trigger.
 *
 * The panel is a portal, so an ancestor's `overflow` cannot crop it, and a
 * pointerdown outside both the trigger and the panel dismisses it.
 * @param props - open state, the trigger, the panel name and layout class, the dismissal callback, and the contents.
 * @returns the panel while open, and nothing while closed.
 */
export function PickerPopover({ open, anchorRef, label, className, onClose, children }: PickerPopoverProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(anchorRef, open, onClose, panelRef)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, gap: 4, margin: 12 })
  if (!open) return null
  return createPortal(
    <div
      ref={panelRef}
      className={clsx(css.panel, className)}
      style={position ?? MEASURE_STYLE}
      // The rows that open a picker declare `aria-haspopup="dialog"`, so the
      // panel is the dialog they announce, named by the row's own label.
      role="dialog"
      aria-label={label}
      // A click inside the panel belongs to the picker, not to the row that
      // opened it: React bubbles portal events through the React tree.
      onClick={(event) => { event.stopPropagation() }}
    >
      {children}
    </div>,
    document.body,
  )
}
