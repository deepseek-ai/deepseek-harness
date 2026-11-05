/** Last confirmed application theme source for native windows before renderer startup. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Theme sources supported by Electron and the application theme selector. */
export type DesktopThemeSource = 'system' | 'light' | 'dark'

/**
 * Read the last confirmed source; missing or unusable cache falls back to the system.
 * @param userData - Electron userData directory.
 * @returns Cached theme source or system fallback.
 */
export function readDesktopThemeCache(userData: string): DesktopThemeSource {
  try {
    const value = readFileSync(join(userData, 'desktop', 'theme-cache'), 'utf8').trim()
    if (value === 'system' || value === 'light' || value === 'dark') return value
    throw new Error('expected system, light or dark')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('desktop theme cache: using system appearance because the cache could not be read', error)
    }
    return 'system'
  }
}

/**
 * Remember a confirmed source; failure leaves the active theme usable and logs lost persistence.
 * @param userData - Electron userData directory.
 * @param source - Theme source confirmed by the owned application main frame.
 */
export function writeDesktopThemeCache(userData: string, source: DesktopThemeSource): void {
  try {
    const directory = join(userData, 'desktop')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'theme-cache'), `${source}\n`, { mode: 0o600 })
  } catch (error) {
    console.warn('desktop theme cache: appearance could not be saved for the next startup', error)
  }
}
