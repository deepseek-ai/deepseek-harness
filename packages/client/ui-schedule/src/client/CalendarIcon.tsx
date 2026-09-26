/** Calendar glyph for the date row's picker trigger. */
import type { ReactNode } from 'react'

/** Inputs of the calendar glyph, matching the product icon set's props. */
export interface CalendarIconProps {
  /** Extra class for layout placement; color rides currentColor. */
  readonly className?: string | undefined
}

/**
 * Draw the 14px calendar outline the Date row's trigger carries.
 *
 * The shared product icon set has no calendar glyph, so this package draws the
 * one its own picker needs, at that set's regular 1px stroke.
 * @param props - extra class for layout placement.
 * @returns the decorative glyph.
 */
export function IconCalendarOutlineRegular({ className }: CalendarIconProps): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      className={className}
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth="1"
    >
      <rect x="1.4" y="2.6" width="11.2" height="10" rx="1.6" stroke="currentColor" />
      <path d="M1.4 5.6H12.6" stroke="currentColor" />
      <path d="M4.4 1.4V3.6M9.6 1.4V3.6" stroke="currentColor" />
    </svg>
  )
}
