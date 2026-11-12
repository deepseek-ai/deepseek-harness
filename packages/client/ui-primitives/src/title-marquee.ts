/**
 * Marquee of a one-line title that clips its own text: while its row is hovered, a title wider than its cell crawls to
 * its far edge, and its clipping edges fade through the `data-scrolled` and `data-clipped` hooks that
 * {@link titleMarqueeClass} styles.
 */

import { useEffect, useMemo, useRef } from 'react'
import type { PointerEvent, RefObject } from 'react'
import css from './TitleMarquee.module.css'

/** Class that fades a marquee title's clipping edges while it travels; add it to the title element. */
/* v8 ignore next -- the stylesheet defines .marquee; were it missing, the title would carry no class and lose only its edge fades. */
export const titleMarqueeClass: string = css.marquee ?? ''

/* Overflow this small hides no meaningful tail; scrolling for it reads as an
   accidental jitter, so the title stays put. */
const MIN_TITLE_REVEAL_PX = 8

/* Marquee travel speed: slow enough to read the text as it passes. */
const TITLE_MARQUEE_PX_PER_MS = 0.03

/**
 * Place the title's scroll position and publish the stylesheet's fade-mask
 * hooks: `data-scrolled` while the title has left its start (left fade) and
 * `data-clipped` while text remains beyond the right edge (right fade).
 * @param title - the clipping title element.
 * @param left - scroll offset in CSS pixels.
 * @param range - the title's maximum scroll offset in CSS pixels.
 */
function placeTitle(title: HTMLSpanElement, left: number, range: number): void {
  // jsdom implements no scrollTo; the lane's direct assignment is instant there
  // anyway, so both paths land on the same position.
  if (typeof title.scrollTo === 'function') title.scrollTo({ left, behavior: 'instant' })
  else title.scrollLeft = left
  if (left > 0) title.dataset.scrolled = ''
  else delete title.dataset.scrolled
  if (left < range) title.dataset.clipped = ''
  else delete title.dataset.clipped
}

/**
 * Return the title to its resting state: scrolled to the start with both fade
 * masks off, so the resting ellipsis renders at full strength.
 * @param title - the clipping title element.
 */
function restTitle(title: HTMLSpanElement): void {
  if (typeof title.scrollTo === 'function') title.scrollTo({ left: 0, behavior: 'instant' })
  else title.scrollLeft = 0
  delete title.dataset.scrolled
  delete title.dataset.clipped
}

/**
 * Marquee a title wider than its one-line cell while its row is hovered: the
 * title clips its own text, so entering crawls it at a constant speed until the
 * far edge (a fork's incremented title, for example) is in view, then rests
 * there under the pointer. Overflow of at most {@link MIN_TITLE_REVEAL_PX}
 * stays put — a barely-clipped title moving a few pixels reads as jitter, not a
 * reveal. Leaving returns the title to the start in one step, because the
 * resting ellipsis and the narrowed cell would otherwise meet the text while it
 * travelled back. Reduced motion jumps to the far edge instead of crawling.
 * @param title - ref to the clipping title element.
 * @returns stable pointer enter/leave handlers for the row.
 */
export function useTitleMarquee(title: RefObject<HTMLSpanElement | null>): {
  enter: (event?: PointerEvent) => void
  leave: () => void
} {
  const frame = useRef(0)
  const revealing = useRef(false)
  useEffect(() => () => { cancelAnimationFrame(frame.current) }, [])
  return useMemo(() => ({
    enter: (event?: PointerEvent): void => {
      if (event?.pointerType === 'touch') return
      /* v8 ignore next -- defensive: the title span renders unconditionally. */
      if (title.current === null) return
      if (revealing.current) return
      revealing.current = true
      const element = title.current
      const range = element.scrollWidth - element.clientWidth
      if (range <= MIN_TITLE_REVEAL_PX) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        placeTitle(element, range, range)
        return
      }
      cancelAnimationFrame(frame.current)
      let previous: number | undefined
      let position = 0
      const step = (now: DOMHighResTimeStamp): void => {
        position += previous === undefined ? 0 : (now - previous) * TITLE_MARQUEE_PX_PER_MS
        previous = now
        placeTitle(element, Math.min(position, range), range)
        if (position < range) frame.current = requestAnimationFrame(step)
      }
      frame.current = requestAnimationFrame(step)
    },
    leave: (): void => {
      revealing.current = false
      cancelAnimationFrame(frame.current)
      /* v8 ignore next -- defensive: the title span renders unconditionally. */
      if (title.current === null) return
      restTitle(title.current)
    },
  }), [title])
}
