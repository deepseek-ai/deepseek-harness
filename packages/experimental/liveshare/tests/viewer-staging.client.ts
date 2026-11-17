/** Process-private staging dirs for generated viewer page test inputs, with a fail-safe disposer. */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/**
 * Ensure the parent exists, then allocate a unique staging directory under it. The mkdtemp call is
 * what returns the value the caller records for cleanup, so a failure to allocate leaves the caller's
 * recorded path unset rather than pointing at an unrelated directory.
 * @param parentDir - Directory that must exist as the staging parent.
 * @param prefix - Basename prefix for the unique directory.
 * @returns The absolute staging directory created for this run.
 */
export function allocateViewerStaging(parentDir: string, prefix: string): string {
  mkdirSync(parentDir, { recursive: true })
  return mkdtempSync(join(parentDir, prefix))
}

/**
 * Remove one staging directory only when it is a freshly allocated child of the allowed parent.
 * Refuses an unset path, the parent itself, or anything outside the parent, so a partial
 * beforeAll (allocation failed, path never recorded) can never resolve to `.` or the workspace.
 * @param dir - Recorded staging directory, or an unset value when allocation did not happen.
 * @param allowedParent - The staging parent this test owns.
 * @param remove - Remover, injectable for tests; defaults to a recursive fs removal.
 * @returns True only when a valid child directory was removed.
 */
export function disposeViewerStaging(
  dir: string | undefined,
  allowedParent: string,
  remove: (path: string) => void = (path) => { rmSync(path, { recursive: true, force: true }) },
): boolean {
  if (dir === undefined || dir === '') return false
  const target = resolve(dir)
  const parent = resolve(allowedParent)
  if (target === parent || !target.startsWith(parent + sep)) return false
  remove(target)
  return true
}
