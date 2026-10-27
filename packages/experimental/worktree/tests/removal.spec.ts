import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectRemoval } from '../src/removal.ts'
import { git, harness, repository, testAgent } from './harness.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function fixture() {
  const root = await repository()
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const ctx = await harness(root)
  disposers.push(() => ctx.fiber.dispose())
  const agent = testAgent(ctx, root)
  const worktree = await ctx.worktrees.create(agent, { name: 'archive-me' })
  return { ctx, agent, worktree, root }
}

describe('safe worktree removal', () => {
  it('removes a clean checkout, preserves local commits and restores the retained branch', async () => {
    const { ctx, agent, worktree, root } = await fixture()
    await writeFile(join(worktree.path, 'local.txt'), 'not pushed\n')
    await git(worktree.path, 'add', 'local.txt')
    await git(worktree.path, 'commit', '-m', 'local commit')
    const head = await git(worktree.path, 'rev-parse', 'HEAD')
    expect(await ctx.worktrees.canRemove(ctx.sandboxPolicy.resolve({ session: agent.session }), worktree)).toBe(true)
    expect(await ctx.worktrees.remove(ctx.sandboxPolicy.resolve({ session: agent.session }), worktree)).toBe(true)
    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'rev-parse', worktree.branch)).toBe(head)
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain(worktree.path)
    expect(await ctx.worktrees.restore(agent, worktree)).toEqual({ path: worktree.path, branchRecreated: false })
    expect(await git(worktree.path, 'rev-parse', 'HEAD')).toBe(head)
  })

  it.each(['modified', 'staged', 'untracked', 'ignored', 'assume-unchanged', 'skip-worktree'] as const)(
    'retains %s files', async (kind) => {
      const { ctx, agent, worktree } = await fixture()
      const tracked = join(worktree.path, 'tracked.txt')
      if (kind === 'untracked') await writeFile(join(worktree.path, 'new.txt'), 'keep')
      else if (kind === 'ignored') {
        await git(worktree.path, 'config', 'core.excludesFile', join(worktree.repositoryRoot, 'exclude'))
        await writeFile(join(worktree.repositoryRoot, 'exclude'), '.env\n')
        await writeFile(join(worktree.path, '.env'), 'private fixture')
      } else {
        await writeFile(tracked, 'keep\n')
        if (kind === 'staged') await git(worktree.path, 'add', 'tracked.txt')
        if (kind === 'assume-unchanged' || kind === 'skip-worktree') await git(worktree.path, 'update-index', `--${kind}`, 'tracked.txt')
      }
      expect(await ctx.worktrees.remove(ctx.sandboxPolicy.resolve({ session: agent.session }), worktree)).toBe(false)
      await access(worktree.path)
    },
  )

  it('rechecks after an eligible inspection', async () => {
    const { ctx, agent, worktree } = await fixture()
    expect(await ctx.worktrees.canRemove(ctx.sandboxPolicy.resolve({ session: agent.session }), worktree)).toBe(true)
    await writeFile(join(worktree.path, 'new.txt'), 'keep')
    expect(await ctx.worktrees.remove(ctx.sandboxPolicy.resolve({ session: agent.session }), worktree)).toBe(false)
    await access(worktree.path)
  })

  it.each(['locked', 'detached', 'branch-mismatch', 'outside-pool', 'missing', 'nested-repository'] as const)(
    'retains a %s checkout', async (kind) => {
      const { ctx, agent, worktree, root } = await fixture()
      let request = worktree
      if (kind === 'locked') await git(root, 'worktree', 'lock', worktree.path)
      if (kind === 'detached') await git(worktree.path, 'checkout', '--detach')
      if (kind === 'branch-mismatch') await git(worktree.path, 'checkout', '-b', 'other-branch')
      if (kind === 'outside-pool') request = { ...worktree, path: root }
      if (kind === 'missing') await git(root, 'worktree', 'remove', worktree.path)
      if (kind === 'nested-repository') {
        const nested = join(worktree.path, 'nested')
        await mkdir(nested)
        await git(nested, 'init')
      }
      expect(await ctx.worktrees.remove(ctx.sandboxPolicy.resolve({ session: agent.session }), request)).toBe(false)
      expect(await git(root, 'rev-parse', worktree.branch)).toBe(worktree.baseCommit)
    },
  )

  it.each(['repository identity', 'registration', 'checked-out branch', 'submodule'] as const)(
    'retains a checkout when the %s changes during inspection', async (changed) => {
      const { ctx, worktree, root } = await fixture()
      const run = vi.fn(async (directory: string, args: string[]) => {
        if (changed === 'repository identity' && args[0] === 'rev-parse') return { stdout: worktree.path, exitCode: 0 }
        if (changed === 'registration' && args[0] === 'worktree') return { stdout: `worktree ${root}\0branch refs/heads/main\0\0\0`, exitCode: 0 }
        if (changed === 'checked-out branch' && args[0] === 'symbolic-ref') return { stdout: 'refs/heads/other', exitCode: 0 }
        if (changed === 'submodule' && args.includes('--stage')) return { stdout: `160000 ${worktree.baseCommit} 0\tsubmodule\0`, exitCode: 0 }
        return { stdout: await git(directory, ...args), exitCode: 0 }
      })
      expect(await inspectRemoval(ctx, '.agents/worktrees', worktree, run, new AbortController().signal)).toBe(false)
      await access(worktree.path)
    },
  )


  it('serializes a restore requested while the same checkout is being removed', async () => {
    const { ctx, agent, worktree } = await fixture()
    const removing = ctx.worktrees.remove(ctx.sandboxPolicy.resolve({ session: agent.session }), worktree)
    const restoring = ctx.worktrees.restore(agent, worktree)
    expect(await removing).toBe(true)
    expect(await restoring).toEqual({ path: worktree.path, branchRecreated: false })
    expect(await git(worktree.path, 'rev-parse', 'HEAD')).toBe(worktree.baseCommit)
  })

})
