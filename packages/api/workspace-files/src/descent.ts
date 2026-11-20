/**
 * Directory paths spelled as a descent from a workspace root. `list` and
 * `changes` accept such a directory when a link on its path resolves outside
 * the root.
 */
import { win32 } from 'node:path'

/**
 * Express a directory as child names below the workspace root, from the two
 * spellings the filesystem backend resolved: `FsTarget.displayPath` of the root
 * and of the directory, each absolute with a home prefix expanded and no link
 * followed. A request string is never judged here, because the backend may
 * read it differently than this function would.
 *
 * The directory qualifies when its spelling is the root's spelling followed by
 * child names. Such a path leads from the root directory through its entries,
 * so it leaves the root only through a link below it. A `..` segment
 * disqualifies the path: after a link it names the parent of the link's target,
 * which the entries below the root need not name.
 *
 * A root spelling that is not absolute, such as a workspace-relative path or a
 * URI, never qualifies. Spellings compare exactly, including case under a
 * Windows root.
 * @param root - the backend's unresolved spelling of the workspace root.
 * @param directory - the backend's unresolved spelling of the directory.
 * @returns the `/`-joined child names, empty for the root itself, or undefined
 *   when the directory is not spelled below the root.
 */
export function workspaceDescent(root: string, directory: string): string | undefined {
  // A POSIX backend spells an absolute path from `/`; a Windows backend spells it from a drive or `\\`.
  const posix = root.startsWith('/')
  if (!posix && !win32.isAbsolute(root)) return undefined
  const separator = posix ? '/' : '\\'
  const base = root.replace(posix ? /\/+$/u : /\\+$/u, '')
  if (directory !== base && !directory.startsWith(`${base}${separator}`)) return undefined
  const names = directory.slice(base.length).split(posix ? '/' : /[\\/]/u).filter(name => name !== '' && name !== '.')
  return names.includes('..') ? undefined : names.join('/')
}
