/** Construction options for {@link ImError}. */
export interface ImErrorOptions extends ErrorOptions {
  /** Whether the failure is unrecoverable on retry (for example, an oversized delivery). */
  permanent?: boolean
}

/** Typed failures that stop the affected IM operation without claiming delivery. */
export class ImError extends Error {
  /** Whether the failure is unrecoverable on retry (for example, an oversized delivery). */
  readonly permanent: boolean

  constructor(
    readonly code: 'configuration' | 'ownership' | 'access' | 'unavailable' | 'capacity' | 'persistence' | 'conflict',
    message: string,
    options?: ImErrorOptions,
  ) {
    super(message, options)
    this.name = 'ImError'
    this.permanent = options?.permanent ?? false
  }
}
