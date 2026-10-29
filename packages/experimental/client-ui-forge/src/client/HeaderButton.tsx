/** Session header entry that shows or hides the forge tab and marks change requests that need attention. */

import type { ReactNode } from 'react'
import { Button, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ChangeRequestGlyph } from './glyphs.tsx'
import type { NS } from './locales.ts'
import type { PanelSnapshot } from './source.ts'
import { needsAttention } from './status.ts'
import css from './HeaderButton.module.css'

/** Business face of the header entry. */
export interface HeaderButtonInjected {
  /** Panel snapshot and tab visibility of the Session; the renderer binds them as `usePanel` and `useVisible`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot>; readonly visible: HostObservable<boolean> }
  /**
   * Hide the forge tab when it is visible, otherwise open or reveal it.
   * @param visible - whether the tab is visible now.
   */
  readonly toggle: (visible: boolean) => void
}

/** Full props of the header entry. */
export type HeaderButtonProps = InjectFace<HeaderButtonInjected> & PropsLocale<typeof NS>

/**
 * Show the entry once the Session has bound change requests or its directory
 * is known to be inside a Git checkout: after an inspection found one or
 * failed, or while a later inspection runs for a directory whose repository
 * is already known.
 * @param snapshot - panel snapshot.
 * @returns whether the entry shows.
 */
function shown(snapshot: PanelSnapshot): boolean {
  const state = snapshot.state
  if (state === null) return false
  return state.changeRequests.length > 0 || state.checkout.state === 'ready' || state.checkout.state === 'failed'
    || (state.checkout.state === 'pending' && state.repository !== null)
}

/**
 * Render the header entry.
 * @param props - panel snapshot and visibility hooks, the toggle, and copy.
 * @returns the entry, or nothing outside a Git checkout without bound change requests.
 */
export function HeaderButton({ usePanel, useVisible, toggle, t }: HeaderButtonProps): ReactNode {
  const visible = usePanel(shown)
  const attention = usePanel(snapshot => snapshot.state?.changeRequests.some(needsAttention) === true)
  const pressed = useVisible(current => current)
  if (!visible) return null
  const label = t(attention ? 'header.attention' : 'header.label')
  return (
    <Tooltip label={label} side="bottom">
      <Button
        size="sm"
        className={css.trigger}
        aria-label={label}
        aria-pressed={pressed}
        data-forge-header=""
        onClick={() => { toggle(pressed) }}
      >
        <ChangeRequestGlyph tone="open" tinted={false} size={16} />
        {attention && <StateDot state="error" size={6} className={css.dot} />}
      </Button>
    </Tooltip>
  )
}
