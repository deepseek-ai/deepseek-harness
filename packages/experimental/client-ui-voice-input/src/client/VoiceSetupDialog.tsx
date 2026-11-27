/** Shared modal for voice activation and unavailable recognition. */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { VoiceGuidance } from './guidance.ts'
import type { NS } from './locales.ts'

type VoiceSetupDialogProps = PropsLocale<typeof NS>
  & Pick<PropsRuntime<'plugins.bundle.activation'>, 'onDismiss'>
  & {
    open: boolean
    kind: VoiceGuidance
    /** Open the plugin details; the details button is absent while it is undefined. */
    onOpenDetails: PropsRuntime<'plugins.bundle.activation'>['onOpenDetails'] | undefined
    /** Open account sign-in from this click; absent while the account UI offers no sign-in entry. */
    onSignIn?: (() => void) | undefined
    /** Switch the saved preference to local recognition; absent without a local provider. */
    onUseLocal?: (() => void) | undefined
  }

const TITLE = { install: 'setupPrompt.title', 'install-or-sign-in': 'choicePrompt.title', 'sign-in': 'signInPrompt.title', unavailable: 'setupPrompt.unavailableTitle' } as const
const BODY = { install: 'setupPrompt.body', 'install-or-sign-in': 'choicePrompt.body', 'sign-in': 'signInPrompt.body', unavailable: 'setupPrompt.unavailableBody' } as const

/**
 * Guide activation or microphone clicks to sign-in or the existing plugin details.
 * @param props - visibility, guidance kind and navigation callbacks.
 * @returns a dismissible prompt that never starts preparation or recording.
 */
export function VoiceSetupDialog({ open, kind, onDismiss, onOpenDetails, onSignIn, onUseLocal, t }: VoiceSetupDialogProps) {
  const offersSignIn = kind === 'sign-in' || kind === 'install-or-sign-in'
  const signIn = offersSignIn && onSignIn !== undefined
  const details = onOpenDetails !== undefined && kind !== 'sign-in'
  return <Modal open={open} title={t(TITLE[kind])} closeLabel={t('cancel')} onClose={onDismiss} description={t(BODY[kind])}
    footer={<>
      {kind === 'sign-in' && onUseLocal !== undefined
        ? <Button variant="ghost" onClick={onUseLocal}>{t('useLocal')}</Button>
        : <Button variant="ghost" onClick={onDismiss}>{t('setupPrompt.later')}</Button>}
      {details && <Button variant={signIn ? 'outline' : 'primary'} data-modal-autofocus={signIn ? undefined : true} onClick={onOpenDetails}>
        {t(kind === 'install' ? 'setupPrompt.open' : kind === 'install-or-sign-in' ? 'choicePrompt.download' : 'setupPrompt.details')}
      </Button>}
      {signIn && <Button variant="primary" data-modal-autofocus onClick={onSignIn}>{t('signIn')}</Button>}
    </>} />
}
