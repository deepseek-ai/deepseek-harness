/** Last confirmed shell language, available even when the Host cannot start. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDesktopLocale, type DesktopLocale } from './locale.ts'

/**
 * Read the last confirmed language without requiring Host settings.
 * @param userData - Electron userData directory.
 * @returns Cached language, or undefined when missing, invalid or unreadable.
 */
export function readDesktopLocaleCache(userData: string): DesktopLocale['id'] | undefined {
  try {
    const value = readFileSync(join(userData, 'desktop', 'locale-cache'), 'utf8').trim()
    const locale = resolveDesktopLocale(value)
    if (locale.id === value) return locale.id
    throw new Error('expected a canonical Desktop locale id')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('desktop locale cache: using system language because the cache could not be read', error)
    }
    return undefined
  }
}

/**
 * Remember a confirmed language; write failure leaves the active language unchanged.
 * @param userData - Electron userData directory.
 * @param locale - Language confirmed by Host settings or the owned renderer.
 */
export function writeDesktopLocaleCache(userData: string, locale: DesktopLocale['id']): void {
  try {
    const directory = join(userData, 'desktop')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'locale-cache'), `${locale}\n`, { mode: 0o600 })
  } catch (error) {
    console.warn('desktop locale cache: language could not be saved for the next startup', error)
  }
}
