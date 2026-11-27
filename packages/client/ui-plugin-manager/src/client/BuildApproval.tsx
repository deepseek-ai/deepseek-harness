/** The request to allow the build scripts pnpm blocked, shown by a failed installation or update. */

import { useId, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { Translate } from './presentation.ts'
import css from './PluginManagerPage.module.css'

/** Lists the pending build scripts with the consequence of allowing them, and retries with them allowed. */
export function BuildApproval({ names, t, onApprove }: {
  /** The pending `allowBuilds` keys the Host reported. */
  readonly names: readonly string[]
  readonly t: Translate
  readonly onApprove: () => void
}): ReactNode {
  const titleId = useId()
  return (
    <section className={css.approval} role="group" aria-labelledby={titleId} data-install-approval>
      <h3 id={titleId} className={css.approvalTitle}>{t('installApprovalTitle')}</h3>
      <p className={css.approvalText}>{t('installApprovalDescription')}</p>
      <ul className={css.approvalList}>
        {names.map(name => <li key={name}><code>{name}</code></li>)}
      </ul>
      <p className={css.approvalText}>{t('installApprovalConsequence')}</p>
      <p className={css.approvalCaution}>{t('installApprovalCaution')}</p>
      <Button variant="primary" className={css.wide} onClick={onApprove}>{t('installApproveAndRetry')}</Button>
    </section>
  )
}
