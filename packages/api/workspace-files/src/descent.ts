/**
 * Directory paths written as a descent from a workspace root. `list` and
 * `changes` accept such a path when a link on it resolves outside the root.
 */
import { posix, win32 } from 'node:path'

/**
 * Express a directory path as child names below the workspace root. The path is
 * judged as written: links are not resolved. A path with a `..` segment never
 * qualifies, because after a link that segment names the parent of the link's
 * target.
 * @param workspaceRoot - absolute workspace root in the filesystem's execution world.
 * @param path - directory path, absolute or relative to the workspace root.
 * @returns the `/`-joined child names, empty for the root itself, or undefined
 *   when the path is not written below the root.
 */
export function workspaceDescent(workspaceRoot: string, path: string): string | undefined {
  const paths = workspaceRoot.startsWith('/') ? posix : win32
  if (path.split(paths === posix ? '/' : /[/\\]/u).includes('..')) return undefined
  const relative = paths.relative(workspaceRoot, paths.resolve(workspaceRoot, path))
  if (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return undefined
  return relative.split(paths.sep).join('/')
}
