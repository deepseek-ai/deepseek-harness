/** Terminal glyph for sidebar tab titles. */
import type { ReactNode } from 'react'
import { IconApiOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the shared terminal prompt in the surrounding text color.
 * @returns a decorative sixteen-pixel line glyph.
 */
export function TerminalIcon(): ReactNode {
  return <IconApiOutlineRegular size={16} />
}
