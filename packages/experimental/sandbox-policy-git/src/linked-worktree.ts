/**
 * The Git directory a linked worktree shares with its repository, read through the execution-world
 * filesystem. The module holds no state.
 * @module
 */

import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/** The `gitdir:` line of a linked worktree's `.git` file. */
const GITDIR_POINTER = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m

/** Byte cap of one pointer file, which holds one path line; `PATH_MAX` is 4096 on Linux and 1024 on macOS. */
const POINTER_BYTES = 8192

/** A linked worktree's shared Git directory and the directory inside it that names the worktree. */
export interface LinkedWorktree {
  /** Canonical Git directory shared by every checkout of the repository. */
  readonly common: string
  /** Canonical `<common>/worktrees/<name>` directory whose pointer files name the worktree. */
  readonly administration: string
}

/**
 * Whether canonical `path` is canonical `root` or lies below it; the test is lexical.
 * @param root - canonical absolute directory.
 * @param path - canonical absolute path.
 * @returns whether `root` contains `path`.
 */
export function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/**
 * The trimmed text of the regular file `name` in `directory`; undefined when it is not a regular file or is
 * blank. A file above {@link POINTER_BYTES} rejects with the filesystem's `FS_TOO_LARGE`.
 */
async function pointer(fs: FileSystem, name: string, directory: string, signal: AbortSignal): Promise<string | undefined> {
  if ((await fs.lstat(name, { cwd: directory }, signal))?.type !== 'file') return undefined
  const bytes = await fs.readBytes(await fs.resolve(name, { cwd: directory, signal }), signal, POINTER_BYTES)
  const text = new TextDecoder().decode(bytes).trim()
  return text.length === 0 ? undefined : text
}

/**
 * Resolve a path to the existing directory it names.
 * @param fs - execution-world filesystem.
 * @param path - directory, absolute or relative to `cwd`.
 * @param cwd - directory a relative `path` resolves from.
 * @param signal - cancellation of the reads.
 * @returns the canonical directory, or undefined when the path names no existing directory.
 */
export async function directoryAt(fs: FileSystem, path: string, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const target = await fs.resolve(path, { cwd, signal })
  return (await fs.stat(target, signal))?.type === 'directory' ? fs.processPath(target) : undefined
}

/** Whether `common` holds the entries Git requires of a repository's Git directory: `HEAD`, `objects`, and `refs`. */
async function gitDirectory(fs: FileSystem, common: string, signal: AbortSignal): Promise<boolean> {
  const [head, objects, refs] = await Promise.all([
    fs.lstat('HEAD', { cwd: common }, signal),
    fs.lstat('objects', { cwd: common }, signal),
    fs.lstat('refs', { cwd: common }, signal),
  ])
  return head?.type === 'file' && objects?.type === 'directory' && refs?.type === 'directory'
}

/**
 * Find the Git directory that the linked worktree at `root` shares with its repository.
 *
 * The files below `root` are writable by whoever works in it, so its `.git` file alone names nothing. The
 * result is a Git directory whose own files name `root` as one of its worktrees, in the layout
 * `git worktree add` writes: `<root>/.git` points at `<common>/worktrees/<name>`, whose `commondir`
 * resolves to `<common>` and whose `gitdir` resolves to `<root>/.git`, and `<common>` holds `HEAD`,
 * `objects`, and `refs`. A `<common>` that contains `root` or lies inside it yields nothing. The main
 * checkout, a subdirectory of a checkout, and a submodule checkout yield nothing. The caller decides whether
 * the files in `administration` are trustworthy.
 * @param fs - execution-world filesystem.
 * @param root - absolute directory a Session works in.
 * @param signal - cancellation of the reads.
 * @returns the canonical directories, or undefined when `root` is not such a worktree.
 * @throws the filesystem's `FS_TOO_LARGE` error when a pointer file exceeds the byte cap.
 */
export async function linkedWorktree(fs: FileSystem, root: string, signal: AbortSignal): Promise<LinkedWorktree | undefined> {
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
  if (within(common, checkout) || within(checkout, common)) return undefined
  return await gitDirectory(fs, common, signal) ? { common, administration } : undefined
}
