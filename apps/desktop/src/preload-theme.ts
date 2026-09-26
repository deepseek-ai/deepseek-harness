/** Mirrors the Web UI's theme source into Electron's native theme so native chrome and Platform login pages follow the app palette. */

import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'

/** Root attribute written by the Web UI's theme bootstrap and presenter (ui-theme / ui-layout). */
const THEME_SOURCE_ATTRIBUTE = 'data-ds-theme-source'

/**
 * Watches `html[data-ds-theme-source]` and forwards each value to the main
 * process, which sets `nativeTheme.themeSource`. Native chrome and renderer
 * `prefers-color-scheme` queries on every platform then follow the app's
 * theme preference instead of the OS appearance while `system` keeps
 * following the OS; the macOS sidebar vibrancy material is one such consumer.
 * The main process reads the same value back as `shouldUseDarkColors` when a
 * Platform login link needs the resolved palette.
 */
export function syncNativeTheme(): void {
  let sent: string | undefined
  const send = (): void => {
    const value = document.documentElement.getAttribute(THEME_SOURCE_ATTRIBUTE)
    if (value === null || value === sent) return
    sent = value
    ipcRenderer.send(DESKTOP_IPC.nativeThemeSet, value)
  }
  const observe = (): void => {
    new MutationObserver(send).observe(document.documentElement, { attributeFilter: [THEME_SOURCE_ATTRIBUTE] })
    send()
  }
  // The preload runs before the document root exists; the theme bootstrap
  // script writes the attribute before DOMContentLoaded.
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', observe, { once: true })
  else observe()
}
