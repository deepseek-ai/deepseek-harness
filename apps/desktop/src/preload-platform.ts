/** Marks the document root with the host platform so shared Web UI CSS can scope desktop-only rules. */

import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'

/**
 * Sets `data-platform` (e.g. `darwin`) on `<html>`, deferring to DOMContentLoaded
 * when the preload runs before the document root exists.
 */
export function markDocumentPlatform(): void {
  const mark = (): void => { document.documentElement.dataset.platform = process.platform }
  // lib.dom types documentElement non-null, but a preload runs before the
  // document root exists.
  const root = document.documentElement as HTMLElement | null
  if (root === null) window.addEventListener('DOMContentLoaded', mark)
  else mark()
}

/**
 * Mirrors the window's macOS fullscreen state onto `<html data-fullscreen>` so
 * CSS drops the traffic-light clearance while the lights are hidden. The main
 * process sends the state on every transition and after each load.
 */
export function syncWindowFullscreen(): void {
  if (process.platform !== 'darwin') return
  ipcRenderer.on(DESKTOP_IPC.windowFullscreen, (_event, fullscreen: boolean) => {
    const root = document.documentElement as HTMLElement | null
    if (root === null) return
    if (fullscreen) root.dataset.fullscreen = 'true'
    else delete root.dataset.fullscreen
  })
}
