/** Coordinates onboarding navigation, transitions and the shared native recharge page. */
import type { ProductEventMap } from '@deepseek-ai/dsh-client-product-analytics/client'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { hasOnboardingCredit } from './onboarding-balance.ts'
import { OnboardingSurface } from './OnboardingSurface.tsx'
import type { DesktopOnboardingProps } from './onboarding-contract.ts'
import { OnboardingWelcomeStep } from './OnboardingWelcomeStep.tsx'
import { OnboardingCreditStep } from './OnboardingCreditStep.tsx'
import { OnboardingPurposeStep } from './OnboardingPurposeStep.tsx'
import { OnboardingProcessStep } from './OnboardingProcessStep.tsx'
import { OnboardingConfirmation, type OnboardingConfirmationKind } from './OnboardingConfirmation.tsx'
import backIcon from './assets/onboarding-back.svg'
import css from './DesktopOnboarding.module.css'

const onboardingPages = {
  welcome: 'onboarding_welcome',
  credit: 'onboarding_recharge',
  purpose: 'onboarding_use_case',
  process: 'onboarding_process',
  done: undefined,
} as const

/**
 * @param props - durable choices, account state, localized copy and the shared recharge page channel.
 * @returns the active first-run page.
 */
export function DesktopOnboarding({
  state, account, openPlatformPage, update, complete, retry, t, locale, track, exiting = false,
}: DesktopOnboardingProps) {
  const [dialog, setDialog] = useState<OnboardingConfirmationKind | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const page = useRef<HTMLElement>(null)
  // The one shared native host owns the recharge page; this flow holds only its
  // own request, released when the flow unmounts.
  const releaseRecharge = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => { releaseRecharge.current?.(); releaseRecharge.current = undefined }, [])
  const progress = state.progress
  const targetStep = progress.step
  const [step, setStep] = useState(targetStep)
  const busy = state.status === 'loading' || state.status === 'saving' || exiting || step !== targetStep
  useEffect(() => {
    if (step === targetStep) return
    const element = page.current
    if (!state.visible || element?.animate === undefined || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStep(targetStep)
      return
    }
    const animation = element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 40, fill: 'forwards', easing: 'ease-out' })
    void animation.finished.then(() => { setStep(targetStep) }, (_error: unknown) => {
      // A newer step or unmount cancels this visual transition.
    })
    return () => { animation.cancel() }
  }, [targetStep, step, state.visible])
  useEffect(() => { heading.current?.focus() }, [step])
  const pageName = onboardingPages[step]
  const shownPage = useRef<string | null>(null)
  useEffect(() => {
    if (!state.visible || pageName === undefined || exiting) {
      shownPage.current = null
      return
    }
    if (state.status === 'loading') return
    if (shownPage.current === pageName) return
    shownPage.current = pageName
    track?.('onboarding_page_view', { page_name: pageName })
  }, [state.visible, state.status, step, pageName, exiting, track])
  const shownPopup = useRef<string | null>(null)
  useEffect(() => {
    if (dialog === null || !state.visible || state.status === 'loading' || step === 'done') { shownPopup.current = null; return }
    if (shownPopup.current === dialog) return
    shownPopup.current = dialog
    track?.('onboarding_popup_view', { popup_name: dialog === 'skip' ? 'skip_setting' : 'skip_charge' })
  }, [dialog, track, state.visible, state.status, step])
  const popupClick = (button_name: ProductEventMap['onboarding_popup_click']['button_name']) => {
    track?.('onboarding_popup_click', { popup_name: dialog === 'skip' ? 'skip_setting' : 'skip_charge', button_name })
  }
  if (state.visible && state.status === 'loading') return <OnboardingSurface>
    <div className={css.loading} role="status">{t('onboardingLoading')}</div>
  </OnboardingSurface>
  if (!state.visible || pageName === undefined) return null
  const click = (button_name: ProductEventMap['onboarding_page_click']['button_name']) => {
    const selected_content = step === 'purpose' && progress.purpose !== null ? ({ office: 'office', development: 'code', both: 'code_office' } as const)[progress.purpose]
      : step === 'process' && progress.process !== null ? ({ compact: 'focus_result', standard: 'key_detail', detailed: 'full_process' } as const)[progress.process] : undefined
    track?.('onboarding_page_click', { page_name: pageName, button_name, ...selected_content === undefined ? {} : { selected_content } })
  }
  const go = (next: 'welcome' | 'credit' | 'purpose' | 'process') => { void update({ step: next }) }
  const canRecharge = openPlatformPage !== undefined
  const recharge = () => {
    setDialog(null)
    releaseRecharge.current?.()
    // Every control that reaches this is disabled without the callback.
    releaseRecharge.current = openPlatformPage?.('top-up', () => { releaseRecharge.current = undefined })
  }
  const later = () => {
    const balance = account.details?.balance
    if (balance?.status === 'ready' && !hasOnboardingCredit(balance)) setDialog('credit')
    else go('purpose')
  }
  const purposeNext = () => {
    if (progress.purpose === 'office') void complete('completed')
    else go('process')
  }
  return <>
    <OnboardingSurface exiting={exiting}>
      <section key={step} ref={page} className={`${css.page} ${dialog !== null ? css.blurred : ''}`} data-desktop-onboarding={step} lang={locale} aria-labelledby="desktop-onboarding-title" aria-busy={busy}>
        {step === 'welcome' && <OnboardingWelcomeStep t={t} locale={locale} heading={heading} busy={busy} onStart={() => { click('next'); go('credit') }} />}
        {step === 'credit' && <OnboardingCreditStep t={t} locale={locale} heading={heading} busy={busy}
          funded={state.creditFunded} canRecharge={canRecharge} onContinue={() => { click('continue'); go('purpose') }} onRecharge={() => { click('charge'); recharge() }} onLater={() => { click('later'); later() }} />}
        {step === 'purpose' && <OnboardingPurposeStep t={t} heading={heading} busy={busy} purpose={progress.purpose}
          onSelect={(purpose) => { void update({ purpose }) }} onContinue={() => { click('next'); purposeNext() }} />}
        {step === 'process' && <OnboardingProcessStep t={t} heading={heading} busy={busy} process={progress.process}
          onSelect={(process) => { void update({ process }) }} onComplete={() => { click('next'); void complete('completed') }} />}
        {state.error !== null && <div className={css.status} role="alert">{t('onboardingSaveFailed')}<Button disabled={busy} onClick={() => { void retry() }}>{t('onboardingRetry')}</Button></div>}
        {step !== 'welcome' && <footer className={css.navigation}>
          <button type="button" disabled={busy} onClick={() => { click('back'); go(step === 'credit' ? 'welcome' : step === 'purpose' ? 'credit' : 'purpose') }}><span className={css.backIcon} style={{ maskImage: `url(${backIcon})` }} aria-hidden="true" />{t('onboardingBack')}</button>
          <button type="button" disabled={busy} onClick={() => { click('skip'); setDialog(step === 'credit' ? 'credit-skip' : 'skip') }}>{t('onboardingSkip')}</button>
        </footer>}
      </section>
    </OnboardingSurface>
    {dialog !== null && <OnboardingConfirmation kind={dialog} t={t} busy={busy} canRecharge={canRecharge}
      onClose={() => { popupClick('close'); setDialog(null) }} onContinueSetup={() => { popupClick('setting'); setDialog(null) }} onContinue={() => { popupClick('know'); setDialog(null); go('purpose') }} onRecharge={() => { popupClick('charge'); recharge() }}
      onSkip={() => { popupClick(dialog === 'skip' ? 'enter' : 'know'); void complete('skipped').then(() => { setDialog(null) }) }} />}
  </>
}
