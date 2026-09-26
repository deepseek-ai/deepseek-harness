/**
 * Anchored dropdown menu of the task manager's rule rows and task header.
 *
 * This is the schedule-local copy of the shared `Menu` implementation. The
 * pinned `header` slot and the `data-menu-field` keyboard handover exist for
 * the Time zone row's search box, so the four call sites here keep that
 * capability locally instead of extending the shared card.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  IconCheckOutlineRegular, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TaskMenu.module.css'

/** Selectable row of a {@link TaskMenu}. */
export interface TaskMenuItem {
  /** Identifier `onSelect` receives when the row is activated. */
  id: string
  /** Visible row label. */
  label: ReactNode
  /** Whether the row cannot be activated, and is not a step of the arrow walk. */
  disabled?: boolean
  /** Leading icon. */
  icon?: ReactNode
  /** Destructive row: error-colored text and icon, and the danger hover fill. */
  danger?: boolean
}

/** Hairline between item groups (not selectable). */
export interface TaskMenuSeparator {
  type: 'separator'
  id: string
}

/** Non-interactive heading row above a group of items. */
export interface TaskMenuLabel {
  type: 'label'
  id: string
  text: string
}

/** One TaskMenu entry: a row, a separator, or a heading label. */
export type TaskMenuEntry = TaskMenuItem | TaskMenuSeparator | TaskMenuLabel

/** Inputs of {@link TaskMenu}. */
export interface TaskMenuProps {
  /** Whether the list is showing (owner-controlled). */
  open: boolean
  /** The trigger element, rendered in place. */
  anchor: ReactNode
  /** Selectable rows and optional separators or heading labels (default none). */
  items?: readonly TaskMenuEntry[]
  /** Row shown as selected, marked with a trailing check. */
  selectedId?: string | undefined
  /** Row activation callback (not called for disabled rows). */
  onSelect: (id: string) => void
  /** Invoked on an outside pointer press, Escape, or a window blur that moved focus into an iframe. */
  onClose: () => void
  /** List alignment against the anchor (default 'start'). */
  align?: 'start' | 'end'
  /** Render the list into document.body, fixed-positioned from the anchor rect. */
  portal?: boolean
  /** Owner content pinned above the scrolling rows. */
  header?: ReactNode
  /** Extra class on the anchor wrapper span. */
  className?: string | undefined
  /** Extra class on the dropdown card itself; the only style hook that reaches a portaled list. */
  listClassName?: string | undefined
}

/** Unplaced portal list: hidden but laid out at a fixed origin so its offset size is real. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Distance the list keeps from the anchor edge. */
const ANCHOR_GAP = 4

/** Distance the list keeps from each viewport edge. */
const VIEWPORT_MARGIN = 12

/**
 * Whether an entry is a group hairline.
 * @param entry - one menu entry.
 * @returns true for a separator entry.
 */
function isSeparator(entry: TaskMenuEntry): entry is TaskMenuSeparator {
  return 'type' in entry && entry.type === 'separator'
}

/**
 * Whether an entry is a non-interactive heading.
 * @param entry - one menu entry.
 * @returns true for a heading entry.
 */
function isLabel(entry: TaskMenuEntry): entry is TaskMenuLabel {
  return 'type' in entry && entry.type === 'label'
}

/**
 * Render an anchored dropdown menu. While the list is open, Tab settles the
 * focused row — from the trigger, Tab enters the list instead — Escape and
 * Shift+Tab close it and return focus to the anchor's first enabled button, and
 * selecting a row does the same.
 * @param props.open - whether the list is showing (owner-controlled).
 * @param props.anchor - the trigger element, rendered in place.
 * @param props.items - selectable rows and optional separators or heading labels.
 * @param props.selectedId - row shown as selected.
 * @param props.onSelect - row activation callback, not called for disabled rows.
 * @param props.onClose - invoked on an outside pointer press, Escape, or a
 * window blur that moved focus into a cross-origin iframe.
 * @param props.align - list alignment against the anchor (default 'start').
 * @param props.portal - render the list into document.body, fixed-positioned
 * from the anchor rect (follows scroll and resize while open).
 * @param props.header - owner content pinned above the scrolling rows; a control
 * it marks `data-menu-field` takes the keyboard once the list is placed, which
 * is the frame a portaled list becomes focusable in.
 * @param props.className - extra class on the anchor wrapper span.
 * @param props.listClassName - extra class on the dropdown card itself.
 * @returns the anchor wrapper with the conditional list.
 */
