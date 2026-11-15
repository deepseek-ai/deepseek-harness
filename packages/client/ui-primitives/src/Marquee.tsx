// Hover marquee for single-line text that its cell clips: while the pointer is
// on the owning row, a CSS animation carries the text to its far edge, and
// leaving returns it to the start.

import { forwardRef, useMemo } from 'react'
import type { HTMLAttributes, PointerEvent, RefObject } from 'react'
import clsx from 'clsx'
import css from './Marquee.module.css'

/* Overflow this small hides no meaningful tail; travelling for it reads as an
   accidental jitter, so the text stays put. */
const MIN_REVEAL_PX = 8

/* Travel speed: slow enough to read the text as it passes. */
const PX_PER_MS = 0.03

/** Row handlers that start and stop one text's marquee. */
export interface HoverMarquee {
  /** Start the travel; touch pointers and text that fits do nothing. */
  readonly enter: (event?: PointerEvent) => void
  /** Return the text to its start in one step. */
  readonly leave: () => void
}

/**
 * Start the text's travel unless it already marquees: measure how far the text
 * overflows its cell, and hand the stylesheet that distance and the time it
 * takes at the constant speed.
 * @param text - the clipping text element.
 */
function travel(text: HTMLElement): void {
  if (text.dataset.marquee !== undefined) return
  const range = text.scrollWidth - text.clientWidth
  if (range <= MIN_REVEAL_PX) return
  text.style.setProperty('--dsh-marquee-range', `${range}px`)
  text.style.setProperty('--dsh-marquee-duration', `${Math.round(range / PX_PER_MS)}ms`)
  text.dataset.marquee = ''
}

/**
 * Return the text to its resting state: at its start, with the ellipsis and
 * without fades.
 * @param text - the clipping text element.
 */
function rest(text: HTMLElement): void {
  delete text.dataset.marquee
  text.style.removeProperty('--dsh-marquee-range')
  text.style.removeProperty('--dsh-marquee-duration')
}

/**
 * Marquee one-line text wider than its cell while the pointer is on its row:
 * the text travels at 30px/s until its far edge is in view, then rests there
 * under the pointer. Overflow of at most 8px stays put. Leaving returns the
 * text to the start in one step, because the resting ellipsis and the narrowed
 * cell would otherwise meet the text while it travelled back. The stylesheet
 * animates the travel and its fades, so the script only measures the overflow
 * once per entry; reduced motion shows the far edge at once.
 * @param text - ref to the clipping text element, a {@link MarqueeText}.
 * @returns stable pointer enter and leave handlers for the row.
 */
export function useHoverMarquee(text: RefObject<HTMLElement | null>): HoverMarquee {
  return useMemo(() => ({
    enter: (event?: PointerEvent): void => {
      if (event?.pointerType === 'touch') return
      if (text.current !== null) travel(text.current)
    },
    leave: (): void => {
      if (text.current !== null) rest(text.current)
    },
  }), [text])
}

/** Props of single-line text that a {@link useHoverMarquee} can marquee. */
export type MarqueeTextProps = HTMLAttributes<HTMLSpanElement>

/**
 * Render single-line text that clips with an ellipsis at rest and, while a
 * {@link useHoverMarquee} marquees it, drops the ellipsis and fades whichever
 * edge still hides text. The children sit in an inner span, which travels.
 */
export const MarqueeText = forwardRef<HTMLSpanElement, MarqueeTextProps>(function MarqueeText({ className, children, ...attributes }, ref) {
  return (
    <span {...attributes} ref={ref} className={clsx(css.text, className)}>
      <span className={css.travel}>{children}</span>
    </span>
  )
})
