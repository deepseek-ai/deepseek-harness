// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverCard } from '../src/HoverCard.tsx'
import { HoverCardGroup } from '../src/HoverCardGroup.tsx'
import { Tooltip } from '../src/Tooltip.tsx'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

// jsdom lacks PointerEvent; MouseEvent preserves relatedTarget for physical and React ancestry checks.
function move(from: Element, to: Element): void {
  fireEvent(from, new MouseEvent('pointerout', { bubbles: true, relatedTarget: to }))
  fireEvent(to, new MouseEvent('pointerover', { bubbles: true, relatedTarget: from }))
  fireEvent(from, new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }))
  fireEvent(to, new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }))
}
function tick(ms: number): void { act(() => { vi.advanceTimersByTime(ms) }) }
function Card({ name, grouped = true, disabled = false }: { name: string; grouped?: boolean; disabled?: boolean }) {
  return <HoverCard grouped={grouped} disabled={disabled} openDelayMs={800}
    anchor={<span>{name}<Tooltip label={`Archive ${name}`} delayMs={500}><button type="button">action {name}</button></Tooltip></span>}
    content={<span>details {name}</span>} copyText={name} copyLabel="Copy" copiedLabel="Copied" />
}

describe('HoverCardGroup', () => {
  it('keeps an inline bridge in its hover region and replaces the active card without overlap', () => {
    const view = render(<HoverCardGroup as="span">
      <HoverCard inline grouped openDelayMs={0} anchor={<span>A</span>} content={<span>details A</span>} />
      <HoverCard inline grouped openDelayMs={0} anchor={<span>B</span>} content={<span>details B</span>} />
    </HoverCardGroup>)
    expect(view.container.firstElementChild?.tagName).toBe('SPAN')
    const a = screen.getByText('A')
    const b = screen.getByText('B')
    move(document.body, a)
    tick(0)
    const card = screen.getByText('details A').parentElement!
    const bridge = card.previousElementSibling!
    move(a, bridge)
    tick(300)
    expect(screen.getByText('details A')).toBeTruthy()
    move(bridge, b)
    expect(screen.queryByText('details A')).toBeNull()
    expect(screen.getByText('details B')).toBeTruthy()
    move(b, document.body)
    tick(300)
    expect(screen.queryByText('details B')).toBeNull()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not warm the next pointer visit when keyboard focus displays an inline card outside a pointer visit', () => {
    const view = render(<>
      <button type="button">outside</button>
      <HoverCardGroup>
        <HoverCard inline grouped openDelayMs={800} anchor={<button type="button">A</button>}
          content={<span>details A</span>} />
        <Card name="B" />
      </HoverCardGroup>
    </>)
    const outside = screen.getByRole('button', { name: 'outside' })
    const a = screen.getByRole('button', { name: 'A' })
    act(() => { outside.focus() })
    fireEvent.keyDown(outside, { key: 'Tab' })
    // jsdom does not move focus for Tab, so apply its native focus transition without a pointer event.
    act(() => { a.focus() })
    expect(document.activeElement).toBe(a)
    expect(screen.getByText('details A')).toBeTruthy()
    move(document.body, screen.getByText('B'))
    expect(screen.queryByText('details B')).toBeNull()
    tick(799)
    expect(screen.queryByText('details B')).toBeNull()
    tick(1)
    expect(screen.getByText('details B')).toBeTruthy()
    expect(screen.queryByText('details A')).toBeNull()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for the first actual display, then switches instantly within one physical list', () => {
    render(<HoverCardGroup><Card name="A" /><span>gap</span><Card name="B" /></HoverCardGroup>)
    const a = screen.getByText('A')
    const b = screen.getByText('B')
    const gap = screen.getByText('gap')
    move(document.body, a)
    tick(799)
    expect(screen.queryByText('details A')).toBeNull()
    tick(1)
    expect(screen.getByText('details A')).toBeTruthy()
    move(a, b)
    expect(screen.queryByText('details A')).toBeNull()
    expect(screen.getByText('details B')).toBeTruthy()
    // Repositioning the old anchor must not let it claim ownership again.
    fireEvent(window, new Event('resize'))
    tick(300)
    expect(screen.queryByText('details A')).toBeNull()
    expect(screen.getByText('details B')).toBeTruthy()
    move(b, gap)
    tick(300)
    move(gap, a)
    expect(screen.getByText('details A')).toBeTruthy()
    move(a, document.body)
    tick(300)
    move(document.body, b)
    expect(screen.queryByText('details B')).toBeNull()
    tick(799)
    expect(screen.queryByText('details B')).toBeNull()
    tick(1)
    expect(screen.getByText('details B')).toBeTruthy()
  })

  it.each(['pointer exit', 'disabled'] as const)('replaces a preview fading after %s before displaying the next card', (reason) => {
    const markup = (disabled = false) => <HoverCardGroup>
      <HoverCard grouped variant="preview" openDelayMs={800} disabled={disabled}
        anchor={<span>A</span>} content={<span>details A</span>} />
      <span>gap</span>
      <Card name="B" />
    </HoverCardGroup>
    const view = render(markup())
    const a = screen.getByText('A')
    const gap = screen.getByText('gap')
    move(document.body, a)
    tick(800)
    expect(screen.getByText('details A')).toBeTruthy()
    move(a, gap)
    // Pointer grace expires after 200ms; disabling closes immediately. Both retain the 100ms fade.
    if (reason === 'disabled') view.rerender(markup(true))
    else tick(200)
    expect(screen.getByText('details A')).toBeTruthy()
    move(gap, screen.getByText('B'))
    expect(screen.getByText('details B')).toBeTruthy()
    expect(screen.queryByText('details A')).toBeNull()
    tick(100)
    expect(screen.getByText('details B')).toBeTruthy()
  })

  it('keeps cancelled openings cold and shares displayed cards independently of action tooltips', () => {
    render(<HoverCardGroup><Card name="A" /><Card name="B" /></HoverCardGroup>)
    const a = screen.getByText('A')
    const b = screen.getByText('B')
    move(document.body, a)
    tick(400)
    move(a, b)
    tick(799)
    expect(screen.queryByText('details A')).toBeNull()
    expect(screen.queryByText('details B')).toBeNull()
    tick(1)
    const card = screen.getByText('details B')
    const action = screen.getByRole('button', { name: 'action B' })
    move(b, action)
    tick(500)
    expect(screen.getByRole('tooltip').textContent).toBe('Archive B')
    expect(screen.getByText('details B')).toBe(card)
    move(action, a)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.getByText('details A')).toBeTruthy()
    expect(screen.queryByText('details B')).toBeNull()
  })

  it('shares warmth through readable, copyable portals until the pointer leaves both surfaces', async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      render(<HoverCardGroup><Card name="A" /><Card name="B" /></HoverCardGroup>)
      const a = screen.getByText('A')
      const b = screen.getByText('B')
      move(document.body, a)
      tick(800)
      const portal = screen.getByRole('button', { name: 'Copy: A' })
      move(a, portal)
      tick(500)
      expect(portal.isConnected).toBe(true)
      await act(async () => { fireEvent.click(portal); await Promise.resolve() })
      expect(writeText).toHaveBeenCalledWith('A')
      expect(screen.getByRole('status').textContent).toBe('Copied')
      move(portal, b)
      expect(screen.getByText('details B')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Copy: A' })).toBeNull()
      const secondPortal = screen.getByRole('button', { name: 'Copy: B' })
      move(b, secondPortal)
      move(secondPortal, document.body)
      tick(300)
      expect(screen.queryByText('details B')).toBeNull()
      move(document.body, a)
      tick(799)
      expect(screen.queryByText('details A')).toBeNull()
      tick(1)
      expect(screen.getByText('details A')).toBeTruthy()
    } finally {
      if (previous === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', previous)
    }
  })

  it('bridges the list-to-card gaps with the active card existing pointer grace', () => {
    render(<HoverCardGroup><Card name="A" /><Card name="B" /></HoverCardGroup>)
    const a = screen.getByText('A')
    const b = screen.getByText('B')
    move(document.body, a)
    tick(800)
    const portal = screen.getByRole('button', { name: 'Copy: A' })
    move(a, document.body)
    tick(100)
    move(document.body, portal)
    tick(500)
    expect(portal.isConnected).toBe(true)
    move(portal, document.body)
    tick(100)
    move(document.body, b)
    expect(screen.getByText('details B')).toBeTruthy()
    expect(screen.queryByText('details A')).toBeNull()
    move(b, document.body)
    tick(300)
    move(document.body, a)
    tick(799)
    expect(screen.queryByText('details A')).toBeNull()
    tick(1)
    expect(screen.getByText('details A')).toBeTruthy()
  })

  it('warms a keyboard-open card only when the pointer visits that card', () => {
    render(<HoverCardGroup>
      <HoverCard inline grouped openDelayMs={800} anchor={<button type="button">A</button>}
        content={<span>details A</span>} />
      <Card name="B" />
    </HoverCardGroup>)
    fireEvent.keyDown(document, { key: 'Tab' })
    act(() => { screen.getByRole('button', { name: 'A' }).focus() })
    const portal = screen.getByText('details A')
    move(document.body, portal)
    move(portal, screen.getByText('B'))
    expect(screen.getByText('details B')).toBeTruthy()
    expect(screen.queryByText('details A')).toBeNull()
  })

  it('rejects stale clipboard feedback after a group handoff and return', async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    let finishWrite: (() => void) | undefined
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve }))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      render(<HoverCardGroup><Card name="A" /><Card name="B" /></HoverCardGroup>)
      const a = screen.getByText('A')
      const b = screen.getByText('B')
      move(document.body, a)
      tick(800)
      fireEvent.keyDown(screen.getByRole('button', { name: 'Copy: A' }), { key: 'Enter' })
      expect(writeText).toHaveBeenCalledWith('A')
      move(a, b)
      expect(screen.getByText('details B')).toBeTruthy()
      move(b, a)
      expect(screen.getByText('details A')).toBeTruthy()
      await act(async () => { finishWrite?.(); await Promise.resolve() })
      expect(screen.queryByText('Copied')).toBeNull()
      expect(screen.getByText('details A')).toBeTruthy()
    } finally {
      finishWrite?.()
      if (previous === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', previous)
    }
  })

  it('keeps separate groups cold and does not enroll ungrouped cards', () => {
    render(<><HoverCardGroup><Card name="A" /><Card name="Project" grouped={false} /></HoverCardGroup>
      <HoverCardGroup><Card name="B" /></HoverCardGroup></>)
    const a = screen.getByText('A')
    const project = screen.getByText('Project')
    const b = screen.getByText('B')
    move(document.body, a)
    tick(800)
    move(a, project)
    expect(screen.queryByText('details Project')).toBeNull()
    tick(800)
    expect(screen.getByText('details Project')).toBeTruthy()
    move(project, b)
    expect(screen.queryByText('details B')).toBeNull()
    tick(800)
    expect(screen.getByText('details B')).toBeTruthy()
  })

  it('does not warm a group through a portal belonging to an ungrouped card', () => {
    render(<HoverCardGroup><Card name="Project" grouped={false} /><Card name="B" /></HoverCardGroup>)
    const project = screen.getByText('Project')
    const b = screen.getByText('B')
    move(document.body, project)
    tick(800)
    const portal = screen.getByRole('button', { name: 'Copy: Project' })
    move(project, portal)
    tick(500)
    expect(portal.isConnected).toBe(true)
    move(portal, b)
    expect(screen.queryByText('details B')).toBeNull()
    tick(799)
    expect(screen.queryByText('details B')).toBeNull()
    tick(1)
    expect(screen.getByText('details B')).toBeTruthy()
  })

  it('cools when the active portal is removed from under the pointer', () => {
    const markup = (showA: boolean) => <HoverCardGroup>
      {showA && <Card name="A" />}<Card name="B" />
    </HoverCardGroup>
    const view = render(markup(true))
    const a = screen.getByText('A')
    move(document.body, a)
    tick(800)
    const portal = screen.getByRole('button', { name: 'Copy: A' })
    move(a, portal)
    view.rerender(markup(false))
    move(portal, screen.getByText('B'))
    expect(screen.queryByText('details B')).toBeNull()
    tick(800)
    expect(screen.getByText('details B')).toBeTruthy()
  })

  it('cools when keyboard focus replaces the portal under the pointer', () => {
    render(<HoverCardGroup>
      <HoverCard inline grouped anchor={<button type="button">A</button>} content={<span>details A</span>} />
      <HoverCard inline grouped anchor={<button type="button">B</button>} content={<span>details B</span>} />
      <Card name="C" />
    </HoverCardGroup>)
    const a = screen.getByRole('button', { name: 'A' })
    move(document.body, a)
    tick(500)
    const portal = screen.getByText('details A')
    move(a, portal)
    fireEvent.keyDown(document, { key: 'Tab' })
    act(() => { screen.getByRole('button', { name: 'B' }).focus() })
    expect(screen.getByText('details B')).toBeTruthy()
    move(portal, screen.getByText('C'))
    expect(screen.queryByText('details C')).toBeNull()
    tick(800)
    expect(screen.getByText('details C')).toBeTruthy()
  })

  it('releases an unmounted active card without cooling its still-mounted list', () => {
    const markup = (showA: boolean, groupKey = 'first') => <HoverCardGroup key={groupKey}>
      {showA && <Card name="A" />}<Card name="B" />
    </HoverCardGroup>
    const view = render(markup(true))
    const a = screen.getByText('A')
    move(document.body, a)
    tick(800)
    view.rerender(markup(false))
    move(a, screen.getByText('B'))
    expect(screen.getByText('details B')).toBeTruthy()
    view.rerender(markup(false, 'new'))
    move(document.body, screen.getByText('B'))
    expect(screen.queryByText('details B')).toBeNull()
    tick(800)
    expect(screen.getByText('details B')).toBeTruthy()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
