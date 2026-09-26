import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCheckOutlineRegular } from './icons/index.tsx'
import { overlayTopMargin } from './overlay-top-margin.ts'
import { usePointerGrace } from './pointer-grace.ts'
import { isBehindModal } from './useModalLayer.ts'
import { observeComposition } from './keyboard-composition.ts'
import { focusWithoutRing } from './focus.ts'
import { ShortcutKeys } from './ShortcutKeys.tsx'
import { MenuSurface } from './MenuSurface.tsx'
import css from './Menu.module.css'

/** Selectable row (optionally with a nested submenu). */
export interface MenuItem {
  id: string
  label: ReactNode
  disabled?: boolean
  /** Effective binding supplied by the command owner; omitted for unbound actions. */
  shortcut?: { keys: readonly string[]; aria?: string | undefined }
  /** Leading icon (figma .Menu_cell gap 8). */
  icon?: ReactNode
  /** Destructive row: error-colored text/icon and danger hover fill. */
  danger?: boolean
  /** Nested card opened to the right on hover/focus. */
  submenu?: readonly MenuItem[]
}

/** Hairline between item groups (not selectable). */
export interface MenuSeparator {
  type: 'separator'
  id: string
}

/** Non-interactive heading row above a group of items. */
export interface MenuLabel {
  type: 'label'
  id: string
  text: string
}

/** One primary-menu entry: a row, a separator, or a heading label. */
export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

/** Props for one component-rendered menu row. */
export interface MenuItemButtonProps {
  /** Visible row label. */
  children: ReactNode
  /** Effective binding supplied by the command owner; omitted for unbound actions. */
  shortcut?: MenuItem['shortcut']
  /** Leading icon (figma .Menu_cell gap 8). */
  icon?: ReactNode
  /** Whether the row cannot be activated. */
  disabled?: boolean
  /** Destructive row: error-colored text/icon and danger hover fill. */
  danger?: boolean
  /**
   * Start a new group: a hairline above this row, the same one a
   * `{ type: 'separator' }` data entry draws. It comes and goes with the row,
   * so a row that renders nothing leaves no stray line; a data separator
   * directly before it draws no second line, and the list's first row draws none.
   */
  separatorBefore?: boolean
  /** Row activation (click, Enter, or Tab on the focused row). */
  onSelect: () => void
}

/**
 * Render one `role="menuitem"` row for a {@link Menu} whose rows are
 * components rather than `items` data: the same markup and styling as a data
 * row, so it joins the list's keyboard walk and post-selection focus return
 * without any shared state. Closing the menu stays the owner's decision, as
 * it is for data rows.
 * @param props.children - visible row label.
 * @param props.shortcut - effective key labels and accessible combination.
 * @param props.icon - optional leading icon.
 * @param props.disabled - whether the row cannot be activated.
 * @param props.danger - whether to use the destructive row colors.
 * @param props.separatorBefore - whether this row starts a new group (hairline above it).
 * @param props.onSelect - row activation callback.
 * @returns one menu-item row.
 */
export function MenuItemButton({
  children, shortcut, icon, disabled = false, danger = false, separatorBefore = false, onSelect,
}: MenuItemButtonProps) {
  return (
    <div className={css.itemWrap}>
      {separatorBefore && <div className={css.separator} role="separator" />}
      <button
        type="button"
        role="menuitem"
        className={clsx(css.item, danger && css.danger)}
        disabled={disabled}
        aria-keyshortcuts={shortcut?.aria}
        onClick={onSelect}
      >
        {icon !== undefined && <span className={css.itemIcon}>{icon}</span>}
        <span className={css.itemLabel}>{children}</span>
        {shortcut !== undefined && <span aria-hidden="true" className={css.shortcut}><ShortcutKeys keys={shortcut.keys} className={css.shortcutKeys} /></span>}
      </button>
    </div>
  )
}

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'type' in entry && entry.type === 'separator'
}

function isLabel(entry: MenuEntry): entry is MenuLabel {
  return 'type' in entry && entry.type === 'label'
}

