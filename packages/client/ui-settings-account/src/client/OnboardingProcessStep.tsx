/** Work-detail choices with radio-group keyboard navigation. */
import type { KeyboardEvent, RefObject } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OnboardingProcess } from '../onboarding-settings.ts'
import type { DesktopOnboardingProps } from './onboarding-contract.ts'
import compactIcon from './assets/onboarding-compact.svg'
import standardIcon from './assets/onboarding-standard.svg'
import detailedIcon from './assets/onboarding-detailed.svg'
import css from './DesktopOnboarding.module.css'

const options = [
  { value: 'compact', titleKey: 'onboardingCompact', descriptionKey: 'onboardingCompactDescription', icon: compactIcon, size: 40 },
  { value: 'standard', titleKey: 'onboardingStandard', descriptionKey: 'onboardingStandardDescription', icon: standardIcon, size: 36 },
  { value: 'detailed', titleKey: 'onboardingDetailed', descriptionKey: 'onboardingDetailedDescription', icon: detailedIcon, size: 36 },
] as const

/** @param props - selected detail, localized copy and persistence callbacks. @returns the process step. */
export function OnboardingProcessStep({ t, heading, busy, process, onSelect, onComplete }: Pick<DesktopOnboardingProps, 't'> & {
  heading: RefObject<HTMLHeadingElement>
  busy: boolean
  process: OnboardingProcess | null
  onSelect: (value: OnboardingProcess) => void
  onComplete: () => void
}) {
  const onKeyDown = (event: KeyboardEvent, value: OnboardingProcess) => {
    if (busy) return
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (direction === 0) return
    event.preventDefault()
    const nextIndex = (options.findIndex(option => option.value === value) + direction + options.length) % options.length
    const next = options[nextIndex as 0 | 1 | 2]
    onSelect(next.value)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-process="${next.value}"]`)?.focus()
  }
  return <div className={`${css.content} ${css.process}`}>
    <div className={css.copy}>
      <h1 id="desktop-onboarding-title" ref={heading} tabIndex={-1}>{t('onboardingProcess')}</h1>
      <p className={css.subtitle}>{t('onboardingProcessDescription')}</p>
    </div>
    <div className={css.processCards} role="radiogroup" aria-labelledby="desktop-onboarding-title">
      {options.map(option => <button type="button" role="radio" key={option.value}
        data-process={option.value} aria-checked={process === option.value}
        tabIndex={process === option.value || (process === null && option.value === 'compact') ? 0 : -1}
        className={`${css.card} ${process === option.value ? css.selected : ''}`}
        aria-disabled={busy} onClick={() => { if (!busy) onSelect(option.value) }}
        onKeyDown={(event) => { onKeyDown(event, option.value) }}>
        <span className={css.processIcon}><img src={option.icon} width={option.size} height={option.size} alt="" /></span>
        <span className={css.cardTitle}>{t(option.titleKey)}</span>
        <span className={css.cardDescription}>{t(option.descriptionKey)}</span>
      </button>)}
    </div>
    <div className={css.primaryAction}>{process !== null && <Button className={css.action} variant="primary" aria-disabled={busy} onClick={() => { if (!busy) onComplete() }}>{t('onboardingEnter')}</Button>}</div>
  </div>
}
