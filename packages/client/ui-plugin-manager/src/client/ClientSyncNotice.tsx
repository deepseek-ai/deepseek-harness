/** This page's client plugin synchronization: an ongoing line while it runs, and the failures with a retry. */
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientEntryState } from '@deepseek-ai/dsh-client-modules/client'
import type { Translate } from './presentation.ts'
import css from './PluginManagerPage.module.css'

/**
 * Show what the page's module system reports; it is independent of the Host's bundle list.
 * @param props - the latest synchronization state, the page copy, and the retry.
 * @returns the status line, the failure notice, both, or nothing.
 */
export function ClientSyncNotice({ sync, t, retry }: {
  readonly sync: ClientEntryState
  readonly t: Translate
  readonly retry: () => void
}): ReactNode {
  return (
    <>
      {sync.syncing ? <p className={`${css.status} ${css.statusWithDot}`} role="status"><StateDot state="ongoing" />{t('clientSyncing')}</p> : null}
      {sync.failures.length === 0 ? null : (
        <div className={css.failure} data-client-sync-failure>
          <p className={css.statusWithDot} role="alert"><StateDot state="error" />{t('clientSyncFailed')}</p>
          <ul>{sync.failures.map(failure => <li key={failure.id}>{failure.id}: {failure.message}</li>)}</ul>
          <Button variant="outline" size="sm" disabled={sync.syncing} onClick={retry}>{t('clientSyncRetry')}</Button>
        </div>
      )}
    </>
  )
}
