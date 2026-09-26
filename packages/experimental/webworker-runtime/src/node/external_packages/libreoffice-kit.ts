/** Office conversion requires a Node Host; the browser preview carries no engine assets. */
import { notAvailableError } from '../notImplementedFail.ts'

/**
 * Refuse converter creation with the kit's unavailable error code.
 * @returns A rejected promise consumed by the Host office-to-pdf provider.
 */
export function createConverter(): Promise<never> {
  return Promise.reject(Object.assign(notAvailableError('@deepseek-ai/libreoffice-kit', 'createConverter'), {
    code: 'unavailable',
  }))
}
