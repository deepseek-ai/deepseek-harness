import type { ReactNode } from 'react'

/** Shared connected-timeline glyph; its owner supplies the accessible label. */
export function TimelineIcon({
  size = 16,
  className,
}: {
  size?: number | undefined
  className?: string | undefined
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 4.75v2M3.5 9.25v2" />
      <circle cx="3.5" cy="3.5" r="1.25" />
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="3.5" cy="12.5" r="1.25" />
      <path d="M7 3.5h6M7 8h4M7 12.5h6" />
    </svg>
  )
}
