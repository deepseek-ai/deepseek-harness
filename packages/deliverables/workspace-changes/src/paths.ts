/** Path classification and display forms for changed files. */
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * Slash-separated form of a native relative path.
 * @param path - native path.
 * @returns the same path with `/` separators.
 */
export function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/**
 * Whether `path` is `root` or lies under it.
 * @param root - absolute directory.
 * @param path - absolute path to test.
 * @returns true for the root itself and every descendant.
 */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Canonical spellings of the temporary directories a workspace-write sandbox
 * grants: the host `/tmp` and the platform temp area, each also in its
 * symlink-resolved form so `/tmp` and `/private/tmp` match alike.
 * @param candidates - directories to canonicalize.
 * @returns absolute directory paths.
 */
export async function temporaryRoots(candidates: readonly string[] = ['/tmp', tmpdir()]): Promise<string[]> {
  const roots = new Set<string>()
  for (const root of candidates) {
    roots.add(root)
    roots.add(await canonicalPath(root))
  }
  return [...roots]
}

/**
 * Symlink-resolved path. A path that does not exist yet is resolved through
 * its nearest existing ancestor, so a file created through a directory
 * symlink has the same canonical spelling before and after it exists.
 * @param path - absolute path.
 * @returns the canonical spelling git reports for the path.
 */
export async function canonicalPath(path: string): Promise<string> {
  const missing: string[] = []
  let head = path
  while (true) {
    try {
      return join(await realpath(head), ...missing)
    } catch {
      // A missing or unreadable component is kept lexically under its nearest resolvable ancestor;
      // a path with no existing ancestor but the root keeps its spelling entirely.
      const parent = dirname(head)
      if (parent === head || dirname(parent) === parent) return path
      missing.unshift(basename(head))
      head = parent
    }
  }
}

/**
 * Whether a file lives under a temporary root, where the model keeps scratch work.
 * @param path - absolute file path.
 * @param roots - {@link temporaryRoots}.
 * @returns true for scratch paths that never enter the change summary.
 */
export function isTemporaryPath(path: string, roots: readonly string[]): boolean {
  return roots.some(root => isInside(root, path))
}

/**
 * Sort key and label of a changed file; see `WorkspaceChangedFile.display`.
 * @param absolute - canonical absolute file path.
 * @param cwd - canonical Session working directory.
 * @param root - repository top-level directory.
 * @param home - canonical home directory, or empty to skip the `~` form.
 * @returns the slash-separated display path.
 */
export function displayPathOf(absolute: string, cwd: string, root: string, home: string): string {
  if (isInside(cwd, absolute) || isInside(root, absolute)) return toPosix(relative(cwd, absolute))
  if (home !== '' && isInside(home, absolute)) return `~/${toPosix(relative(home, absolute))}`
  return toPosix(absolute)
}

/**
 * The durable `path` field: relative inside the working directory, absolute elsewhere.
 * @param absolute - canonical absolute file path.
 * @param cwd - canonical Session working directory.
 * @returns the path the Web client opens the file through.
 */
export function durablePathOf(absolute: string, cwd: string): string {
  return isInside(cwd, absolute) ? toPosix(relative(cwd, absolute)) : absolute
}

/**
 * Code-unit order of display paths, which places `../` and absolute paths
 * before letters and matches git's own listing order for relative paths.
 * @param a - first file.
 * @param b - second file.
 * @returns negative, zero, or positive as `Array.prototype.sort` expects.
 */
export function compareDisplay(a: { display: string }, b: { display: string }): number {
  return a.display < b.display ? -1 : a.display > b.display ? 1 : 0
}
