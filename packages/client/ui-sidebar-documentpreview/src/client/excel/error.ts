/** Locale-independent spreadsheet parser failure categories. */
export class ExcelPreviewError extends Error {
  /** @param code - User-actionable parser failure. */
  constructor(readonly code: 'invalid' | 'tooLarge' | 'timeout' | 'encoding', options?: ErrorOptions) {
    super(code, options)
    this.name = 'ExcelPreviewError'
  }
}
