/** Catalog query states shared by the task list, the detail, and the task tab. */
import type { ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TaskManagerPage.module.css'

/** Props of the catalog states: query state, shown content, and the retry action. */
export type CatalogFeedbackProps = PropsLocale<'schedule.manager'> & {
  /** Catalog query state; loading and a failed read each render their own state. */
  readonly status: 'loading' | 'ready' | 'error'
  /**
   * Whether catalog content is on screen: shown content keeps a compact
   * failure notice beside it, while an empty panel centers its states.
   */
  readonly populated: boolean
  /** Reload the catalog after a query failure. */
  readonly onRetry: () => Promise<void>
}

/**
 * Render the catalog's loading and query-failure states.
 *
 * An empty panel centers a bare spinner while loading and the failure with its
 * retry; a panel that already shows content keeps a compact notice for a failed
 * refresh, and stays silent while a refresh loads, so the retained rows remain
 * readable. Deletion outcomes are not catalog states: the app-wide toast
 * announces them.
 * @param props - query state, whether content is shown, the retry action, and localized copy.
 * @returns the applicable states, or nothing while the catalog is ready.
 */
export function CatalogFeedback({ status, populated, onRetry, t }: CatalogFeedbackProps): ReactNode {
  return <>
    {status === 'loading' && !populated && <div className={css.empty} role="status" aria-label={t('list.loading')}>
      <StateDot state="ongoing" />
    </div>}
    {status === 'error' && (populated
      ? <div className={css.notice}>
        <p role="alert">{t('list.error')}</p>
        <Button variant="outline" size="sm" onClick={() => { void onRetry() }}>{t('list.retry')}</Button>
      </div>
      : <div className={css.empty}>
        <IconWarningOutlineRegular size={24} className={css.emptyGlyph} />
        <p role="alert" className={css.emptyTitle}>{t('list.error')}</p>
        <Button variant="outline" className={css.emptyAction} onClick={() => { void onRetry() }}>{t('list.retry')}</Button>
      </div>)}
  </>
}
