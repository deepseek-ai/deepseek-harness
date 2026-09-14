/** Structured PDF worker failures; the renderer's locale owns visible explanations. */
export class PdfWorkerFailure extends Error {
  /** Distinguishes Worker startup/transport failures from document parsing errors. */
  readonly kind = 'worker'

  /** @param cause - native error or messageerror event, retained for diagnostics. */
  constructor(cause: Event) {
    super(undefined, { cause })
    this.name = 'PdfWorkerFailure'
  }
}
