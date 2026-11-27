/** Account notification row above the sidebar account launcher. */
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { AccountSectionInjected } from './AccountSection.tsx'
import type {} from './account-ui.ts'
import css from './AccountNotices.module.css'

/** Notice row composed by the settings shell. */
export type AccountNoticesProps = PropsRuntime<'settings.notice'>
  & PropsRenderSlots<'settings.launcher.notifications'> & InjectFace<AccountSectionInjected>

/**
 * @param props - settings navigation and account state.
 * @returns the account notification extension, active only when signed in outside onboarding.
 */
export function AccountNotices({ openSettings, useAccount, renderSlot }: AccountNoticesProps) {
  const account = useAccount(state => state)
  const active = account.view?.status === 'credential-stored' && !account.desktopOnboardingVisible && !account.onboarding
  return <div className={css.root}>{renderSlot('settings.launcher.notifications', {
    active, openAccount: () => { openSettings('account') },
  })}</div>
}
