/** JSON-safe inputs and results of the experimental speech Remote namespace. */
import type { SpeechFailureCode, SpeechProviderId, SpeechSnapshot } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Audio encoding or intake limits prevented transcription. */
    'speech/invalid-audio': { readonly reason: string }
    /** The selected provider rejected transcription; `code` is present when the provider classified the failure. */
    'speech/transcription-failed': { readonly reason: string; readonly code?: SpeechFailureCode }
  }
}

/** Complete recording submitted for transcription, separate from Session admission. */
export interface TranscriptionRequest {
  readonly audioBase64: string
  readonly providerId?: SpeechProviderId
  readonly language?: string
}

/** Current provider choices and audio intake limits. */
export interface SpeechCatalog extends SpeechSnapshot {
  readonly maxAudioBytes: number
  readonly maxDurationSeconds: number
}
