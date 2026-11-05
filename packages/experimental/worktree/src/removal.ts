/** Identity validation shared by restoration and removal, and the conservative inspection before a checkout is removed. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { RestoreWorktreeRequest } from './types.ts'

/** Runs one Git command in the owner's confinement and reports its output. */
export type GitRead = (directory: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>

/** Resolved canonical locations of a recorded checkout that validation confirmed. */
export interface CheckoutIdentity {
  readonly root: Awaited<ReturnType<Context['fs']['resolve']>>
  readonly target: Awaited<ReturnType<Context['fs']['resolve']>>
}

/**
 * Confirm that a recorded checkout names a canonical directory inside the
 * configured pool of the source checkout it claims, and that the source is
 * still that repository's top level.
 * @param ctx - execution-world filesystem provider.
 * @param directory - configured relative worktree pool.
 * @param request - saved checkout identity.
 * @param run - bounded Git runner with the owner's policy.
 * @param signal - cancellation of the lookups.
 * @returns the resolved root and target, or null when any identity check fails.
 */
export async function checkoutIdentity(
  ctx: Context, directory: string, request: RestoreWorktreeRequest, run: GitRead, signal: AbortSignal,
): Promise<CheckoutIdentity | null> {
  const { path, repositoryRoot } = request
  const root = await ctx.fs.resolve(repositoryRoot, { signal })
  const pool = await ctx.fs.resolve(directory, { cwd: repositoryRoot, signal })
  const target = await ctx.fs.resolve(path, { cwd: repositoryRoot, signal })
  if (ctx.fs.processPath(root) !== repositoryRoot || ctx.fs.processPath(target) !== path
    || !ctx.fs.contains(root, pool) || !ctx.fs.contains(pool, target) || pool.targetKey === target.targetKey) return null
  const top = await run(repositoryRoot, ['rev-parse', '--show-toplevel'])
  const actualRoot = await ctx.fs.resolve(top.stdout.replace(/\r?\n$/, ''), { cwd: repositoryRoot, signal })
  if (actualRoot.targetKey !== root.targetKey) return null
  return { root, target }
}

/**
 * Find the registration of `target` among the source repository's worktrees.
 * @param ctx - execution-world filesystem provider.
 * @param request - saved checkout identity.
 * @param target - resolved checkout directory.
 * @param run - bounded Git runner with the owner's policy.
 * @param signal - cancellation of the lookups.
 * @returns the porcelain fields of the matching entry, or undefined when none is registered.
 */
export async function registration(
  ctx: Context, request: RestoreWorktreeRequest, target: CheckoutIdentity['target'], run: GitRead, signal: AbortSignal,
): Promise<readonly string[] | undefined> {
  const registered = await run(request.repositoryRoot, ['worktree', 'list', '--porcelain', '-z'])
  for (const entry of registered.stdout.split('\0\0').map(entry => entry.split('\0'))) {
    const registeredPath = entry.find(field => field.startsWith('worktree '))?.slice('worktree '.length)
    if (registeredPath === undefined) continue
    const recorded = await ctx.fs.resolve(registeredPath, { cwd: request.repositoryRoot, signal })
    if (recorded.targetKey === target.targetKey) return entry
  }
  return undefined
}

/**
 * Inspect the checkout and, when eligible and still admitted after inspection,
 * remove it and its registration with a non-force `git worktree remove`. The
 * branch is never deleted; a rejection can leave a partial directory.
 * @param ctx - execution-world filesystem provider.
 * @param directory - configured relative worktree pool.
 * @param request - saved checkout identity.
 * @param run - bounded Git runner with the owner's policy.
 * @param signal - cancellation before or during removal.
 * @param admit - synchronous final admission after inspection; false retains the checkout.
 * @returns true when removed; false when inspection or admission retains it; Git failures reject.
 */
export async function removeCheckout(
  ctx: Context, directory: string, request: RestoreWorktreeRequest, run: GitRead, signal: AbortSignal, admit: () => boolean,
): Promise<boolean> {
  if (!await inspectRemoval(ctx, directory, request, run, signal)) return false
  signal.throwIfAborted()
  if (!admit()) return false
  await run(request.repositoryRoot, ['worktree', 'remove', '--', request.path])
  return true
}

/**
 * Verify checkout identity and account for every file that Git's non-force
 * removal would refuse: tracked changes, untracked files, hidden index flags,
 * and submodules. Ignored files are not counted; `git worktree remove` discards them.
 * @param ctx - execution-world filesystem provider.
 * @param directory - configured relative worktree pool.
 * @param request - saved checkout identity.
 * @param run - bounded Git runner with the owner's policy.
 * @param signal - cancellation of inspection.
 * @returns false for an ineligible checkout; inspection failures reject.
 */
export async function inspectRemoval(
  ctx: Context, directory: string, request: RestoreWorktreeRequest, run: GitRead, signal: AbortSignal,
): Promise<boolean> {
  const { path, branch } = request
  const identity = await checkoutIdentity(ctx, directory, request, run, signal)
  if (identity === null) return false
  if ((await ctx.fs.lstat(path, undefined, signal))?.type !== 'directory') return false
  const fields = await registration(ctx, request, identity.target, run, signal)
  // The primary registration is excluded even when the configured pool contains it.
  if (fields === undefined || !fields.includes(`branch refs/heads/${branch}`)
    || fields.some(field => field === 'detached' || field.startsWith('locked') || field.startsWith('prunable'))) return false
  const head = await run(path, ['symbolic-ref', 'HEAD'])
  if (head.stdout.trim() !== `refs/heads/${branch}`) return false
  const status = await run(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])
  if (status.stdout.length !== 0) return false
  // Git status deliberately hides skip-worktree and assume-unchanged files.
  const flags = await run(path, ['ls-files', '-v', '-z'])
  if (flags.stdout.split('\0').some(entry => entry.length > 0 && (entry[0] === 'S' || /^[a-z]/.test(entry)))) return false
  const index = await run(path, ['ls-files', '--stage', '-z'])
  if (index.stdout.split('\0').some(entry => entry.startsWith('160000 '))) return false
  return true
}