/** Unplaced portal list: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Render an anchored dropdown menu. While the list is open its keys mirror the
 * composer's: Tab settles the focused row — from the trigger, Tab enters the
 * list instead — and Escape or Shift+Tab close it and return focus to the
 * anchor's first button, and selecting a row does the same — the rows unmount
 * with the list. Only a keyboard on the trigger or inside the list is
 * intercepted; Tab presses elsewhere on the page stay the browser's.
 * @param props.autoFocus - focus the first item on open; the arrow keys walk the list either way.
 * @param props.open - whether the list is showing (owner-controlled).
 * @param props.anchor - the trigger element (rendered in place).
 * @param props.items - selectable data rows and optional separators (default none; with no `children` either, the list is empty).
 * @param props.selectedId - row shown as selected.
 * @param props.selectedIds - rows shown as selected when a menu contains independent option groups.
 * @param props.onSelect - data-row activation callback (not called for disabled rows or submenu parents that only open children).
 * @param props.onClose - invoked on outside click, Escape, or a window blur
 * that moved focus into an iframe (the only signal a pointerdown inside a
 * cross-origin iframe leaves).
 * @param props.align - list alignment against the anchor (default 'start').
 * @param props.side - open below (`bottom`, default) or above (`top`) the anchor.
 * @param props.portal - render the list into document.body, fixed-positioned
 * from the anchor rect (follows movement and resizing while open). Use when an
 * ancestor's overflow clipping would crop the in-place list; default false
 * keeps the pure-CSS in-place behavior.
 * @param props.closeOnPointerLeave - close the list once the pointer has left
 * both trigger and list for the pointer grace (default false keeps it open
 * until outside click/Escape/selection). The grace makes the 4px trigger->list
 * gap and a brief overshoot survivable; coming back cancels the close.
 * @param props.dense - reduce vertical row spacing without changing the standard typography or card width.
 * @param props.compact - use reduced menu typography and spacing.
 * @param props.getAnchorRect - portal mode only: supply the anchor rect
 * directly (e.g. from a host-owned trigger button) instead of measuring the
 * Menu's own wrapper span. Required when the wrapper isn't itself laid out at
 * the trigger (render-prop anchors, effect-positioned proxies — measuring the
 * wrapper there races the host's layout effects). Called on open, each animation
 * frame, and scroll/resize; return null to skip placement for that frame.
 * @param props.footer - rows pinned below the scrolling items area, separated
 * by a hairline; they stay visible while the items above scroll.
 * @param props.children - component rows rendered after `items` in the same
 * list, each a `role="menuitem"` button such as {@link MenuItemButton}; they
 * share the keyboard walk, the submenu exclusivity, and the post-selection
 * focus return.
 * @param props.selection - how a selected row is marked: a trailing check
 * (`'check'`, default — figma .Menu_cell) or the hover fill held on the row
 * with no check (`'fill'`, for icon-labelled rows where a trailing glyph
 * crowds the cell).
 * @param props.className - extra class on the anchor wrapper span.
 * @param props.listClassName - extra class on the dropdown card itself; the
 * only style hook that reaches a portaled list, which renders under
 * document.body outside the owner's DOM subtree.
 * @returns anchor wrapper with the conditional list.
 */
