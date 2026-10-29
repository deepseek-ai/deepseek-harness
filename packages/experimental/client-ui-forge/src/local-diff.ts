/**
 * Local changes of a Session's checkout: where the `branch` scope forks, the
 * patch of one scope with its untracked files, the new-side text of one file,
 * and the size of the `branch` scope for the panel's card. Git runs through
 * the Session's Git runner; untracked and working-tree files are read through
 * `ctx.fs`, both within `maxDiffBytes`.
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { decodeText, parseDiff, parseNumstat, untrackedFile } from './diff.ts'
import { gitIn, GitOutputTooLarge } from './git.ts'
import type { Git, GitConfig, GitOutput, Inspection } from './git.ts'
import { parseName, remoteOrder } from './parse.ts'
import type { ForgeDiffFile, ForgeLocalChanges, ForgeLocalDiff, ForgeLocalScope, ForgeSessionWorktree } from './types.ts'

/** Git limits plus the size limits of local diffs. */
export interface DiffConfig extends GitConfig {
  /** Largest patch, untracked file, or new-side file in bytes. */
  readonly maxDiffBytes: number
  /** Most untracked files listed. */
  readonly maxUntrackedFiles: number
}

/** The commit the `branch` scope compares with and the name the panel shows for it. */
export interface ForkPoint {
  /** Full commit object name. */
  readonly commit: string
  /** Remote branch such as `origin/master`, the created worktree's base branch, or an abbreviated commit. */
  readonly label: string
}

/** Thrown when a patch, a file list, or a file exceeds `maxDiffBytes`. */
export class DiffTooLarge extends Error {
  override name = 'DiffTooLarge'
}

/** Thrown when filter configuration cannot be read completely; no comparison has run. */
export class FilterConfigError extends Error {
  override name = 'FilterConfigError'
}

/** Thrown for the `branch` scope of a checkout without a fork point. */
export class NoForkPoint extends Error {
  override name = 'NoForkPoint'
}

/** No executable diff helpers or submodule working-tree inspection; preserve recorded submodule commit changes. */
const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=dirty', '--no-color', '-M', '--src-prefix=a/', '--dst-prefix=b/'] as const

/** Disable enumerated clean/process filters for one diff without modifying Git configuration. */
async function diffFilterOverrides(git: Git): Promise<Readonly<Record<string, string>>> {
  let configured: GitOutput
  try {
    configured = await git('filters', ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], [0, 1])
  } catch (error) {
    throw new FilterConfigError('Cannot read complete Git filter configuration; comparison was not run', { cause: error })
  }
  const overrides: Record<string, string> = {}
  for (const key of configured.stdout.split('\0')) {
    if (!key.endsWith('.clean') && !key.endsWith('.process')) continue
    const driver = key.slice(0, key.lastIndexOf('.'))
    overrides[`${driver}.clean`] = ''
    overrides[`${driver}.process`] = ''
    overrides[`${driver}.required`] = 'false'
  }
  return overrides
}

/** Characters Git inspects for a NUL character before it calls content binary. */
const BINARY_PROBE = 8000

/**
 * Find where the `branch` scope forks: the base commit of the worktree the
 * Session created while the checkout is that worktree, else the merge base of
 * HEAD with the default branch of the first remote that names one, in the
 * order the panel recognizes code hosts.
 * @param git - runner bound to the checkout.
 * @param inspection - the checkout and its remotes.
 * @param created - worktree the Session created, or null.
 * @returns the fork point, or null when no remote names a default branch or HEAD shares no history with it.
 */
