/** Framework-hook projection into the desktop introduction's pure view. */
import { useEffect, useLayoutEffect, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { DesktopOnboardingProps, DesktopOnboardingState } from './onboarding-contract.ts'
import { OnboardingSurface } from './OnboardingSurface.tsx'
import { DesktopOnboarding } from './DesktopOnboarding.tsx'

/** Observable sources and actions supplied by the account plugin's apply closure. */
export interface DesktopOnboardingInjected extends Omit<DesktopOnboardingProps, 'state' | 'account' | 't' | 'exiting' | 'locale'> {
  hooks: {
    onboarding: HostObservable<DesktopOnboardingState>
    account: HostObservable<AccountSnapshot>
  }
}

/**
 * Read shared state through framework hooks; sessions do not control activation.
 * @param props - shell overlay bindings and account-owned actions.
 * @returns the unfinished flow, retained briefly after successful completion unless motion is reduced.
 */
export function DesktopOnboardingEntry({ useOnboarding, useAccount, ...props }:
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings.account'> & InjectFace<DesktopOnboardingInjected>) {
  const locale = props.t('onboardingArtworkLocale')
  const state = useOnboarding(value => value)
  const account = useAccount(value => value)
  useLayoutEffect(() => {
    if (!state.visible) return
    const bridge = (globalThis as typeof globalThis & {
      dshOnboarding?: { setActive(active: boolean): void }
    }).dshOnboarding
    bridge?.setActive(true)
    return () => { bridge?.setActive(false) }
  }, [state.visible])
  const [lastVisible, setLastVisible] = useState(state.visible ? state : null)
  const done = !state.visible && state.progress.step === 'done'
    && account.view?.status === 'credential-stored'
  const pendingCompletion = done && state.status === 'saving'
  const completed = done && state.status === 'ready'
  const exiting = completed && lastVisible !== null
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useLayoutEffect(() => {
    if (state.visible) setLastVisible(state)
    else if (!completed && !pendingCompletion) setLastVisible(null)
  }, [state, completed, pendingCompletion])
  useEffect(() => {
    if (!exiting) return
    // Matches OnboardingSurface's exit animation; cleanup also covers sign-out.
    const timer = window.setTimeout(() => { setLastVisible(null) }, 180)
    return () => { window.clearTimeout(timer) }
  }, [exiting])

  const displayed = state.visible ? state : exiting || pendingCompletion ? lastVisible : null
  if (displayed === null) return state.status === 'loading'
    ? <OnboardingSurface><div role="status">{props.t('onboardingLoading')}</div></OnboardingSurface> : null
  return <DesktopOnboarding {...props} locale={locale} state={pendingCompletion ? { ...displayed, status: 'saving' } : displayed}
    account={account} exiting={exiting} />
}
