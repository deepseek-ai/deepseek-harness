/** Selectable command text with keyboard access while horizontally overflowing. */
import { useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import css from './CommandText.module.css'

/** Display text and owner-localized identification for a command scrollport. */
export interface CommandTextProps {
  /** Original command or formatted command arguments, without truncation. */
  text: string
  /** Accessible name while the text can scroll horizontally. */
  label: string
  /** Owner typography and positioning. */
  className?: string | undefined
}

/**
 * Render command text without adding Tab stops for content that fits.
 * @param props - Text, localized scrollport name, and owner styling.
 * @returns A horizontal text scrollport, named and keyboard-focusable only when overflowing.
 */
export function CommandText({ text, label, className }: CommandTextProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    /* v8 ignore next -- the span is rendered unconditionally. */
    if (element === null) return undefined
    const measure = () => { setOverflow(element.scrollWidth > element.clientWidth) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    const fonts = 'fonts' in element.ownerDocument ? element.ownerDocument.fonts : undefined
    fonts?.addEventListener('loadingdone', measure)
    return () => {
      observer?.disconnect()
      fonts?.removeEventListener('loadingdone', measure)
    }
  }, [text])
  return (
    <span ref={ref} className={clsx(css.text, className)} data-command-text
      tabIndex={overflow ? 0 : undefined}
      role={overflow ? 'group' : undefined}
      aria-label={overflow ? label : undefined}
    >{text}</span>
  )
}
