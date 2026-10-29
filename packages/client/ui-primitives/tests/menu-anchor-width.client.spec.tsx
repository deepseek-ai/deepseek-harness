// @vitest-environment jsdom
/** Portal menus reserve their anchor width before measuring end alignment. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Menu } from '../src/Menu.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function measureAnchor() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 40, 280, 22))
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'menu' ? Math.max(120, Number.parseFloat(this.style.minWidth) || 0) : 280
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40)
}

describe('Menu anchor minimum width', () => {
  it('matches the anchor and clears its minimum when the option is removed', () => {
    measureAnchor()
    const props = { open: true, portal: true, align: 'end' as const, anchor: <button>Tools</button>, onClose: vi.fn() }
    const view = render(<Menu {...props} minWidthFromAnchor items={[{ id: 'one', label: 'One' }]} />)
    expect(view.getByRole('menu').style.minWidth).toBe('280px')
    expect(view.getByRole('menu').style.left).toBe('120px')
    view.rerender(<Menu {...props} items={[{ id: 'one', label: 'One' }]} />)
    expect(view.getByRole('menu').style.minWidth).toBe('')
  })

  it('keeps the minimum inside the viewport margins when the anchor is wider', () => {
    measureAnchor()
    vi.stubGlobal('innerWidth', 200)
    const view = render(<Menu open portal minWidthFromAnchor align="end" anchor={<button>Tools</button>}
      items={[{ id: 'one', label: 'One' }]} onClose={vi.fn()} />)
    expect(view.getByRole('menu').style.minWidth).toBe('176px')
    expect(view.getByRole('menu').style.left).toBe('12px')
  })
})
