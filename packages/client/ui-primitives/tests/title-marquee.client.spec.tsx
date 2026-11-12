// @vitest-environment jsdom
/**
 * The title marquee: while its row is hovered, a clipped title crawls to its far edge at a constant speed, or jumps
 * there under reduced motion; touch and overflow too small to read stay put; leaving returns it to its start in one
 * step.
 */
import { useRef, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { titleMarqueeClass, useTitleMarquee } from '../src/title-marquee.ts'
import css from '../src/TitleMarquee.module.css'

const TITLE = 'A title long enough to be clipped'

/** A one-line row whose title marquees while it is hovered. */
function Row(): ReactNode {
  const title = useRef<HTMLSpanElement>(null)
  const marquee = useTitleMarquee(title)
  return (
    <button type="button" onPointerEnter={marquee.enter} onPointerLeave={marquee.leave}>
      <span ref={title} className={titleMarqueeClass}>{TITLE}</span>
    </button>
  )
}

/** Render the row with its title clipped to `clientWidth` of `scrollWidth` pixels. */
function renderRow(scrollWidth: number, clientWidth: number) {
  const view = render(<Row />)
  const row = screen.getByRole('button')
  const title = screen.getByText(TITLE)
  // jsdom lays out nothing: the title's clipped geometry is stated outright.
  Object.defineProperty(title, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(title, 'clientWidth', { value: clientWidth, configurable: true })
  return { view, row, title }
}

/** The fade-mask hooks the title publishes. */
function fades(title: HTMLElement): { readonly scrolled: boolean; readonly clipped: boolean } {
  return { scrolled: title.hasAttribute('data-scrolled'), clipped: title.hasAttribute('data-clipped') }
}

let reducedMotion = false

beforeEach(() => {
  reducedMotion = false
  vi.useFakeTimers()
  // jsdom implements no matchMedia; the stub answers the reduced-motion probe.
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: reducedMotion && query === '(prefers-reduced-motion: reduce)' })))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useTitleMarquee', () => {
  it('crawls a clipped title to its far edge at a constant speed while its row is hovered, and rests there', () => {
    const { row, title } = renderRow(320, 180)
    expect(titleMarqueeClass).toBe(css.marquee)
    fireEvent.pointerEnter(row)
    // The first frame only records the clock; travel begins on the second.
    vi.advanceTimersByTime(16)
    expect(title.scrollLeft).toBe(0)
    expect(fades(title)).toEqual({ scrolled: false, clipped: true })
    // 30px a second: 1600ms of frames crawl 48px, off the start and short of the far edge.
    vi.advanceTimersByTime(1600)
    expect(title.scrollLeft).toBeCloseTo(48, 5)
    expect(fades(title)).toEqual({ scrolled: true, clipped: true })
    vi.advanceTimersByTime(10_000)
    expect(title.scrollLeft).toBe(140)
    expect(fades(title)).toEqual({ scrolled: true, clipped: false })
  })

  it('keeps crawling when the pointer enters the row again mid-crawl', () => {
    const { row, title } = renderRow(320, 180)
    fireEvent.pointerEnter(row)
    vi.advanceTimersByTime(1616)
    fireEvent.pointerEnter(row)
    vi.advanceTimersByTime(1600)
    expect(title.scrollLeft).toBeCloseTo(96, 5)
  })

  it('leaves a title that fits or overflows by at most 8px at its start, and crawls one a pixel wider', () => {
    const fits = renderRow(180, 180)
    fireEvent.pointerEnter(fits.row)
    vi.advanceTimersByTime(1000)
    expect(fits.title.scrollLeft).toBe(0)
    expect(fades(fits.title)).toEqual({ scrolled: false, clipped: false })
    cleanup()

    const jitter = renderRow(188, 180)
    fireEvent.pointerEnter(jitter.row)
    vi.advanceTimersByTime(1000)
    expect(jitter.title.scrollLeft).toBe(0)
    cleanup()

    const reveal = renderRow(189, 180)
    fireEvent.pointerEnter(reveal.row)
    vi.advanceTimersByTime(1000)
    expect(reveal.title.scrollLeft).toBe(9)
  })

  it('ignores a touch, which hovers nothing', () => {
    const { row, title } = renderRow(320, 180)
    // jsdom lacks PointerEvent; a plain event keeps the pointer type React reads.
    const touch = new Event('pointerover', { bubbles: true })
    Object.defineProperty(touch, 'pointerType', { value: 'touch' })
    fireEvent(row, touch)
    vi.advanceTimersByTime(1000)
    expect(title.scrollLeft).toBe(0)
    expect(fades(title)).toEqual({ scrolled: false, clipped: false })
  })

  it('jumps a clipped title to its far edge under reduced motion', () => {
    reducedMotion = true
    const { row, title } = renderRow(320, 180)
    fireEvent.pointerEnter(row)
    expect(title.scrollLeft).toBe(140)
    expect(fades(title)).toEqual({ scrolled: true, clipped: false })
    fireEvent.pointerLeave(row)
    expect(title.scrollLeft).toBe(0)
    expect(fades(title)).toEqual({ scrolled: false, clipped: false })
  })

  it('returns the title to its start in one instant step on leave and cancels the crawl', () => {
    const { row, title } = renderRow(320, 180)
    const scrollTo = vi.fn<(options: ScrollToOptions) => void>()
    Object.defineProperty(title, 'scrollTo', { value: scrollTo, configurable: true })
    fireEvent.pointerEnter(row)
    vi.advanceTimersByTime(1616)
    expect(scrollTo.mock.lastCall?.[0].left).toBeCloseTo(48, 5)
    expect(scrollTo.mock.lastCall?.[0].behavior).toBe('instant')
    fireEvent.pointerLeave(row)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'instant' })
    expect(fades(title)).toEqual({ scrolled: false, clipped: false })
    const calls = scrollTo.mock.calls.length
    vi.advanceTimersByTime(1000)
    expect(scrollTo).toHaveBeenCalledTimes(calls)

    // Once left, the next hover crawls from the start again.
    fireEvent.pointerEnter(row)
    vi.advanceTimersByTime(16)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'instant' })
    expect(fades(title)).toEqual({ scrolled: false, clipped: true })
  })

  it('stops the crawl when the row unmounts', () => {
    const { view, row, title } = renderRow(320, 180)
    fireEvent.pointerEnter(row)
    vi.advanceTimersByTime(1616)
    const reached = title.scrollLeft
    view.unmount()
    vi.advanceTimersByTime(1000)
    expect(title.scrollLeft).toBe(reached)
  })
})
