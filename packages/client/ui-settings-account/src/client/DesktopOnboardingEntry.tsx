/** Framework-hook projection into the desktop introduction's pure view. */
import { useEffect, useLayoutEffect, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the `useMediaQuery` standard prop merge.
import type {} from '@deepseek-ai/dsh-client-ui-responsive/client'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { DesktopOnboardingProps, DesktopOnboardingState } from './onboarding-contract.ts'
import { OnboardingSurface } from './OnboardingSurface.tsx'
import { DesktopOnboarding } from './DesktopOnboarding.tsx'

/** Observable sources and actions supplied by the account plugin's apply closure. */
export interface DesktopOnboardingInjected
  extends Omit<DesktopOnboardingProps, 'state' | 'account' | 't' | 'exiting' | 'locale' | 'colorScheme' | 'reducedMotion'> {
  /** Publish whether onboarding covers the workspace. @param visible - includes loading, saving, and exit animation. */
  setVisible: (visible: boolean) => void
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
export function DesktopOnboardingEntry({ useOnboarding, useAccount, useMediaQuery, useTheme, useDocumentPortal, setVisible, ...props }:
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings.account'> & InjectFace<DesktopOnboardingInjected>) {
  const Portal = useDocumentPortal()
  const locale = props.t('onboardingArtworkLocale')
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
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
  const exiting = completed && lastVisible !== null && !reducedMotion

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
  const visible = displayed !== null || state.status === 'loading'
  useLayoutEffect(() => { setVisible(visible) }, [setVisible, visible])
  if (!visible) return null
  return <Portal>{displayed === null
    ? <OnboardingSurface><div role="status">{props.t('onboardingLoading')}</div></OnboardingSurface>
    : <DesktopOnboarding {...props} locale={locale} colorScheme={colorScheme} state={pendingCompletion ? { ...displayed, status: 'saving' } : displayed}
      account={account} exiting={exiting} reducedMotion={reducedMotion} />}</Portal>
}
