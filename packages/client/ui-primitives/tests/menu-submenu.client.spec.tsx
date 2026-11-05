// @vitest-environment jsdom
/** Submenu interactions use explicit geometry and pointer capabilities, not the host screen. */
import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Menu, MenuItemButton, type MenuEntry } from '../src/Menu.tsx'
import { POINTER_GRACE_MS } from '../src/pointer-grace.ts'

let panel: DOMRect
let row: DOMRect
let childHeight: number
let hover: boolean

beforeEach(() => {
  panel = new DOMRect(100, 100, 200, 300)
  row = new DOMRect(104, 140, 192, 34)
  childHeight = 100
  hover = true
  vi.stubGlobal('innerWidth', 1024)
  vi.stubGlobal('innerHeight', 768)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: hover })))
  vi.useFakeTimers()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'BUTTON' ? row : panel
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.className.includes('submenu') ? childHeight : panel.height
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function pointer(
  target: Element, type: 'pointerover' | 'pointerout' | 'pointerdown', pointerType: 'mouse' | 'pen' | 'touch', relatedTarget: EventTarget | null = null,
) {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  fireEvent(target, event)
}

const entries = [
  { id: 'parent', label: 'Applications', submenu: [
    { id: 'disabled', label: 'Unavailable', disabled: true },
    { id: 'first', label: 'First app' },
    { id: 'second', label: 'Second app' },
  ] },
  { id: 'other', label: 'Other action' },
]

function Fixture({ onSelect = () => {}, backLabel = 'Go back' }: { onSelect?: (id: string) => void; backLabel?: string }) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} submenuBackLabel={backLabel}
    anchor={<button onClick={() =>{  setOpen(true) }}>More</button>}
    items={entries} onClose={() =>{  setOpen(false) }}
    onSelect={(id) => { onSelect(id); setOpen(false) }}>
    <MenuItemButton onSelect={() =>{  setOpen(false) }}>Plugin action</MenuItemButton>
  </Menu>
}

