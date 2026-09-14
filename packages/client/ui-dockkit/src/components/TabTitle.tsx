/**
 * A chip's title: one line, clipped at the chip's inset, never ellipsized.
 * While the text is wider than its box the span carries
 * `data-dockkit-tab-clipped`, and the stylesheet fades the text out at the
 * clipped edge in place of an ellipsis. Written to the DOM directly rather
 * than through state: a reading changes nothing that renders, only how the
 * stylesheet paints it. Re-read after every commit (the text may have
 * changed) and whenever the span's box resizes (the chip shrank or grew).
 */
import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import css from './dockkit.module.css'

/** Set or clear the span's `data-dockkit-tab-clipped` from its current geometry. */
function markClipped(element: HTMLElement): void {
  // Sub-pixel widths: the text counts as clipped past one whole pixel.
  if (element.scrollWidth > element.clientWidth + 1) element.dataset.dockkitTabClipped = ''
  else delete element.dataset.dockkitTabClipped
}

/** The title span of a strip chip or a floating panel's header chip. */
export function TabTitle({ children }: { readonly children: ReactNode }): ReactNode {
  const span = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    /* v8 ignore next -- the span is rendered unconditionally. */
    if (span.current !== null) markClipped(span.current)
  })
  useLayoutEffect(() => {
    const element = span.current
    /* v8 ignore next -- the span is rendered unconditionally. */
    if (element === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => { markClipped(element) })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])
  return <span ref={span} className={css.tabTitle} data-dockkit-tab-title>{children}</span>
}
