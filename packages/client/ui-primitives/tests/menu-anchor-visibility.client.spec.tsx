// @vitest-environment jsdom
/** A portalled menu follows its anchor's interactive lifetime. */
import { useRef, useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Menu } from '../src/Menu.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(['inert', 'hidden'].flatMap(attribute => [false, true].map(contextual => ({ attribute, contextual }))))(
  'closes when the retained anchor becomes $attribute with contextual=$contextual', async ({ attribute, contextual }) => {
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
    await act(async () => { view.getByTestId('owner').setAttribute(attribute, ''); await Promise.resolve() })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(view.getByTestId('owner').isConnected).toBe(true)
  })

it('closes when an external anchor leaves the document', async () => {
  const anchor = document.createElement('button')
  const anchorRef = { current: anchor }
  document.body.append(anchor)
  function Fixture() {
    const [open, setOpen] = useState(true)
    return <Menu open={open} portal anchor={null} anchorRef={anchorRef}
      onClose={() => { setOpen(false) }} items={[{ id: 'copy', label: 'Copy' }]} />
  }
  render(<Fixture />)
  expect(screen.getByRole('menu')).toBeTruthy()
  await act(async () => { anchor.remove(); await Promise.resolve() })
  expect(screen.queryByRole('menu')).toBeNull()
})

it.each(['hidden', 'inert'])('tracks %s on an external anchor that mounts after opening', async (attribute) => {
  function Fixture({ ready }: { ready: boolean }) {
    const [open, setOpen] = useState(true)
    const anchor = useRef<HTMLButtonElement>(null)
    return <>{ready && <button ref={anchor}>Late anchor</button>}
      <Menu open={open} portal anchor={null} anchorRef={anchor}
        onClose={() => { setOpen(false) }} items={[{ id: 'copy', label: 'Copy' }]} /></>
  }
  const view = render(<Fixture ready={false} />)
  expect(screen.queryByRole('menu')).toBeNull()
  view.rerender(<Fixture ready />)
  expect(screen.getByRole('menu')).toBeTruthy()
  await act(async () => { screen.getByRole('button').setAttribute(attribute, ''); await Promise.resolve() })
  expect(screen.queryByRole('menu')).toBeNull()
})

it('retargets visibility when an open menu receives a replacement element through the same ref', async () => {
  function Fixture({ generation }: { generation: number }) {
    const [open, setOpen] = useState(true)
    const anchor = useRef<HTMLButtonElement>(null)
    return <><button key={generation} ref={anchor}>Anchor {generation}</button>
      <Menu open={open} portal anchor={null} anchorRef={anchor}
        onClose={() => { setOpen(false) }} items={[{ id: 'copy', label: 'Copy' }]} /></>
  }
  const view = render(<Fixture generation={0} />)
  const original = screen.getByRole('button')
  await act(async () => { view.rerender(<Fixture generation={1} />); await Promise.resolve() })
  expect(original.isConnected).toBe(false)
  expect(screen.getByRole('menu')).toBeTruthy()
  await act(async () => { screen.getByRole('button').setAttribute('hidden', ''); await Promise.resolve() })
  expect(screen.queryByRole('menu')).toBeNull()
})

it('does not restart a contextual dismissal while its original control remains inert', async () => {
  const close = vi.fn()
  function Fixture() {
    const [exiting, setExiting] = useState<'dismiss'>()
    const trigger = useRef<HTMLButtonElement>(null)
    return <><div data-testid="owner"><button ref={trigger}>Open</button></div>
      <Menu open portal contextual anchor={null} returnFocus={() => trigger.current} exiting={exiting}
        onClose={() => { close(); setExiting('dismiss') }} items={[{ id: 'copy', label: 'Copy' }]} /></>
  }
  const view = render(<Fixture />)
  const menu = screen.getByRole('menu')
  const anchorName = menu.style.positionAnchor
  await act(async () => { view.getByTestId('owner').setAttribute('inert', ''); await Promise.resolve() })
  await act(async () => { view.getByTestId('owner').setAttribute('hidden', ''); await Promise.resolve() })
  expect(close).toHaveBeenCalledTimes(1)
  expect(menu.style.visibility).not.toBe('hidden')
  expect(menu.style.positionAnchor).toBe(anchorName)
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
