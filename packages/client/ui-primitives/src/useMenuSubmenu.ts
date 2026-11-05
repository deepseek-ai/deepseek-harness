/** Owns one menu's child layout mode, pointer grace, and focus transitions. */
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject, SyntheticEvent } from 'react'
import type { MenuEntry, MenuItem } from './Menu.tsx'
import { submenuNeedsPage } from './menu-submenu-position.ts'
import { usePointerGrace } from './pointer-grace.ts'

/** Whether a pointer event can request hover interactions.
 * @param event - current pointer, including mixed-input touch events.
 * @returns true for non-touch input with an available hover device.
 */
export function menuHoverAllowed(event: { pointerType: string }): boolean {
  return event.pointerType !== 'touch' && window.matchMedia('(any-hover: hover)').matches
}

interface MenuSubmenu {
  entry: (MenuItem & { submenu: readonly MenuEntry[] }) | undefined
  panelRef: RefObject<HTMLDivElement>
  /** CSS anchor name of the root card's anchor box; the child card is placed against it. */
  parentAnchor: string
  /** Whether the layout mode for the current child is known; the card stays hidden until it is. */
  measured: boolean
  page: boolean
  hidden: boolean
  contains: (node: Node | null) => boolean
  activeList: (focused: Node | null) => HTMLDivElement | null
  /** Returns false when no visible child can handle the navigation. */
  returnToParent: () => boolean
  openChild: (id: string, target: HTMLButtonElement, enter?: boolean) => void
  focusParent: (id: string, target: HTMLButtonElement) => void
  leave: () => void
  cancelClose: () => void
  collapseFrom: (event: SyntheticEvent<HTMLDivElement>) => void
}

/** Manage a single child card without owning the root menu's document listeners.
 * @param options - current entries, root lifetime, and fallback focus destination.
 * @returns child rendering data and narrow interaction operations.
 */
