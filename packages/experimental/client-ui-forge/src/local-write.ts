/**
 * Writes a person makes from the changes view to a Session's checkout: staging, unstaging, and restoring whole files,
 * and returning index entries to an earlier state. The press is that person's authorization, so Git runs through the
 * mounted subprocess provider without the Session's sandbox policy, which bounds what the Agent does. Staging and
 * restoring run the clean and smudge filters the repository configures.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { gitUnconfined } from './git.ts'
import type { Git } from './git.ts'
import type { FileLayers } from './layers.ts'
import { insideCheckout, localDiff } from './local-diff.ts'
import type { DiffConfig } from './local-diff.ts'
import { restorable } from './restore.ts'
import type { ForgeDiffFile, ForgeLocalWrite, ForgeLocalWriteFile, ForgeLocalWriteResult } from './types.ts'

/** Thrown before anything is written when a file's unstaged change differs from the change the reader saw. */
export class LocalChangesStale extends Error {
  override name = 'LocalChangesStale'
}

/**
 * Thrown before anything is written when a file listed as deleted has a directory at its path. Git takes a path for
 * the directory and everything in it, so staging the deletion would stage those files and restoring the file would
 * delete them.
 */
export class LocalPathReplaced extends Error {
  override name = 'LocalPathReplaced'
}

/** A full SHA-1 or SHA-256 object name, the only form of a tree Git receives. */
const TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** Characters of paths one command receives. Windows limits a command line to 32,767 characters, which Git's own arguments share. */
const PATH_CHARACTERS = 16_000

/**
 * Apply one write to the checkout at `root`. `stage` and `restore` first read the `unstaged` scope again, under the
 * Session's sandbox policy as every read, and refuse the whole write when a file's change is not the one the reader
 * saw or a deleted file's path holds a directory; `unstage` and `reindex` change index entries only. The writing
 * commands run unconfined; paths reach Git as literal pathspecs, and a restore leaves submodules alone whatever
 * `submodule.recurse` says.
 * @param ctx - context that provides `fs`, `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - Git and size limits.
 * @param session - Session whose sandbox policy the reads use.
 * @param root - top-level directory of the checkout.
 * @param write - the write.
 * @param layers - classifier the `unstaged` scope is read with.
 * @param signal - cancellation of every command and read.
 * @returns the index before a `stage` or `unstage` as a tree, for undoing it.
 * @throws LocalChangesStale when a file changed since it was read; LocalPathReplaced when a deleted file's path holds
 * a directory; an Error for a path outside the checkout, a tree that is not a full object name, or a file that
 * {@link restorable} leaves out of a restore; the errors of {@link localDiff}; GitFailed when Git fails. A failure
 * after the first command leaves the paths of the earlier commands written.
 */
export async function localWrite(
  ctx: Context,
  config: DiffConfig,
  session: Session,
  root: string,
  write: ForgeLocalWrite,
  layers: FileLayers,
  signal: AbortSignal,
): Promise<ForgeLocalWriteResult> {
  const git = gitUnconfined(ctx, config, root, signal)
  const unstaged = (files: readonly ForgeLocalWriteFile[]): Promise<ForgeDiffFile[]> =>
    listed(ctx, config, session, root, files, layers, signal)
  switch (write.kind) {
    case 'stage': {
      const files = await unstaged(write.files)
      const undo = await indexTree(git)
      // A rename the index already expects stages the removal of its old path with the new one.
      await run(git, 'add', ['add', '--'], files.flatMap(file => file.previousPath === null ? [file.path] : [file.previousPath, file.path]))
      return { undo }
    }
    case 'unstage': {
      const paths = contained(write.paths)
      const undo = await indexTree(git)
      await run(git, 'reset', ['reset', '-q', '--'], paths)
      return { undo }
    }
    case 'restore': {
      const files = await unstaged(write.files)
      const refused = files.find(file => !restorable(file))
      if (refused !== undefined) throw new Error(`forge-panel: ${refused.path} is a submodule or has no index content, so it cannot be restored`)
      await run(git, 'restore', ['restore', '--worktree', '--no-recurse-submodules', '--'], files.filter(file => !file.untracked).map(file => file.path))
      await run(git, 'clean', ['clean', '-f', '-q', '--'], files.filter(file => file.untracked).map(file => file.path))
      return { undo: null }
    }
    case 'reindex':
      if (!TREE.test(write.tree)) throw new Error('forge-panel: the tree to return to is not a full object name')
      await run(git, 'reset', ['reset', '-q', write.tree, '--'], contained(write.paths))
      return { undo: null }
    /* v8 ignore next -- closed ForgeLocalWrite union exhaustiveness guard */
    default: return assertNever(write, 'ForgeLocalWrite.kind')
  }
}

/**
 * The files as the `unstaged` scope lists them now; a file that is gone or whose change differs is stale, and a
 * deleted file whose path holds a directory is refused.
 */
async function listed(
  ctx: Context,
  config: DiffConfig,
  session: Session,
  root: string,
  files: readonly ForgeLocalWriteFile[],
  layers: FileLayers,
  signal: AbortSignal,
): Promise<ForgeDiffFile[]> {
  const current = new Map((await localDiff(ctx, config, session, root, null, { kind: 'unstaged' }, layers, signal)).files.map(file => [file.path, file]))
  const matched = files.map((seen) => {
    const file = current.get(seen.path)
    if (file?.digest !== seen.digest) throw new LocalChangesStale(`${seen.path} changed since it was read`)
    return file
  })
  for (const file of matched) {
    // Only a deleted file leaves its path free for a directory.
    if (file.status !== 'deleted') continue
    const entry = await ctx.fs.lstat(file.path, { cwd: root }, signal)
    if (entry?.type === 'directory') throw new LocalPathReplaced(`${file.path} is a directory now; stage or restore the files in it instead`)
  }
  return matched
}

/** The paths, each of which stays inside the checkout. */
function contained(paths: readonly string[]): readonly string[] {
  const outside = paths.find(path => !insideCheckout(path))
  if (outside !== undefined) throw new Error(`forge-panel: ${JSON.stringify(outside)} is not a path inside the checkout`)
  return paths
}

/** Write the index as a tree; null while it holds unmerged entries or cannot be locked, which the write that follows reports. */
async function indexTree(git: Git): Promise<string | null> {
  const written = await git('write-tree', ['write-tree'], [0, 128])
  return written.exitCode === 0 ? written.stdout.trim() : null
}

/** Run one subcommand over the paths as literal pathspecs, in as many commands as the command-line limit needs. */
async function run(git: Git, name: string, command: readonly string[], paths: readonly string[]): Promise<void> {
  let batch: string[] = []
  let characters = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const args = ['--literal-pathspecs', ...command, ...batch]
    batch = []
    characters = 0
    await git(name, args)
  }
  for (const path of paths) {
    if (characters + path.length > PATH_CHARACTERS) await flush()
    batch.push(path)
    characters += path.length + 1
  }
  await flush()
}
