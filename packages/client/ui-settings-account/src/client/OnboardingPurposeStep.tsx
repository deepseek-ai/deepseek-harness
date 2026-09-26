/** Work-purpose selection with controlled, independently selectable cards. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Button, FileTypeIcon, IconCheckOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OnboardingPurpose } from '../onboarding-settings.ts'
import type { DesktopOnboardingProps } from './onboarding-contract.ts'
import officeIcon from './assets/onboarding-office.svg'
import codeIcon from './assets/onboarding-code.svg'
import css from './DesktopOnboarding.module.css'

/** @param props - selected purposes, localized copy and persistence callbacks. @returns the purpose step. */
export function OnboardingPurposeStep({ t, heading, busy, purpose, onSelect, onContinue }: Pick<DesktopOnboardingProps, 't'> & {
  heading: RefObject<HTMLHeadingElement>
  busy: boolean
  purpose: OnboardingPurpose | null
  onSelect: (value: OnboardingPurpose | null) => void
  onContinue: () => void
}) {
  const selected = (value: 'office' | 'development') => purpose === value || purpose === 'both'
  const toggle = (value: 'office' | 'development') => {
    if (busy) return
    const office = value === 'office' ? !selected('office') : selected('office')
    const development = value === 'development' ? !selected('development') : selected('development')
    onSelect(office && development ? 'both' : office ? 'office' : development ? 'development' : null)
  }
  return <div className={`${css.content} ${css.purpose}`}>
    <div className={css.copy}>
      <h1 id="desktop-onboarding-title" ref={heading} tabIndex={-1}>{t('onboardingPurposePrefix')} <em className={css.brand}>{t('onboardingBrand')}</em> {t('onboardingPurposeSuffix')}</h1>
      <p className={css.subtitle}>{t('onboardingPurposeDescription')}</p>
    </div>
    <div className={css.purposeCards}>
      {(['office', 'development'] as const).map(value => <PurposeCard key={value} purpose={value} checked={selected(value)} t={t} onToggle={() => { toggle(value) }} />)}
    </div>
    <div className={css.primaryAction}>{purpose !== null && <Button className={css.action} variant="primary" aria-disabled={busy} onClick={() => { if (!busy) onContinue() }}>{t('onboardingContinue')}</Button>}</div>
  </div>
}

function PurposeCard({ purpose, checked, t, onToggle }: {
  purpose: 'office' | 'development'
  checked: boolean
  t: DesktopOnboardingProps['t']
  onToggle: () => void
}) {
  const previous = useRef(checked)
  const [entering, setEntering] = useState(false)
  useLayoutEffect(() => {
    setEntering(checked && !previous.current)
    previous.current = checked
  }, [checked])
  const titleKey = purpose === 'office' ? 'onboardingOffice' : 'onboardingDevelopment'
  return <div className={`${css.card} ${checked ? css.selected : ''} ${purpose === 'office' ? css.officeCard : ''}`}>
    <div className={css.cardTop}>
      {checked ? <span className={`${css.fileIcons} ${entering ? css.iconsEntering : ''}`} aria-hidden="true">
        {(purpose === 'office' ? ['word', 'ppt', 'excel', 'pdf', 'image'] as const : ['typescript', 'javascript', 'sql', 'python', 'cpp'] as const)
          .map(kind => <FileTypeIcon key={kind} kind={kind} size={28} />)}
      </span> : <img src={purpose === 'office' ? officeIcon : codeIcon} width={40} height={40} alt="" />}
      <label className={css.cardCheckbox}>
        <input type="checkbox" aria-label={t(titleKey)} checked={checked} onChange={onToggle} />
        <span className={css.indicator} aria-hidden="true"><IconCheckOutlineRegular /></span>
      </label>
    </div>
    <span className={css.cardTitle}>{t(titleKey)}</span>
    <span className={css.cardDescription}>{t(purpose === 'office' ? 'onboardingOfficeDescription' : 'onboardingDevelopmentDescription')}</span>
  </div>
}
