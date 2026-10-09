/** Locale-owned messages shared by microphone preview and dictation. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { RecordingError } from './audio.ts'
import type { NS } from './locales.ts'

/**
 * Translate a capture or transcription failure.
 * @param failure - the rejected value.
 * @param t - the active voice-input translator.
 * @returns localized failure text.
 */
export function failureText(failure: unknown, t: PropsLocale<typeof NS>['t']): string {
  return failure instanceof RecordingError ? t(failure.kind)
    : t('failed', { message: failure instanceof Error ? failure.message : String(failure) })
}
