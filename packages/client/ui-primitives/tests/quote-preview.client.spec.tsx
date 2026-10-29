// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuotePreview } from '@deepseek-ai/dsh-client-ui-primitives'
import { POINTER_GRACE_MS } from '../src/pointer-grace.ts'

afterEach(cleanup)

describe('QuotePreview', () => {
  it('measures clipping without a ResizeObserver implementation', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    try {
      const view = render(<QuotePreview text="static excerpt" />)
      expect(view.container.querySelector('[data-quote-preview-text]')?.textContent).toBe('static excerpt')
    } finally { vi.unstubAllGlobals() }
  })

  it('renders the 16-pixel quote mark with its inherited fill color', () => {
    const { container } = render(<QuotePreview text="icon text" />)
    const icon = container.querySelector('svg')
    expect(icon?.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(icon?.getAttribute('width')).toBe('16')
    expect(icon?.getAttribute('height')).toBe('16')
    const paths = [...container.querySelectorAll('svg path')]
    expect(paths).toHaveLength(2)
    expect(paths.map(path => path.getAttribute('stroke'))).toEqual([null, null])
    expect(paths.map(path => path.getAttribute('fill'))).toEqual(['currentColor', 'currentColor'])
  })

  it('renders the same inert preview without a removal action', () => {
    render(<QuotePreview text="selected text" />)
    const quote = screen.getByText('selected text').closest<HTMLElement>('[data-quote-preview]')!
    expect(quote.getAttribute('data-quote-preview')).toBe('')
    expect(quote.getAttribute('role')).toBeNull()
    expect(quote.getAttribute('tabindex')).toBeNull()
    expect(quote.getAttribute('title')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    fireEvent.pointerEnter(quote)
    fireEvent.focus(quote)
    expect(document.querySelector('[data-quote-popover]')).toBeNull()
  })

  it('uses the shared hover card only while the excerpt is clipped', async () => {
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(200)
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    try {
      render(<QuotePreview text="a complete clipped excerpt" />)
      const quote = screen.getByText('a complete clipped excerpt').closest<HTMLElement>('[data-quote-preview]')!
      fireEvent.pointerEnter(quote)
      await waitFor(() => { expect(document.querySelector('[data-quote-popover]')?.textContent).toBe('a complete clipped excerpt') })
    } finally {
      scrollWidth.mockRestore()
      clientWidth.mockRestore()
    }
  })

  it('remeasures clipping and disconnects its resize observers', async () => {
    let clipped = true
    const observers: { callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn()
      disconnect = vi.fn()
      constructor(callback: ResizeObserverCallback) { observers.push({ callback, observe: this.observe, disconnect: this.disconnect }) }
    })
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockImplementation(() => clipped ? 200 : 100)
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    try {
      const { unmount } = render(<QuotePreview text="resized excerpt" />)
      const quote = screen.getByText('resized excerpt').closest<HTMLElement>('[data-quote-preview]')!
      fireEvent.pointerEnter(quote)
      await waitFor(() => { expect(document.querySelector('[data-quote-popover]')).not.toBeNull() })
      const source = quote.querySelector('[data-quote-preview-text]')!
      const measure = observers.find(observer => observer.observe.mock.calls.some(([target]) => target === source))!
      clipped = false
      act(() => { measure.callback([], {} as ResizeObserver) })
      expect(document.querySelector('[data-quote-popover]')).toBeNull()
      unmount()
      expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true)
    } finally {
      scrollWidth.mockRestore()
      clientWidth.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('keeps the clipped popover open while the pointer moves onto it', () => {
    vi.useFakeTimers()
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(200)
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    try {
      render(<QuotePreview text="a hoverable clipped excerpt" />)
      const quote = screen.getByText('a hoverable clipped excerpt').closest<HTMLElement>('[data-quote-preview]')!
      fireEvent.pointerEnter(quote)
      act(() => { vi.advanceTimersByTime(0) })
      const popover = document.querySelector<HTMLElement>('[data-quote-popover]')!.parentElement!
      const hoverRegion = quote.parentElement!

      fireEvent.pointerLeave(hoverRegion)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS - 1) })
      fireEvent.pointerEnter(popover)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS * 2) })
      expect(document.querySelector('[data-quote-popover]')).not.toBeNull()

      fireEvent.pointerLeave(popover)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
      expect(document.querySelector('[data-quote-popover]')).toBeNull()
    } finally {
      scrollWidth.mockRestore()
      clientWidth.mockRestore()
      vi.useRealTimers()
    }
  })

  it('contains keyboard and pointer removal events inside the editable preview', () => {
    const onRemove = vi.fn()
    const onPointerDown = vi.fn()
    const onKeyDown = vi.fn()
    render(
      <div onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
        <QuotePreview
          text="selected text"
          removal={{ label: 'Remove quote', onRemove }}
        />
      </div>,
    )
    const button = screen.getByRole('button', { name: 'Remove quote' })
    fireEvent.pointerDown(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.click(button)
    expect(onPointerDown).not.toHaveBeenCalled()
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
