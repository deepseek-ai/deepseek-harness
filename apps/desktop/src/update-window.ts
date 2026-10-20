/** Native window preparation before an update confirmation can stop the Host. */
import type { BrowserWindow } from 'electron'
import { DesktopUpdatePreparationError } from './update-error.ts'

type UpdateWindow = Pick<BrowserWindow, 'isDestroyed' | 'isFullScreen' | 'setFullScreen'> & Pick<NodeJS.EventEmitter, 'once' | 'off'>

const FULLSCREEN_EXIT_TIMEOUT_MS = 5000

/**
 * Leave macOS fullscreen before displaying installation confirmation.
 * @param window - Product window that owns the update confirmation.
 * @param timeoutMessage - Locale-owned guidance to exit fullscreen and retry.
 * @returns Whether the window survived the completed native transition; destruction cancels installation.
 * @throws {DesktopUpdatePreparationError} If macOS does not report completion within five seconds.
 */
export async function prepareDesktopUpdateWindow(window: UpdateWindow, timeoutMessage: string): Promise<boolean> {
  if (window.isDestroyed()) return false
  if (process.platform !== 'darwin' || !window.isFullScreen()) return true
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(deadline)
      window.off('leave-full-screen', left)
      window.off('closed', closed)
    }
    const left = (): void => { cleanup(); resolve(true) }
    const closed = (): void => { cleanup(); resolve(false) }
    // Bound a missing native completion event; elapsed time never authorizes installation.
    const deadline = setTimeout(() => { cleanup(); reject(new DesktopUpdatePreparationError('fullscreen-timeout', timeoutMessage)) }, FULLSCREEN_EXIT_TIMEOUT_MS)
    window.once('leave-full-screen', left)
    window.once('closed', closed)
    try { window.setFullScreen(false) }
    catch (error) { cleanup(); throw error }
  })
}
