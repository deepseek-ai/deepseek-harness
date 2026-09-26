/** Resolve and validate the current account's shared runtime-signature cache. */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { join, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

/**
 * Resolve the file-owned override or the current account's signing-state cache without reading its contents.
 * @param {NodeJS.ProcessEnv} environment File-owned packaging configuration.
 * @returns {string} Absolute local cache path; relative, network, device and alternate-stream paths are rejected.
 */
export function resolveWindowsSignatureCacheDirectory(environment) {
  const path = environment.DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR
    ?? win32.join(homedir(), '.dsh-desktop-signing', 'signature-cache', 'v1')
  if (!/^[a-z]:[\\/]/iu.test(path) || path.slice(2).includes(':') || /[\0\r\n]/u.test(path)) {
    throw new Error('DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR must be an absolute local drive directory')
  }
  return win32.resolve(path)
}

/**
 * Create private current-account storage or validate an explicitly selected migration source.
 * @param {string} path Absolute local directory.
 * @param {boolean} existingSource Require an existing, current-account-owned migration source without changing its permissions.
 * @returns {Promise<void>} Resolves after checking drive type, ancestor links, ownership and destination permissions.
 */
export async function prepareWindowsSignatureCacheDirectory(path, existingSource = false) {
  if (process.platform !== 'win32') throw new Error('Windows signature cache directory validation requires Windows')
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(import.meta.dirname, 'windows-signature-cache-directory.ps1'), '-CachePath', resolve(path),
    ...(existingSource ? ['-ExistingSource'] : []),
  ], { env: scrubWindowsSigningEnvironment(process.env), windowsHide: true, timeout: 60_000 })
  if ((await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) {
    throw new Error('Signature cache directory is redirected; configure DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR outside redirected storage')
  }
}
