/** Activation guidance after the Host inspects recognition readiness. */
import { useEffect } from 'react'
import { VoiceSetupDialog } from './VoiceSetupDialog.tsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { VoiceInputInjected } from './VoiceInput.tsx'
import { voiceGuidance } from './guidance.ts'
import type { NS } from './locales.ts'

/** Registration shares for the bundle's activation guidance. */
export type VoiceSetupPromptProps = PropsRuntime<'plugins.bundle.activation'> & PropsLocale<typeof NS>
  & Pick<InjectFace<VoiceInputInjected>, 'useSpeechReadiness' | 'useAccountSignIn' | 'signIn'>

/**
 * Offer sign-in or navigation to installation without starting a download.
 * @param props - activation navigation, the shared Host readiness observer and the optional sign-in entry.
 * @returns the shared modal only when the selected provider needs sign-in or local preparation.
 */
export function VoiceSetupPrompt({ useSpeechReadiness, useAccountSignIn, signIn, onDismiss, onOpenDetails, t }: VoiceSetupPromptProps) {
  const readiness = useSpeechReadiness(value => value)
  const signInPresent = useAccountSignIn(present => present)
  const provider = readiness.catalog?.providers.find(item => item.id === readiness.catalog?.selection.providerId)
  const phase = readiness.connected ? provider?.preparation.phase : undefined
  const guidance = voiceGuidance(readiness.catalog, readiness.connected)
  const prompt = guidance === 'unavailable' ? null : guidance
  useEffect(() => {
    if (phase !== undefined && phase !== 'checking' && prompt === null) onDismiss()
  }, [phase, prompt, onDismiss])
  return <VoiceSetupDialog open={prompt !== null} kind={prompt ?? 'install'} onDismiss={onDismiss} onOpenDetails={onOpenDetails}
    onSignIn={signInPresent ? () => { onDismiss(); signIn() } : undefined} t={t} />
}
