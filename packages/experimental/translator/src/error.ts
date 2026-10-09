/** Safe translation diagnostics that never include submitted text or response bodies. */
import type { TranslationErrorCode } from './types.ts'

/** Provider failure or configured request/response limit rejection. */
export class TranslationError extends Error {
  override name = 'TranslationError'

  /**
   * @param code - failure classification independent of localized UI wording.
   * @param message - diagnostic without source text or provider response content.
   */
  constructor(readonly code: TranslationErrorCode, message: string) {
    super(message)
  }
}
