/** A failure this page retries in place: the failure sentence, its retry, and any failure rows under them. */
import type { ReactNode } from 'react'
import { Button, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import css from './PluginManagerPage.module.css'

/**
 * Show a failure with the action that retries it.
 * @param props - the failure sentence, the retry's label, state and handler, and optional rows shown under
 * the sentence; `data-*` attributes go to the notice's root element.
 * @returns the notice.
 */
export function FailureNotice({ message, retryLabel, retryDisabled, onRetry, children, ...root }: {
  readonly message: string
  readonly retryLabel: string
  readonly retryDisabled?: boolean | undefined
  readonly onRetry: () => void
  readonly children?: ReactNode
} & Readonly<Record<`data-${string}`, true>>): ReactNode {
  return (
    <div className={css.failure} {...root}>
      <IconWarningOutlineRegular className={css.failureIcon} />
      <div className={css.failureBody}>
        <div className={css.failureHead}>
          <p className={css.failureText} role="alert">{message}</p>
          <Button variant="outline" size="sm" className={css.failureRetry} disabled={retryDisabled} onClick={onRetry}>{retryLabel}</Button>
        </div>
        {children}
      </div>
    </div>
  )
}
