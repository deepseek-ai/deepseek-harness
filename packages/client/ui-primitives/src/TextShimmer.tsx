/** Text-only activity animation with a stable span across lifecycle changes. */
import { memo, useMemo, type CSSProperties } from 'react'
import clsx from 'clsx'
import css from './TextShimmer.module.css'

/** Text and activity supplied by the owning row. */
export interface TextShimmerProps {
  children: string
  active: boolean
  className?: string | undefined
}

/**
 * Render text with an optional moving highlight; inactive text keeps the same node.
 * @param props - localized text, running state, and owner styling.
 * @returns the retained text span.
 */
export const TextShimmer = memo(function TextShimmer({ children, active, className }: TextShimmerProps) {
  const style = useMemo(() => ({
    '--dsh-text-shimmer-spread': `${children.length * 8}px`,
  } as CSSProperties), [children.length])
  return <span className={clsx(css.root, className)} style={style} data-text-shimmer={active || undefined}>{children}</span>
})
