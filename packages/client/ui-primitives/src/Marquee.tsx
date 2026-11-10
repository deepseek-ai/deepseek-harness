// Hover marquee for single-line text that its cell clips: entering the owning
// row crawls the text to its far edge, and leaving returns it to the start.

import { forwardRef, useEffect, useMemo, useRef } from 'react'
import type { HTMLAttributes, PointerEvent, RefObject } from 'react'
import clsx from 'clsx'
import css from './Marquee.module.css'

/* Overflow this small hides no meaningful tail; scrolling for it reads as an
   accidental jitter, so the text stays put. */
const MIN_REVEAL_PX = 8

/* Travel speed: slow enough to read the text as it passes. */
const PX_PER_MS = 0.03

/** Row handlers that start and stop one text's marquee. */
export interface HoverMarquee {
  /** Start the crawl; touch pointers and text that fits do nothing. */
  readonly enter: (event?: PointerEvent) => void
  /** Return the text to its start in one step. */
  readonly leave: () => void
}

/**
 * Place the text's scroll position and publish the stylesheet's fade-mask
 * hooks: `data-scrolled` while the text has left its start (left fade) and
 * `data-clipped` while text remains beyond the end edge (right fade).
 * @param text - the clipping text element.
 * @param left - scroll offset in CSS pixels.
 * @param range - the text's maximum scroll offset in CSS pixels.
 */
function place(text: HTMLElement, left: number, range: number): void {
  // jsdom implements no scrollTo; direct assignment is instant there anyway,
  // so both paths land on the same position.
  if (typeof text.scrollTo === 'function') text.scrollTo({ left, behavior: 'instant' })
  else text.scrollLeft = left
  if (left > 0) text.dataset.scrolled = ''
  else delete text.dataset.scrolled
  if (left < range) text.dataset.clipped = ''
  else delete text.dataset.clipped
}

/**
 * Return the text to its resting state: scrolled to the start with both fade
 * masks off, so the resting ellipsis renders at full strength.
 * @param text - the clipping text element.
 */
function rest(text: HTMLElement): void {
  if (typeof text.scrollTo === 'function') text.scrollTo({ left: 0, behavior: 'instant' })
  else text.scrollLeft = 0
  delete text.dataset.scrolled
  delete text.dataset.clipped
}

/**
 * Marquee one-line text wider than its cell while its row is hovered: the text
 * clips itself, so entering crawls it at a constant speed until its far edge is
 * in view, then rests there under the pointer. Overflow of at most 8px stays
 * put. Leaving returns the text to the start in one step, because the resting
 * ellipsis and the narrowed cell would otherwise meet the text while it
 * travelled back. Reduced motion jumps to the far edge instead of crawling.
 * @param text - ref to the clipping text element, such as a {@link MarqueeText}.
 * @returns stable pointer enter and leave handlers for the row.
 */
export function useHoverMarquee(text: RefObject<HTMLElement | null>): HoverMarquee {
  const frame = useRef(0)
  const revealing = useRef(false)
  useEffect(() => () => { cancelAnimationFrame(frame.current) }, [])
  return useMemo(() => ({
    enter: (event?: PointerEvent): void => {
      if (event?.pointerType === 'touch') return
      const element = text.current
      if (element === null || revealing.current) return
      revealing.current = true
      const range = element.scrollWidth - element.clientWidth
      if (range <= MIN_REVEAL_PX) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        place(element, range, range)
        return
      }
      cancelAnimationFrame(frame.current)
      let previous: number | undefined
      let position = 0
      const step = (now: DOMHighResTimeStamp): void => {
        position += previous === undefined ? 0 : (now - previous) * PX_PER_MS
        previous = now
        place(element, Math.min(position, range), range)
        if (position < range) frame.current = requestAnimationFrame(step)
      }
      frame.current = requestAnimationFrame(step)
    },
    leave: (): void => {
      revealing.current = false
      cancelAnimationFrame(frame.current)
      if (text.current !== null) rest(text.current)
    },
  }), [text])
}

/** Props of single-line text that a {@link useHoverMarquee} can crawl. */
export type MarqueeTextProps = HTMLAttributes<HTMLSpanElement>

/**
 * Render single-line text that clips with an ellipsis at rest and, while a
 * {@link useHoverMarquee} crawls it, drops the ellipsis and fades whichever
 * edge still hides text.
 */
export const MarqueeText = forwardRef<HTMLSpanElement, MarqueeTextProps>(function MarqueeText({ className, ...attributes }, ref) {
  return <span {...attributes} ref={ref} className={clsx(css.text, className)} />
})
