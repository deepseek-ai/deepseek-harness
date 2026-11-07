/** Startup policy for optional Electron shell preferences, independent of the Host. */
import { DesktopSettingsFile, type DesktopUpdatePreferences } from './settings-file.ts'

/** Resolved popup preference; channel failures do not disable a valid popup preference. */
export interface DesktopSettings {
  readonly updates: Pick<DesktopUpdatePreferences, 'allowTestAuthPopupWindow'>
}

/**
 * Initialize the shared document explicitly at startup, then resolve the popup preference.
 * @param userData - Electron userData, independent of DSH_HOME.
 * @returns Validated popup preference, or false with a diagnostic on failure; changes require restart.
 */
export async function readDesktopSettings(userData: string): Promise<DesktopSettings> {
  const file = new DesktopSettingsFile(userData)
  const result = await file.initialize()
  const preference = result.kind === 'ready' ? result.fields.allowTestAuthPopupWindow : undefined
  if (preference?.kind === 'valid') return { updates: { allowTestAuthPopupWindow: preference.value } }
  const error = result.kind === 'error' ? result.error : preference?.kind === 'invalid' ? preference.error : undefined
  if (error) {
    try { console.warn(`desktop settings: ${file.path}: using defaults because settings could not be loaded`, error) } catch (_logError) {
      // Optional popup settings remain disabled even when diagnostic output is unavailable.
    }
  }
  return { updates: { allowTestAuthPopupWindow: false } }
}
