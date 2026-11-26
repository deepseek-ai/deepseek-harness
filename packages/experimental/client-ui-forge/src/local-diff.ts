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
import { rangeStart } from './commit-range.ts'
import { decodeText, oversizedUntrackedFile, parseDiff, parseNumstat, untrackedFile } from './diff.ts'
import type { ParsedDiffFile } from './diff.ts'
import { gitIn, GitOutputTooLarge } from './git.ts'
import type { Git, GitConfig, GitOutput, Inspection } from './git.ts'
import { ATTRIBUTES_PATH } from './layers.ts'
import type { FileLayers } from './layers.ts'
import { branchLabel } from './branch-name.ts'
import { BASE_REF_PREFIXES, parseBaseBranches, parseName, parseWorktrees, remoteOrder } from './parse.ts'
import type {
  ForgeBaseBranches, ForgeCheckout, ForgeCommitRange, ForgeLocalChanges, ForgeLocalCommits, ForgeLocalDiff, ForgeLocalScope,
  ForgeSessionWorktree,
} from './types.ts'
import type { ForgeCommit } from '@deepseek-ai/dsh-experimental-forge/types'

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
  /** Branch such as `origin/master`, the created worktree's base branch, or an abbreviated commit. */
  readonly label: string
  /** Whether `commit` is the base commit of the worktree the Session created rather than a merge base. */
  readonly worktree: boolean
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

/** Thrown when the base branch chosen for the `branch` scope does not exist. */
export class BaseMissing extends Error {
  override name = 'BaseMissing'
}

/** Thrown when the branch a scope reads in place of the checked-out one does not exist. */
export class HeadMissing extends Error {
  override name = 'HeadMissing'
}

/** Thrown when chosen commits are not among the commits of the `branch` scope, or are out of order. */
export class CommitsMissing extends Error {
  override name = 'CommitsMissing'
}

/** Thrown when chosen commits of the `branch` scope are not a run in which each commit's first parent is the one before it. */
export class CommitsNotLinear extends Error {
  override name = 'CommitsNotLinear'
}

/** A full SHA-1 or SHA-256 object name, the only form of a chosen commit Git receives. */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** One commit per record: object name, first parent, author, author date, and subject, separated by NUL. */
const LOG_FORMAT = '--format=%H%x00%P%x00%an%x00%aI%x00%s%x1e'

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
 * The Session's own HEAD, which a branch shown in place of the Session's checkout is compared with while no base
 * branch is chosen: a reader of another branch asks what it changed since it left the Session's work.
 */
export interface SessionHead {
  /** Full object name of the commit the Session's HEAD names. */
  readonly commit: string
  /** Name the panel shows for it: the checked-out branch, or the abbreviated commit of a detached HEAD. */
  readonly label: string
  /** Full ref of the checked-out branch, which the automatic base stands for in a base listing; null when HEAD is detached. */
  readonly ref: string | null
}

/**
 * Read the Session's own HEAD.
 * @param git - runner bound to the Session's checkout.
 * @param checkout - that checkout.
 * @returns the commit and its name, or null while the checked-out branch has no commit.
 * @throws an Error when Git fails.
 */
export async function sessionHead(git: Git, checkout: ForgeCheckout): Promise<SessionHead | null> {
  const head = await git('session-head', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], [0, 1])
  const commit = head.exitCode === 0 ? parseName(head.stdout) : null
  if (commit === null) return null
  return checkout.branch === null ? { commit, label: commit.slice(0, 7), ref: null }
    : { commit, label: checkout.branch, ref: `${BASE_REF_PREFIXES[0]}${checkout.branch}` }
}

/**
 * Find where the `branch` scope forks while no base branch is chosen. For a branch shown in place of the Session's
 * checkout: the merge base of the tip with the Session's own HEAD. For the Session's checkout: the base commit of the
 * worktree the Session created while the checkout is that worktree, else the merge base of HEAD with the default
 * branch of the first remote that names one, in the order the panel recognizes code hosts.
 * @param git - runner bound to the checkout.
 * @param inspection - the checkout and its remotes.
 * @param created - worktree the checkout's Session created, or null.
 * @param tip - revision the scope shows: HEAD for the checkout, or a branch ref, which no created worktree applies to.
 * @param against - the Session's own HEAD while the scope shows another branch, or null for the Session's checkout.
 * @returns the fork point, or null when the tip shares no history with what it is compared with, or no remote names
 * a default branch for the Session's checkout.
 */
