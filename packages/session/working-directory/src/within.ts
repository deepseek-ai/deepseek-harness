/**
 * Lexical path containment shared by the working-directory service and its tests.
 * @module @deepseek-ai/dsh-working-directory/within
 */
import { isAbsolute, relative, sep } from 'node:path'

/**
 * Whether `path` is `root` or lies below it. Both paths are canonical absolute
 * paths of one execution world; the test is lexical and never touches the filesystem.
 * @param root - canonical absolute directory.
 * @param path - canonical absolute path to test.
 * @returns true for `root` itself and every path below it.
 */
export function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}
