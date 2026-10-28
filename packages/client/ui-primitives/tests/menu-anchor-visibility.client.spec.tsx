// @vitest-environment jsdom
/** A portalled menu follows its anchor's interactive lifetime. */
import { useState } from 'react'
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

it.each(['inert', 'hidden'])('closes when the retained anchor becomes %s', (attribute) => {
  function Fixture() {
    const [open, setOpen] = useState(true)
    return <div data-testid="owner"><Menu open={open} onClose={() => { setOpen(false) }} portal
      anchor={<button>Open</button>} items={[{ id: 'copy', label: 'Copy' }]} /></div>
  }
  const view = render(<Fixture />)
  expect(screen.getByRole('menu')).toBeTruthy()
  view.getByTestId('owner').setAttribute(attribute, '')
  act(() => { for (const callback of [...frames.values()]) callback(0) })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(view.getByTestId('owner').isConnected).toBe(true)
})
