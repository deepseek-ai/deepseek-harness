/** Package directory and resource canonicalization through the active runtime carrier's filesystem. */

import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

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

/** Canonicalize a module resource, preserving physical file aliases.
 * SEA archive files are symlink-free and support stat and reads, while their containing directories support realpath.
 * @param path Existing module resource path.
 * @returns Canonical resource path under the active carrier's filesystem.
 * @throws When the resource or its directory cannot be inspected or resolved.
 */
export function realModuleFile(path: string): string {
  return !isPackagedExecutable() || lstatSync(path).isSymbolicLink()
    ? realpathSync(path)
    : join(realModuleDirectory(dirname(path)), basename(path))
}
