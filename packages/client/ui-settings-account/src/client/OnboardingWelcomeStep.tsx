/** Welcome page with a required explicit start. */
import type { RefObject } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopOnboardingProps } from './onboarding-contract.ts'
import { OnboardingIllustration } from './OnboardingIllustration.tsx'
import art from './assets/onboarding-welcome.png'
import artDark from './assets/onboarding-welcome-dark.png'
import artZh from './assets/onboarding-welcome-zh.png'
import artZhDark from './assets/onboarding-welcome-zh-dark.png'
import css from './DesktopOnboarding.module.css'

/** @param props - localized content, focus target and navigation. @returns the welcome step. */
export function OnboardingWelcomeStep({ t, locale, heading, busy, onStart }: Pick<DesktopOnboardingProps, 't' | 'locale'> & {
  heading: RefObject<HTMLHeadingElement>
  busy: boolean
  onStart: () => void
}) {
  return <div className={`${css.content} ${css.welcome}`}>
    <div className={css.copy}>
      <h1 id="desktop-onboarding-title" ref={heading} tabIndex={-1}>{t('onboardingWelcome')} <em className={css.brand}>{t('onboardingBrand')}</em></h1>
      <p className={css.heroDescription}>{t('onboardingIntroduction')}</p>
      <Button variant="primary" className={`${css.action} ${css.start}`} disabled={busy} onClick={onStart}>{t('onboardingStart')}</Button>
    </div>
    <div className={css.welcomeIllustration} aria-hidden="true">
      <OnboardingIllustration className={css.welcomeArtwork} src={locale === 'zh' ? artZh : art} darkSrc={locale === 'zh' ? artZhDark : artDark} />
    </div>
  </div>
}
