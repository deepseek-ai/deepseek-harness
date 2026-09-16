/** Legacy profile-link inspection shared by the disk materializer and runtime resolver. */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Profile-private package links projected into its pnpm-managed node_modules. */
export const PROFILE_MODULE_FALLBACK_DIR = '.dsh-module-fallback'

/**
 * Return whether the process reads application modules from pkg's virtual filesystem.
 * @returns whether pkg owns the module filesystem.
 */
export function isPackagedExecutable(): boolean {
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

/**
 * Resolve a link target without following the final path component.
 * @param path - candidate path whose parent is canonicalized.
 * @returns the canonical candidate, or undefined when its parent is absent.
 */
export function canonicalLinkPath(path: string): string | undefined {
  try {
    return join(realModuleDirectory(dirname(path)), basename(path))
  } catch (error) {
    // A missing parent means the candidate cannot identify an existing owned link.
    /* v8 ignore next 2 -- a non-ENOENT realpath failure requires a host filesystem fault */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    /* v8 ignore next -- see the host-filesystem exception above */
    throw error
  }
}

/**
 * Return whether a symlink or junction points at the same path as `target`.
 * @param link - symlink or junction to inspect.
 * @param target - expected target path.
 * @returns whether both paths identify the same entry.
 */
export function symlinkPointsTo(link: string, target: string): boolean {
  const actual = resolve(dirname(link), readlinkSync(link))
  const canonicalActual = canonicalLinkPath(actual)
  const canonicalTarget = canonicalLinkPath(resolve(target))
  return canonicalActual !== undefined && canonicalActual === canonicalTarget
}

/**
 * Return whether an observed profile package must not claim local precedence.
 * @param profileDir - profile directory containing the package projection.
 * @param packageName - bare package name to inspect.
 * @returns whether the entry is a managed fallback link or disappeared during inspection.
 */
export function isProfileModuleFallbackLink(profileDir: string, packageName: string): boolean {
  const link = join(profileDir, 'node_modules', packageName)
  const target = join(profileDir, PROFILE_MODULE_FALLBACK_DIR, 'node_modules', packageName)
  try {
    return lstatSync(link).isSymbolicLink() && symlinkPointsTo(link, target)
  } catch (error) {
    /* v8 ignore next 2 -- a vanished candidate cannot claim local precedence */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    /* v8 ignore next -- non-ENOENT lstat/readlink failures require a host filesystem fault */
    throw error
  }
}
