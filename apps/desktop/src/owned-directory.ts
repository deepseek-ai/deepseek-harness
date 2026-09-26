/** Desktop transaction cleanup that unlinks directory links without visiting their targets. */

import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Remove an owned directory and its contents, unlinking root and nested links.
 * Missing roots are ignored; existing roots must be directories or links.
 * @param path - Owned directory or link to remove; link targets are preserved.
 */
export function removeOwnedDirectory(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (!stat.isDirectory()) throw new Error(`desktop project: owned directory path is not a directory: ${path}`)
  // Electron's recursive rm follows nested Windows junctions into installed resources.
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) removeOwnedDirectory(child)
    else unlinkSync(child)
  }
  rmdirSync(path)
}
