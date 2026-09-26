/** Filesystem recovery for callers that own profile shutdown and write exclusion. */

import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { PROFILE_PATCH_FILENAME, readProfileManifest } from './profile.ts'
import { writeProfileBundles } from './profile-plugins.ts'

/**
 * Back up the profile patch and retain only the caller's recovery bundles.
 * The caller must stop the profile and exclude concurrent profile writes.
 * Installed packages and other manifest fields are preserved; patches are never parsed.
 * Failures propagate and may leave completed changes in place for a retry.
 * @param binName - Diagnostic prefix for invalid profile manifests.
 * @param profileDir - Profile directory to recover without loading its plugins.
 * @param bundles - Ordered bundles to enable after recovery.
 * @returns Backup path with a Unix millisecond timestamp and optional collision ordinal, or undefined if absent.
 */
export function sanitizeProfile(binName: string, profileDir: string, bundles: readonly string[]): string | undefined {
  const manifest = existsSync(join(profileDir, 'package.json')) ? readProfileManifest(binName, profileDir) : undefined
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME)
  const backupBase = `${patchPath}.bak-${Date.now()}`
  let backupPath: string | undefined = backupBase
  let ordinal = 0
  // Caller-owned write exclusion keeps the selected destination absent until rename.
  while (existsSync(backupPath)) backupPath = `${backupBase}-${++ordinal}`
  try {
    renameSync(patchPath, backupPath)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    backupPath = undefined
  }
  if (manifest !== undefined) writeProfileBundles(profileDir, manifest, bundles)
  return backupPath
}
