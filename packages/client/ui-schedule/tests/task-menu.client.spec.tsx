// @vitest-environment jsdom
/**
 * `TaskMenu` behaviors: the pinned header slot, the `data-menu-field` keyboard
 * handover a portaled list performs once it is placed, the row walk, and the
 * dismissal and focus-return paths the task manager's four menus rely on.
 */
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskMenu } from '../src/client/TaskMenu.tsx'
import type { TaskMenuEntry } from '../src/client/TaskMenu.tsx'
import taskMenuCss from '../src/client/TaskMenu.module.css'

afterEach(cleanup)

/** Rows every walking case uses: one enabled row and one disabled row. */
const ITEMS: readonly TaskMenuEntry[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta', disabled: true },
]

/** Three enabled rows, so the walk can wrap at both ends. */
const THREE_ROWS: readonly TaskMenuEntry[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
]

/**
 * Host that owns the open state, as every call site does, and closes on both
 * selection and dismissal.
 * @param props.onSelect - receives each selected row id.
 * @param props.portal - whether the host opens the menu in portal mode.
 * @returns the anchored menu.
 */
function OpenMenu({ onSelect, portal = false }: {
  onSelect: (id: string) => void
  portal?: boolean
}) {
  const [open, setOpen] = useState(true)
  return <TaskMenu
    open={open}
    portal={portal}
    items={ITEMS}
    onSelect={(id) => { onSelect(id); setOpen(false) }}
    onClose={() => { setOpen(false) }}
    anchor={<button type="button">trigger</button>}
  />
}

