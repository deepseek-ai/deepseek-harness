// @vitest-environment jsdom
/** Portal menus keep the desktop frame's top clearance without leaving a gap below an anchor inside it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Menu } from '../src/Menu.tsx'

const root = document.documentElement
let prior = ''

beforeEach(() => {
  prior = root.style.getPropertyValue('--dsh-frame-top-clearance')
  root.style.setProperty('--dsh-frame-top-clearance', '48px')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (prior === '') root.style.removeProperty('--dsh-frame-top-clearance')
  else root.style.setProperty('--dsh-frame-top-clearance', prior)
})

/**
 * Open an 80px-tall portal menu from an anchor with the stated rect.
 * @param anchor - the anchor rect in viewport coordinates.
 * @param side - which anchor edge the menu opens from.
 * @returns the render result.
 */
function openMenu(anchor: DOMRect, side: 'top' | 'bottom') {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(anchor)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(120)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80)
  return render(<Menu open portal side={side} anchor={<button>Open</button>} items={[{ id: 'one', label: 'One' }]} onClose={vi.fn()} />)
}

describe('Menu top clearance', () => {
  it('opens directly below an anchor that sits inside the top strip', () => {
    const view = openMenu(new DOMRect(300, 14, 18, 22), 'bottom')
    expect(view.getByRole('menu').style.top).toBe('40px')
  })

  it('keeps a menu that does not fit above its anchor below the top strip', () => {
    const view = openMenu(new DOMRect(300, 100, 18, 22), 'top')
    expect(view.getByRole('menu').style.top).toBe('68px')
  })

  it('places a menu that does not fit above an anchor inside the top strip directly below it', () => {
    const view = openMenu(new DOMRect(300, 14, 18, 22), 'top')
    expect(view.getByRole('menu').style.top).toBe('40px')
  })

  it('keeps the top strip clear when the anchor has scrolled above the viewport', () => {
    const view = openMenu(new DOMRect(300, -30, 18, 22), 'bottom')
    expect(view.getByRole('menu').style.top).toBe('68px')
  })
})
