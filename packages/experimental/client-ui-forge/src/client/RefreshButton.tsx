/** Refresh button beside a Session panel section title. */

import { useState, type ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { RefreshGlyph } from './RefreshGlyph.tsx'
import css from './Forge.module.css'

/** Props of the refresh button. */
export interface RefreshButtonProps {
  /** Reinspect the checkout, probe sign-in, and poll the change requests; settles once the Host has inspected and probed. */
  readonly refresh: () => Promise<void>
  /** Accessible name and tooltip. */
  readonly label: string
}

/**
 * Render a refresh button whose glyph turns until the refresh settles; presses
 * while a refresh runs are ignored.
 * @param props - the refresh action and its label.
 * @returns the button.
 */
export function RefreshButton({ refresh, label }: RefreshButtonProps): ReactNode {
  const [refreshing, setRefreshing] = useState(false)
  const start = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void refresh().finally(() => { setRefreshing(false) })
  }
  return (
    <Tooltip label={label} side="top">
      <button type="button" className={css.iconButton} aria-label={label} aria-disabled={refreshing} onClick={start}>
        <RefreshGlyph busy={refreshing} size={14} />
      </button>
    </Tooltip>
  )
}