export async function forkPoint(
  git: Git, inspection: Inspection, created: ForgeSessionWorktree | null, tip = 'HEAD', against: SessionHead | null = null,
): Promise<ForkPoint | null> {
  if (against !== null) return await mergeBase(git, tip, against.commit, against.label)
  if (tip === 'HEAD' && created !== null && created.path === inspection.checkout.root) {
    const label = created.from === null ? created.baseCommit.slice(0, 7) : branchLabel(created.from)
    return { commit: created.baseCommit, label, worktree: true }
  }
  for (const remote of remoteOrder(inspection.upstream, inspection.remotes)) {
    const head = await git('remote-head', ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote.name}/HEAD`], [0, 1, 128])
    const base = head.exitCode === 0 ? parseName(head.stdout) : null
    if (base === null) continue
    return await mergeBase(git, tip, base, base)
  }
  return null
}

/** The merge base of the tip with a revision, under the name the panel shows for that revision; null without shared history. */
async function mergeBase(git: Git, tip: string, revision: string, label: string): Promise<ForkPoint | null> {
  const merge = await git('merge-base', ['merge-base', tip, revision], [0, 1, 128])
  const commit = merge.exitCode === 0 ? parseName(merge.stdout) : null
  return commit === null ? null : { commit, label, worktree: false }
}

/**
 * Find where the `branch` scope forks from a chosen base branch: the merge base of the tip with it.
 * @param git - runner bound to the checkout.
 * @param ref - full ref name under `refs/heads/` or `refs/remotes/`.
 * @param tip - revision the scope shows: HEAD for the checkout, or a branch ref.
 * @returns the fork point, or null when the tip shares no history with the branch or has no commit.
 * @throws BaseMissing when the ref does not exist; an Error for another ref name or when Git fails.
 */
export async function chosenForkPoint(git: Git, ref: string, tip = 'HEAD'): Promise<ForkPoint | null> {
  const { name, present } = await branchOf(git, ref)
  if (!present) throw new BaseMissing(`The base branch ${name} does not exist`)
  return await mergeBase(git, tip, ref, name)
}

/**
 * Check the branch a scope shows in place of the checkout.
 * @param git - runner bound to a checkout of the repository.
 * @param ref - full ref name under `refs/heads/` or `refs/remotes/`.
 * @returns the ref, which Git may receive as a revision.
 * @throws HeadMissing when the ref does not exist; an Error for another ref name or when Git fails.
 */
export async function branchTip(git: Git, ref: string): Promise<string> {
  const { name, present } = await branchOf(git, ref)
  if (!present) throw new HeadMissing(`The branch ${name} does not exist`)
  return ref
}

/** The name of a branch ref and whether the ref exists; another ref name is refused before Git reads it. */
async function branchOf(git: Git, ref: string): Promise<{ readonly name: string; readonly present: boolean }> {
  const prefix = BASE_REF_PREFIXES.find(candidate => ref.startsWith(candidate) && ref.length > candidate.length)
  if (prefix === undefined) throw new Error(`forge-panel: ${JSON.stringify(ref)} is not a branch ref`)
  // `--verify` accepts only an exact ref path, so revision syntax such as `@{1}` never resolves.
  const present = await git('show-ref', ['show-ref', '--verify', '--quiet', ref], [0, 1])
  return { name: ref.slice(prefix.length), present: present.exitCode === 0 }
}

/**
 * List the branches the `branch` scope can compare with.
 * @param git - runner bound to the checkout.
 * @param inspection - the checkout and its remotes.
 * @param created - worktree the checkout's Session created, or null.
 * @param query - text the branch names must contain, ignoring case; empty for every branch.
 * @param limit - most branches in each group.
 * @param tip - revision the scope shows: HEAD for the checkout, or a branch ref, which the listing leaves out.
 * @param against - the Session's own HEAD while the scope shows another branch, or null for the Session's checkout;
 * the listing leaves its branch out, because the automatic fork point already compares with it.
 * @returns the automatic fork point, then remote-tracking and local branches, most recently committed first; a local
 * branch that a worktree has checked out names the directory Git registered for it.
 * @throws an Error when Git fails or prints more than the runner's output limit.
 */
export async function baseBranches(
  git: Git,
  inspection: Inspection,
  created: ForgeSessionWorktree | null,
  query: string,
  limit: number,
  tip = 'HEAD',
  against: SessionHead | null = null,
): Promise<ForgeBaseBranches> {
  const fork = await forkPoint(git, inspection, created, tip, against)
  const refs = await git('base-branches', [
    'for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(symref)', ...BASE_REF_PREFIXES,
  ])
  const shown = tip !== 'HEAD' ? tip : inspection.checkout.branch === null ? null : `${BASE_REF_PREFIXES[0]}${inspection.checkout.branch}`
  const hidden = [shown, against === null ? null : against.ref].filter(ref => ref !== null)
  const { remote, local } = parseBaseBranches(refs.stdout, hidden, query, limit)
  const trees = await branchWorktrees(git)
  return {
    automatic: fork === null ? null : { name: fork.label, worktree: fork.worktree },
    remote,
    local: local.map((branch) => {
      const worktree = trees.get(branch.ref)
      return worktree === undefined ? branch : { ...branch, worktree }
    }),
  }
}

/**
 * Find the worktree of the repository that has each branch checked out.
 * @param git - runner bound to a checkout of the repository.
 * @returns the directory Git registered for each checked-out branch, by full ref name, without a worktree that Git
 * marks as gone and one without a branch. {@link parseWorktrees} says why a caller confirms the directory.
 * @throws an Error when Git fails or prints more than the runner's output limit.
 */
export async function branchWorktrees(git: Git): Promise<ReadonlyMap<string, string>> {
  return parseWorktrees((await git('worktrees', ['worktree', 'list', '--porcelain'])).stdout)
}

/**
 * Read changes at `root` with command-local clean/process filter overrides and without
 * submodule working-tree inspection. Git's built-in newline, ident, and encoding conversions still apply.
 * Each file's layer follows `layers` and the root `.gitattributes` of the new side: the index for `staged`,
 * else the working tree.
 * @param ctx - context that provides `fs`, `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - Git and size limits.
 * @param session - Session whose sandbox policy and execution world apply.
 * @param root - top-level directory of the checkout the scope reads: the Session's own, or the worktree of its `head`.
 * @param fork - fork point of the `branch` scope, or null without one.
 * @param scope - which changes to read; its `head` is already resolved into `root` and `tip`.
 * @param layers - classifier of each file's review layer.
 * @param signal - cancellation of every command and read.
 * @param tip - `HEAD` to read the checkout at `root` with its working tree, or a verified branch ref that the
 * `branch` scope reads from its commits alone.
 * @returns tracked files in Git's order, then untracked files unless the scope is `staged` or reads a branch's commits.
 * @throws NoForkPoint for the `branch` scope without `fork`; FilterConfigError when filter configuration
 * cannot be read within `maxDiffBytes`; DiffTooLarge for oversized comparison output or `.gitattributes`;
 * an Error when Git or the `.gitattributes` read fails.
 */
export async function localDiff(
  ctx: Context,
  config: DiffConfig,
  session: Session,
  root: string,
  fork: ForkPoint | null,
  scope: ForgeLocalScope,
  layers: FileLayers,
  signal: AbortSignal,
  tip = 'HEAD',
): Promise<ForgeLocalDiff> {
  const git = gitIn(ctx, { ...config, maxOutputBytes: config.maxDiffBytes }, session, root, signal)
  let range: readonly string[]
  switch (scope.kind) {
    case 'branch':
      if (fork === null) throw new NoForkPoint('The checkout has no fork point to compare its branch with')
      if (scope.commits !== null) return await commitsDiff(git, fork, scope.commits, layers, tip)
      if (tip !== 'HEAD') return await treeDiff(git, fork, fork.commit, tip, layers)
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
  if (scope.kind === 'staged') {
    const shown = await bounded(git('attributes', ['show', `:${ATTRIBUTES_PATH}`], [0, 128]))
    return { base: null, files: layers.classify(tracked, shown.exitCode === 0 ? shown.stdout : ''), omitted: 0 }
  }
  const untracked = await untrackedFiles(ctx, config, git, root, signal)
  let attributes = ''
  try {
    attributes = decodeText(await readFile(ctx, config, root, ATTRIBUTES_PATH, signal)) ?? ''
  } catch (error) {
    if (!(error instanceof FsError && error.code === 'FS_NOT_FOUND')) throw error
  }
  return {
    base: fork === null || scope.kind !== 'branch' ? null : fork.label,
    files: layers.classify([...tracked, ...untracked.files], attributes),
    omitted: untracked.omitted,
  }
}

/**
 * Read the new side of one file in a scope, which supplies the unchanged
 * lines between hunks: the index for `staged`, the last chosen commit for
 * chosen commits of the `branch` scope, the branch for a head read from its commits, else the working tree.
 * @param ctx - context that provides `fs`, `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - Git and size limits.
 * @param session - Session whose sandbox policy and execution world apply.
 * @param root - top-level directory of the checkout.
 * @param scope - the scope whose new side to read.
 * @param path - path relative to `root`, as the diff names it.
 * @param signal - cancellation.
 * @param tip - `HEAD` for the checkout at `root`, or a verified branch ref whose commits the `branch` scope reads.
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
  tip = 'HEAD',
): Promise<string> {
  if (!insideCheckout(path)) throw new Error(`forge-panel: ${JSON.stringify(path)} is not a path inside the checkout`)
  let text: string | undefined
  const chosen = scope.kind === 'branch' && scope.commits !== null ? scope.commits.to : undefined
  if (chosen !== undefined && !COMMIT.test(chosen)) throw new CommitsMissing('The chosen commit is not a full object name')
  const commit = scope.kind === 'staged' ? '' : chosen ?? (scope.kind === 'branch' && tip !== 'HEAD' ? tip : undefined)
  if (commit !== undefined) {
    const git = gitIn(ctx, { ...config, maxOutputBytes: config.maxDiffBytes }, session, root, signal)
    const shown = (await bounded(git('show', ['show', `${commit}:${path}`]))).stdout
    text = shown.slice(0, BINARY_PROBE).includes('\0') ? undefined : shown
  } else {
    text = decodeText(await readFile(ctx, config, root, path, signal))
  }
  if (text === undefined) throw new Error(`forge-panel: ${path} is binary`)
  return text
}

/**
 * Read the old side of one changed file in a scope: the fork point for the `branch` scope, the first parent of the
 * first chosen commit for chosen commits, the index for `unstaged`, else HEAD.
 * @param ctx - context that provides `subprocess`, `sandbox`, and `sandboxPolicy`.
 * @param config - Git and size limits.
 * @param session - Session whose sandbox policy and execution world apply.
 * @param root - top-level directory of the checkout.
 * @param scope - the scope whose old side to read.
 * @param fork - the `branch` scope's fork point, or null for other scopes.
 * @param path - path relative to `root` on the old side, as the diff names it.
 * @param signal - cancellation.
 * @returns the text, or null when the old side has no such file or holds binary content.
 * @throws NoForkPoint for the `branch` scope without `fork`; CommitsMissing for a chosen commit that is not a full
 * object name; DiffTooLarge over `maxDiffBytes`; an Error for a path outside the checkout or a failed read.
 */
export async function localOldText(
  ctx: Context,
  config: DiffConfig,
  session: Session,
  root: string,
  scope: ForgeLocalScope,
  fork: ForkPoint | null,
  path: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!insideCheckout(path)) throw new Error(`forge-panel: ${JSON.stringify(path)} is not a path inside the checkout`)
  let revision: string
  switch (scope.kind) {
    case 'branch':
      if (fork === null) throw new NoForkPoint('The checkout has no fork point to compare its branch with')
      if (scope.commits !== null && !COMMIT.test(scope.commits.from)) throw new CommitsMissing('The chosen commit is not a full object name')
      revision = scope.commits === null ? fork.commit : `${scope.commits.from}^`
      break
    case 'unstaged': revision = ''; break
    case 'uncommitted': case 'staged': revision = 'HEAD'; break
    /* v8 ignore next -- closed ForgeLocalScope union exhaustiveness guard */
    default: return assertNever(scope, 'ForgeLocalScope.kind')
  }
  const git = gitIn(ctx, { ...config, maxOutputBytes: config.maxDiffBytes }, session, root, signal)
  // Git exits with 128 for a path or revision that does not exist, such as the parent of a root commit.
  const shown = await bounded(git('show', ['show', `${revision}:${path}`], [0, 128]))
  if (shown.exitCode !== 0 || shown.stdout.slice(0, BINARY_PROBE).includes('\0')) return null
  return shown.stdout
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

/**
 * List the commits of the `branch` scope: those reachable from the tip but not from the fork point, parents before children.
 * @param git - runner bound to the checkout, whose output limit bounds the listing.
 * @param fork - fork point of the `branch` scope.
 * @param limit - most commits listed.
 * @param tip - revision the scope shows: HEAD for the checkout, or a branch ref.
 * @returns the newest `limit` commits, ending with the tip's commit, and the tip's commit.
 * @throws an Error when Git fails or prints more than the runner's output limit.
 */
export async function localCommits(git: Git, fork: ForkPoint, limit: number, tip = 'HEAD'): Promise<ForgeLocalCommits> {
  const head = (await git('head', ['rev-parse', '--verify', tip])).stdout.trim()
  const listed = await branchCommits(git, fork, tip, limit + 1)
  return { headSha: head, commits: listed.slice(-limit), truncated: listed.length > limit }
}

/**
 * Commits between the fork point and the tip, parents before children.
 * @param limit - when given, only the newest `limit` commits in topological order.
 */
async function branchCommits(git: Git, fork: ForkPoint, tip: string, limit?: number): Promise<ForgeCommit[]> {
  // A configured `log.showSignature` would print verification text before the fields and run the verifying program.
  const count = limit === undefined ? [] : [`--max-count=${String(limit)}`]
  const output = await git('log', ['log', '--no-show-signature', '--topo-order', '--reverse', ...count, LOG_FORMAT, `${fork.commit}..${tip}`, '--'])
  return output.stdout.split('\x1e').flatMap((record): ForgeCommit[] => {
    const fields = record.replace(/^\n/, '').split('\0')
    // The text after the last record holds no fields.
    if (fields.length !== 5) return []
    const [sha, parents, author, authoredAt, title] = fields as [string, string, string, string, string]
    return [{ sha, parent: /^\S+/.exec(parents)?.[0] ?? null, title, author, authoredAt }]
  })
}

/** The committed changes of consecutive commits of the `branch` scope, from the first commit's first parent to the last. */
async function commitsDiff(git: Git, fork: ForkPoint, chosen: ForgeCommitRange, layers: FileLayers, tip: string): Promise<ForgeLocalDiff> {
  if (!COMMIT.test(chosen.from) || !COMMIT.test(chosen.to)) throw new CommitsMissing('The chosen commits are not full object names')
  const start = rangeStart(await branchCommits(git, fork, tip), chosen)
  if (start === 'missing') throw new CommitsMissing('The chosen commits are no longer on the branch')
  if (start === 'not-linear') throw new CommitsNotLinear('The chosen commits are not one run of first parents')
  // A first commit without a parent starts an unrelated history that the tip merged; it adds every file.
  return await treeDiff(git, fork, start.parent ?? await emptyTree(git), chosen.to, layers)
}

/** The committed changes from one revision to another, with each file's layer read at the newer one. */
async function treeDiff(git: Git, fork: ForkPoint, from: string, to: string, layers: FileLayers): Promise<ForgeLocalDiff> {
  const overrides = await diffFilterOverrides(git)
  const files = parseDiff((await bounded(git('diff', [...DIFF, from, to, '--'], undefined, overrides))).stdout)
  const shown = await bounded(git('attributes', ['show', `${to}:${ATTRIBUTES_PATH}`], [0, 128]))
  return { base: fork.label, files: layers.classify(files, shown.exitCode === 0 ? shown.stdout : ''), omitted: 0 }
}

/** HEAD, or the empty tree while the checked-out branch has no commit. */
async function headOrEmptyTree(git: Git): Promise<string> {
  const head = await git('head', ['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1])
  return head.exitCode === 0 ? 'HEAD' : await emptyTree(git)
}

/** The object name of the empty tree. */
async function emptyTree(git: Git): Promise<string> {
  return (await git('empty-tree', ['hash-object', '-t', 'tree', '--stdin'])).stdout.trim()
}

/** Untracked files Git does not ignore, at most `maxUntrackedFiles`; a nested repository and a file gone since the listing are left out. */
async function untrackedFiles(
  ctx: Context,
  config: DiffConfig,
  git: Git,
  root: string,
  signal: AbortSignal,
): Promise<{ readonly files: ParsedDiffFile[]; readonly omitted: number }> {
  const listed = await bounded(git('untracked', ['ls-files', '--others', '--exclude-standard', '-z']))
  const paths = listed.stdout.split('\0').filter(path => path.length > 0 && !path.endsWith('/'))
  const files: ParsedDiffFile[] = []
  for (const path of paths.slice(0, config.maxUntrackedFiles)) {
    let content: Uint8Array
    try {
      content = await readFile(ctx, config, root, path, signal)
    } catch (error) {
      if (error instanceof DiffTooLarge) {
        files.push(oversizedUntrackedFile(path))
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

/**
 * Whether a diff path stays inside the checkout: relative, without NUL, and without a `..` segment.
 * @param path - path as a diff names it.
 * @returns whether Git and the filesystem may receive it relative to the checkout root.
 */
export function insideCheckout(path: string): boolean {
  if (path.length === 0 || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return path.split(/[/\\]/).every(segment => segment !== '..')
}