export function useMenuSubmenu(options: {
  open: boolean
  items: readonly MenuEntry[]
  footer: readonly MenuEntry[] | undefined
  listRef: RefObject<HTMLDivElement>
  refocusAnchor: () => void
}): MenuSubmenu {
  const { open, items, footer, listRef, refocusAnchor } = options
  const [expanded, setExpanded] = useState<{ id: string; trigger: HTMLButtonElement; activated: boolean } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // A DOM target suppresses its focus-open handler until focus restoration completes.
  const pendingFocus = useRef<'child' | HTMLButtonElement | null>(null)
  const entry = [...items, ...(footer ?? [])].find((item): item is MenuItem & { submenu: readonly MenuEntry[] } =>
    !('type' in item) && item.id === expanded?.id && item.disabled !== true
    && item.submenu !== undefined && item.submenu.length > 0)
  const trigger = expanded?.trigger ?? null
  const anchorId = useId().replaceAll(':', '')
  const parentAnchor = `--dsh-submenu-parent-${anchorId}`
  // Null until the active child has been measured against the layout viewport.
  const [needsPage, setNeedsPage] = useState<boolean | null>(null)
  const contains = (node: Node | null): boolean => panelRef.current?.contains(node) === true
  const invalidated = expanded !== null && entry === undefined
  // These reads precede React removing an invalidated panel or a page's return row.
  const active = document.activeElement
  const restoreInvalidatedFocus = open && invalidated && (contains(active) || trigger === active)
  const backWasFocused = contains(active) && active?.hasAttribute('data-menu-back') === true
  const measured = needsPage !== null
  const page = entry !== undefined && expanded?.activated === true && needsPage === true
  const hidden = !measured || (needsPage && !page)
  // CSS anchors place the card against the parent card. JavaScript selects the layout and
  // supplies two lengths: the card's natural height and the active row's offset from the
  // parent card's top. Both are relative sizes, so page zoom and panning leave them valid.
  const visible = open && entry !== undefined
  useLayoutEffect(() => {
    const panel = panelRef.current
    const parent = listRef.current
    if (!visible || panel === null || parent === null || trigger === null) { setNeedsPage(null); return }
    const measureRow = (): void => {
      panel.style.setProperty('--dsh-submenu-row-offset', `${trigger.getBoundingClientRect().top - parent.getBoundingClientRect().top}px`)
    }
    // The layout uses the side card's natural size, not the size a page layout gives it.
    const measure = (): void => {
      const layout = panel.getAttribute('data-submenu-layout')
      panel.removeAttribute('data-submenu-layout')
      const width = panel.offsetWidth
      panel.style.setProperty('--dsh-submenu-height', `${panel.offsetHeight}px`)
      if (layout !== null) panel.setAttribute('data-submenu-layout', layout)
      measureRow()
      const viewport = document.documentElement.clientWidth || window.innerWidth
      setNeedsPage(submenuNeedsPage(parent.getBoundingClientRect(), width, viewport))
    }
    measure()
    window.addEventListener('resize', measure)
    parent.addEventListener('scroll', measureRow, true)
    const observer = new ResizeObserver(measure)
    for (const element of [parent, trigger, panel]) observer.observe(element)
    return () => {
      window.removeEventListener('resize', measure)
      parent.removeEventListener('scroll', measureRow, true)
      observer.disconnect()
    }
  }, [visible, entry, trigger, listRef])
  const focusFirstChild = (): void => {
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled):not([data-menu-back])')
      ?? panel?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    first?.focus()
  }
  const returnToParent = (): void => {
    cancelClose()
    pendingFocus.current = trigger
    setExpanded(null)
  }
  const collapse = (): void => {
    cancelClose()
    if (contains(document.activeElement)) returnToParent()
    else setExpanded(null)
  }
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(() => { if (!page) collapse() })
  const openChild = (id: string, target: HTMLButtonElement, enter = false): void => {
    cancelClose()
    if (trigger !== target && contains(document.activeElement)) {
      pendingFocus.current = target
      target.focus()
      pendingFocus.current = null
    }
    pendingFocus.current = enter ? 'child' : null
    setExpanded(current => current?.id === id
      ? enter && !current.activated ? { ...current, activated: true } : current
      : { id, trigger: target, activated: enter })
    if (enter) focusFirstChild()
  }
  useLayoutEffect(() => {
    if (!open || invalidated) {
      cancelClose()
      pendingFocus.current = null
      setExpanded(null)
      if (restoreInvalidatedFocus && (document.activeElement === document.body || document.activeElement === trigger)) {
        const target = trigger?.isConnected === true && !trigger.disabled ? trigger
          : listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        pendingFocus.current = target ?? null
        if (target != null) target.focus()
        else refocusAnchor()
        pendingFocus.current = null
      }
      return
    }
    if (entry === undefined && pendingFocus.current instanceof HTMLButtonElement) {
      pendingFocus.current.focus()
      pendingFocus.current = null
    }
    if (entry === undefined || hidden) return
    if (pendingFocus.current === 'child' || (page && listRef.current?.contains(document.activeElement))
      || (!page && backWasFocused)) {
      focusFirstChild()
      pendingFocus.current = null
    }
  }, [open, entry, needsPage, page, hidden, invalidated, restoreInvalidatedFocus, backWasFocused, cancelClose])

  const collapseFrom = (event: SyntheticEvent<HTMLDivElement>): void => {
    // React DOM normalizes text-node event targets to their parent element.
    const row = (event.target as Element).closest('button[role="menuitem"]')
    if (row === null || row.getAttribute('aria-haspopup') === 'menu') return
    if (row.closest('[role="menu"]') === event.currentTarget) collapse()
  }
  return {
    entry, panelRef, parentAnchor, measured, page, hidden,
    contains,
    activeList: (focused: Node | null) => page || contains(focused) ? panelRef.current : listRef.current,
    returnToParent: (): boolean => {
      if (entry === undefined || hidden) return false
      returnToParent()
      return true
    },
    openChild,
    focusParent: (id: string, target: HTMLButtonElement): void => {
      if (pendingFocus.current !== target) openChild(id, target)
    },
    leave: (): void => { if (!page) armClose() },
    cancelClose,
    collapseFrom,
  }
}
