/** Welcome page with a required explicit start. */
import type { Ref } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { DesktopOnboardingProps } from './onboarding-contract.ts'
import { OnboardingIllustration } from './OnboardingIllustration.tsx'
import art from './assets/onboarding-welcome.webp'
import artDark from './assets/onboarding-welcome-dark.webp'
import artZh from './assets/onboarding-welcome-zh.webp'
import artZhDark from './assets/onboarding-welcome-zh-dark.webp'
import css from './DesktopOnboarding.module.css'

/** @param props - localized content, focus target and navigation. @returns the welcome step. */
export function OnboardingWelcomeStep({ t, locale, colorScheme, heading, busy, onStart }: Pick<DesktopOnboardingProps, 't' | 'locale' | 'colorScheme'> & {
  heading: Ref<HTMLHeadingElement>
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
      <OnboardingIllustration className={css.welcomeArtwork} src={locale === 'zh' ? artZh : art} darkSrc={locale === 'zh' ? artZhDark : artDark} colorScheme={colorScheme} />
    </div>
  </div>
}
