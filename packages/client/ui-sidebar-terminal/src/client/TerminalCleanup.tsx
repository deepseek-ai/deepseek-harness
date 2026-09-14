/** Failed background cleanup remains actionable after the originating tab disappears. */
import type { ReactNode } from 'react'
import type { TerminalCloseFailure } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from './locales.ts'
import css from './TerminalCleanup.module.css'

/** The model owns cleanup; this seat only shows failures and requests retries. */
export interface TerminalCleanupInjected {
  readonly hooks: { readonly closeFailures: HostObservable<readonly TerminalCloseFailure[]> }
  /** @param id - failed cleanup identity. */
  readonly retryClose: (id: WebTerminalId) => void
}

/**
 * Render failed cleanup tasks without recreating or blocking any sidebar tab.
 * @param props - root overlay hooks, retry command and localized copy.
 * @returns a compact alert stack, empty when no close has failed.
 */
export function TerminalCleanup({ useCloseFailures, retryClose, t }: PropsRuntime<'shell.overlay'> & PropsLocale<'sidebarTerminal'> & InjectFace<TerminalCleanupInjected>): ReactNode {
  const failures = useCloseFailures(value => value)
  if (failures.length === 0) return null
  return <div className={css.stack}>{failures.map(failure => <div key={failure.id} className={css.notice} role="alert">
    <span>{t('cleanupFailed', { title: failure.title, message: failure.message })}</span>
    <button type="button" onClick={() => { retryClose(failure.id) }}>{t('retry')}</button>
  </div>)}</div>
}
