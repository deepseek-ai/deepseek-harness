// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { MarqueeText, useHoverMarquee } from '../src/Marquee.tsx'

afterEach(cleanup)

function Row({ text, hold }: { readonly text: string; readonly hold?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const marquee = useHoverMarquee(ref, { hold })
  return (
    <div role="row" {...marquee}>
      <MarqueeText ref={ref} className="cell" data-cell="">{text}</MarqueeText>
    </div>
  )
}

/** The clipping element and the span inside it that travels. */
function parts(): { text: HTMLElement; travel: HTMLElement } {
  const text = document.querySelector('[data-cell]') as HTMLElement
  return { text, travel: text.firstElementChild as HTMLElement }
}

/** State the clipped text's geometry outright: jsdom lays out nothing. */
function geometry(element: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(element, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(element, 'clientWidth', { value: clientWidth, configurable: true })
}

/** What the stylesheet reads: whether the text marquees, the travel distance, and its duration. */
function marquee(text: HTMLElement): (string | undefined)[] {
  return [text.dataset.marquee, text.style.getPropertyValue('--dsh-marquee-range'), text.style.getPropertyValue('--dsh-marquee-duration')]
}

describe('useHoverMarquee', () => {
  it('hands the stylesheet the overflow and its time at 30px/s while hovered, and rests at once on leave', () => {
    render(<Row text="A cell long enough to clip" />)
    const row = screen.getByRole('row')
    const { text, travel } = parts()
    expect(text.className).toContain('cell')
    expect(travel.textContent).toBe('A cell long enough to clip')
    geometry(text, 320, 180)
    fireEvent.pointerEnter(row, { pointerType: 'touch' })
    expect(marquee(text)).toEqual([undefined, '', ''])
    fireEvent.pointerEnter(row)
    expect(marquee(text)).toEqual(['', '140px', '4667ms'])
    // A repeated entry while it marquees measures nothing again, so the travel does not restart.
    geometry(text, 400, 180)
    fireEvent.pointerEnter(row)
    expect(marquee(text)).toEqual(['', '140px', '4667ms'])
    fireEvent.pointerLeave(row)
    expect(marquee(text)).toEqual([undefined, '', ''])
  })

  it('leaves text that fits or overflows by at most 8px at rest', () => {
    render(<Row text="Short" />)
    const row = screen.getByRole('row')
    const { text } = parts()
    for (const [scrollWidth, expected] of [[180, false], [188, false], [189, true]] as const) {
      geometry(text, scrollWidth, 180)
      fireEvent.pointerEnter(row)
      expect(text.hasAttribute('data-marquee')).toBe(expected)
      fireEvent.pointerLeave(row)
    }
  })

  it('marquees while held, with or without the pointer, and rests when neither remains', () => {
    const view = render(<Row text="Held text" />)
    const row = screen.getByRole('row')
    const { text } = parts()
    geometry(text, 300, 200)
    view.rerender(<Row text="Held text" hold />)
    expect(marquee(text)).toEqual(['', '100px', '3333ms'])
    fireEvent.pointerEnter(row)
    fireEvent.pointerLeave(row)
    expect(text.hasAttribute('data-marquee')).toBe(true)
    view.rerender(<Row text="Held text" />)
    expect(text.hasAttribute('data-marquee')).toBe(false)
    // The pointer keeps a marquee whose hold ends.
    fireEvent.pointerEnter(row)
    view.rerender(<Row text="Held text" hold />)
    view.rerender(<Row text="Held text" />)
    expect(text.hasAttribute('data-marquee')).toBe(true)
  })

  it('ignores hover before its text element mounts', () => {
    function Detached() {
      const ref = useRef<HTMLSpanElement>(null)
      return <div role="row" {...useHoverMarquee(ref)} />
    }
    render(<Detached />)
    fireEvent.pointerEnter(screen.getByRole('row'))
    fireEvent.pointerLeave(screen.getByRole('row'))
    expect(screen.getByRole('row').childElementCount).toBe(0)
  })
})
