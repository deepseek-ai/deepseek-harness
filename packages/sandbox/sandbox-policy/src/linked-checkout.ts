/**
 * The Git administration directories of a linked checkout, read through the
 * execution-world filesystem. These functions hold no service state.
 * @module
 */

import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/**
 * Whether `path` is `root` or lies below it. Both are canonical absolute paths of one execution
 * world; the test is lexical and never touches the filesystem.
 * @param root - canonical absolute directory.
 * @param path - canonical absolute path to test.
 * @returns whether `root` contains `path`.
 */
export function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/** The `gitdir:` pointer line of a linked checkout's `.git` file. */
const GITDIR_POINTER = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m

/**
 * Read one short pointer file inside a Git administration directory.
 * @param fs - execution-world filesystem.
 * @param path - pointer file, absolute or relative to `cwd`.
 * @param cwd - directory a relative `path` resolves from.
 * @param signal - cancellation of the reads.
 * @returns the text, or undefined when the path is not a regular file.
 */
export async function pointerText(fs: FileSystem, path: string, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const entry = await fs.lstat(path, { cwd }, signal)
  if (entry?.type !== 'file') return undefined
  return fs.readText(await fs.resolve(path, { cwd, signal }), signal)
}

/**
 * Resolve a pointer target to a canonical directory.
 * @param fs - execution-world filesystem.
 * @param path - pointer target, absolute or relative to `cwd`.
 * @param cwd - directory a relative `path` resolves from.
 * @param signal - cancellation of the reads.
 * @returns the canonical directory, or undefined when the target is not an existing directory.
 */
export async function pointerDirectory(fs: FileSystem, path: string, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const target = await fs.resolve(path, { cwd, signal })
  const info = await fs.stat(target, signal)
  return info?.type === 'directory' ? fs.processPath(target) : undefined
}

/**
 * The Git administration directories a linked checkout at `root` writes outside itself. Only the layout
 * Git creates for a linked worktree yields them; the [README](../README.md#use-this-package) states why.
 * @param fs - execution-world filesystem.
 * @param root - canonical absolute checkout directory.
 * @param signal - cancellation of the reads.
 * @returns the common directory and the administration directory, canonical, or an empty list.
 */
export async function linkedCheckoutAdministration(fs: FileSystem, root: string, signal: AbortSignal): Promise<string[]> {
  const pointer = await fs.lstat('.git', { cwd: root }, signal)
  if (pointer?.type !== 'file') return []
  const pointerTarget = await fs.resolve('.git', { cwd: root, signal })
  const target = GITDIR_POINTER.exec(await fs.readText(pointerTarget, signal))?.[1]
  if (target === undefined) return []
  const gitDirectory = await pointerDirectory(fs, target, root, signal)
  if (gitDirectory === undefined || basename(dirname(gitDirectory)) !== 'worktrees') return []
  const common = dirname(dirname(gitDirectory))
  const commonPointer = (await pointerText(fs, 'commondir', gitDirectory, signal))?.trim()
  if (commonPointer === undefined || commonPointer.length === 0) return []
  if (await pointerDirectory(fs, commonPointer, gitDirectory, signal) !== common) return []
  const back = (await pointerText(fs, 'gitdir', gitDirectory, signal))?.trim()
  if (back === undefined || back.length === 0) return []
  if (fs.processPath(await fs.resolve(back, { cwd: gitDirectory, signal })) !== fs.processPath(pointerTarget)) return []
  if (within(common, root)) return []
  return [common, gitDirectory]
}
