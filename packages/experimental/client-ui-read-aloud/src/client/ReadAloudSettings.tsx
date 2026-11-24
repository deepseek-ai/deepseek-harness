/** Bundle details: what keeps the read-aloud control hidden, how reading is billed, and where the service is documented. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReadAloudStatus } from '@deepseek-ai/dsh-read-aloud/types'
import type { NS } from './locales.ts'
import css from './ReadAloud.module.css'

/** Entry-injected availability and the account sign-in verb. */
export interface ReadAloudSettingsInjected {
  hooks: {
    readAloudStatus: HostObservable<ReadAloudStatus['state']>
    /** Whether the account sign-in service is present; the sign-in action is offered only while it is. */
    accountSignIn: HostObservable<boolean>
  }
  /** Open the DeepSeek account sign-in. */
  signIn: () => void
}

/** Props of the bundle details section. */
export type ReadAloudSettingsProps = InjectFace<ReadAloudSettingsInjected> & PropsLocale<typeof NS>

/**
 * Render the read-aloud section of the bundle's details.
 * @param props - the injected state hooks, the sign-in verb, and the translator.
 * @returns the availability line when the control is hidden, then the billing note with the guide link.
 */
export function ReadAloudSettings({ useReadAloudStatus, useAccountSignIn, signIn, t }: ReadAloudSettingsProps) {
  const status = useReadAloudStatus(state => state)
  const canSignIn = useAccountSignIn(present => present)
  return (
    <div className={css.settings}>
      {status === 'sign-in-required' && (
        <p className={css.status} role="status">
          <span>{t('settings.signInRequired')}</span>
          {canSignIn && <Button size="sm" onClick={signIn}>{t('settings.signIn')}</Button>}
        </p>
      )}
      {status === 'unavailable' && <p className={css.status} role="status">{t('settings.unavailable')}</p>}
      <p className={css.billing}>
        <span>{t('settings.billing')}</span>
        <a className={css.link} href={t('settings.guideUrl')} target="_blank" rel="noopener noreferrer">{t('settings.guide')}</a>
      </p>
    </div>
  )
}
