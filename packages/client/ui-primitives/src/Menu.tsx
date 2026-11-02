import { useCallback, useEffect, useId, useLayoutEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useAnchoredPosition } from './useAnchoredPosition.ts'
import { useMenuSubmenu, menuHoverAllowed } from './useMenuSubmenu.ts'
import { MenuRow, MenuDecoration, menuIconColumns } from './MenuRow.tsx'
import { SubmenuPanel } from './SubmenuPanel.tsx'
import { usePointerGrace } from './pointer-grace.ts'
import { isBehindModal } from './useModalLayer.ts'
import { observeComposition } from './keyboard-composition.ts'
import { focusWithoutRing } from './focus.ts'
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
  /** Child choices opened by hover, focus, click, or ArrowRight; placement follows available space. */
  submenu?: readonly MenuEntry[]
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
  /** Whether this row identifies the currently displayed page or view. */
  current?: boolean
  /** Whether the row cannot be activated. */
  disabled?: boolean
  /**
   * Why the disabled row cannot be activated. The row then stays hoverable and
   * focusable, shows the reason in a tooltip, and exposes it as the row's
   * description; an enabled row ignores it.
   */
  disabledReason?: string | undefined
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
 * @param props.current - whether the row identifies the currently displayed page or view.
 * @param props.disabled - whether the row cannot be activated.
 * @param props.disabledReason - why a disabled row cannot be activated, shown in a tooltip and read as its description.
 * @param props.danger - whether to use the destructive row colors.
 * @param props.separatorBefore - whether this row starts a new group (hairline above it).
 * @param props.onSelect - row activation callback.
 * @returns one menu-item row.
 */
export function MenuItemButton({ onSelect, ...props }: MenuItemButtonProps) {
  return <MenuRow {...props} decorativeIcon={false} onClick={onSelect} />
}