export function TaskMenu({ open, anchor, items = [], selectedId, onSelect, onClose, align = 'start', portal = false, header, className, listClassName }: TaskMenuProps) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** Index the arrow walk last focused, the resume point when focus left the rows. */
  const walkIndex = useRef<number | null>(null)
  /** Whether this open already moved the keyboard into the list. */
  const handedOver = useRef(false)
  const openRef = useRef(open)
  openRef.current = open
  /** Latest close callback, so the document listeners bind once per open. */
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const dismiss = useCallback(() => { closeRef.current() }, [])

  const position = useAnchoredPosition({
    open: open && portal, anchorRef: rootRef, panelRef: listRef, align, gap: ANCHOR_GAP, margin: VIEWPORT_MARGIN,
  })
  useDismissOnOutsidePointer(rootRef, open, dismiss, listRef)

  /* jscpd:ignore-start -- schedule-local copy of the shared ui-primitives Menu; the two owners change independently. */
  /**
   * Hand the keyboard back to the anchor's first enabled button. Focus left on
   * a removed row otherwise falls to the page body, where the next Tab restarts
   * from the top of the page.
   */
  const refocusAnchor = (): void => {
    rootRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }

  /**
   * Post-selection focus, for the paths where the rows unmount with the list.
   * A selection whose owner keeps the menu open is left alone, and so is an
   * owner that moved focus itself: only a keyboard left on the closing list
   * (or on the body its removal produced) comes back to the anchor.
   */
  const refocusAfterSelection = (): void => {
    queueMicrotask(() => {
      if (openRef.current) return
      const active = document.activeElement
      if (active === null || active === document.body || listRef.current?.contains(active) === true) refocusAnchor()
    })
  }
  /* jscpd:ignore-end */

  // A portaled list paints hidden until the placement effect measures it, and a
  // hidden control refuses focus, so neither a header field's own autoFocus nor
  // this effect can take the keyboard in the opening commit. Once the list is
  // placed, a header control marked `data-menu-field` takes it. Focus is handed
  // over once per open, so a reposition while the reader is on a row does not
  // pull the keyboard back.
  useEffect(() => {
    if (!open) {
      handedOver.current = false
      return
    }
    if (handedOver.current) return
    const list = listRef.current
    /* v8 ignore next -- the list is rendered in the same commit that sets `open`, before this effect runs. */
    if (list === null) return
    // A portaled list paints hidden until the position hook has measured it,
    // and a hidden control refuses focus: the handover waits for that frame.
    if (portal && position === null) return
    const field = list.querySelector<HTMLElement>('[data-menu-field]')
    if (field === null) return
    handedOver.current = true
    field.focus()
  }, [open, portal, position])

  useEffect(() => {
    if (!open) {
      walkIndex.current = null
      return
    }
    /* jscpd:ignore-start -- schedule-local copy of the shared ui-primitives Menu; the two owners change independently. */
    const onKeyDown = (e: KeyboardEvent): void => {
      // Where the keyboard is, computed once: the menu owns it when it holds a
      // row or sits on its anchor region.
      const focused = document.activeElement
      const insideList = listRef.current?.contains(focused) === true
      const anchored = rootRef.current?.contains(focused) === true || insideList
      if (e.key === 'Escape') {
        // Closing hands the keyboard back when the menu had it.
        dismiss()
        if (anchored) refocusAnchor()
      }
      // Tab settles like Enter and Shift+Tab leaves like Escape, so a menu's
      // keys mean what they mean in the composer. Only a keyboard already on
      // the trigger or inside the list is intercepted: Tab elsewhere on the
      // page keeps the browser's traversal even while a menu is open.
      if (e.key === 'Tab') {
        const list = listRef.current
        /* v8 ignore next -- the list is mounted whenever this effect's `open` is true. */
        if (list === null) return
        if (!anchored) return
        if (e.shiftKey) {
          e.preventDefault()
          dismiss()
          refocusAnchor()
          return
        }
        // Tab settles the row it is on; from the anchor it enters the list. A
        // focused control that is not a row (the header search box) and a list
        // with no enabled row keep the browser's traversal instead.
        if (insideList) {
          if (focused instanceof Element && focused.getAttribute('role') === 'menuitem') {
            e.preventDefault()
            ;(focused as HTMLElement).click()
          }
          return
        }
        const row = list.querySelector<HTMLButtonElement>('button:not(:disabled)')
        if (row === null) return
        e.preventDefault()
        row.focus()
        walkIndex.current = 0
        return
      }
      // Arrows walk the list. A keyboard still on the anchor enters at the end
      // the step comes from — unless it already walked, in which case the walk
      // resumes where it last put focus. The walk resumes from that recorded
      // index, not from `document.activeElement`: a row that refused focus (a
      // hidden portal frame, a detached node) would otherwise re-enter at the
      // near end on every press and the walk would alternate between two rows.
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      // An embedded search field owns its text-navigation keys. Arrow keys may
      // still enter the result list, while Home and End keep moving its caret.
      if (e.target instanceof HTMLInputElement && (e.key === 'Home' || e.key === 'End')) return
      const list = listRef.current
      /* v8 ignore next -- the list is mounted whenever this effect's `open` is true. */
      if (list === null) return
      if (!anchored) return
      const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      if (buttons.length === 0) return
      const index = buttons.indexOf(focused as HTMLButtonElement)
      const from = index >= 0 ? index : walkIndex.current
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
        : from === null
          ? (e.key === 'ArrowDown' ? 0 : buttons.length - 1)
          : (from + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      e.preventDefault()
      walkIndex.current = next
      buttons[next]?.focus()
    }
    /* jscpd:ignore-end */
    // A pointerdown inside a cross-origin iframe (a sandboxed HTML preview)
    // never reaches this document; the focus move it causes blurs the window
    // instead. Only that case closes: an app or tab switch leaves the
    // document's focus where it was, so activeElement is not an iframe.
    const onWindowBlur = (): void => {
      if (document.activeElement instanceof HTMLIFrameElement) dismiss()
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [open, dismiss])

  const renderEntry = (entry: TaskMenuEntry) => {
    /* jscpd:ignore-start -- schedule-local copy of the shared ui-primitives Menu; the two owners change independently. */
    if (isSeparator(entry)) {
      return <div key={entry.id} className={css.separator} role="separator" />
    }
    if (isLabel(entry)) {
      return <div key={entry.id} className={css.label} role="presentation">{entry.text}</div>
    }
    /* jscpd:ignore-end */
    const selected = entry.id === selectedId
    return (
      <div key={entry.id} className={css.itemWrap}>
        <button
          type="button"
          role="menuitem"
          className={clsx(css.item, selected && css.selected, entry.danger === true && css.danger)}
          disabled={entry.disabled}
          onClick={() => { onSelect(entry.id) }}
        >
          {/* jscpd:ignore-start -- schedule-local copy of the shared ui-primitives Menu; the two owners change independently. */}
          {entry.icon !== undefined && <span className={css.itemIcon}>{entry.icon}</span>}
          <span className={css.itemLabel}>{entry.label}</span>
          {/* Selection marker is a trailing check, figma .Menu_cell. */}
          {selected && <IconCheckOutlineRegular className={css.check} />}
          {/* jscpd:ignore-end */}
        </button>
      </div>
    )
  }

  // Portal lists render hidden until placed: the position hook measures this
  // pre-render in the same commit, so the first painted frame is already at
  // the final coordinates.
  const list = open && (
    <div
      ref={listRef}
      className={clsx(css.list, listClassName, css.scrollable, portal && css.portal, align === 'end' && !portal && css.alignEnd)}
      style={portal ? position ?? MEASURE_STYLE : undefined}
      role="menu"
      // React portals bubble synthetic events through the React tree: without
      // this stop, an item click re-fires an owner handler above the anchor.
      // The same bubble is where every row's activation lands, so the
      // post-selection focus return is decided once here, after the row's own
      // handler ran; a click on the card's own padding decides nothing.
      onClick={(e) => {
        e.stopPropagation()
        /* v8 ignore next -- React dispatches a click from an element target. */
        const row = e.target instanceof Element ? e.target.closest('button[role="menuitem"]') : null
        if (row !== null) refocusAfterSelection()
      }}
    >
      {header !== undefined && <div className={css.header} role="presentation">{header}</div>}
      <div className={css.viewport} role="presentation">
        {items.map(renderEntry)}
      </div>
    </div>
  )

  return (
    <span ref={rootRef} className={clsx(css.root, className)}>
      {anchor}
      {portal ? (list !== false && createPortal(list, document.body)) : list}
    </span>
  )
}
