/** Refresh glyph that turns while a refresh runs. */

import { useState, type ReactNode } from 'react'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './RefreshGlyph.module.css'

/** Props of the refresh glyph. */
export interface RefreshGlyphProps {
  /** Whether the refresh runs. */
  readonly busy: boolean
  /** Glyph size in pixels. */
  readonly size: number
}

/**
 * Render the refresh glyph. It turns while `busy` and, once `busy` ends,
 * completes the turn under way, so a quick refresh still shows a whole turn
 * and the glyph stops upright. Under reduced motion it dims and returns instead of turning.
 * @param props - whether the refresh runs, and the glyph size.
 * @returns the glyph.
 */
export function RefreshGlyph({ busy, size }: RefreshGlyphProps): ReactNode {
  // Set when a turn starts and cleared at the first turn boundary after `busy` ends.
  const [turning, setTurning] = useState(false)
  return (
    <span
      className={css.glyph}
      data-turning={busy || turning ? '' : undefined}
      onAnimationStart={() => { setTurning(true) }}
      onAnimationIteration={() => { if (!busy) setTurning(false) }}
    >
      <IconRefreshOutlineRegular size={size} />
    </span>
  )
}
