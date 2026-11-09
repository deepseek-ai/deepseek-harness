/** Classified failures shared by conversion and its consumers. */
import type { OfficeKitErrorCode } from './types.ts'

/**
 * Classified conversion failure; engine details stay in the cause. `code` is also the `document-render/failed` Remote
 * reason the Office preview localizes, so it is not a `HarnessError` code; a consumer that records tool failures maps
 * it to its own error class, as `dsh-tool-office` does with `OfficeToolError`.
 */
export class OfficeKitError extends Error {
  /**
   * @param code - category suitable for a conversion consumer.
   * @param message - diagnostic explaining the failed conversion.
   * @param options - underlying engine or filesystem failure.
   */
  constructor(readonly code: OfficeKitErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OfficeKitError'
  }
}
