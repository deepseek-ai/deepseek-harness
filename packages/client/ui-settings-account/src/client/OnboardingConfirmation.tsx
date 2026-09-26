/** Credit and setup confirmations with contained keyboard focus. */
import { Button, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopOnboardingProps } from './onboarding-contract.ts'
import css from './DesktopOnboarding.module.css'

/** The action requiring confirmation, including skipping directly from the credit page. */
export type OnboardingConfirmationKind = 'credit' | 'credit-skip' | 'skip'

/** @param props - confirmation action, localized copy and navigation callbacks. @returns a focus-contained dialog. */
export function OnboardingConfirmation({ kind, t, busy, canRecharge, onClose, onContinue, onRecharge, onSkip }:
  Pick<DesktopOnboardingProps, 't'> & {
    kind: OnboardingConfirmationKind
    busy: boolean
    canRecharge: boolean
    onClose: () => void
    onContinue: () => void
    onRecharge: () => void
    onSkip: () => void
  }) {
  const credit = kind !== 'skip'
  const title = t(credit ? 'onboardingNoCreditTitle' : 'onboardingSkipTitle')
  return <Modal open headless backdropBlur={false} title={title} onClose={onClose}>
    <div className={css.confirmation}>
      <div className={css.confirmationHeading}><h2>{title}</h2>
        <button type="button" className={css.confirmationClose} aria-label={t('close')} onClick={onClose}><IconCloseOutlineRegular size={14} /></button>
      </div>
      <p>{t(credit ? 'onboardingNoCreditDescription' : 'onboardingSkipDescription')}</p>
      <div className={css.confirmationActions}>
        <Button className={css.dialogButton} variant="outline" disabled={busy} onClick={kind === 'credit-skip' ? onSkip : kind === 'credit' ? onContinue : onClose}>{t(credit ? 'onboardingUnderstood' : 'onboardingKeepSetting')}</Button>
        <Button className={css.dialogButton} variant="primary" disabled={busy || (credit && !canRecharge)} onClick={credit ? onRecharge : onSkip}>{t(credit ? 'onboardingGoTopUp' : 'onboardingEnter')}</Button>
      </div>
    </div>
  </Modal>
}
