/**
 * The per-tab context menu, opened by a secondary press on the chip. It carries
 * the close gesture and whatever the embedder appends; the copy and float
 * gestures have no menu item — copying is an embedder API, floating is a drag
 * released clear of the surface. A menu that would hold no item at all renders
 * no popup, so a secondary press on a chip with nothing to offer shows nothing.
 * Presentational — it renders what its props supply and dismisses itself on
 * outside presses.
 *
 * It renders in a portal, positioned against the control that opened it. The tab
 * strip clips its overflow on purpose (so it never becomes a scroll container
 * that claims a drag), and a menu drawn inside the strip would be clipped with
 * it; a portal puts it above every clipping ancestor. React still bubbles the
 * portal's synthetic events through the strip, which is why the press guards
 * below remain necessary.
 */
import { Children, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { DockLabels } from '../contract/adapter.ts'
import css from './dockkit.module.css'

/** Gap between the opening control and the menu, and the viewport margin kept clear. */
const MENU_GAP = 4

/** What the menu offers, where it anchors, and how it closes. */
export interface TabMenuProps {
  readonly labels: DockLabels
  /** The control that opened the menu; the menu hangs below its left edge. */
  readonly anchor: HTMLElement
  /** Close the tab; `undefined` removes the kit's item, leaving the extras only. */
  readonly onClose: (() => void) | undefined
  /** Dismiss without acting. */
  readonly onDismiss: () => void
  /** Embedder items, rendered after the kit's own; absent means none. */
  readonly extras: ReactNode
}

/** Where the menu sits, or `undefined` before the first measurement. */
function placeMenu(anchor: HTMLElement, menu: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect()
  const width = menu.offsetWidth
  // Below the control, aligned to its left edge; flipped to its right edge when
  // that would run off the viewport, as it does for the last tab in a column
  // against the window's right side.
  const left = rect.left + width + MENU_GAP > window.innerWidth
    ? Math.max(MENU_GAP, rect.right - width)
    : rect.left
  return { top: rect.bottom + MENU_GAP, left }
}

/** The actions menu body, anchored to the control that opened it. */
export function TabMenu({ labels, anchor, onClose, onDismiss, extras }: TabMenuProps): ReactNode {
  const self = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<CSSProperties | undefined>(undefined)
  const hasItems = onClose !== undefined || Children.toArray(extras).some(item => item !== '')

  useLayoutEffect(() => {
    if (self.current === null) return
    setPosition(placeMenu(anchor, self.current))
  }, [anchor, hasItems])

  useEffect(() => {
    const menu = self.current
    /* v8 ignore next -- the ref is attached by effect time: the menu renders unconditionally. */
    if (menu === null) return undefined
    // A press anywhere but inside the menu dismisses it; one with no element
    // target (dispatched to the window itself) counts as outside.
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && menu.contains(event.target)) return
      onDismiss()
    }
    // Capture phase: a press on a tab chip starts a drag on its own handler,
    // so the menu must be gone before that handler runs.
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => { window.removeEventListener('pointerdown', onPointerDown, true) }
  }, [onDismiss, hasItems])

  if (!hasItems) return null
  return createPortal(
    <div
      className={css.menu}
      ref={self}
      role="menu"
      data-dockkit-tab-menu
      // Unplaced for one layout pass: measured, then positioned.
      style={position ?? { visibility: 'hidden', top: 0, left: 0 }}
      // React bubbles a portal's events to its tab chip, so both halves of a
      // press must stop here: the press would otherwise start a tab drag and
      // capture the pointer, which retargets the release and swallows this
      // item's click; the click would otherwise also focus a tab the item may
      // have removed.
      onPointerDown={(event) => { event.stopPropagation() }}
      onClick={(event) => { event.stopPropagation() }}
    >
      {onClose !== undefined && (
        <button type="button" role="menuitem" className={css.menuItem} data-dockkit-menu-close onClick={onClose}>
          {labels.closeTab}
        </button>
      )}
      {/* Embedder items last: the kit's own item is the same in every menu, so
          a reader looks for it in the same place every time. */}
      {extras}
    </div>,
    document.body,
  )
}
