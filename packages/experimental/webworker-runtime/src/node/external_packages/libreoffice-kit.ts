/** Office conversion and native preview require a Node Host; the browser preview carries no engine assets. */
import { notAvailableError } from '../notImplementedFail.ts'

/** The kit's typed failure; `code` is `unavailable` when no engine exists on this platform. */
export class ConversionError extends Error {
  /**
   * @param code - Failure category consumers branch on.
   * @param message - Diagnostic text.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ConversionError'
  }
}

/**
 * Refuse converter creation with the kit's unavailable error code.
 * @returns A rejected promise consumed by the Host office-kit provider.
 */
export function createConverter(): Promise<never> {
  return Promise.reject(Object.assign(notAvailableError('@deepseek-ai/libreoffice-kit', 'createConverter'), {
    code: 'unavailable',
  }))
}

/**
 * Report that the browser preview has no engine, as the kit does for a missing runtime.
 * @returns A rejection with an `unavailable` {@link ConversionError}.
 */
export function discoverRuntime(): Promise<never> {
  return Promise.reject(new ConversionError('unavailable', notAvailableError('@deepseek-ai/libreoffice-kit', 'discoverRuntime').message))
}
