// @vitest-environment jsdom
/** A portalled menu follows its anchor's interactive lifetime. */
import { useRef, useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Menu } from '../src/Menu.tsx'

let frames: Map<number, FrameRequestCallback>
beforeEach(() => {
  frames = new Map()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each(['inert', 'hidden'].flatMap(attribute => [false, true].map(contextual => ({ attribute, contextual }))))(
  'closes when the retained anchor becomes $attribute with contextual=$contextual', ({ attribute, contextual }) => {
    function Fixture() {
      const [open, setOpen] = useState(true)
      const trigger = useRef<HTMLButtonElement>(null)
      const menu = <Menu open={open} onClose={() => { setOpen(false) }} portal contextual={contextual}
        returnFocus={contextual ? () => trigger.current : undefined}
        anchor={contextual ? null : <button>Open</button>} items={[{ id: 'copy', label: 'Copy' }]} />
      return <><div data-testid="owner">{contextual ? <button ref={trigger}>Open</button> : menu}</div>
        {contextual && menu}</>
    }
    const view = render(<Fixture />)
    expect(screen.getByRole('menu')).toBeTruthy()
    view.getByTestId('owner').setAttribute(attribute, '')
    act(() => { for (const callback of [...frames.values()]) callback(0) })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(view.getByTestId('owner').isConnected).toBe(true)
  })

it('does not restart a contextual dismissal while its original control remains inert', () => {
  const close = vi.fn()
  function Fixture() {
    const [exiting, setExiting] = useState<'dismiss'>()
    const trigger = useRef<HTMLButtonElement>(null)
    return <><div data-testid="owner"><button ref={trigger}>Open</button></div>
      <Menu open portal contextual anchor={null} returnFocus={() => trigger.current} exiting={exiting}
        onClose={() => { close(); setExiting('dismiss') }} items={[{ id: 'copy', label: 'Copy' }]} /></>
  }
  const view = render(<Fixture />)
  view.getByTestId('owner').setAttribute('inert', '')
  act(() => { for (const callback of [...frames.values()]) callback(0) })
  act(() => { for (const callback of [...frames.values()]) callback(0) })
  expect(close).toHaveBeenCalledTimes(1)
})

it.each([undefined, 'existing-panel'])('restores the trigger aria-controls value %s after closing', (previous) => {
  function Fixture({ open }: { open: boolean }) {
    const trigger = useRef<HTMLButtonElement>(null)
    return <><button ref={trigger} aria-controls={previous}>Open</button>
      <Menu open={open} portal contextual anchor={null} returnFocus={() => trigger.current}
        onClose={vi.fn()} items={[{ id: 'copy', label: 'Copy' }]} /></>
  }
  const view = render(<Fixture open />)
  const trigger = screen.getByRole('button', { name: 'Open' })
  const menu = screen.getByRole('menu')
  expect(trigger.getAttribute('aria-controls')?.split(' ')).toContain(menu.id)
  view.rerender(<Fixture open={false} />)
  expect(trigger.getAttribute('aria-controls')).toBe(previous ?? null)
})
