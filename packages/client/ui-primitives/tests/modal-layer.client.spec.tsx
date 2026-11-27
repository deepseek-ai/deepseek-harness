// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Modal } from '../src/client/Modal.tsx'
import { closeTopModal, isBehindModal, useModalLayer } from '../src/client/useModalLayer.ts'
import { Menu, MenuItemButton } from '../src/client/Menu.tsx'

afterEach(cleanup)
function Nested({ withSearch = true }: { withSearch?: boolean }) {
  const [settings, setSettings] = useState(false)
  const [reference, setReference] = useState(false)
  const [menu, setMenu] = useState(false)
  return <>
    <button onClick={() => { setSettings(true) }}>Settings</button>
    <Modal open={settings} title="Settings" closeLabel="Close settings" onClose={() => { setSettings(false) }}>
      <button onClick={() => { setReference(true) }}>Reference</button>
    </Modal>
    <Modal open={reference} title="Reference" closeLabel="Close reference" onClose={() => { setReference(false) }}>
      {withSearch && <input data-modal-autofocus aria-label="Search" />}
      <Menu open={menu} autoFocus anchor={<button onClick={() => { setMenu(true) }}>Menu</button>}
        items={[{ id: 'item', label: 'Item' }]} onSelect={() => { setMenu(false) }} onClose={() => { setMenu(false) }} />
    </Modal>
  </>
}
const escape = (init = {}) => fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape', code: 'Escape', ...init })