function ExternalTriggerFixture({ onClose }: { onClose: () => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return <>
    <button ref={trigger} data-context-menu-trigger="" aria-haspopup="menu"
      onClick={() => { setOpen(value => !value) }}><span>External more</span></button>
    <Menu open={open} anchor={null} portal contextual returnFocus={() => trigger.current}
      isExternalTrigger={node => trigger.current?.contains(node) === true}
      anchorRef={trigger}
      items={entries} onClose={() => { onClose(); setOpen(false) }} />
  </>
}

function openMenu() {
  const trigger = screen.getByRole('button', { name: 'More' })
  act(() =>{  trigger.focus() })
  fireEvent.click(trigger)
  return trigger
}

function childMenu() {
  return screen.getByRole('menuitem', { name: 'First app' }).closest<HTMLElement>('[role="menu"]')!
}

describe('Menu submenus', () => {
  it('dismisses a non-contextual menu when an external marked trigger is pressed', () => {
    const close = vi.fn()
    render(<>
      <button data-context-menu-trigger="">Header more</button>
      <Menu open anchor={null} items={entries} onClose={close} />
    </>)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Header more' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not activate an external popup trigger on ArrowRight', () => {
    render(<ExternalTriggerFixture onClose={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'External more' })
    act(() => { trigger.focus() })
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    expect(screen.getByRole('menu')).toBeDefined()
    expect(document.activeElement).toBe(trigger)
  })

  it('dismisses on a return-focus subtree that is not marked as a menu trigger', () => {
    const close = vi.fn()
    const restore = document.createElement('div')
    const target = document.createElement('button')
    restore.append(target)
    document.body.append(restore)
    try {
      render(<Menu open anchor={null} contextual returnFocus={() => restore} items={entries} onClose={close} />)
      fireEvent.pointerDown(target)
      expect(close).toHaveBeenCalledOnce()
    } finally { restore.remove() }
  })

  it.each(['mouse', 'pen'] as const)('accepts a secondary %s when the primary pointer cannot hover', (pointerType) => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(any-hover: hover)' })))
    render(<Fixture />)
    openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    pointer(parent, 'pointerover', 'touch')
    fireEvent.mouseOver(parent)
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    pointer(parent, 'pointerover', pointerType)
    expect(screen.getByRole('menuitem', { name: 'First app' })).toBeDefined()
  })

  it('lets an external return-focus trigger toggle closed through pointerdown then click', () => {
    const close = vi.fn()
    render(<ExternalTriggerFixture onClose={close} />)
    const target = screen.getByText('External more')
    fireEvent.pointerDown(target)
    fireEvent.click(target)
    expect(screen.getByRole('menu')).toBeDefined()
    fireEvent.pointerDown(target)
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(target)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each(['removed', 'disabled', 'empty'] as const)('restores the root page when the active parent becomes %s', (change) => {
    vi.stubGlobal('innerWidth', 390)
    const props = { open: true, anchor: null, submenuBackLabel: 'Go back', onClose: vi.fn() }
    const view = render(<Menu {...props} items={entries} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
    const changed: MenuEntry[] = change === 'removed' ? [entries[1]!]
      : [{ ...entries[0]!, ...(change === 'disabled' ? { disabled: true } : { submenu: [] }) }, entries[1]!]
    view.rerender(<Menu {...props} items={changed} />)
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Other action' })).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: change === 'empty' ? 'Applications' : 'Other action' }))
    view.rerender(<Menu {...props} items={entries} />)
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Applications' }).getAttribute('aria-expanded')).toBe('false')
  })

  it.each([390, 1024])('restores focus when an active footer submenu is removed at %ipx', (width) => {
    vi.stubGlobal('innerWidth', width)
    const props = { open: true, anchor: null, items: [entries[1]!], onClose: vi.fn() }
    const view = render(<Menu {...props} footer={[entries[0]!]} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    view.rerender(<Menu {...props} />)
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Other action' }))
  })

  it('preserves focus already moved outside an invalidated submenu', () => {
    vi.stubGlobal('innerWidth', 390)
    const props = { open: true, anchor: <button>Outside control</button>, onClose: vi.fn() }
    const view = render(<Menu {...props} items={entries} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    const outside = screen.getByRole('button', { name: 'Outside control' })
    act(() => { outside.focus() })
    view.rerender(<Menu {...props} items={[entries[1]!]} />)
    expect(screen.getByRole('menuitem', { name: 'Other action' })).toBeDefined()
    expect(document.activeElement).toBe(outside)
  })

  it('returns focus to the anchor when invalidation leaves no enabled root row', () => {
    vi.stubGlobal('innerWidth', 390)
    const props = { open: true, anchor: <button>More</button>, onClose: vi.fn() }
    const view = render(<Menu {...props} items={[entries[0]!]} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    view.rerender(<Menu {...props} items={[]} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More' }))
  })

  it('shows a chevron, isolates the child keyboard walk, and returns before closing the root', () => {
    render(<Fixture />)
    const trigger = openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    expect(parent.querySelector('[data-icon="dsw-icon-chevron-right-outline-regular"]')).not.toBeNull()
    act(() =>{  parent.focus() })
    expect(parent.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(parent)
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second app' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    expect(document.activeElement).toBe(parent)
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.getByRole('menu')).toBeDefined()
    expect(document.activeElement).toBe(parent)
    fireEvent.keyDown(parent, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it.each(['click', 'Tab'])('selects the child with %s once and restores the original trigger', async (method) => {
    const select = vi.fn()
    render(<Fixture onSelect={select} />)
    const trigger = openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    const child = screen.getByRole('menuitem', { name: 'First app' })
    fireEvent.pointerDown(child)
    expect(screen.getAllByRole('menu')).toHaveLength(2)
    if (method === 'click') fireEvent.click(child)
    else fireEvent.keyDown(child, { key: 'Tab' })
    await act(async () => { await Promise.resolve() })
    expect(select).toHaveBeenCalledExactlyOnceWith('first')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('portals a side child anchored to the parent card at the active row offset, outside parent scrolling', () => {
    panel = new DOMRect(780, 620, 200, 120)
    row = new DOMRect(784, 680, 192, 34)
    render(<Fixture />)
    openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    fireEvent.click(parent)
    const menu = childMenu()
    const root = parent.closest<HTMLElement>('[role="menu"]')!
    expect(menu.parentElement).toBe(document.body)
    expect(root.contains(menu)).toBe(false)
    expect(menu.getAttribute('data-submenu-layout')).toBe('side')
    expect(menu.style.visibility).toBe('')
    // CSS anchors own placement and flipping; the card names its anchor and sets no coordinates.
    const box = root.querySelector<HTMLElement>(':scope > [aria-hidden="true"][style*="anchor-name"]')
    expect(box?.style.anchorName).toBe(menu.style.getPropertyValue('--dsh-submenu-parent'))
    expect(menu.style.left).toBe('')
    expect(menu.style.top).toBe('')
    expect(menu.style.getPropertyValue('--dsh-submenu-height')).toBe('100px')
    expect(menu.style.getPropertyValue('--dsh-submenu-row-offset')).toBe('60px')
    row = new DOMRect(784, 650, 192, 34)
    fireEvent.scroll(root.querySelector('[role="presentation"]')!)
    expect(menu.style.getPropertyValue('--dsh-submenu-row-offset')).toBe('30px')
  })

  it('re-measures the row offset on observed size changes and stops observing on close', () => {
    const observers: { callback: ResizeObserverCallback; observed: Element[]; disconnect: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('ResizeObserver', class {
      private readonly record
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, observed: [] as Element[], disconnect: vi.fn() }
        observers.push(this.record)
      }
      observe(element: Element) { this.record.observed.push(element) }
      unobserve() {}
      disconnect() { this.record.disconnect() }
    })
    render(<Fixture />)
    openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    fireEvent.click(parent)
    const menu = childMenu()
    const observer = observers.at(-1)!
    expect(observer.observed).toEqual(expect.arrayContaining([parent, menu, parent.closest('[role="menu"]')]))
    expect(menu.style.getPropertyValue('--dsh-submenu-row-offset')).toBe('40px')
    row = new DOMRect(104, 200, 192, 34)
    act(() => { observer.callback([], {} as ResizeObserver) })
    expect(menu.style.getPropertyValue('--dsh-submenu-row-offset')).toBe('100px')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(observer.disconnect).toHaveBeenCalled()
  })

  it('uses one visible panel at 390px and a localized non-selecting return action', () => {
    vi.stubGlobal('innerWidth', 390)
    panel = new DOMRect(170, 100, 200, 300)
    const select = vi.fn()
    render(<Fixture onSelect={select} backLabel="返回上级" />)
    openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    fireEvent.click(parent)
    const menu = childMenu()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(menu.getAttribute('data-submenu-layout')).toBe('page')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '返回上级' }))
    expect(select).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(parent)
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
  })

  it('keeps a narrow menu on its parent page until explicit submenu activation', () => {
    vi.stubGlobal('innerWidth', 390)
    const close = vi.fn()
    render(<Menu open autoFocus anchor={null} submenuBackLabel="Go back" items={entries} onClose={close} />)
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    expect(document.activeElement).toBe(parent)
    expect(parent.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    fireEvent.keyDown(parent, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    expect(screen.getByRole('menuitem', { name: 'Go back' })).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
  })

  it('uses the caller parent label when no explicit return label was supplied', () => {
    vi.stubGlobal('innerWidth', 390)
    render(<Menu open anchor={null} items={entries} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    const back = screen.getByRole('menuitem', { name: 'Applications' })
    expect(back.querySelector('[data-icon="dsw-icon-chevron-left-outline-regular"]')).not.toBeNull()
    fireEvent.click(back)
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
  })

  it('preserves the focused child DOM node while resizing between side and single-panel placement', () => {
    render(<Fixture />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    const child = screen.getByRole('menuitem', { name: 'Second app' })
    act(() =>{  child.focus() })
    vi.stubGlobal('innerWidth', 390)
    fireEvent(window, new Event('resize'))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(document.activeElement).toBe(child)
    vi.stubGlobal('innerWidth', 1024)
    fireEvent(window, new Event('resize'))
    expect(screen.getAllByRole('menu')).toHaveLength(2)
    expect(document.activeElement).toBe(child)
  })

  it('keeps wide touch devices in side placement and ignores touch and compatibility mouse hover', () => {
    hover = false
    render(<Fixture />)
    openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    pointer(parent, 'pointerover', 'touch')
    fireEvent.mouseOver(parent)
    pointer(parent, 'pointerover', 'mouse')
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    pointer(parent, 'pointerdown', 'touch')
    fireEvent.click(parent)
    expect(screen.getAllByRole('menu')).toHaveLength(2)
    expect(childMenu().getAttribute('data-submenu-layout')).toBe('side')
    expect(screen.queryByRole('menuitem', { name: 'Go back' })).toBeNull()
    hover = true
    pointer(screen.getByRole('menuitem', { name: 'Other action' }), 'pointerover', 'touch')
    fireEvent.mouseOver(screen.getByRole('menuitem', { name: 'Other action' }))
    expect(screen.getByRole('menuitem', { name: 'First app' })).toBeDefined()
  })

  it.each(['Other action', 'Plugin action'])('keeps keyboard navigation after hovering root row %s', (name) => {
    render(<Fixture />)
    openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    fireEvent.click(parent)
    const menu = childMenu()
    const target = screen.getByRole('menuitem', { name })
    pointer(menu, 'pointerover', 'mouse', parent)
    pointer(menu, 'pointerout', 'mouse', target)
    pointer(target, 'pointerover', 'mouse', menu)
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    expect(document.activeElement).toBe(parent)
    fireEvent.keyDown(parent, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Other action' }))
  })

  it('keeps child keyboard navigation when hover replaces its submenu', () => {
    render(<Menu open anchor={null} onClose={() => {}} items={[
      entries[0]!,
      { id: 'next', label: 'Next group', submenu: [{ id: 'next-one', label: 'Next choice' }] },
    ]} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    const menu = childMenu()
    const next = screen.getByRole('menuitem', { name: 'Next group' })
    pointer(menu, 'pointerover', 'mouse')
    pointer(menu, 'pointerout', 'mouse', next)
    pointer(next, 'pointerover', 'mouse', menu)
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    expect(document.activeElement).toBe(next)
    fireEvent.keyDown(next, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Next choice' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(next)
  })

  it('does not return to the submenu parent when a root row already holds focus', () => {
    render(<Fixture />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    const target = screen.getByRole('menuitem', { name: 'Other action' })
    act(() => { target.focus() })
    pointer(target, 'pointerover', 'mouse')
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    expect(document.activeElement).toBe(target)
  })

  it('returns child focus after pointer grace so root arrow navigation can continue', () => {
    render(<Fixture />)
    openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    fireEvent.click(parent)
    const menu = childMenu()
    pointer(menu, 'pointerover', 'mouse', parent)
    pointer(menu, 'pointerout', 'mouse', document.body)
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    expect(document.activeElement).toBe(parent)
    fireEvent.keyDown(parent, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Other action' }))
  })

  it.each(['More', 'Other action'])('preserves focus moved to %s before pointer grace ends', (name) => {
    render(<Fixture />)
    openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    fireEvent.click(parent)
    const menu = childMenu()
    pointer(menu, 'pointerover', 'mouse', parent)
    pointer(menu, 'pointerout', 'mouse', document.body)
    const target = screen.getByRole(name === 'More' ? 'button' : 'menuitem', { name })
    act(() => { target.focus() })
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
    expect(document.activeElement).toBe(target)
  })

  it('allows crossing the hover gap and cancels stale grace after keyboard return', () => {
    render(<Fixture />)
    openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    pointer(parent, 'pointerover', 'mouse')
    pointer(parent, 'pointerout', 'mouse')
    pointer(childMenu(), 'pointerover', 'mouse')
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(screen.getByRole('menuitem', { name: 'First app' })).toBeDefined()
    pointer(parent, 'pointerout', 'mouse')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(parent)
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(screen.getByRole('menuitem', { name: 'First app' })).toBeDefined()
    pointer(screen.getByRole('menuitem', { name: 'Plugin action' }), 'pointerover', 'mouse')
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
  })

  it('moves focus from a removed return row to the first child on width expansion', () => {
    vi.stubGlobal('innerWidth', 390)
    render(<Fixture />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    act(() =>{  screen.getByRole('menuitem', { name: 'Go back' }).focus() })
    vi.stubGlobal('innerWidth', 1024)
    fireEvent(window, new Event('resize'))
    expect(screen.queryByRole('menuitem', { name: 'Go back' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
  })

  it('keeps the return row reachable when a narrow child has no enabled choices', () => {
    vi.stubGlobal('innerWidth', 390)
    render(<Menu open anchor={null} submenuBackLabel="Go back" onClose={() => {}}
      items={[{ id: 'parent', label: 'Applications', submenu: [{ id: 'disabled', label: 'Unavailable', disabled: true }] }]} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Go back' }))
  })

  it('preserves the document composition guard across child opening and placement updates', () => {
    render(<Menu open anchor={null} items={entries} onClose={vi.fn()} />)
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    fireEvent.compositionStart(document)
    fireEvent.click(parent)
    vi.stubGlobal('innerWidth', 390)
    fireEvent(window, new Event('resize'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
    fireEvent.compositionEnd(document)
    fireEvent.keyUp(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(parent)
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
  })

  it('walks the single-panel child and closes to the original anchor on Shift+Tab', () => {
    vi.stubGlobal('innerWidth', 390)
    render(<Fixture />)
    const trigger = openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second app' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Go back' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('cancels a pending child close when the root closes and reopens', () => {
    const props = { anchor: null, items: entries, onClose: vi.fn() }
    const view = render(<Menu {...props} open />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    const child = childMenu()
    pointer(child, 'pointerover', 'mouse')
    pointer(child, 'pointerout', 'mouse', document.body)
    view.rerender(<Menu {...props} open={false} />)
    view.rerender(<Menu {...props} open />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
  })

  it.each([false, true])('requires caller opt-in for external controls even in contextual=%s menus', (contextual) => {
    const close = vi.fn()
    const props = { open: true, anchor: null, contextual, items: entries, onClose: close }
    const view = render(<><button data-context-menu-trigger="">External</button><Menu {...props} /></>)
    const external = screen.getByRole('button', { name: 'External' })
    fireEvent.pointerDown(external)
    expect(close).toHaveBeenCalledOnce()
    view.rerender(<><button data-context-menu-trigger="">External</button>
      <Menu {...props} isExternalTrigger={node => external.contains(node)} /></>)
    fireEvent.pointerDown(external.firstChild!)
    expect(close).toHaveBeenCalledOnce()
    fireEvent.pointerDown(document.body)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('handles child context gestures only in contextual=%s menus', (contextual) => {
    const close = vi.fn()
    render(<Menu open contextual={contextual} anchor={null} items={entries} onClose={close} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    const child = screen.getByRole('menuitem', { name: 'First app' })
    const nativeMenuAllowed = fireEvent.contextMenu(child)
    expect(nativeMenuAllowed).toBe(!contextual)
    expect(close).toHaveBeenCalledTimes(contextual ? 1 : 0)
  })

  it('does not collapse a compact child on touch leave', () => {
    render(<Menu open compact dense anchor={null} items={entries} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    const child = childMenu()
    pointer(child, 'pointerover', 'touch')
    pointer(child, 'pointerout', 'touch', document.body)
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
  })

  it('retains an activated page when an armed side-card grace expires after resizing', () => {
    render(<Fixture />)
    openMenu()
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    fireEvent.click(parent)
    const child = childMenu()
    pointer(child, 'pointerover', 'mouse')
    pointer(child, 'pointerout', 'mouse', document.body)
    vi.stubGlobal('innerWidth', 390)
    fireEvent(window, new Event('resize'))
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    pointer(child, 'pointerover', 'mouse')
    pointer(child, 'pointerout', 'mouse', document.body)
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First app' }))
  })

  it('keeps focus on an enabled parent when its hovered child becomes empty', () => {
    const props = { open: true, anchor: null, onClose: vi.fn() }
    const view = render(<Menu {...props} items={entries} />)
    const parent = screen.getByRole('menuitem', { name: 'Applications' })
    act(() => { parent.focus() })
    view.rerender(<Menu {...props} items={[{ ...entries[0]!, submenu: [] }, entries[1]!]} />)
    expect(document.activeElement).toBe(parent)
    expect(screen.queryByRole('menuitem', { name: 'First app' })).toBeNull()
  })

  it('ignores nested custom menu rows and text-target events during submenu exclusivity', () => {
    render(<Menu open anchor={null} items={entries} onClose={vi.fn()}>
      <div role="menu"><button role="menuitem">Nested row</button></div>
      <span>Non-row text</span>
    </Menu>)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Applications' }))
    pointer(screen.getByRole('menuitem', { name: 'Nested row' }), 'pointerover', 'mouse')
    const event = new MouseEvent('pointerover', { bubbles: true })
    Object.defineProperty(event, 'pointerType', { value: 'mouse' })
    fireEvent(screen.getByText('Non-row text').firstChild!, event)
    expect(screen.getByRole('menuitem', { name: 'First app' })).toBeDefined()
  })

  it('does not open disabled submenu parents and dismisses on outside pointerdown', () => {
    const close = vi.fn()
    render(<Menu open anchor={null} items={[{ ...entries[0]!, disabled: true }]} onClose={close} />)
    pointer(screen.getByRole('menuitem'), 'pointerover', 'mouse')
    fireEvent.click(screen.getByRole('menuitem'))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    fireEvent.pointerDown(document.body)
    expect(close).toHaveBeenCalledOnce()
  })
})
