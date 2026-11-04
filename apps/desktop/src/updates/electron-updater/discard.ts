/** Retires electron-updater 6.x targets only after owned checks and downloads settle. */
import type { Server } from 'node:http'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { recordUpdateCleanupFailure } from '../../update-cleanup-log.ts'
import type { AppUpdater } from 'electron-updater'

/**
 * Revoke the library's pending target and await macOS's local feed server closure.
 * This adapter depends on private electron-updater 6.x fields, covered by real-library tests.
 * autoInstallOnAppQuit must be false and quitAndInstall must not have been called.
 * @param updater - Settled updater owned by the Desktop coordinator.
 * @returns After old in-memory targets and the local feed server are retired; residual files only produce durable warnings.
 */
export async function discardDesktopUpdate(updater: AppUpdater): Promise<void> {
  // The dependency omits these private fields from its public integration declarations.
  const internal = updater as object as {
    updateInfoAndProvider: unknown
    downloadedUpdateHelper?: {
      _file: string | null
      _packageFile: string | null
      versionInfo: unknown
      fileInfo: unknown
      _downloadedFileInfo: unknown
      cacheDirForPendingUpdate: string
    } | null
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
  const helper = internal.downloadedUpdateHelper
  if (helper == null) return
  // Equivalent to the pinned helper's memory reset; its clear() silently swallows filesystem failures.
  helper._file = null
  helper._packageFile = null
  helper.versionInfo = null
  helper.fileInfo = null
  helper._downloadedFileInfo = null
  const directory = helper.cacheDirForPendingUpdate
  let names: string[]
  try { names = await readdir(directory) } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      recordUpdateCleanupFailure(app.getPath('logs'), { operation: 'list', path: directory, error })
    }
    return
  }
  for (const name of names) {
    const path = join(directory, name)
    try { await rm(path, { recursive: true, force: true }) } catch (error) {
      recordUpdateCleanupFailure(app.getPath('logs'), { operation: 'remove', path, error })
    }
  }
}