function SearchableMenuDialog({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const items = 'Copy'.toLowerCase().includes(query.toLowerCase()) ? [{ id: 'copy', label: 'Copy' }] : []
  return <Modal open title="Settings" closeLabel="Close settings" onClose={onClose}>
    <Menu open={open} portal anchor={<button onClick={() => { setOpen(true) }}>Actions</button>}
      items={items} onClose={() => { setOpen(false) }}
      search={{ label: 'Filter actions', clearLabel: 'Clear filter', value: query, onChange: setQuery, emptyMessage: 'No matching actions' }} />
  </Modal>
}

it('restores the opener after a closing dialog updates its retained controls', () => {
  function RetainedDialog({ open }: { open: boolean }) {
    const dialog = useRef<HTMLDivElement>(null)
    useModalLayer(dialog, open, () => {})
    return <div ref={dialog} role="dialog" aria-modal={open || undefined}>
      <button data-modal-autofocus>{open ? 'Close' : 'Open'}</button>
    </div>
  }
  const view = render(<><button>Opener</button><RetainedDialog open={false} /></>)
  const opener = screen.getByRole('button', { name: 'Opener' })
  opener.focus()
  view.rerender(<><button>Opener</button><RetainedDialog open /></>)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  view.rerender(<><button>Opener</button><RetainedDialog open={false} /></>)
  expect(document.activeElement).toBe(opener)
})

it('preserves the owner return focus when a dialog unmounts', () => {
  function Details() {
    const [open, setOpen] = useState(false)
    const more = useRef<HTMLButtonElement>(null)
    return <>
      <section aria-label="Details" tabIndex={-1}>
        <button ref={more} onClick={() => { setOpen(true) }}>More</button>
      </section>
      <Modal open={open} title="Confirm" closeLabel="Cancel" onClose={() => {
        setOpen(false)
        more.current?.focus()
      }} />
    </>
  }
  render(<Details />)
  screen.getByRole('region', { name: 'Details' }).focus()
  const more = screen.getByRole('button', { name: 'More' })
  fireEvent.click(more)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(more)
})

it('closes only the top modal through application commands and restores each opener', () => {
  render(<Nested />)
  const settings = screen.getByRole('button', { name: 'Settings' }); settings.focus(); fireEvent.click(settings)
  const reference = screen.getByRole('button', { name: 'Reference' }); reference.focus(); fireEvent.click(reference)
  act(() => { closeTopModal(document) })
  expect(screen.queryByRole('dialog', { name: 'Reference' })).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
  expect(document.activeElement).toBe(reference)
  act(() => { closeTopModal(document) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(settings)
  closeTopModal(document)
  expect(document.activeElement).toBe(settings)
})

it.each(['menu', 'dialog'])('does not dismiss a modal behind a newer %s', (role) => {
  const onClose = vi.fn()
  render(<Modal open title="Settings" closeLabel="Close" onClose={onClose} />)
  const overlay = document.createElement('div')
  overlay.setAttribute('role', role)
  overlay.setAttribute('aria-modal', 'true')
  document.body.append(overlay)
  try { closeTopModal(document); expect(onClose).not.toHaveBeenCalled() }
  finally { overlay.remove() }
  closeTopModal(document)
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('uses the latest close callback and retains a modal whose owner declines dismissal', () => {
  const first = vi.fn(), busy = vi.fn()
  const view = render(<Modal open title="Settings" closeLabel="Close" onClose={first} />)
  view.rerender(<Modal open title="Settings" closeLabel="Close" onClose={busy} />)
  closeTopModal(document)
  expect(first).not.toHaveBeenCalled()
  expect(busy).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('closes one layer per Escape, honors local menus and IME, and restores the real opener', () => {
  expect(isBehindModal(null)).toBe(false)
  render(<Nested />)
  const settings = screen.getByRole('button', { name: 'Settings' }); settings.focus(); fireEvent.click(settings)
  const reference = screen.getByRole('button', { name: 'Reference' }); reference.focus(); fireEvent.click(reference)
  expect(document.activeElement).toBe(screen.getByRole('textbox'))
  fireEvent.compositionStart(screen.getByRole('textbox'))
  escape()
  fireEvent.compositionEnd(screen.getByRole('textbox'))
  escape()
  escape({ isComposing: true }); escape({ ctrlKey: true }); escape({ repeat: true })
  expect(screen.getAllByRole('dialog')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  fireEvent.compositionStart(document.activeElement!)
  fireEvent.compositionEnd(document.activeElement!)
  escape()
  expect(screen.getByRole('menu')).toBeTruthy()
  fireEvent.keyUp(document.activeElement!, { key: 'Escape' })
  escape()
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getAllByRole('dialog')).toHaveLength(2)
  escape()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(document.activeElement).toBe(reference)
  escape()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(settings)
})

it('keeps Tab within the top dialog and releases listeners after unmount', () => {
  const view = render(<Nested />)
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  const last = screen.getByRole('button', { name: 'Reference' }); last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close settings' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
  view.unmount()
  const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  document.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
})

it.each([
  { direction: 'forward', shiftKey: false, target: 'Close reference' },
  { direction: 'backward', shiftKey: true, target: 'Menu' },
])('moves $direction from the top dialog container into its controls', ({ shiftKey, target }) => {
  render(<Nested withSearch={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  const reference = screen.getByRole('button', { name: 'Reference' })
  reference.focus()
  fireEvent.click(reference)
  const dialog = screen.getByRole('dialog', { name: 'Reference' })
  dialog.focus()

  expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey })).toBe(false)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: target }))
  escape()
  expect(screen.queryByRole('dialog', { name: 'Reference' })).toBeNull()
  expect(document.activeElement).toBe(reference)
})

it('keeps focus in a headless empty dialog and leaves portaled menu traversal to its owner', () => {
  render(<Modal open headless title="Empty" onClose={() => {}} />)
  const dialog = screen.getByRole('dialog')
  expect(document.activeElement).toBe(dialog)
  fireEvent.keyDown(dialog, { key: 'Tab' })
  expect(document.activeElement).toBe(dialog)
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(dialog)
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const button = document.createElement('button')
  menu.append(button); document.body.append(menu)
  try {
    button.focus()
    expect(fireEvent.keyDown(button, { key: 'Tab' })).toBe(true)
    fireEvent.blur(window)
  } finally { menu.remove() }
})

it('leaves native Tab traversal between a portaled menu search field and its clear button', () => {
  render(<SearchableMenuDialog onClose={() => {}} />)
  const opener = screen.getByRole('button', { name: 'Actions' })
  opener.focus()
  fireEvent.click(opener)
  const search = screen.getByRole('searchbox', { name: 'Filter actions' })
  const clear = screen.getByRole('button', { name: 'Clear filter' })

  expect(document.activeElement).toBe(search)
  expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(true)
  expect(document.activeElement).toBe(search)
  clear.focus()
  expect(fireEvent.keyDown(clear, { key: 'Tab', shiftKey: true })).toBe(true)
  expect(document.activeElement).toBe(clear)
  expect(fireEvent.keyDown(clear, { key: 'Tab' })).toBe(false)
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy' }))
})

it('activates the first enabled search result on Enter after composition ends', () => {
  const onSelect = vi.fn()
  render(<Menu open anchor={null} onClose={() => {}} onSelect={onSelect}
    items={[{ id: 'disabled', label: 'Unavailable', disabled: true }, { id: 'copy', label: 'Copy' }, { id: 'paste', label: 'Paste' }]}
    search={{ label: 'Filter actions', value: 'p', onChange: () => {} }} />)
  const search = screen.getByRole('searchbox', { name: 'Filter actions' })
  expect(screen.queryByRole('button')).toBeNull()

  fireEvent.compositionStart(search)
  expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(true)
  fireEvent.compositionEnd(search)
  expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(true)
  fireEvent.keyUp(search, { key: 'Enter' })
  expect(fireEvent.keyDown(search, { key: 'Enter', repeat: true })).toBe(false)
  expect(onSelect).not.toHaveBeenCalled()

  expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(false)
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('copy')
})

it('keeps explained results focusable while Enter chooses the next selectable result', () => {
  const onCopy = vi.fn()
  const onLocked = vi.fn()
  const onSelect = vi.fn()
  render(<Menu open anchor={null} onClose={() => {}} onSelect={onSelect}
    footer={[{ id: 'add', label: 'Add workspace' }]}
    search={{ label: 'Filter actions', value: '', onChange: () => {} }}>
    <MenuItemButton disabled disabledReason="Waiting for access" onSelect={onLocked}>Locked</MenuItemButton>
    <MenuItemButton onSelect={onCopy}>Copy</MenuItemButton>
  </Menu>)
  const search = screen.getByRole('searchbox', { name: 'Filter actions' })
  fireEvent.keyDown(search, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Locked' }))
  act(() => { search.focus() })
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(onCopy).toHaveBeenCalledOnce()
  expect(onLocked).not.toHaveBeenCalled()
  expect(onSelect).not.toHaveBeenCalled()
})

it.each(['Home', 'End'])('leaves %s to native text navigation while the menu search has focus', (key) => {
  render(<SearchableMenuDialog onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
  const search = screen.getByRole('searchbox', { name: 'Filter actions' })
  fireEvent.change(search, { target: { value: 'Cop' } })
  expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeTruthy()
  expect(document.activeElement).toBe(search)
  expect(fireEvent.keyDown(search, { key })).toBe(true)
  expect(document.activeElement).toBe(search)
})

it('keeps an empty searchable menu in front of the dialog for application close commands', () => {
  const closeDialog = vi.fn()
  render(<SearchableMenuDialog onClose={closeDialog} />)
  const opener = screen.getByRole('button', { name: 'Actions' })
  opener.focus()
  fireEvent.click(opener)
  const search = screen.getByRole('searchbox', { name: 'Filter actions' })
  const clear = screen.getByRole('button', { name: 'Clear filter' })
  expect(screen.getByRole('menu')).toBeTruthy()
  expect(search.closest('[role="menu"]')).toBeNull()
  fireEvent.change(search, { target: { value: 'missing' } })
  expect(screen.getByRole('status').textContent).toBe('No matching actions')
  expect(screen.queryByRole('menu')).toBeNull()
  clear.focus()
  expect(fireEvent.keyDown(clear, { key: 'Tab' })).toBe(false)
  expect(document.activeElement).toBe(search)

  act(() => { closeTopModal(document) })
  expect(closeDialog).not.toHaveBeenCalled()
  fireEvent.click(clear)
  expect(screen.getByRole('menu')).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.change(search, { target: { value: 'missing' } })
  escape()
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(document.activeElement).toBe(opener)
  expect(closeDialog).not.toHaveBeenCalled()
  act(() => { closeTopModal(document) })
  expect(closeDialog).toHaveBeenCalledOnce()
})

it('does not steal focus when a lower layer disappears and restores a remaining parent after opener removal', () => {
  const tree = (parent: boolean, child: boolean, opener: boolean) => <>
    <Modal open={parent} title="Parent" closeLabel="Close parent" onClose={() => {}}>
      {opener && <button>Child opener</button>}
    </Modal>
    <Modal open={child} title="Child" closeLabel="Close child" onClose={() => {}}><input data-modal-autofocus aria-label="Child input" /></Modal>
  </>
  const view = render(tree(true, false, true))
  screen.getByRole('button', { name: 'Child opener' }).focus()
  view.rerender(tree(true, true, true))
  view.rerender(tree(true, true, false))
  view.rerender(tree(true, false, false))
  expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Parent' }))
  view.rerender(tree(true, false, true))
  screen.getByRole('button', { name: 'Child opener' }).focus()
  view.rerender(tree(true, true, true))
  const input = screen.getByRole('textbox')
  view.rerender(tree(false, true, true))
  expect(document.activeElement).toBe(input)
  view.rerender(tree(false, false, true))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('gives a new modal Escape ahead of an older menu', () => {
  let menuClosed = false
  let childClosed = false
  render(<>
    <Modal open title="Parent" closeLabel="Close parent" onClose={() => {}}>
      <Menu open anchor={<button>Menu</button>} items={[{ id: 'item', label: 'Item' }]}
        onSelect={() => {}} onClose={() => { menuClosed = true }} />
    </Modal>
    <Modal open title="Child" closeLabel="Close child" onClose={() => { childClosed = true }}><input data-modal-autofocus /></Modal>
  </>)
  escape()
  expect(menuClosed).toBe(false)
  expect(childClosed).toBe(true)
})
