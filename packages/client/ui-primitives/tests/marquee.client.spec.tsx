// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { MarqueeText, useHoverMarquee } from '../src/Marquee.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function Row({ text }: { readonly text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const marquee = useHoverMarquee(ref)
  return (
    <div role="row" onPointerEnter={marquee.enter} onPointerLeave={marquee.leave}>
      <MarqueeText ref={ref} className="cell" data-cell="">{text}</MarqueeText>
    </div>
  )
}

/** State the clipped text's geometry outright: jsdom lays out nothing. */
function geometry(element: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(element, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(element, 'clientWidth', { value: clientWidth, configurable: true })
}

describe('useHoverMarquee', () => {
  it('crawls clipped text to its far edge at 30px/s while hovered and returns at once on leave', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    render(<Row text="A cell long enough to clip" />)
    const row = screen.getByRole('row')
    const text = screen.getByText('A cell long enough to clip')
    expect(text.className).toContain('cell')
    expect(text.hasAttribute('data-cell')).toBe(true)
    geometry(text, 320, 180)
    fireEvent.pointerEnter(row, { pointerType: 'touch' })
    vi.advanceTimersByTime(1000)
    expect(text.scrollLeft).toBe(0)
    fireEvent.pointerEnter(row)
    vi.advanceTimersByTime(16)
    expect([text.scrollLeft, text.hasAttribute('data-scrolled'), text.hasAttribute('data-clipped')]).toEqual([0, false, true])
    vi.advanceTimersByTime(1600)
    expect(text.scrollLeft).toBeCloseTo(48, 5)
    expect([text.hasAttribute('data-scrolled'), text.hasAttribute('data-clipped')]).toEqual([true, true])
    // A repeated entry while revealing does not restart the crawl.
    fireEvent.pointerEnter(row)
    vi.advanceTimersByTime(10_000)
    expect([text.scrollLeft, text.hasAttribute('data-clipped')]).toEqual([140, false])
    fireEvent.pointerLeave(row)
    expect([text.scrollLeft, text.hasAttribute('data-scrolled'), text.hasAttribute('data-clipped')]).toEqual([0, false, false])
  })

  it('leaves text that fits or overflows by at most 8px at its start', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    render(<Row text="Short" />)
    const row = screen.getByRole('row')
    const text = screen.getByText('Short')
    for (const [scrollWidth, expected] of [[180, 0], [188, 0], [189, 9]] as const) {
      geometry(text, scrollWidth, 180)
      fireEvent.pointerEnter(row)
      vi.advanceTimersByTime(1000)
      expect(text.scrollLeft).toBe(expected)
      fireEvent.pointerLeave(row)
    }
  })

  it('jumps to the far edge under reduced motion and uses scrollTo where the element has it', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    render(<Row text="Reduced motion text" />)
    const row = screen.getByRole('row')
    const text = screen.getByText('Reduced motion text')
    const scrollTo = vi.fn()
    text.scrollTo = scrollTo as typeof text.scrollTo
    geometry(text, 300, 200)
    fireEvent.pointerEnter(row)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 100, behavior: 'instant' })
    expect([text.hasAttribute('data-scrolled'), text.hasAttribute('data-clipped')]).toEqual([true, false])
    fireEvent.pointerLeave(row)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'instant' })
  })

  it('stops its frames when the row unmounts mid-crawl', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const view = render(<Row text="Unmounted mid-crawl" />)
    const text = screen.getByText('Unmounted mid-crawl')
    geometry(text, 400, 200)
    fireEvent.pointerEnter(screen.getByRole('row'))
    vi.advanceTimersByTime(100)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores hover before its text element mounts', () => {
    function Detached() {
      const ref = useRef<HTMLSpanElement>(null)
      const marquee = useHoverMarquee(ref)
      return <div role="row" onPointerEnter={marquee.enter} onPointerLeave={marquee.leave} />
    }
    render(<Detached />)
    fireEvent.pointerEnter(screen.getByRole('row'))
    fireEvent.pointerLeave(screen.getByRole('row'))
    expect(screen.getByRole('row').childElementCount).toBe(0)
  })
})
