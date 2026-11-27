/** Native Office sessions require a Node Host; browser previews retain their existing fallback. */
import { notAvailableError } from '../notImplementedFail.ts'

/** Refuse native editor creation without importing engine or Desktop assets.
 * @returns A rejection identifying the unavailable native Office capability.
 */
export function openDocument(): Promise<never> {
  return Promise.reject(Object.assign(notAvailableError('@deepseek-ai/libreoffice-kit/editor', 'openDocument'), {
    code: 'unavailable',
  }))
}