/** Unplaced portal list: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Render an anchored dropdown menu. While the list is open its keys mirror the
 * composer's: Tab settles the focused row — from the trigger, Tab enters the
 * list instead — and Escape or Shift+Tab close it and return focus to the
 * anchor's first button, and selecting a row does the same — the rows unmount
 * with the list. Only a keyboard on the trigger or inside the list is
 * intercepted; Tab presses elsewhere on the page stay the browser's. Escape
 * first returns from a visible child, while ArrowRight enters and ArrowLeft returns.
 * When neither side fits, click or ArrowRight opens a single-panel child page;
 * focus alone retains the parent page.
 * @param props.contextual - cursor positioning, context dismissal, and per-divider icon alignment.
 * @param props.exiting - retain an inert popup during dismissal or replacement fade.
 * @param props.returnFocus - original control captured before asynchronous menu preparation.
 * @param props.isExternalTrigger - recognizes external controls whose pointer presses should not dismiss;
 * omitted, every press outside the anchor and menu panels dismisses.
 * @param props.autoFocus - focus the first item on open; the arrow keys walk the list either way.
 * @param props.open - whether the list is showing (owner-controlled).
 * @param props.anchor - the trigger element (rendered in place).
 * @param props.items - selectable data rows and optional separators (default none; with no `children` either, the list is empty).
 * @param props.submenuBackLabel - localized single-panel return label; omitted uses the caller's
 * parent-row label beside a back arrow, without selecting that row.
 * @param props.selectedId - row shown as selected.
 * @param props.selectedIds - rows shown as selected when a menu contains independent option groups.
 * @param props.onSelect - data-row activation callback (not called for disabled rows or submenu parents that only open children).
 * @param props.onClose - invoked on outside click, Escape, or a window blur
 * that moved focus into an iframe (the only signal a pointerdown inside a
 * cross-origin iframe leaves).
 * @param props.align - list alignment against the anchor (default 'start').
 * @param props.side - open below (`bottom`, default) or above (`top`) the anchor.
 * @param props.portal - render the list into document.body, fixed-positioned
 * synchronously (follows movement, resizing, and browser zoom while open)
 * and clamped inside the visual viewport. Use when an ancestor's overflow clipping would crop the
 * in-place list; default false keeps the pure-CSS in-place behavior.
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
 * wrapper there races the host's layout effects). Called while tracking the
 * anchor and on scroll/resize; return null to defer placement.
 * @param props.minWidthFromAnchor - in portal mode, keep the menu at least as wide as its anchor, bounded by viewport margins.
 * @param props.footer - rows pinned below the scrolling items area, separated
 * by a hairline; contextual menus reuse an explicit leading separator. These rows stay visible while the items above scroll.
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
export function Menu({ open, anchor, items = [], children, submenuBackLabel, selectedId, selectedIds, onSelect, onClose, align = 'start', side = 'bottom', portal = false, closeOnPointerLeave = false, dense = false, compact = false, autoFocus = false, selection = 'check', getAnchorRect, minWidthFromAnchor = false, footer, className, listClassName, contextual = false, exiting, returnFocus, isExternalTrigger }: {
  open: boolean
  /** Pointer-positioned popup: cursor clearance, grouped icons, and context gestures. */
  contextual?: boolean
  /** Recognizes external triggers exempt from outside dismissal; omitted exempts no external nodes. */
  isExternalTrigger?: (node: Node) => boolean
  /** Resolve the original control for focus restoration and inert/hidden dismissal. */
  returnFocus?: (() => HTMLElement | null) | undefined
  /** Retain a dismissed context popup during its short fade. */
  exiting?: 'dismiss' | 'replace' | undefined
  autoFocus?: boolean
  anchor: ReactNode
  items?: readonly MenuEntry[]
  /** Localized return action; omitted uses the caller's parent label with a back arrow. */
  submenuBackLabel?: string | undefined
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
  minWidthFromAnchor?: boolean
  className?: string | undefined
  listClassName?: string | undefined
}) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  useLayoutEffect(() => {
    const trigger = returnFocus?.()
    if (!open || !contextual || trigger == null) return
    const previous = trigger.getAttribute('aria-controls')
    trigger.setAttribute('aria-controls', [previous, menuId].filter(Boolean).join(' '))
    return () => {
      if (previous === null) trigger.removeAttribute('aria-controls')
      else trigger.setAttribute('aria-controls', previous)
    }
  }, [open, contextual, returnFocus, menuId])
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
    const trigger = returnFocus?.() ?? triggerRef.current
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
      if (openRef.current && exitingRef.current === undefined) return
      const active = document.activeElement
      if (active === null || active === document.body || listRef.current?.contains(active) === true
        || submenu.contains(active)) refocusAnchor(navigation)
    })
  }
  const exitingRef = useRef(exiting)
  exitingRef.current = exiting
  const openRef = useRef(open)
  openRef.current = open
  const submenu = useMenuSubmenu({ open: open && exiting === undefined, items, footer, contextual, listRef, refocusAnchor })
  const submenuEvents = useRef<Pick<typeof submenu, 'contains' | 'activeList' | 'returnToParent'>>(submenu)
  submenuEvents.current = submenu
  const close = useRef(onClose)
  close.current = onClose
  // Keep the dismissal fade at the last interactive anchor position.
  const lastAnchorRect = useRef<DOMRect | null>(null)
  const readAnchor = useCallback(() => {
    const anchorElement = returnFocus?.() ?? rootRef.current
    if (anchorElement?.closest('[inert], [hidden]') != null) {
      if (exitingRef.current === undefined) close.current()
      return lastAnchorRect.current
    }
    lastAnchorRect.current = getAnchorRect === undefined ? rootRef.current?.getBoundingClientRect() ?? null : getAnchorRect()
    return lastAnchorRect.current
  }, [getAnchorRect, returnFocus])
  const fixedPos = useAnchoredPosition({
    open: open && portal,
    anchorRef: rootRef,
    panelRef: listRef,
    side,
    align,
    gap: 4,
    margin: 12,
    frameClearance: !contextual,
    minWidthFromAnchor,
    getAnchorRect: readAnchor,
  })
  const positioned = !portal || fixedPos !== null
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(onClose)

  // Opening remembers where the keyboard was, so closing can hand it back to
  // that control — an anchor wrapping several (a split button) cannot be asked
  // for it by position. Declared before the autoFocus effect so the capture
  // sees the trigger, not the row autoFocus is about to focus.
  useEffect(() => {
    if (!open) return
    const active = document.activeElement
    triggerRef.current = active instanceof HTMLElement && (getAnchorRect !== undefined || rootRef.current?.contains(active) === true)
      ? active : null
  }, [open])

  useEffect(() => {
    if (!open || exiting !== undefined || !autoFocus || !positioned
      || listRef.current?.contains(document.activeElement) || submenu.contains(document.activeElement)) return
    const first = listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    walkIndex.current = first === undefined || first === null ? null : 0
    if (first != null) focusWithoutRing(first)
  }, [open, autoFocus, items.length, footer?.length, positioned, exiting])

  useEffect(() => {
    if (!open || exiting !== undefined) {
      walkIndex.current = null
      return
    }
    const composition = observeComposition(document)
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || (contextual && e.button === 2)) return
      // The portaled list is outside the anchor subtree; check both.
      if (rootRef.current?.contains(e.target) === true) return
      if (isExternalTrigger?.(e.target) === true) return
      if (listRef.current?.contains(e.target) === true || submenuEvents.current.contains(e.target)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (composition.guards(e) || isBehindModal(triggerRef.current ?? rootRef.current)
        || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return
      // Where the keyboard is, computed once: the menu owns it when it holds a
      // row or sits on its anchor region.
      const focused = document.activeElement
      const insideList = listRef.current?.contains(focused) === true || submenuEvents.current.contains(focused)
      const anchored = focused === returnFocus?.() || rootRef.current?.contains(focused) === true || insideList
      if (e.key === 'Escape' && !e.shiftKey) {
        e.preventDefault()
        if (e.repeat) return
        if (submenuEvents.current.returnToParent()) return
        // Closing hands the keyboard back when the menu had it — and, as this
        // primitive always did for autoFocus menus, when it held the keyboard
        // and lost it again (a row that unmounted under it).
        onClose()
        if (anchored || autoFocus) refocusAnchor()
      }
      if (e.key === 'ArrowLeft' && anchored && submenuEvents.current.returnToParent()) {
        e.preventDefault()
        return
      }
      if (e.key === 'ArrowRight' && insideList && focused instanceof HTMLButtonElement
        && focused.getAttribute('aria-haspopup') === 'menu') {
        e.preventDefault()
        focused.click()
        return
      }
      // Tab settles like Enter and Shift+Tab leaves like Escape, so a menu's
      // keys mean what they mean in the composer. Only a keyboard already on
      // the trigger or inside the list is intercepted: Tab elsewhere on the
      // page keeps the browser's traversal even while a menu is open.
      if (e.key === 'Tab') {
        const list = submenuEvents.current.activeList(focused)
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
            if (focused.getAttribute('aria-disabled') === 'true') {
              onClose()
              refocusAnchor(true)
              return
            }
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
      const list = submenuEvents.current.activeList(focused)
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
  }, [open, onClose, autoFocus, contextual, exiting, returnFocus, isExternalTrigger])

  useLayoutEffect(() => {
    if (exiting === 'dismiss' && listRef.current?.contains(document.activeElement)) refocusAnchor()
  }, [exiting])

  // A close from selection/Escape/outside click outruns a pending grace close;
  // left armed it would shut a list reopened inside the grace window. Its own
  // effect, not the listener effect above: that one re-runs on every `onClose`
  // identity change and would cancel the grace mid-transit.
  useEffect(() => {
    if (!open) cancelClose()
  }, [open, cancelClose])

  const itemColumns = menuIconColumns(items, contextual)
  const footerColumns = menuIconColumns(footer ?? [], contextual)
  const renderEntry = (entry: MenuEntry, columns: ReadonlySet<MenuEntry>) => {
    if ('type' in entry) return <MenuDecoration key={entry.id} entry={entry} />
    const hasSub = entry.submenu !== undefined && entry.submenu.length > 0
    return <MenuRow key={entry.id} icon={entry.icon} reserveIcon={columns.has(entry)}
      disabled={entry.disabled} danger={entry.danger} shortcut={entry.shortcut}
      selected={entry.id === selectedId || selectedIds?.includes(entry.id) === true} selection={selection}
      aria-haspopup={hasSub ? 'menu' : undefined}
      aria-expanded={hasSub ? submenu.entry?.id === entry.id && !submenu.hidden : undefined}
      wrapperProps={hasSub ? {
        onPointerEnter: (event) => {
          if (!menuHoverAllowed(event) || entry.disabled) return
          const trigger = event.currentTarget.querySelector<HTMLButtonElement>('button')
          if (trigger !== null) submenu.openChild(entry.id, trigger)
        },
        onPointerLeave: (event) => { if (menuHoverAllowed(event)) submenu.leave() },
      } : undefined}
      onFocus={hasSub ? (event) => { submenu.focusParent(entry.id, event.currentTarget) } : undefined}
      onClick={(event) => {
        if (hasSub) submenu.openChild(entry.id, event.currentTarget, true)
        else onSelect?.(entry.id)
      }}>{entry.label}</MenuRow>
  }

  // Portal lists stay hidden until their first synchronous measurement.
  const list = open && (
    <MenuSurface compact={compact} id={contextual ? menuId : undefined}
      ref={listRef}
      className={clsx(css.list, listClassName, dense && css.denseList, compact && css.compactList, css.scrollable, submenu.page && css.parentPage, portal && css.portal, side === 'top' && !portal && css.sideTop, align === 'end' && !portal && css.alignEnd)}
      style={submenu.page ? { ...(portal ? fixedPos ?? MEASURE_STYLE : {}), visibility: 'hidden' } : portal ? fixedPos ?? MEASURE_STYLE : undefined}
      role={exiting === undefined && !submenu.page ? 'menu' : undefined}
      aria-hidden={exiting === undefined && !submenu.page ? undefined : true}
      data-context-menu={contextual ? '' : undefined}
      phase={contextual ? exiting ?? 'enter' : undefined}
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
      onContextMenu={contextual ? (event) => {
        event.preventDefault(); event.stopPropagation(); onClose()
      } : undefined}
      onPointerOver={(event) => { if (menuHoverAllowed(event)) submenu.collapseFrom(event) }}
      onFocus={submenu.collapseFrom}
    >
      <div className={css.viewport} role="presentation">
        {items.map(entry => renderEntry(entry, itemColumns))}
        {children}
      </div>
      {footer !== undefined && footer.length > 0 && (
        <div className={css.footer} role="presentation">
          {footer.map(entry => renderEntry(entry, footerColumns))}
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
      onPointerLeave={closeOnPointerLeave ? (event) => { if (open && menuHoverAllowed(event)) armClose() } : undefined}
    >
      {anchor}
      {portal ? (list !== false && createPortal(list, document.body)) : list}
      {open && exiting === undefined && submenu.entry !== undefined && <SubmenuPanel key={submenu.entry.id}
        entry={submenu.entry} submenu={submenu} compact={compact} dense={dense} contextual={contextual}
        backLabel={submenuBackLabel ?? submenu.entry.label} onSelect={onSelect} onClose={onClose} afterSelection={refocusAfterSelection} />}
    </span>
  )
}
