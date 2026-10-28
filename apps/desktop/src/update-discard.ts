/** Retires electron-updater 6.x targets only after owned checks and downloads settle. */
import type { Server } from 'node:http'
import type { AppUpdater } from 'electron-updater'

/**
 * Revoke the library's pending target and await macOS's local feed server closure.
 * This adapter depends on private electron-updater 6.x fields, covered by real-library tests.
 * autoInstallOnAppQuit must be false and quitAndInstall must not have been called.
 * @param updater - Settled updater owned by the Desktop coordinator.
 * @returns After no old target or local feed server remains usable for installation.
 */
export async function discardDesktopUpdate(updater: AppUpdater): Promise<void> {
  // The dependency omits these private fields from its public integration declarations.
  const internal = updater as object as {
    updateInfoAndProvider: unknown
    downloadedUpdateHelper?: { clear(): Promise<void> } | null
    server?: Server | null
    squirrelDownloadedUpdate?: boolean
  }
  if (internal.squirrelDownloadedUpdate === true) throw new Error('desktop update: native installation already staged')
  const server = internal.server
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  }
  internal.server = null
  internal.updateInfoAndProvider = null
  await internal.downloadedUpdateHelper?.clear()
}
