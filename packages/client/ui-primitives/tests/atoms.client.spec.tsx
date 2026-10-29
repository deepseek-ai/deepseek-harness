// @vitest-environment jsdom
import { createRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Button, ConnectionIndicator, Input, Menu, MenuItemButton, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { POINTER_GRACE_MS } from '../src/pointer-grace.ts'
import { focusWithoutRing } from '../src/focus.ts'
import buttonCss from '../src/Button.module.css'

afterEach(cleanup)

describe('isMobileDevice', () => {
  beforeEach(() => { vi.resetModules() })

  it.each([
    { name: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5, mobile: true },
    { name: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X)', platform: 'iPad', maxTouchPoints: 5, mobile: true },
    { name: 'iPod', userAgent: 'Mozilla/5.0 (iPod; U; CPU like Mac OS X; en)', platform: 'iPod', maxTouchPoints: 5, mobile: true },
    { name: 'Android phone', userAgent: 'Mozilla/5.0 (Linux; Android 10; K) Mobile', platform: 'Linux armv8l', maxTouchPoints: 0, mobile: true },
    { name: 'Android tablet', userAgent: 'Mozilla/5.0 (Linux; Android 10; K)', platform: 'Linux armv8l', maxTouchPoints: 5, mobile: true },
    { name: 'desktop-mode iPad', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5, mobile: true },
    { name: 'Mac', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0, mobile: false },
    { name: 'Windows touchscreen', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 5, mobile: false },
    { name: 'native networking UA', userAgent: 'DeepSeek%20Chat/0 CFNetwork/3860.400.51 Darwin/25.3.0', platform: '', maxTouchPoints: 0, mobile: false },
    { name: 'unknown UA', userAgent: 'Unrecognized/1.0', platform: '', maxTouchPoints: 0, mobile: false },
  ])('classifies $name', async ({ userAgent, platform, maxTouchPoints, mobile }) => {
    for (const [name, value] of Object.entries({ userAgent, platform, maxTouchPoints })) {
      const descriptor = Object.getOwnPropertyDescriptor(navigator, name)
      Object.defineProperty(navigator, name, { configurable: true, value })
      onTestFinished(() => {
        if (descriptor === undefined) Reflect.deleteProperty(navigator, name)
        else Object.defineProperty(navigator, name, descriptor)
      })
    }
    const { isMobileDevice } = await import('../src/focus.ts')
    expect(isMobileDevice()).toBe(mobile)
  })

  it.each([true, false])('shares a cached %s result between callers until the module reloads', async (mobile) => {
    const mobileUA = 'Mozilla/5.0 (iPhone)'
    const desktopUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(mobile ? mobileUA : desktopUA)
    onTestFinished(() => { ua.mockRestore() })
    const first = await import('../src/focus.ts')
    expect(first.isMobileDevice()).toBe(mobile)

    ua.mockReturnValue(mobile ? desktopUA : mobileUA)
    const other = await import('@deepseek-ai/dsh-client-ui-primitives/src/focus.ts')
    expect(other.isMobileDevice()).toBe(mobile)
    expect(ua).toHaveBeenCalledTimes(1)

    vi.resetModules()
    const reloaded = await import('../src/focus.ts')
    expect(reloaded.isMobileDevice()).toBe(!mobile)
    expect(ua).toHaveBeenCalledTimes(2)
  })
})

it('retains automatic focus styling while typing and restores it for keyboard navigation', () => {
  render(<button>Automatic destination</button>)
  const button = screen.getByRole('button')
  focusWithoutRing(button)
  fireEvent.keyDown(button, { key: 'a' })
  expect(button.hasAttribute('data-dsh-automatic-focus')).toBe(true)
  fireEvent.keyDown(button, { key: 'ArrowDown' })
  expect(button.hasAttribute('data-dsh-automatic-focus')).toBe(false)
})

describe('Button', () => {
  it('exposes its native button for focus and releases the ref on unmount', () => {
    const ref = createRef<HTMLButtonElement>()
    const { unmount } = render(<Button ref={ref}>Focus</Button>)
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Focus' }))
    ref.current?.focus()
    expect(document.activeElement).toBe(ref.current)
    unmount()
    expect(ref.current).toBeNull()
  })

  it('renders children, icon, and forwards clicks', () => {
    const onClick = vi.fn()
    render(<Button variant="primary" icon={<svg data-testid="ic" />} onClick={onClick}>Go</Button>)
    const button = screen.getByRole('button', { name: 'Go' })
    expect(screen.getByTestId('ic')).toBeDefined()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('disabled blocks interaction', () => {
    const onClick = vi.fn()
    render(<Button disabled onClick={onClick}>No</Button>)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('selects the outline stylesheet for outlined actions only', () => {
    const { rerender } = render(<Button variant="outline">Cancel</Button>)
    const button = screen.getByRole('button', { name: 'Cancel' })
    expect(button.classList.contains(buttonCss.outline!)).toBe(true)
    for (const variant of ['primary', 'ghost', 'toolbar'] as const) {
      rerender(<Button variant={variant}>Cancel</Button>)
      expect(button.classList.contains(buttonCss.outline!)).toBe(false)
    }
  })

  it('keeps the native element and focus when the variant changes', () => {
    const ref = createRef<HTMLButtonElement>()
    const { rerender } = render(<Button ref={ref} variant="outline">Open</Button>)
    const button = screen.getByRole('button')
    button.focus()
    rerender(<Button ref={ref} variant="primary">Open</Button>)
    expect(ref.current).toBe(button)
    expect(document.activeElement).toBe(button)
    rerender(<Button ref={ref} variant="outline">Open</Button>)
    expect(ref.current).toBe(button)
    expect(document.activeElement).toBe(button)
  })
})

describe('Pill', () => {
  it('is a span when static, a button when clickable', () => {
    const { rerender } = render(<Pill active>tab</Pill>)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<Pill onClick={() => {}}>tab</Pill>)
    expect(screen.getByRole('button', { name: 'tab' })).toBeDefined()
  })

  it('active and className land on both static and interactive forms', () => {
    const { container, rerender } = render(<Pill className="x">tab</Pill>)
    const asSpan = container.firstElementChild as HTMLElement
    expect(asSpan.classList.contains('x')).toBe(true)
    rerender(<Pill active className="x" onClick={() => {}}>tab</Pill>)
    const asButton = screen.getByRole('button')
    expect(asButton.classList.contains('x')).toBe(true)
  })
})

describe('Input', () => {
  it('exposes its native input for focus and releases the ref on unmount', () => {
    const ref = createRef<HTMLInputElement>()
    const { unmount } = render(<Input ref={ref} aria-label="Search" />)
    expect(ref.current).toBe(screen.getByRole('textbox', { name: 'Search' }))
    ref.current?.focus()
    expect(document.activeElement).toBe(ref.current)
    unmount()
    expect(ref.current).toBeNull()
  })

  it('forwards value/onChange and renders the leading icon', () => {
    const onChange = vi.fn()
    render(<Input icon={<svg data-testid="ic" />} value="q" onChange={onChange} placeholder="search" />)
    const input = screen.getByPlaceholderText<HTMLInputElement>('search')
    expect(input.value).toBe('q')
    fireEvent.change(input, { target: { value: 'qq' } })
    expect(onChange).toHaveBeenCalled()
    expect(screen.getByTestId('ic')).toBeDefined()
  })
})

describe('MenuItemButton', () => {
  it('exposes the current page without preventing activation and clears it when selection moves', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<MenuItemButton current onSelect={onSelect}>Notes</MenuItemButton>)
    const row = screen.getByRole('menuitem', { name: 'Notes' })
    expect(row.getAttribute('aria-current')).toBe('page')
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledOnce()
    rerender(<MenuItemButton current={false} onSelect={onSelect}>Notes</MenuItemButton>)
    expect(row.hasAttribute('aria-current')).toBe(false)
    rerender(<MenuItemButton onSelect={onSelect}>Notes</MenuItemButton>)
    expect(row.hasAttribute('aria-current')).toBe(false)
  })
})

describe('Menu', () => {
  const items = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta', disabled: true },
  ]

  it('shows items only while open; select fires onSelect', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <Menu open={false} anchor={<span>trigger</span>} items={items} onSelect={onSelect} onClose={() => {}} />)
    expect(screen.queryByRole('menu')).toBeNull()
    rerender(
      <Menu open anchor={<span>trigger</span>} items={items} selectedId="a" onSelect={onSelect} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  it('walks component rows with the data rows and returns focus to the trigger after one is activated', async () => {
    const onAction = vi.fn()
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <Menu
          open={open}
          anchor={<button type="button">trigger</button>}
          items={[{ id: 'a', label: 'Alpha' }]}
          onSelect={() => {}}
          onClose={() => { setOpen(false) }}
        >
          <MenuItemButton separatorBefore shortcut={{ keys: ['Ctrl', 'P'], aria: 'Control+P' }} onSelect={() => { onAction(); setOpen(false) }}>Publish</MenuItemButton>
        </Menu>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Alpha', 'PublishCtrlP'])
    // The component row starts a group: one hairline, between the data row and it.
    const publishWrap = screen.getByRole('menuitem', { name: 'Publish' }).parentElement
    expect(screen.getByRole('separator').nextElementSibling).toBe(screen.getByRole('menuitem', { name: 'Publish' }))
    expect(publishWrap?.contains(screen.getByRole('separator'))).toBe(true)
    const publish = screen.getByRole('menuitem', { name: 'Publish' })
    expect(publish.getAttribute('aria-keyshortcuts')).toBe('Control+P')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'End' })
    expect(document.activeElement).toBe(publish)
    fireEvent.keyDown(publish, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }))
    fireEvent.click(publish)
    expect(onAction).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(trigger)
  })

  it('explains an unavailable component row on hover and focus without activating it', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    try {
      const onSelect = vi.fn()
      const reason = 'Available at 15:51:37.'
      const menu = (explanation: string | undefined) => (
        <Menu open anchor={<button type="button">trigger</button>} onClose={() => {}}>
          <MenuItemButton disabled={explanation !== undefined} disabledReason={explanation} onSelect={onSelect}>Run now</MenuItemButton>
        </Menu>
      )
      const { rerender } = render(menu(reason))
      const row = screen.getByRole('menuitem', { name: 'Run now', description: reason })
      expect(row.hasAttribute('disabled')).toBe(false)
      expect(row.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(row)
      expect(onSelect).not.toHaveBeenCalled()
      fireEvent.pointerEnter(row, { pointerType: 'mouse' })
      act(() => { vi.advanceTimersByTime(499) })
      expect(screen.queryByRole('tooltip')).toBeNull()
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.getByRole('tooltip').textContent).toBe(reason)
      fireEvent.pointerLeave(row, { pointerType: 'mouse' })
      expect(screen.queryByRole('tooltip')).toBeNull()
      // The arrow walk reaches the row, and keyboard focus shows the reason at once.
      const trigger = screen.getByRole('button', { name: 'trigger' })
      fireEvent.keyDown(document.body, { key: 'Tab' })
      trigger.focus()
      fireEvent.keyDown(trigger, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(row)
      expect(screen.getByRole('tooltip').textContent).toBe(reason)
      // A reason that goes away keeps the focused row mounted and makes it an ordinary row.
      rerender(menu(undefined))
      expect(document.activeElement).toBe(row)
      expect(row.hasAttribute('aria-disabled')).toBe(false)
      expect(row.hasAttribute('aria-describedby')).toBe(false)
      expect(screen.queryByRole('tooltip')).toBeNull()
      fireEvent.click(row)
      expect(onSelect).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('closes an explained unavailable row on Tab and returns focus to the trigger', () => {
    const onClose = vi.fn()
    const onSelect = vi.fn()
    render(<Menu open anchor={<button type="button">trigger</button>} onClose={onClose}>
      <MenuItemButton disabled disabledReason="Wait for the next run interval" onSelect={onSelect}>Run now</MenuItemButton>
    </Menu>)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const row = screen.getByRole('menuitem', { name: 'Run now' })
    expect(document.activeElement).toBe(row)
    fireEvent.keyDown(row, { key: 'Tab' })
    expect(onClose).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })

  it('disabled item does not select; Escape and outside pointerdown close', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <Menu open anchor={<span>trigger</span>} items={items} onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }))
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('inside pointerdown does not close', () => {
    const onClose = vi.fn()
    render(
      <Menu open anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('window blur closes only when focus moved into an iframe', () => {
    const onClose = vi.fn()
    render(
      <Menu open anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
    // An app or tab switch blurs the window without focusing an iframe: stays open.
    fireEvent.blur(window)
    expect(onClose).not.toHaveBeenCalled()
    // A pointerdown inside a cross-origin iframe never reaches this document;
    // the focus move it causes is the one signal left, and it closes.
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

  it('selected item shows the trailing check; align=end, side=top, and className apply', () => {
    const { container } = render(
      <Menu
        open
        align="end"
        side="top"
        className="x"
        anchor={<span>trigger</span>}
        items={items}
        selectedId="a"
        onSelect={() => {}}
        onClose={() => {}}
      />)
    expect((container.firstElementChild as HTMLElement).classList.contains('x')).toBe(true)
    const menu = screen.getByRole('menu')
    expect(menu.className).toMatch(/sideTop|alignEnd/)
    const selected = screen.getByRole('menuitem', { name: 'Alpha' })
    expect(selected.querySelector('svg')).not.toBeNull()
    const other = screen.getByRole('menuitem', { name: 'Beta' })
    expect(other.querySelector('svg')).toBeNull()
    fireEvent.keyDown(document, { key: 'a' })
  })

  it('fill selection holds the row fill instead of a trailing check', () => {
    render(
      <Menu
        open
        selection="fill"
        anchor={<span>trigger</span>}
        items={items}
        selectedId="a"
        onSelect={() => {}}
        onClose={() => {}}
      />)
    const selected = screen.getByRole('menuitem', { name: 'Alpha' })
    expect(selected.querySelector('svg')).toBeNull()
    expect(selected.className).toMatch(/selectedFill/)
    const other = screen.getByRole('menuitem', { name: 'Beta' })
    expect(other.className).not.toMatch(/selectedFill/)
  })

  it('renders a leading icon and a separator between groups', () => {
    render(
      <Menu
        open
        compact
        anchor={<span>trigger</span>}
        items={[
          { id: 'a', label: 'Alpha', icon: <svg data-testid="ic" /> },
          { type: 'separator', id: 's1' },
          { id: 'c', label: 'Create' },
        ]}
        onSelect={() => {}}
        onClose={() => {}}
      />)
    expect(screen.getByTestId('ic')).toBeDefined()
    expect(screen.getByRole('separator')).toBeDefined()
  })

  it('Tab settles the focused row; Shift+Tab closes back to the anchor', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <Menu open autoFocus anchor={<button type="button">trigger</button>} items={items} onSelect={onSelect} onClose={onClose} />)
    // autoFocus parks the keyboard on the first row; Tab settles it like Enter.
    const alpha = screen.getByRole('menuitem', { name: 'Alpha' })
    expect(document.activeElement).toBe(alpha)
    expect(alpha.getAttribute('data-dsh-automatic-focus')).toBe('')
    expect(fireEvent.keyDown(alpha, { key: 'Tab' })).toBe(false)
    expect(alpha.getAttribute('data-dsh-automatic-focus')).toBeNull()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('a')

    // Shift+Tab leaves like Escape: closed, with the trigger taking the keyboard.
    fireEvent.keyDown(alpha, { key: 'Tab', shiftKey: true })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'trigger' }))
  })

  it('Tab from the trigger enters the open list, and elsewhere on the page stays native', () => {
    render(
      <Menu open anchor={<button type="button">trigger</button>} items={items} onSelect={() => {}} onClose={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }))

    // A keyboard outside both the anchor and the list keeps the traversal.
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(true)
    outside.remove()
  })

  it('walks the list with the arrows without autoFocus, wrapping at both ends', () => {
    const onClose = vi.fn()
    const rows = [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
      { id: 'c', label: 'Gamma' },
    ]
    render(
      <Menu open anchor={<button type="button">trigger</button>} items={rows} onSelect={() => {}} onClose={onClose} />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    const alpha = screen.getByRole('menuitem', { name: 'Alpha' })
    const beta = screen.getByRole('menuitem', { name: 'Beta' })
    const gamma = screen.getByRole('menuitem', { name: 'Gamma' })
    trigger.focus()
    // autoFocus is off: the menu opens with the keyboard on the anchor, and the
    // first step enters at the near end.
    expect(document.activeElement).toBe(trigger)
    expect(fireEvent.keyDown(trigger, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    fireEvent.keyDown(beta, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(gamma)
    fireEvent.keyDown(gamma, { key: 'ArrowDown' }) // wraps forwards
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha, { key: 'ArrowUp' }) // wraps backwards
    expect(document.activeElement).toBe(gamma)
    fireEvent.keyDown(gamma, { key: 'Home' })
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha, { key: 'End' })
    expect(document.activeElement).toBe(gamma)
    // Escape closes and hands the keyboard back to the anchor.
    fireEvent.keyDown(gamma, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(trigger)
  })

  it('enters at the last enabled row on ↑ and steps over a disabled one', () => {
    render(
      <Menu open anchor={<button type="button">trigger</button>} items={items} onSelect={() => {}} onClose={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    // Beta is disabled: it is not a step target, so Alpha is the only row.
    expect(fireEvent.keyDown(trigger, { key: 'ArrowUp' })).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }))
  })

  it('renders a non-interactive heading label and a danger row', () => {
    const onSelect = vi.fn()
    render(
      <Menu
        open
        anchor={<span>trigger</span>}
        items={[
          { type: 'label', id: 'h', text: 'Group by' },
          { id: 'del', label: 'Delete', danger: true },
        ]}
        onSelect={onSelect}
        onClose={() => {}}
      />)
    const heading = screen.getByText('Group by')
    expect(heading.getAttribute('role')).toBe('presentation')
    // The heading is not a menu item — only the danger row is interactive.
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    const danger = screen.getByRole('menuitem', { name: 'Delete' })
    expect(danger.className).toMatch(/danger/)
    fireEvent.click(danger)
    expect(onSelect).toHaveBeenCalledWith('del')
  })

  it('closeOnPointerLeave closes a grace after the pointer leaves trigger and list; default never does', () => {
    vi.useFakeTimers()
    try {
      const onClose = vi.fn()
      const { rerender } = render(
        <Menu open closeOnPointerLeave anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      const wrapper = screen.getByText('trigger').parentElement as HTMLElement
      fireEvent.pointerLeave(wrapper)
      // Still open through the grace: the pointer may be crossing the gap.
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS - 1) })
      expect(onClose).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(onClose).toHaveBeenCalledTimes(1)
      rerender(
        <Menu open anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      fireEvent.pointerLeave(wrapper)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS * 10) })
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('coming back inside the grace keeps the list open (trigger and list are one region)', () => {
    vi.useFakeTimers()
    try {
      const onClose = vi.fn()
      render(
        <Menu open closeOnPointerLeave anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      const wrapper = screen.getByText('trigger').parentElement as HTMLElement
      fireEvent.pointerLeave(wrapper)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS - 50) })
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS * 10) })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a close from selection disarms the pending grace close', () => {
    vi.useFakeTimers()
    try {
      const onClose = vi.fn()
      const { rerender } = render(
        <Menu open closeOnPointerLeave anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      const wrapper = screen.getByText('trigger').parentElement as HTMLElement
      fireEvent.pointerLeave(wrapper)
      // The owner closes for its own reason (selection/Escape) mid-grace; the
      // armed timer must not survive to shut a list reopened right after.
      rerender(
        <Menu open={false} closeOnPointerLeave anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS * 10) })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaving a closed list arms nothing', () => {
    vi.useFakeTimers()
    try {
      const onClose = vi.fn()
      render(
        <Menu open={false} closeOnPointerLeave anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      fireEvent.pointerLeave(screen.getByText('trigger').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS * 10) })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a list click does not bubble to the anchor row (portal synthetic-event path)', () => {
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <Menu open anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={() => {}} />
      </div>)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('closes an open submenu when the pointer or focus reaches a component row', () => {
    render(
      <Menu
        open
        anchor={<span>trigger</span>}
        items={[{ id: 'p', label: 'Parent', submenu: [{ id: 's', label: 'Sub' }] }]}
        onSelect={() => {}}
        onClose={() => {}}
      >
        <MenuItemButton onSelect={() => {}}>Row</MenuItemButton>
      </Menu>,
    )
    const parent = screen.getByRole('menuitem', { name: 'Parent' })
    fireEvent.focus(parent)
    expect(screen.getByRole('menuitem', { name: 'Sub' })).toBeDefined()
    // Rows inside the card are not top-level rows: focusing one keeps it open.
    fireEvent.focus(screen.getByRole('menuitem', { name: 'Sub' }))
    expect(screen.getByRole('menuitem', { name: 'Sub' })).toBeDefined()
    fireEvent.focus(screen.getByRole('menuitem', { name: 'Row' }))
    expect(screen.queryByRole('menuitem', { name: 'Sub' })).toBeNull()
    fireEvent.mouseEnter(parent.parentElement as HTMLElement)
    expect(screen.getByRole('menuitem', { name: 'Sub' })).toBeDefined()
    fireEvent.mouseOver(screen.getByRole('menuitem', { name: 'Row' }))
    expect(screen.queryByRole('menuitem', { name: 'Sub' })).toBeNull()
  })

  it('opens a submenu on hover and selects a nested item', () => {
    const onSelect = vi.fn()
    render(
      <Menu
        open
        compact
        anchor={<span>trigger</span>}
        items={[
          { id: 'plain', label: 'Plain' },
          {
            id: 'new',
            label: 'New Workspace',
            submenu: [
              { id: 'ok', label: 'Create ok', icon: <svg data-testid="sub-ic" />, shortcut: { keys: ['⌘', 'N'], aria: 'Meta+N' } },
            ],
          },
        ]}
        onSelect={onSelect}
        onClose={() => {}}
      />)
    const plain = screen.getByRole('menuitem', { name: 'Plain' })
    fireEvent.mouseEnter(plain.parentElement as HTMLElement)
    fireEvent.focus(plain)
    const parent = screen.getByRole('menuitem', { name: 'New Workspace' })
    const wrap = parent.parentElement as HTMLElement
    fireEvent.click(parent)
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.focus(parent)
    fireEvent.mouseEnter(wrap)
    expect(screen.getByTestId('sub-ic')).toBeDefined()
    expect(screen.getByRole('menuitem', { name: 'Create ok' }).getAttribute('aria-keyshortcuts')).toBe('Meta+N')
    expect(screen.getByRole('menuitem', { name: 'Create ok' }).querySelectorAll('kbd')).toHaveLength(2)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create ok' }))
    expect(onSelect).toHaveBeenCalledWith('ok')
    fireEvent.mouseLeave(wrap)
    expect(screen.queryByRole('menuitem', { name: 'Create ok' })).toBeNull()
  })

  it('portal mode prefers getAnchorRect over measuring its own wrapper', () => {
    const rect = { left: 40, right: 72, top: 100, bottom: 128, width: 32, height: 28, x: 40, y: 100, toJSON: () => ({}) } as DOMRect
    render(
      <Menu
        portal
        open
        getAnchorRect={() => rect}
        anchor={null}
        items={items}
        onSelect={() => {}}
        onClose={() => {}}
      />)
    const menu = screen.getByRole('menu')
    // side=bottom, align=start: below the host-supplied rect, left-aligned.
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('132px')
  })

  it('portal mode skips the frame when getAnchorRect returns null (no menu until a rect exists)', () => {
    render(
      <Menu
        portal
        open
        getAnchorRect={() => null}
        anchor={null}
        items={items}
        onSelect={() => {}}
        onClose={() => {}}
      />)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('follows an anchor moving without scroll or resize and stops tracking when closed or unmounted', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    let rect = new DOMRect(40, 100, 32, 28)
    const getAnchorRect = vi.fn(() => rect)
    const props = { portal: true, anchor: null, items, getAnchorRect, onClose: () => {} }
    try {
      const view = render(<Menu {...props} open />)
      rect = new DOMRect(140, 180, 32, 28)
      act(() => { vi.advanceTimersToNextFrame() })
      expect(screen.getByRole('menu').style.left).toBe('140px')
      expect(screen.getByRole('menu').style.top).toBe('212px')

      view.rerender(<Menu {...props} open={false} />)
      getAnchorRect.mockClear()
      act(() => { vi.advanceTimersToNextFrame() })
      expect(getAnchorRect).not.toHaveBeenCalled()

      view.rerender(<Menu {...props} open />)
      view.unmount()
      getAnchorRect.mockClear()
      act(() => { vi.advanceTimersToNextFrame() })
      expect(getAnchorRect).not.toHaveBeenCalled()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('portal mode renders the list under body, positions it fixed, and still closes on outside pointerdown', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const { container } = render(
      <Menu portal open anchor={<span>trigger</span>} items={items} onSelect={onSelect} onClose={onClose} />)
    const menu = screen.getByRole('menu')
    // Outside the anchor wrapper subtree — overflow-clipping ancestors can't crop it.
    expect(container.contains(menu)).toBe(false)
    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.top).not.toBe('')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onSelect).toHaveBeenCalledWith('a')
    fireEvent.pointerDown(menu)
    expect(onClose).not.toHaveBeenCalled()
    // Non-Node targets (e.g. window itself) are ignored, not treated as outside.
    const nonNodeTarget = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(nonNodeTarget, 'target', { value: window })
    document.dispatchEvent(nonNodeTarget)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('portal mode resolves align=end / side=top to clamped left/top coordinates', () => {
    render(
      <Menu portal open align="end" side="top" anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={() => {}} />)
    const menu = screen.getByRole('menu')
    expect(menu.style.left).not.toBe('')
    expect(menu.style.top).not.toBe('')
    expect(menu.style.right).toBe('')
    expect(menu.style.bottom).toBe('')
  })

  it('renders footer rows in a pinned section below the items; they still select', () => {
    const onSelect = vi.fn()
    render(
      <Menu
        open
        anchor={<span>trigger</span>}
        items={items}
        footer={[{ id: 'new', label: 'Create new' }]}
        onSelect={onSelect}
        onClose={() => {}}
      />)
    const footerItem = screen.getByRole('menuitem', { name: 'Create new' })
    expect((footerItem.closest('div[class*="footer"]'))).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Alpha' }).closest('div[class*="footer"]')).toBeNull()
    fireEvent.click(footerItem)
    expect(onSelect).toHaveBeenCalledWith('new')
  })

  it('caps the list height for internal scrolling unless a submenu row is present', () => {
    const { rerender } = render(
      <Menu open anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('menu').className).toMatch(/scrollable/)
    rerender(
      <Menu
        open
        anchor={<span>trigger</span>}
        items={[{ id: 'p', label: 'Parent', submenu: [{ id: 's', label: 'Sub' }] }]}
        onSelect={() => {}}
        onClose={() => {}}
      />)
    expect(screen.getByRole('menu').className).not.toMatch(/scrollable/)
  })
})

describe('Modal', () => {
  it('is absent while closed; Escape and mask click call onClose', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal open={false} onClose={onClose} title="Create new workspace" closeLabel="Close">body</Modal>)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(
      <Modal open onClose={onClose} title="Create new workspace" closeLabel="Configure later" description="Name it." contentClassName="scrolling-content" footer={<button type="button">Create</button>}>
        <input aria-label="name" />
      </Modal>)
    const dialog = screen.getByRole('dialog', { name: 'Create new workspace' })
    expect(dialog).toBeDefined()
    // The full-page layer escapes caller stacking contexts but remains in
    // this document/current WebUI window.
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(screen.getByRole('button', { name: 'Configure later' })).toBeDefined()
    expect(screen.getByText('Name it.')).toBeDefined()
    expect(screen.getByText('Name it.').parentElement?.className).toContain('scrolling-content')
    fireEvent.keyDown(document, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    // Mask is the presentation sibling behind the dialog.
    const mask = document.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.click(mask)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('renders headless content without the default close chrome', () => {
    render(
      <Modal open onClose={() => {}} title="Custom surface" headless backdropBlur={false}>
        <span>Custom body</span>
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'Custom surface' })).toBeDefined()
    expect((screen.getByRole('dialog').previousElementSibling as HTMLElement).style.backdropFilter).toBe('none')
    expect(screen.getByText('Custom body')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('ConnectionIndicator', () => {
  it('renders outage, attempt progress, and recovered states without a native tooltip', () => {
    const reconnect = vi.fn()
    const labels = {
      disconnectedLabel: 'Disconnected, retry',
      connectingLabel: 'Connecting',
      recoveredLabel: 'Connected',
      reconnectActionLabel: 'Disconnected, reconnect now',
      restartActionLabel: 'Connecting, restart now',
      onReconnect: reconnect,
    }
    const { container, rerender } = render(
      <ConnectionIndicator state={undefined} {...labels} />,
    )
    expect(container.firstChild).toBeNull()
    rerender(<ConnectionIndicator state="disconnected" {...labels} />)
    const indicator = screen.getByRole('button', { name: 'Disconnected, reconnect now' })
    expect(indicator.textContent).toContain('Disconnected, retry')
    expect(indicator.hasAttribute('title')).toBe(false)
    expect(indicator.querySelector('svg')).toBeTruthy()
    fireEvent.click(indicator)
    expect(reconnect).toHaveBeenCalledOnce()

    rerender(<ConnectionIndicator state="connecting" {...labels} />)
    const connecting = screen.getByRole('button', { name: 'Connecting, restart now' })
    expect(connecting.textContent).toContain('Connecting...')
    expect(connecting.querySelector('[data-state="ongoing"]')).not.toBeNull()

    rerender(<ConnectionIndicator state="recovered" {...labels} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
  })

  it('fades out for the exit duration before unmounting', () => {
    vi.useFakeTimers()
    try {
      const labels = {
        disconnectedLabel: 'Disconnected, retry',
        connectingLabel: 'Connecting',
        recoveredLabel: 'Connected',
        reconnectActionLabel: 'Disconnected, reconnect now',
        restartActionLabel: 'Connecting, restart now',
        onReconnect: vi.fn(),
      }
      const { container, rerender } = render(
        <ConnectionIndicator state="disconnected" {...labels} />,
      )
      rerender(<ConnectionIndicator state={undefined} {...labels} />)
      expect(screen.getByRole('button', { name: 'Disconnected, reconnect now' })).toBeTruthy()
      act(() => { vi.advanceTimersByTime(150) })
      expect(container.firstChild).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
