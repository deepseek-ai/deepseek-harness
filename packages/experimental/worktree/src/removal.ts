/** Conservative inspection of a recorded worktree before its checkout is removed. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { RestoreWorktreeRequest } from './types.ts'

type GitRead = (directory: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>

/**
 * Verify checkout identity and account for every file Git might discard on removal.
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
  const { path, branch, repositoryRoot } = request
  const root = await ctx.fs.resolve(repositoryRoot, { signal })
  const pool = await ctx.fs.resolve(directory, { cwd: repositoryRoot, signal })
  const target = await ctx.fs.resolve(path, { cwd: repositoryRoot, signal })
  if (ctx.fs.processPath(root) !== repositoryRoot || ctx.fs.processPath(target) !== path
    || !ctx.fs.contains(root, pool) || !ctx.fs.contains(pool, target) || pool.targetKey === target.targetKey) return false
  if ((await ctx.fs.lstat(path, undefined, signal))?.type !== 'directory') return false
  const top = await run(repositoryRoot, ['rev-parse', '--show-toplevel'])
  const actualRoot = await ctx.fs.resolve(top.stdout.replace(/\r?\n$/, ''), { cwd: repositoryRoot, signal })
  if (actualRoot.targetKey !== root.targetKey) return false
  const registered = await run(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'])
  const entries = registered.stdout.split('\0\0').map(entry => entry.split('\0'))
  let fields: string[] | undefined
  for (const entry of entries.slice(1)) {
    const registeredPath = entry.find(field => field.startsWith('worktree '))?.slice('worktree '.length)
    if (registeredPath === undefined) continue
    const recorded = await ctx.fs.resolve(registeredPath, { cwd: repositoryRoot, signal })
    if (recorded.targetKey === target.targetKey) { fields = entry; break }
  }
  // The primary registration is excluded even when the configured pool contains it.
  if (fields === undefined || !fields.includes(`branch refs/heads/${branch}`)
    || fields.some(field => field === 'detached' || field.startsWith('locked') || field.startsWith('prunable'))) return false
  const head = await run(path, ['symbolic-ref', 'HEAD'])
  if (head.stdout.trim() !== `refs/heads/${branch}`) return false
  const status = await run(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'])
  if (status.stdout.length !== 0) return false
  // Git status deliberately hides skip-worktree and assume-unchanged files.
  const flags = await run(path, ['ls-files', '-v', '-z'])
  if (flags.stdout.split('\0').some(entry => entry.length > 0 && (entry[0] === 'S' || /^[a-z]/.test(entry)))) return false
  const index = await run(path, ['ls-files', '--stage', '-z'])
  if (index.stdout.split('\0').some(entry => entry.startsWith('160000 '))) return false
  return true
}
