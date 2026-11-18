/**
 * The Git directory a linked worktree shares with its repository, read through the execution-world
 * filesystem. The module holds no state.
 * @module
 */

import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/** The `gitdir:` line of a linked worktree's `.git` file. */
const GITDIR_POINTER = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m

/** Whether canonical `path` is canonical `root` or lies below it; the test is lexical. */
function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/** The trimmed text of the regular file `name` in `directory`; undefined when it is not a regular file or is blank. */
async function pointer(fs: FileSystem, name: string, directory: string, signal: AbortSignal): Promise<string | undefined> {
  if ((await fs.lstat(name, { cwd: directory }, signal))?.type !== 'file') return undefined
  const text = (await fs.readText(await fs.resolve(name, { cwd: directory, signal }), signal)).trim()
  return text.length === 0 ? undefined : text
}

/** The canonical path of the existing directory that `path` names from `cwd`; undefined when there is none. */
async function directoryAt(fs: FileSystem, path: string, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const target = await fs.resolve(path, { cwd, signal })
  return (await fs.stat(target, signal))?.type === 'directory' ? fs.processPath(target) : undefined
}

/**
 * Find the Git directory that the linked worktree at `root` shares with its repository.
 *
 * The files below `root` are writable by whoever works in it, so its `.git` file alone names nothing. The
 * result is a directory whose own files name `root` as one of its worktrees, in the layout
 * `git worktree add` writes: `<root>/.git` points at `<common>/worktrees/<name>`, whose `commondir`
 * resolves to `<common>` and whose `gitdir` resolves to `<root>/.git`. A `<common>` that contains `root`
 * or lies inside it yields nothing. The main checkout, a subdirectory of a checkout, and a submodule
 * checkout yield nothing.
 * @param fs - execution-world filesystem.
 * @param root - absolute directory a Session works in.
 * @param signal - cancellation of the reads.
 * @returns the canonical shared Git directory, or undefined when `root` is not such a worktree.
 */
export async function sharedGitDirectory(fs: FileSystem, root: string, signal: AbortSignal): Promise<string | undefined> {
  const checkout = await directoryAt(fs, root, root, signal)
  if (checkout === undefined) return undefined
  const target = GITDIR_POINTER.exec(await pointer(fs, '.git', checkout, signal) ?? '')?.[1]
  if (target === undefined) return undefined
  const administration = await directoryAt(fs, target, checkout, signal)
  if (administration === undefined || basename(dirname(administration)) !== 'worktrees') return undefined
  const common = dirname(dirname(administration))
  const commonPointer = await pointer(fs, 'commondir', administration, signal)
  if (commonPointer === undefined || await directoryAt(fs, commonPointer, administration, signal) !== common) return undefined
  const back = await pointer(fs, 'gitdir', administration, signal)
  if (back === undefined) return undefined
  if (fs.processPath(await fs.resolve(back, { cwd: administration, signal })) !== join(checkout, '.git')) return undefined
  return within(common, checkout) || within(checkout, common) ? undefined : common
}
