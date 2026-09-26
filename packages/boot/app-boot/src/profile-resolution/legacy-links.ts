/** Package directory canonicalization through the active runtime carrier's filesystem. */

import { realpathSync } from 'node:fs'

/**
 * Return whether the process reads application modules from pkg's virtual filesystem.
 * @returns whether pkg owns the module filesystem.
 */
function isPackagedExecutable(): boolean {
  return (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined
}

/**
 * Resolve a directory through the active carrier's filesystem implementation.
 * @param path - directory path to canonicalize.
 * @returns the canonical directory path.
 */
export function realModuleDirectory(path: string): string {
  return isPackagedExecutable() ? realpathSync(path) : realpathSync.native(path)
}
