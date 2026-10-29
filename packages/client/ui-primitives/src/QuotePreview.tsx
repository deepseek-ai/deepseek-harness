/** Shared compact presentation for draft and sent text quotes. */

import { useLayoutEffect, useRef, useState } from 'react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { IconCloseOutlineRegular } from './icons/index.tsx'
import { HoverCard } from './HoverCard.tsx'
import css from './QuotePreview.module.css'

function QuoteMarkIcon({ className }: { readonly className?: string | undefined }) {
  return (
    <svg width={16} height={16} className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <g transform="translate(6.8 2.4)">
        <path d="M2.8125 0.583008L3.2002 1.16602C2.43912 1.6713 1.88491 2.41238 1.60547 3.25684H2.98926V6.70605H0V4.52148C1.96593e-05 2.70313 0.9109 1.00575 2.42578 0L2.8125 0.583008Z" fill="currentColor" />
        <path d="M7.50781 0.583008L7.89551 1.16602C7.13443 1.6713 6.58022 2.41238 6.30078 3.25684H7.68457V6.70605H4.69531V4.52148C4.69533 2.70313 5.60621 1.00575 7.12109 0L7.50781 0.583008Z" fill="currentColor" />
      </g>
    </svg>
  )
}

/** Optional whole-quote removal control supplied by an editable owner. */
export interface QuotePreviewRemoval {
  /** Localized accessible name for the removal button. */
  readonly label: string
  /** Remove the complete owning quote node. */
  readonly onRemove: () => void
}

/** Presentation inputs for one compact quote excerpt. */
export interface QuotePreviewProps {
  /** Exact selected text rendered inline and exposed in a popover while clipped. */
  readonly text: string
  /** Composer-only removal action; omit for inert sent quotes. */
  readonly removal?: QuotePreviewRemoval | undefined
}

/**
 * Render one width-capped quote preview shared by editable drafts and sent messages.
 * Clipped excerpts open a content-sized, scrollable popover that fits within the viewport.
 * @param props - selected text and optional localized removal action.
 * @returns a non-navigating quote preview with a full-text popover only while clipped.
 */
export function QuotePreview({ text, removal }: QuotePreviewProps): JSX.Element {
  const sourceRef = useRef<HTMLSpanElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const source = sourceRef.current
    /* v8 ignore next -- the ref is attached before layout effects run. */
    if (source === null) return
    const measure = () => {
      const clipped = source.scrollWidth > source.clientWidth
      setTruncated(clipped)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(source)
    return () => { observer.disconnect() }
  }, [text])
  const remove = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    removal?.onRemove()
  }
  const preview = (
    <span
      className={css.quote}
      data-quote-preview=""
      data-removable={removal === undefined ? undefined : ''}
    >
      {removal === undefined
        ? (
          <span className={css.marker} aria-hidden>
            <QuoteMarkIcon className={css.quoteMark} />
          </span>
        )
        : (
          <button
            type="button"
            className={css.remove}
            aria-label={removal.label}
            onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }}
            onKeyDown={(event) => { event.stopPropagation() }}
            onClick={remove}
          >
            <QuoteMarkIcon className={css.quoteMark} />
            <IconCloseOutlineRegular size={12} className={css.closeMark} />
          </button>
        )}
      <span ref={sourceRef} className={css.source} data-quote-preview-text="">{text}</span>
    </span>
  )
  return (
    <HoverCard
      inline
      grouped
      fitContent
      openDelayMs={0}
      disabled={!truncated}
      anchor={preview}
      content={<span className={css.popoverText} data-quote-popover="" aria-hidden="true">{text}</span>}
    />
  )
}
