/** Typed failures that stop the affected IM operation without claiming delivery. */
export class ImError extends Error {
  constructor(readonly code: 'configuration' | 'ownership' | 'access' | 'unavailable' | 'capacity' | 'persistence' | 'conflict', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImError'
  }
}
