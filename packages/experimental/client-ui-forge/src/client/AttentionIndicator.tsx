/** Mark over the Session panel toggle while a bound change request needs attention. */

import type { ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type { NS } from './locales.ts'
import type { PanelSnapshot } from './source.ts'
import { needsAttention } from './status.ts'
import css from './Forge.module.css'

/** Business face of the attention indicator. */
export interface AttentionIndicatorInjected {
  /** Panel snapshot of the Session; bound as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
}

/** Full props of the attention indicator. */
export type AttentionIndicatorProps =
  PropsRuntime<'conversation.session.panel.indicator'>
  & InjectFace<AttentionIndicatorInjected>
  & PropsLocale<typeof NS>

/**
 * Render a yellow dot, named for assistive technology, while any bound change
 * request has failing checks, requested changes, or a merge conflict.
 * @param props - panel snapshot hook and copy.
 * @returns the indicator, or null while nothing needs attention.
 */
export function AttentionIndicator({ usePanel, t }: AttentionIndicatorProps): ReactNode {
  const attention = usePanel(snapshot => snapshot.state?.changeRequests.some(needsAttention) === true)
  if (!attention) return null
  return (
    <span className={css.attention} data-forge-attention="">
      <span className={css.visuallyHidden}>{t('header.attention')}</span>
    </span>
  )
}
