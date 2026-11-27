// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuotePreview } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { POINTER_GRACE_MS } from '../src/client/pointer-grace.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('QuotePreview', () => {
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

  it('renders the same non-interactive preview without a removal action', () => {
    render(<QuotePreview text="selected text" />)
    const quote = screen.getByText('selected text').closest<HTMLElement>('[data-quote-preview]')!
    expect(quote.getAttribute('data-quote-preview')).toBe('')
    expect(quote.getAttribute('role')).toBeNull()
    expect(quote.getAttribute('tabindex')).toBeNull()
    expect(quote.getAttribute('title')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens the full-text hover card on every hover without reading layout', async () => {
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
    render(<QuotePreview text="a complete excerpt" />)
    fireEvent.pointerEnter(screen.getByText('a complete excerpt').closest<HTMLElement>('[data-quote-preview]')!)
    await waitFor(() => { expect(document.querySelector('[data-quote-popover]')?.textContent).toBe('a complete excerpt') })
    expect(scrollWidth).not.toHaveBeenCalled()
    expect(clientWidth).not.toHaveBeenCalled()
  })

  it('keeps the popover open while the pointer moves onto it', () => {
    vi.useFakeTimers()
    try {
      render(<QuotePreview text="a hoverable excerpt" />)
      const quote = screen.getByText('a hoverable excerpt').closest<HTMLElement>('[data-quote-preview]')!
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
      vi.useRealTimers()
    }
  })

  it('shows an owner summary inline and in its popover', async () => {
    const text = '## User Comment 1\nFile: src/index.ts\nComment:\nrename this'
    const view = render(<QuotePreview text={text} summary={{ label: 'index.ts L78', title: 'src/index.ts', detail: 'L78', body: 'rename this' }} />)
    const quote = view.container.querySelector<HTMLElement>('[data-quote-preview]')!
    const inline = quote.querySelector('[data-quote-preview-text]')!
    expect([...inline.children].map(part => [part.textContent, part.getAttribute('aria-hidden')]))
      .toEqual([['index.ts L78', 'true'], ['src/index.ts L78', null], ['rename this', null]])
    expect(view.queryByText(text)).toBeNull()
    fireEvent.pointerEnter(quote)
    await waitFor(() => {
      expect([...document.querySelector('[data-quote-popover]')!.children].map(line => line.textContent))
        .toEqual(['src/index.ts', 'L78', 'rename this'])
    })
    view.unmount()

    render(<QuotePreview text={text} summary={{ label: 'index.ts', title: 'src/index.ts', body: 'rename this' }} />)
    expect(document.querySelector('[data-quote-preview-text]')?.children[1]?.textContent).toBe('src/index.ts')
    fireEvent.pointerEnter(document.querySelector<HTMLElement>('[data-quote-preview]')!)
    await waitFor(() => {
      expect([...document.querySelector('[data-quote-popover]')!.children].map(line => line.textContent)).toEqual(['src/index.ts', 'rename this'])
    })
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
