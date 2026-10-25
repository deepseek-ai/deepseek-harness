/** Shared modal for voice activation and unavailable recognition. */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { NS } from './locales.ts'

type VoiceSetupDialogProps = PropsLocale<typeof NS>
  & Pick<PropsRuntime<'plugins.bundle.activation'>, 'onDismiss'>
  & {
    open: boolean
    needsInstallation: boolean
    /** Open the plugin details; the details button is absent while it is undefined. */
    onOpenDetails: PropsRuntime<'plugins.bundle.activation'>['onOpenDetails'] | undefined
  }

/**
 * Guide activation or microphone clicks to the existing plugin details.
 * @param props - visibility, installation need and navigation callbacks.
 * @returns a dismissible prompt that never starts preparation or recording.
 */
export function VoiceSetupDialog({ open, needsInstallation, onDismiss, onOpenDetails, t }: VoiceSetupDialogProps) {
  return <Modal open={open} title={t(needsInstallation ? 'setupPrompt.title' : 'setupPrompt.unavailableTitle')}
    closeLabel={t('cancel')} onClose={onDismiss}
    footer={<>
      <Button variant="ghost" onClick={onDismiss}>{t('setupPrompt.later')}</Button>
      {onOpenDetails !== undefined && <Button variant="primary" data-modal-autofocus onClick={onOpenDetails}>
        {t(needsInstallation ? 'setupPrompt.open' : 'setupPrompt.details')}
      </Button>}
    </>}>
    <p>{t(needsInstallation ? 'setupPrompt.body' : 'setupPrompt.unavailableBody')}</p>
  </Modal>
}
