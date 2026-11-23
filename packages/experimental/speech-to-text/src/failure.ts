/** Classified provider failures that Consumers report without parsing provider messages. */
import type { SpeechFailureCode } from './types.ts'

/** An expected recognition failure; its `code` selects localized guidance and `message` stays a Host diagnostic. */
export class SpeechTranscriptionError extends Error {
  override readonly name = 'SpeechTranscriptionError'

  /**
   * @param code - failure class that Consumers localize.
   * @param message - Host diagnostic without credentials or audio.
   * @param options - optional underlying cause.
   */
  constructor(readonly code: SpeechFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}
