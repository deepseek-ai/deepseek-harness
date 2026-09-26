/** Terminal glyph for sidebar tab titles. */
import type { ReactNode } from 'react'

/**
 * Render the tab title's terminal prompt in the surrounding text color.
 * @returns a decorative sixteen-pixel line glyph.
 */
export function TerminalIcon(): ReactNode {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 4L7 8L3 12" stroke="currentColor" />
    <path d="M9 12H13" stroke="currentColor" />
  </svg>
}
