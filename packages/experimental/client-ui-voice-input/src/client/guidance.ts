/** Recording guidance derived from one complete Host readiness snapshot; pure, shared by every voice surface. */
import type { SpeechCatalog } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'
import type { SpeechProviderView } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { NS } from './locales.ts'

/**
 * What a click on the microphone shows instead of recording.
 * `install`: download the selected local model; `install-or-sign-in`: automatic selection fell back to an unprepared local
 * model while signing in would enable cloud recognition; `sign-in`: the selected cloud provider needs a DeepSeek account;
 * `unavailable`: readiness is unknown, progressing or failed.
 */
export type VoiceGuidance = 'install' | 'install-or-sign-in' | 'sign-in' | 'unavailable'

/**
 * Find the provider the saved selection resolves to.
 * @param catalog - latest Host catalog.
 * @returns the provider a recording started now would use.
 */
export function selectedProvider(catalog: SpeechCatalog | null): SpeechProviderView | undefined {
  return catalog?.providers.find(provider => provider.id === catalog.selection.providerId)
}

/**
 * Find the provider that “use local recognition” selects.
 * @param catalog - latest Host catalog.
 * @returns the first Host-local provider.
 */
export function localProvider(catalog: SpeechCatalog | null): SpeechProviderView | undefined {
  return catalog?.providers.find(provider => provider.location === 'host-local')
}

/**
 * Decide whether the microphone records on click.
 * @param provider - one provider view.
 * @returns whether a recording can start without preparation.
 */
export function canRecord(provider: SpeechProviderView | undefined): boolean {
  const phase = provider?.preparation.phase
  return phase === 'ready' || phase === 'standby' || phase === 'waking'
}

/** `sign-in-required` is the only reason a provider is `unavailable`. */
const needsSignIn = (provider: SpeechProviderView): boolean => provider.preparation.phase === 'unavailable'

/**
 * Choose the guidance a microphone click shows instead of recording.
 * @param catalog - latest Host catalog.
 * @param connected - whether the readiness stream is live.
 * @returns guidance for a microphone click, or null when recording can start.
 */
export function voiceGuidance(catalog: SpeechCatalog | null, connected: boolean): VoiceGuidance | null {
  const provider = selectedProvider(catalog)
  if (!connected || catalog === null || provider === undefined) return 'unavailable'
  if (canRecord(provider)) return null
  if (provider.location === 'cloud' && needsSignIn(provider)) return 'sign-in'
  if (provider.location !== 'host-local' || provider.preparation.phase !== 'unprepared') return 'unavailable'
  const signInWouldHelp = catalog.selection.mode === 'auto' && catalog.providers.some(row => row.location === 'cloud' && needsSignIn(row))
  return signInWouldHelp ? 'install-or-sign-in' : 'install'
}

/**
 * Name a provider together with where it processes audio.
 * @param provider - one provider view.
 * @param t - voice-input translator.
 * @returns the localized option label.
 */
export function providerLabel(provider: SpeechProviderView, t: PropsLocale<typeof NS>['t']): string {
  return t(provider.location === 'cloud' ? 'providerCloud' : 'providerLocal', { name: provider.name })
}

/**
 * List every language some provider recognizes, so the preference survives switching providers.
 * @param catalog - latest Host catalog.
 * @param order - preferred menu order; codes outside it follow in provider order.
 * @returns distinct language codes in menu order.
 */
export function offeredLanguages(catalog: SpeechCatalog | null, order: readonly string[]): string[] {
  const listed = new Set(catalog?.providers.flatMap(provider => provider.languages))
  return [...order.filter(code => listed.has(code)), ...[...listed].filter(code => !order.includes(code))]
}
