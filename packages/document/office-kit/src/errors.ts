/** Classified failures shared by conversion and its consumers. */
import type { OfficeKitErrorCode } from './types.ts'

/** Classified conversion failure; engine details stay in the cause. */
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