describe('TaskMenu', () => {
  it('shows items only while open, and reports the clicked row id', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <TaskMenu open={false} portal anchor={<span>trigger</span>} onSelect={onSelect} onClose={() => {}} />)
    expect(screen.queryByRole('menu')).toBeNull()
    rerender(
      <TaskMenu open portal anchor={<span>trigger</span>} items={ITEMS} onSelect={onSelect} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('renders an empty list when it is given no rows', () => {
    render(<TaskMenu open anchor={<span>trigger</span>} onSelect={() => {}} onClose={() => {}} />)
    expect(within(screen.getByRole('menu')).queryAllByRole('menuitem')).toEqual([])
  })

  it('renders a heading, a separator, a selected check, a leading icon, and a danger row', () => {
    render(<TaskMenu
      open
      selectedId="a"
      listClassName="extra"
      className="wrapper"
      anchor={<span>trigger</span>}
      items={[
        { type: 'label', id: 'heading', text: 'Group by' },
        { id: 'a', label: 'Alpha' },
        { type: 'separator', id: 'gap' },
        { id: 'c', label: 'Create', icon: <svg data-testid="icon" /> },
        { id: 'd', label: 'Delete', danger: true },
      ]}
      onSelect={() => {}}
      onClose={() => {}}
    />)
    expect(screen.getByText('Group by').getAttribute('role')).toBe('presentation')
    expect(screen.getByRole('separator')).toBeDefined()
    expect(screen.getByTestId('icon')).toBeDefined()
    expect(screen.getByRole('menu').classList.contains('extra')).toBe(true)
    expect(screen.getByText('trigger').parentElement?.classList.contains('wrapper')).toBe(true)
    // Only the selected row carries the trailing check.
    expect(screen.getByRole('menuitem', { name: 'Alpha' }).querySelectorAll('svg')).toHaveLength(1)
    expect(screen.getByRole('menuitem', { name: 'Alpha' }).className).toMatch(/selected/)
    expect(screen.getByRole('menuitem', { name: 'Create' }).querySelectorAll('svg')).toHaveLength(1)
    expect(screen.getByRole('menuitem', { name: 'Create' }).className).not.toMatch(/selected/)
    expect(screen.getByRole('menuitem', { name: 'Delete' }).querySelectorAll('svg')).toHaveLength(0)
    expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toMatch(/danger/)
  })

  it('aligns an in-place list to the anchor\'s end edge', () => {
    const { container } = render(<TaskMenu
      open
      align="end"
      anchor={<span>trigger</span>}
      items={ITEMS}
      onSelect={() => {}}
      onClose={() => {}}
    />)
    expect(container.querySelector('[role="menu"]')?.classList.contains(taskMenuCss.alignEnd!)).toBe(true)
    expect(container.querySelector('[role="menu"]')?.classList.contains(taskMenuCss.portal!)).toBe(false)
  })

  it('keeps text Home and End navigation in a menu header input', () => {
    render(<TaskMenu
      open
      anchor={<button type="button">trigger</button>}
      header={<input aria-label="Filter" defaultValue="query" />}
      items={ITEMS}
      onSelect={() => {}}
      onClose={() => {}}
    />)
    const filter = screen.getByRole('textbox', { name: 'Filter' })
    filter.focus()
    expect(fireEvent.keyDown(filter, { key: 'Home' })).toBe(true)
    expect(fireEvent.keyDown(filter, { key: 'End' })).toBe(true)
    expect(document.activeElement).toBe(filter)
    // Arrow keys still enter the result list from the field.
    expect(fireEvent.keyDown(filter, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }))
  })

  it('hands a placed portal list to the field its header marks', () => {
    render(<TaskMenu
      open
      portal
      align="end"
      anchor={<button type="button">trigger</button>}
      header={<input aria-label="Filter" data-menu-field="" />}
      items={ITEMS}
      onSelect={() => {}}
      onClose={() => {}}
    />)
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Filter' }))
  })

  it('keeps the keyboard on the row when a placed portal list repositions', () => {
    render(<TaskMenu
      open
      portal
      anchor={<button type="button">trigger</button>}
      header={<input aria-label="Filter" data-menu-field="" />}
      items={ITEMS}
      onSelect={() => {}}
      onClose={() => {}}
    />)
    const field = screen.getByRole('textbox', { name: 'Filter' })
    expect(document.activeElement).toBe(field)
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    const alpha = screen.getByRole('menuitem', { name: 'Alpha' })
    expect(document.activeElement).toBe(alpha)

    // Placement runs again on scroll and resize, and on the panel's own size
    // change; the handover is once per open, so a reader on a row keeps it.
    fireEvent(window, new Event('resize'))
    expect(document.activeElement).toBe(alpha)
  })

  it('walks the list with the arrows, wrapping at both ends, and Escape returns the keyboard', () => {
    const onClose = vi.fn()
    render(<TaskMenu
      open
      anchor={<button type="button">trigger</button>}
      items={THREE_ROWS}
      onSelect={() => {}}
      onClose={onClose}
    />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    const alpha = screen.getByRole('menuitem', { name: 'Alpha' })
    const beta = screen.getByRole('menuitem', { name: 'Beta' })
    const gamma = screen.getByRole('menuitem', { name: 'Gamma' })
    trigger.focus()
    // The menu does not move the keyboard on open, so the first step enters at
    // the near end.
    expect(document.activeElement).toBe(trigger)
    // A key outside the walk is left to the browser.
    expect(fireEvent.keyDown(trigger, { key: 'a' })).toBe(true)
    expect(fireEvent.keyDown(trigger, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    fireEvent.keyDown(beta, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(gamma)
    fireEvent.keyDown(gamma, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(gamma)
    fireEvent.keyDown(gamma, { key: 'Home' })
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha, { key: 'End' })
    expect(document.activeElement).toBe(gamma)

    fireEvent.keyDown(gamma, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(trigger)
  })

  it('enters at the last enabled row on ArrowUp and steps over a disabled one', () => {
    render(<TaskMenu
      open
      anchor={<button type="button">trigger</button>}
      items={ITEMS}
      onSelect={() => {}}
      onClose={() => {}}
    />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    expect(fireEvent.keyDown(trigger, { key: 'ArrowUp' })).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }))
  })

  it('keeps the browser traversal on arrows and Tab when the list has no enabled row', () => {
    render(<TaskMenu
      open
      anchor={<button type="button">trigger</button>}
      items={[{ id: 'b', label: 'Beta', disabled: true }]}
      onSelect={() => {}}
      onClose={() => {}}
    />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    expect(fireEvent.keyDown(trigger, { key: 'ArrowDown' })).toBe(true)
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
  })

  it('Tab settles the focused row', () => {
    const onSelect = vi.fn()
    render(<OpenMenu onSelect={onSelect} />)
    screen.getByRole('button', { name: 'trigger' }).focus()
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'trigger' }), { key: 'Tab' })).toBe(false)
    const alpha = screen.getByRole('menuitem', { name: 'Alpha' })
    expect(document.activeElement).toBe(alpha)
    expect(fireEvent.keyDown(alpha, { key: 'Tab' })).toBe(false)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('Shift+Tab closes back to the anchor', () => {
    const onClose = vi.fn()
    render(<TaskMenu
      open
      anchor={<button type="button">trigger</button>}
      items={ITEMS}
      onSelect={() => {}}
      onClose={onClose}
    />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Tab' })
    const alpha = screen.getByRole('menuitem', { name: 'Alpha' })
    expect(document.activeElement).toBe(alpha)
    expect(fireEvent.keyDown(alpha, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps the browser traversal for Tab on a header control and outside the menu', () => {
    render(<TaskMenu
      open
      anchor={<button type="button">trigger</button>}
      header={<input aria-label="Filter" />}
      items={ITEMS}
      onSelect={() => {}}
      onClose={() => {}}
    />)
    // A focused control inside the list that is not a row keeps the traversal.
    const filter = screen.getByRole('textbox', { name: 'Filter' })
    filter.focus()
    expect(fireEvent.keyDown(filter, { key: 'Tab' })).toBe(true)

    // So does a keyboard outside both the anchor and the list, on Tab and on
    // the arrow walk alike.
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(true)
    expect(fireEvent.keyDown(outside, { key: 'ArrowDown' })).toBe(true)
    outside.remove()
  })

  it('leaves the keyboard and the selection alone for a click on the card that is not a row', () => {
    const onSelect = vi.fn()
    render(<TaskMenu
      open
      anchor={<button type="button">trigger</button>}
      items={ITEMS}
      onSelect={onSelect}
      onClose={() => {}}
    />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    // The card's own padding is inside the list but outside every row, so the
    // click activates nothing and moves no keyboard.
    fireEvent.click(screen.getByRole('menu'))
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })

  it('Escape closes without moving the keyboard when the menu did not hold it', () => {
    const onClose = vi.fn()
    render(<TaskMenu
      open
      anchor={<button type="button">trigger</button>}
      items={ITEMS}
      onSelect={() => {}}
      onClose={onClose}
    />)
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    fireEvent.keyDown(outside, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('closes on an outside pointer press and stays open for one inside the card', () => {
    const onClose = vi.fn()
    const { rerender } = render(<TaskMenu
      open
      portal
      anchor={<span>trigger</span>}
      items={ITEMS}
      onSelect={() => {}}
      onClose={onClose}
    />)
    // The portaled card is outside the anchor wrapper, so its own press counts
    // as inside through the card ref.
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)

    // An in-place card is inside the anchor wrapper.
    rerender(<TaskMenu open anchor={<span>trigger</span>} items={ITEMS} onSelect={() => {}} onClose={onClose} />)
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a window blur only when focus moved into an iframe', () => {
    const onClose = vi.fn()
    render(<TaskMenu
      open
      anchor={<span>trigger</span>}
      items={ITEMS}
      onSelect={() => {}}
      onClose={onClose}
    />)
    fireEvent.blur(window)
    expect(onClose).not.toHaveBeenCalled()
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    try {
      iframe.focus()
      expect(document.activeElement).toBe(iframe)
      fireEvent.blur(window)
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      iframe.remove()
    }
  })

  it('returns the keyboard to the anchor after a selection', async () => {
    render(<OpenMenu onSelect={() => {}} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'trigger' }))
  })

  it('leaves the keyboard where the owner moved it after a selection', async () => {
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    try {
      render(<OpenMenu onSelect={() => { elsewhere.focus() }} />)
      fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
      await act(async () => { await Promise.resolve() })
      expect(document.activeElement).toBe(elsewhere)
    } finally {
      elsewhere.remove()
    }
  })

  it('returns the keyboard to the anchor when the page reports no active element', async () => {
    // A document that reports no active element still has to hand the keyboard
    // back, or the next Tab restarts from the top of the page.
    const activeElement = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(null)
    try {
      render(<OpenMenu onSelect={() => {}} />)
      fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
      await act(async () => { await Promise.resolve() })
    } finally {
      activeElement.mockRestore()
    }
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'trigger' }))
  })
})
