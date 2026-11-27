/** Scrollable Office part navigation; the native document remains the selection owner. */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, IconFlatListOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/client'
import css from './SheetTabs.module.css'

interface Part {
  index: number
  name: string
}

function reveal(button: HTMLElement, scroller: HTMLElement): void {
  const bounds = button.getBoundingClientRect()
  const viewport = scroller.getBoundingClientRect()
  if (bounds.left < viewport.left) scroller.scrollLeft += bounds.left - viewport.left
  else if (bounds.right > viewport.right) scroller.scrollLeft += bounds.right - viewport.right
}

/**
 * Render name-only sheet or slide tabs and an overflow menu.
 * @param props.parts - native part indices and names in display order.
 * @param props.selected - native active part index.
 * @param props.onSelect - request a native part change.
 * @param props.label - localized tab-list name.
 * @param props.listLabel - localized overflow-menu action.
 * @param props.panelId - shared sheet panel controlled by these tabs.
 * @returns part navigation with one tab stop and Left/Right/Home/End activation.
 */
export function SheetTabs({ parts, selected, onSelect, label, listLabel, panelId }: {
  parts: readonly Part[]
  selected: number
  onSelect: (part: number) => void
  label: string
  listLabel: string
  panelId: string
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const tabs = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useLayoutEffect(() => {
    const container = root.current as HTMLDivElement, list = tabs.current as HTMLDivElement, scroll = scroller.current as HTMLDivElement
    const update = () => {
      // Compare against the whole strip so removing the menu cannot reintroduce overflow.
      const overflowing = list.scrollWidth > container.clientWidth
      setOverflow(overflowing)
      const active = list.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      if (!overflowing) {
        if (menuOpen || container.querySelector('[aria-haspopup="menu"]') === document.activeElement) active?.focus({ preventScroll: true })
        setMenuOpen(false)
      }
      if (active !== null) reveal(active, scroll)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    observer.observe(list)
    observer.observe(scroll)
    return () => { observer.disconnect() }
  }, [parts, menuOpen, selected])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, position: number) => {
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = (position + parts.length - 1) % parts.length; break
      case 'ArrowRight': next = (position + 1) % parts.length; break
      case 'Home': next = 0; break
      case 'End': next = parts.length - 1; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    const list = tabs.current as HTMLDivElement, scroll = scroller.current as HTMLDivElement, part = parts[next] as Part
    const button = list.querySelectorAll<HTMLButtonElement>('[role="tab"]').item(next)
    button.focus({ preventScroll: true })
    reveal(button, scroll)
    onSelect(part.index)
  }

  return (
    <div className={css.navigation} ref={root}>
      <div className={css.scroller} ref={scroller}>
        <div className={css.tabs} role="tablist" aria-label={label} ref={tabs}>
          {parts.map((part, position) => (
            <Tooltip key={part.index} label={part.name} side="top" portal delayMs={400}>
              <span className={css.tabAnchor}>
                <Button
                  id={`${panelId}-sheet-${part.index}`}
                  role="tab"
                  aria-selected={part.index === selected}
                  aria-controls={panelId}
                  tabIndex={part.index === selected ? 0 : -1}
                  className={css.tab}
                  size="sm"
                  variant="ghost"
                  onClick={() => { onSelect(part.index) }}
                  onKeyDown={(event) => { onKeyDown(event, position) }}
                >
                  <span className={css.name}>{part.name}</span>
                </Button>
              </span>
            </Tooltip>
          ))}
        </div>
      </div>
      {overflow && (
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          onSelect={(id) => { setMenuOpen(false); onSelect(Number(id)) }}
          selectedId={String(selected)}
          items={parts.map(part => ({ id: String(part.index), label: part.name }))}
          portal
          side="top"
          align="end"
          autoFocus
          className={css.menu}
          anchor={
            <Tooltip label={listLabel} side="top" portal disabled={menuOpen}>
              <span className={css.tabAnchor}>
                <Button
                  className={css.listButton}
                  size="sm"
                  variant="ghost"
                  icon={<IconFlatListOutlineRegular size={16} />}
                  aria-label={listLabel}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => { setMenuOpen(value => !value) }}
                />
              </span>
            </Tooltip>
          }
        />
      )}
    </div>
  )
}
