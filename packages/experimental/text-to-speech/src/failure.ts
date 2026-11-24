/** Classified provider failures that Consumers report without parsing provider messages. */
import type { SynthesisFailureCode } from './types.ts'

/** An expected synthesis failure; its `code` selects localized guidance and `message` stays a Host diagnostic. */
export class SpeechSynthesisError extends Error {
  override readonly name = 'SpeechSynthesisError'

  /**
   * @param code - failure class that Consumers localize.
   * @param message - Host diagnostic without credentials or the spoken text.
   * @param options - optional underlying cause.
   */
  constructor(readonly code: SynthesisFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}