export function Menu({ open, anchor, items = [], children, selectedId, selectedIds, onSelect, onClose, align = 'start', side = 'bottom', portal = false, closeOnPointerLeave = false, dense = false, compact = false, autoFocus = false, selection = 'check', getAnchorRect, footer, className, listClassName }: {
  open: boolean
  autoFocus?: boolean
  anchor: ReactNode
  items?: readonly MenuEntry[]
  children?: ReactNode
  footer?: readonly MenuEntry[]
  selectedId?: string | undefined
  selectedIds?: readonly string[] | undefined
  onSelect?: (id: string) => void
  onClose: () => void
  align?: 'start' | 'end'
  side?: 'bottom' | 'top' | 'right'
  portal?: boolean
  closeOnPointerLeave?: boolean
  dense?: boolean
  compact?: boolean
  selection?: 'check' | 'fill'
  getAnchorRect?: () => DOMRect | null
  className?: string | undefined
  listClassName?: string | undefined
}) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** Index the arrow walk last focused, the resume point when focus left the rows. */
  const walkIndex = useRef<number | null>(null)
  /**
   * The control that had the keyboard when this menu opened — its own trigger,
   * which an anchor that wraps several controls (a split button) would not be
   * able to name by position.
   */
  const triggerRef = useRef<HTMLElement | null>(null)
  const selectingWithTab = useRef(false)

  /**
   * Hand the keyboard back to the trigger that opened the menu — or, when the
   * anchor never held it, to the anchor's first button. Focus left on a removed
   * row otherwise falls to the page body, where the next Tab restarts from the
   * top of the page.
   * @param navigation - whether explicit keyboard traversal should retain its focus indicator.
   */
  const refocusAnchor = (navigation = false): void => {
    const trigger = triggerRef.current
    const target = trigger !== null && document.contains(trigger) && !(trigger as HTMLButtonElement).disabled
      ? trigger : rootRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (target == null) return
    if (navigation) target.focus()
    else focusWithoutRing(target)
  }

  /**
   * Post-selection focus, for the paths where the rows unmount with the list.
   * A selection whose owner keeps the menu open is left alone, and so is an
   * owner that moved focus itself (a presented file card hands it to its
   * preview button): only a keyboard left on the closing list (or on the body
   * its removal produced) comes back to the trigger.
   */
  const refocusAfterSelection = (): void => {
    const navigation = selectingWithTab.current
    queueMicrotask(() => {
      if (openRef.current) return
      const active = document.activeElement
      if (active === null || active === document.body || listRef.current?.contains(active) === true) refocusAnchor(navigation)
    })
  }
  const openRef = useRef(open)
  openRef.current = open
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null)
  const [fixedPos, setFixedPos] = useState<CSSProperties | null>(null)
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(onClose)

  // Portal mode: fixed-position the list from the anchor rect before paint;
  // track the anchor while open (capture-phase scroll catches nested panes).
  // getAnchorRect trumps measuring the wrapper span: a child layout effect
  // runs before the parent's, so a wrapper the host positions in its own
  // effect measures stale here — the host callback owns the truth instead.
  useLayoutEffect(() => {
    if (!open || !portal) { setFixedPos(null); return }
    const place = () => {
      let r: DOMRect | null
      if (getAnchorRect !== undefined) {
        r = getAnchorRect()
      } else {
        /* v8 ignore next 2 -- the ref is attached before the layout effect runs and the listeners die with it. */
        r = rootRef.current?.getBoundingClientRect() ?? null
      }
      if (r === null) return
      const MARGIN = 12
      const vw = window.innerWidth
      const vh = window.innerHeight
      const listEl = listRef.current
      const lw = listEl?.offsetWidth ?? 0
      const lh = listEl?.offsetHeight ?? 0

      let x: number
      let y: number
      if (side === 'right') {
        x = r.right + 4
        y = r.top
      } else if (align === 'start') {
        x = r.left
        y = side === 'bottom' ? r.bottom + 4 : r.top - lh - 4
      } else {
        x = r.right - lw
        y = side === 'bottom' ? r.bottom + 4 : r.top - lh - 4
      }

      if (lw > 0) x = Math.min(Math.max(x, MARGIN), vw - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, overlayTopMargin(MARGIN)), vh - lh - MARGIN)

      setFixedPos(current => current?.left === x && current.top === y ? current : { left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // end/top alignment and clamping use real dimensions before anything
    // paints — no visible jump from a zero-size first guess.
    place()
    // Dragging or transforming an ancestor moves the anchor without a scroll or resize event.
    const track = () => {
      place()
      frame = requestAnimationFrame(track)
    }
    let frame = requestAnimationFrame(track)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, portal, align, side, getAnchorRect])

  // Opening remembers where the keyboard was, so closing can hand it back to
  // that control — an anchor wrapping several (a split button) cannot be asked
  // for it by position. Declared before the autoFocus effect so the capture
  // sees the trigger, not the row autoFocus is about to focus.
  useEffect(() => {
    if (!open) {
      triggerRef.current = null
      return
    }
    const active = document.activeElement
    triggerRef.current = active instanceof HTMLElement && rootRef.current?.contains(active) === true ? active : null
  }, [open])

  useEffect(() => {
    if (!open || !autoFocus) return
    const first = listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    walkIndex.current = first === undefined || first === null ? null : 0
    if (first != null) focusWithoutRing(first)
  }, [open, autoFocus])

  useEffect(() => {
    if (!open) {
      setOpenSubmenuId(null)
      walkIndex.current = null
      return
    }
    const composition = observeComposition(document)
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return
      // The portaled list is outside the anchor subtree; check both.
      if (rootRef.current?.contains(e.target) === true) return
      if (listRef.current?.contains(e.target) === true) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (composition.guards(e) || isBehindModal(rootRef.current) || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return
      // Where the keyboard is, computed once: the menu owns it when it holds a
      // row or sits on its anchor region.
      const focused = document.activeElement
      const insideList = listRef.current?.contains(focused) === true
      const anchored = rootRef.current?.contains(focused) === true || insideList
      if (e.key === 'Escape' && !e.shiftKey) {
        e.preventDefault()
        if (e.repeat) return
        // Closing hands the keyboard back when the menu had it — and, as this
        // primitive always did for autoFocus menus, when it held the keyboard
        // and lost it again (a row that unmounted under it).
        onClose()
        if (anchored || autoFocus) refocusAnchor()
      }
      // Tab settles like Enter and Shift+Tab leaves like Escape, so a menu's
      // keys mean what they mean in the composer. Only a keyboard already on
      // the trigger or inside the list is intercepted: Tab elsewhere on the
      // page keeps the browser's traversal even while a menu is open.
      if (e.key === 'Tab') {
        const list = listRef.current
        if (list === null || !anchored) return
        if (e.shiftKey) {
          e.preventDefault()
          onClose()
          refocusAnchor(true)
          return
        }
        // Tab settles the row it is on; from anywhere else in the menu region
        // it enters the list. A focused control that is not a row (a retry
        // button inside an error strip) and a list with no enabled row keep the
        // browser's traversal instead of being swallowed.
        if (insideList) {
          if (focused instanceof Element && focused.getAttribute('role') === 'menuitem') {
            e.preventDefault()
            selectingWithTab.current = true
            try { (focused as HTMLElement).click() }
            finally { selectingWithTab.current = false }
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
      // Arrows walk the list whether or not the menu focused its first item on
      // open, so `autoFocus` chooses only that entry behavior. A keyboard still
      // on the anchor enters at the end the step comes from — unless it already
      // walked, in which case the walk resumes where it left off. The walk resumes
      // from where it last put focus, not from `document.activeElement`: a row
      // that refused focus (a hidden portal frame, a detached node) would
      // otherwise re-enter at the near end on every press and the walk would
      // alternate between two rows.
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      const list = listRef.current
      if (list === null || !anchored) return
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
    // A pointerdown inside a cross-origin iframe (a sandboxed HTML preview)
    // never reaches this document; the focus move it causes blurs the window
    // instead. Only that case closes: an app or tab switch leaves the
    // document's focus where it was, so activeElement is not an iframe.
    const onWindowBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    const onEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onKeyDown(event) }
    const onOtherKey = (event: KeyboardEvent): void => { if (event.key !== 'Escape') onKeyDown(event) }
    document.addEventListener('keydown', onOtherKey)
    document.addEventListener('keydown', onEscape, true)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      composition.dispose()
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onOtherKey)
      document.removeEventListener('keydown', onEscape, true)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [open, onClose, autoFocus])

  // A close from selection/Escape/outside click outruns a pending grace close;
  // left armed it would shut a list reopened inside the grace window. Its own
  // effect, not the listener effect above: that one re-runs on every `onClose`
  // identity change and would cancel the grace mid-transit.
  useEffect(() => {
    if (!open) cancelClose()
  }, [open, cancelClose])

  // The submenu card is absolutely positioned outside the list box; the
  // scroll clip would crop it, so only submenu-free menus get the height cap.
  const scrollable = !items.some(entry => !isSeparator(entry) && !isLabel(entry) && entry.submenu !== undefined && entry.submenu.length > 0)

  const renderEntry = (entry: MenuEntry) => {
    if (isSeparator(entry)) {
      return <div key={entry.id} className={css.separator} role="separator" />
    }
    if (isLabel(entry)) {
      return <div key={entry.id} className={css.label} role="presentation">{entry.text}</div>
    }
    const hasSub = entry.submenu !== undefined && entry.submenu.length > 0
    const subOpen = hasSub && openSubmenuId === entry.id
    const selected = entry.id === selectedId || selectedIds?.includes(entry.id) === true
    return (
      <div
        key={entry.id}
        className={css.itemWrap}
        onMouseEnter={hasSub ? () => { setOpenSubmenuId(entry.id) } : undefined}
        onMouseLeave={() => { setOpenSubmenuId(null) }}
      >
        <button
          type="button"
          role="menuitem"
          className={clsx(css.item, selected && (selection === 'fill' ? css.selectedFill : css.selected), entry.danger === true && css.danger)}
          disabled={entry.disabled}
          aria-keyshortcuts={entry.shortcut?.aria}
          aria-haspopup={hasSub ? 'menu' : undefined}
          aria-expanded={hasSub ? subOpen : undefined}
          onFocus={hasSub ? () => { setOpenSubmenuId(entry.id) } : undefined}
          onClick={() => {
            if (hasSub) {
              setOpenSubmenuId(entry.id)
              return
            }
            onSelect?.(entry.id)
          }}
        >
          {entry.icon !== undefined && <span className={css.itemIcon}>{entry.icon}</span>}
          <span className={css.itemLabel}>{entry.label}</span>
          {entry.shortcut !== undefined && <span aria-hidden="true" className={css.shortcut}><ShortcutKeys keys={entry.shortcut.keys} className={css.shortcutKeys} /></span>}
          {/* Selection marker is a trailing check (figma .Menu_cell) unless the fill mode carries it. */}
          {selected && selection === 'check' && <IconCheckOutlineRegular className={css.check} />}
        </button>
        {subOpen && entry.submenu !== undefined && (
          <MenuSurface compact={compact} className={clsx(css.submenu, compact && css.compactList)} role="menu">
            {entry.submenu.map(sub => (
              <button
                key={sub.id}
                type="button"
                role="menuitem"
                className={css.item}
                disabled={sub.disabled}
                aria-keyshortcuts={sub.shortcut?.aria}
                onClick={() => { onSelect?.(sub.id); refocusAfterSelection() }}
              >
                {sub.icon !== undefined && <span className={css.itemIcon}>{sub.icon}</span>}
                <span className={css.itemLabel}>{sub.label}</span>
                {sub.shortcut !== undefined && <span aria-hidden="true" className={css.shortcut}><ShortcutKeys keys={sub.shortcut.keys} className={css.shortcutKeys} /></span>}
              </button>
            ))}
          </MenuSurface>
        )}
      </div>
    )
  }

  // Submenu exclusivity is decided from the list's own bubble, by DOM:
  // reaching a top-level row that is not a submenu parent — by pointer or by
  // focus, data row or component row — closes the open card. A parent opens
  // its card in its own handlers; rows inside the card are not top-level rows.
  const collapseSubmenuFrom = (e: SyntheticEvent<HTMLDivElement>): void => {
    const row = e.target instanceof Element ? e.target.closest('button[role="menuitem"]') : null
    if (row === null || row.getAttribute('aria-haspopup') === 'menu') return
    if (row.closest('[role="menu"]') !== e.currentTarget) return
    setOpenSubmenuId(null)
  }

  // Portal lists render hidden until placed: the placement effect measures
  // this pre-render in the same commit, so the first painted frame is
  // already at the final position (with getAnchorRect returning null the
  // list simply stays hidden).
  const list = open && (
    <MenuSurface compact={compact}
      ref={listRef}
      className={clsx(css.list, listClassName, dense && css.denseList, compact && css.compactList, scrollable && css.scrollable, portal && css.portal, side === 'top' && !portal && css.sideTop, align === 'end' && !portal && css.alignEnd)}
      style={portal ? fixedPos ?? MEASURE_STYLE : undefined}
      role="menu"
      // React portals bubble synthetic events through the REACT tree: without
      // this stop, an item click re-fires the anchor row's own onClick
      // (open/toggle) after onSelect. The same bubble is where every row's
      // activation lands — data rows and component rows alike — so the
      // post-selection focus return is decided once here, after the row's
      // own handler ran; a submenu parent only opened its card.
      onClick={(e) => {
        e.stopPropagation()
        const row = e.target instanceof Element ? e.target.closest('button[role="menuitem"]') : null
        if (row !== null && row.getAttribute('aria-haspopup') !== 'menu') refocusAfterSelection()
      }}
      onMouseOver={collapseSubmenuFrom}
      onFocus={collapseSubmenuFrom}
    >
      <div className={css.viewport} role="presentation">
        {items.map(renderEntry)}
        {children}
      </div>
      {footer !== undefined && footer.length > 0 && (
        <div className={css.footer} role="presentation">
          {footer.map(renderEntry)}
        </div>
      )}
    </MenuSurface>
  )

  // Pointer-leave dismissal watches the WRAPPER, not the list: React's
  // enter/leave traversal runs over the React tree, so trigger and portaled
  // list are one region here. Aiming back at the trigger, or crossing the 4px
  // gap between them, therefore never counts as leaving.
  return (
    <span
      ref={rootRef}
      className={clsx(css.root, className)}
      onPointerEnter={closeOnPointerLeave ? cancelClose : undefined}
      onPointerLeave={closeOnPointerLeave ? () => { if (open) armClose() } : undefined}
    >
      {anchor}
      {portal ? (list !== false && createPortal(list, document.body)) : list}
    </span>
  )
}