export async function forkPoint(git: Git, inspection: Inspection, created: ForgeSessionWorktree | null): Promise<ForkPoint | null> {
  if (created !== null && created.path === inspection.checkout.root) {
    return { commit: created.baseCommit, label: created.from ?? created.baseCommit.slice(0, 7) }
  }
  for (const remote of remoteOrder(inspection.upstream, inspection.remotes)) {
    const head = await git('remote-head', ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote.name}/HEAD`], [0, 1, 128])
    const base = head.exitCode === 0 ? parseName(head.stdout) : null
    if (base === null) continue
    const merge = await git('merge-base', ['merge-base', 'HEAD', base], [0, 1, 128])
    const commit = merge.exitCode === 0 ? parseName(merge.stdout) : null
    return commit === null ? null : { commit, label: base }
  }
  return null
}

/**
 * Read changes at `root` with command-local clean/process filter overrides and without
 * submodule working-tree inspection. Git's built-in newline, ident, and encoding conversions still apply.
 * @param ctx - context that provides `fs`, `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - Git and size limits.
 * @param session - Session whose sandbox policy and execution world apply.
 * @param root - top-level directory of the checkout.
 * @param fork - fork point of the `branch` scope, or null without one.
 * @param scope - which changes to read.
 * @param signal - cancellation of every command and read.
 * @returns tracked files in Git's order, then untracked files unless the scope is `staged`.
 * @throws NoForkPoint for the `branch` scope without `fork`; FilterConfigError when filter configuration
 * cannot be read within `maxDiffBytes`; DiffTooLarge for oversized comparison output; an Error when Git fails.
 */
export async function localDiff(
  ctx: Context,
  config: DiffConfig,
  session: Session,
  root: string,
  fork: ForkPoint | null,
  scope: ForgeLocalScope,
  signal: AbortSignal,
): Promise<ForgeLocalDiff> {
  const git = gitIn(ctx, { ...config, maxOutputBytes: config.maxDiffBytes }, session, root, signal)
  let range: readonly string[]
  switch (scope.kind) {
    case 'branch':
      if (fork === null) throw new NoForkPoint('The checkout has no fork point to compare its branch with')
      range = [fork.commit]
      break
    case 'uncommitted': range = [await headOrEmptyTree(git)]; break
    case 'unstaged': range = []; break
    case 'staged': range = ['--cached', await headOrEmptyTree(git)]; break
    /* v8 ignore next -- closed ForgeLocalScope union exhaustiveness guard */
    default: return assertNever(scope, 'ForgeLocalScope.kind')
  }
  const overrides = await diffFilterOverrides(git)
  const tracked = parseDiff((await bounded(git('diff', [...DIFF, ...range, '--'], undefined, overrides))).stdout)
  if (scope.kind === 'staged') return { base: null, files: tracked, omitted: 0 }
  const untracked = await untrackedFiles(ctx, config, git, root, signal)
  return { base: fork === null || scope.kind !== 'branch' ? null : fork.label, files: [...tracked, ...untracked.files], omitted: untracked.omitted }
}

/**
 * Read the new side of one file in a scope, which supplies the unchanged
 * lines between hunks: the index for `staged`, else the working tree.
 * @param ctx - context that provides `fs`, `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - Git and size limits.
 * @param session - Session whose sandbox policy and execution world apply.
 * @param root - top-level directory of the checkout.
 * @param scope - the scope whose new side to read.
 * @param path - path relative to `root`, as the diff names it.
 * @param signal - cancellation.
 * @returns the text.
 * @throws DiffTooLarge over `maxDiffBytes`; an Error for a path outside the checkout, binary content, or a failed read.
 */
export async function localText(
  ctx: Context,
  config: DiffConfig,
  session: Session,
  root: string,
  scope: ForgeLocalScope,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  if (!insideCheckout(path)) throw new Error(`forge-panel: ${JSON.stringify(path)} is not a path inside the checkout`)
  let text: string | undefined
  if (scope.kind === 'staged') {
    const git = gitIn(ctx, { ...config, maxOutputBytes: config.maxDiffBytes }, session, root, signal)
    const shown = (await bounded(git('show', ['show', `:${path}`]))).stdout
    text = shown.slice(0, BINARY_PROBE).includes('\0') ? undefined : shown
  } else {
    text = decodeText(await readFile(ctx, config, root, path, signal))
  }
  if (text === undefined) throw new Error(`forge-panel: ${path} is binary`)
  return text
}

/**
 * Measure the `branch` scope for the panel's card.
 * @param ctx - context that provides `fs`, `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - Git and size limits.
 * @param session - Session whose sandbox policy and execution world apply.
 * @param inspection - the checkout and its remotes.
 * @param created - worktree the Session created, or null.
 * @param signal - cancellation of every command and read.
 * @returns the base and the changed files, or null without a fork point.
 * @throws FilterConfigError when filter configuration cannot be read within `maxOutputBytes`;
 * DiffTooLarge when the untracked file list exceeds `maxDiffBytes`; an Error when Git fails.
 */
export async function localChanges(
  ctx: Context,
  config: DiffConfig,
  session: Session,
  inspection: Inspection,
  created: ForgeSessionWorktree | null,
  signal: AbortSignal,
): Promise<ForgeLocalChanges | null> {
  const root = inspection.checkout.root
  const git = gitIn(ctx, config, session, root, signal)
  const fork = await forkPoint(git, inspection, created)
  if (fork === null) return null
  const overrides = await diffFilterOverrides(git)
  const numstat = await git('numstat', [...DIFF, '--numstat', '-z', fork.commit, '--'], undefined, overrides)
  const listing = gitIn(ctx, { ...config, maxOutputBytes: config.maxDiffBytes }, session, root, signal)
  const untracked = await untrackedFiles(ctx, config, listing, root, signal)
  return {
    base: fork.label,
    files: [
      ...parseNumstat(numstat.stdout),
      ...untracked.files.map(file => ({ path: file.path, additions: file.additions, deletions: 0, binary: file.binary })),
    ],
  }
}

/**
 * Count the commits the checkout has beyond a change request's head, which a
 * change request diff does not show yet.
 * @param git - runner bound to the Session's directory.
 * @param branch - the change request's head branch.
 * @param commit - the change request's head commit.
 * @returns the count, or null on another branch, outside a checkout, or without the commit locally.
 */
export async function aheadOf(git: Git, branch: string, commit: string): Promise<number | null> {
  const head = await git('symbolic-ref', ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1, 128])
  if (head.exitCode !== 0 || parseName(head.stdout) !== branch) return null
  const present = await git('cat-file', ['cat-file', '-e', `${commit}^{commit}`], [0, 1, 128])
  if (present.exitCode !== 0) return null
  return Number((await git('rev-list', ['rev-list', '--count', `${commit}..HEAD`])).stdout.trim())
}

/** HEAD, or the empty tree while the checked-out branch has no commit. */
async function headOrEmptyTree(git: Git): Promise<string> {
  const head = await git('head', ['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1])
  if (head.exitCode === 0) return 'HEAD'
  return (await git('empty-tree', ['hash-object', '-t', 'tree', '--stdin'])).stdout.trim()
}

/** Untracked files Git does not ignore, at most `maxUntrackedFiles`; a nested repository and a file gone since the listing are left out. */
async function untrackedFiles(
  ctx: Context,
  config: DiffConfig,
  git: Git,
  root: string,
  signal: AbortSignal,
): Promise<{ readonly files: ForgeDiffFile[]; readonly omitted: number }> {
  const listed = await bounded(git('untracked', ['ls-files', '--others', '--exclude-standard', '-z']))
  const paths = listed.stdout.split('\0').filter(path => path.length > 0 && !path.endsWith('/'))
  const files: ForgeDiffFile[] = []
  for (const path of paths.slice(0, config.maxUntrackedFiles)) {
    let content: Uint8Array
    try {
      content = await readFile(ctx, config, root, path, signal)
    } catch (error) {
      if (error instanceof DiffTooLarge) {
        files.push({ ...untrackedFile(path, new Uint8Array()), oversized: true })
        continue
      }
      if (error instanceof FsError) continue
      throw error
    }
    files.push(untrackedFile(path, content))
  }
  return { files, omitted: Math.max(0, paths.length - config.maxUntrackedFiles) }
}

/** Read one file of the checkout through `ctx.fs`, at most `maxDiffBytes`. */
async function readFile(ctx: Context, config: DiffConfig, root: string, path: string, signal: AbortSignal): Promise<Uint8Array> {
  const target = await ctx.fs.resolve(path, { cwd: root, signal })
  try {
    return await ctx.fs.readBytes(target, signal, config.maxDiffBytes)
  } catch (error) {
    if (error instanceof FsError && error.code === 'FS_TOO_LARGE') throw new DiffTooLarge(`${path} exceeds maxDiffBytes`, { cause: error })
    throw error
  }
}

/** Translate the runner's output limit into DiffTooLarge. */
async function bounded(output: Promise<GitOutput>): Promise<GitOutput> {
  try {
    return await output
  } catch (error) {
    if (error instanceof GitOutputTooLarge) throw new DiffTooLarge(error.message, { cause: error })
    throw error
  }
}

/** Whether a diff path stays inside the checkout: relative, without NUL, and without a `..` segment. */
function insideCheckout(path: string): boolean {
  if (path.length === 0 || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return path.split(/[/\\]/).every(segment => segment !== '..')
}
