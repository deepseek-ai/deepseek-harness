// @vitest-environment jsdom
/** Portal menus delegate minimum width and viewport limits to CSS. */
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Menu } from '../src/Menu.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Menu anchor minimum width', () => {
  it('registers only the external trigger as its anchor', () => {
    function Fixture() {
      const trigger = useRef<HTMLButtonElement>(null)
      return <><button ref={trigger}>Tools</button>
        <Menu open portal anchor={null} anchorRef={trigger}
          items={[{ id: 'one', label: 'One' }]} onClose={vi.fn()} /></>
    }
    const view = render(<Fixture />)
    const trigger = view.getByRole('button', { name: 'Tools' })
    const name = view.getByRole('menu').style.positionAnchor
    expect(name).not.toBe('')
    expect([...document.querySelectorAll<HTMLElement>('[style]')]
      .filter(node => node.style.anchorName === name)).toEqual([trigger])
  })

  it('enables anchor-width matching and clears it when the option is removed', () => {
    const props = { open: true, portal: true, align: 'end' as const, anchor: <button>Tools</button>, onClose: vi.fn() }
    const view = render(<Menu {...props} minWidthFromAnchor items={[{ id: 'one', label: 'One' }]} />)
    const menu = view.getByRole('menu')
    expect(menu.hasAttribute('data-match-anchor-width')).toBe(true)
    expect(menu.style.minWidth).toBe('')
    expect(menu.style.positionAnchor).not.toBe('')
    view.rerender(<Menu {...props} items={[{ id: 'one', label: 'One' }]} />)
    expect(view.getByRole('menu').hasAttribute('data-match-anchor-width')).toBe(false)
  })

  it('keeps matching declarative when the visual viewport is narrower than its anchor', () => {
    const readRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), {
      width: 200, height: 400, offsetLeft: 40, offsetTop: 60,
    }))
    const view = render(<Menu open portal minWidthFromAnchor align="end" anchor={<button style={{ width: 280 }}>Tools</button>}
      items={[{ id: 'one', label: 'One' }]} onClose={vi.fn()} />)
    const menu = view.getByRole('menu')
    expect(menu.hasAttribute('data-match-anchor-width')).toBe(true)
    expect(menu.style.minWidth).toBe('')
    expect(menu.style.left).toBe('')
    expect(readRect).not.toHaveBeenCalled()
  })
})
