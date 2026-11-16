import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { inspectRemoval, removeCheckout } from '../src/removal.ts'
import type { GitCommands, GitRead, GitScan } from '../src/removal.ts'
import type { RestoreWorktreeRequest } from '../src/types.ts'
import { git, harness, repository, testAgent } from './harness.ts'

/** A Git runner over the fixture's unconfined git, as the service's danger-full-access runner behaves. */
const run: GitRead = async (directory, args) => ({ stdout: await git(directory, ...args), exitCode: 0 })

/** Pass each NUL-terminated field of `text` to `onField` as the streaming runner does; true when it stopped early. */
function scanText(text: string, onField: (field: string) => boolean): boolean {
  return !text.split('\0').slice(0, -1).every(field => onField(field))
}

/** A streaming runner over the same git; it reads the output whole, then passes its fields in order. */
const scan: GitScan = async (directory, args, onField) => scanText(await git(directory, ...args), onField)

const commands: GitCommands = { read: run, scan }

/** The inspection-and-removal step archive cleanup runs, with the pool the harness configures. */
function remove(ctx: Context, _agent: Agent, request: RestoreWorktreeRequest, admit: () => boolean = () => true): Promise<boolean> {
  return removeCheckout(ctx, '.agents/worktrees', request, commands, new AbortController().signal, admit)
}

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
  it('removes a clean checkout, preserves local commits and restores the retained branch', { timeout: 15_000 }, async () => {
    const { ctx, agent, worktree, root } = await fixture()
    await writeFile(join(worktree.path, 'local.txt'), 'not pushed\n')
    await git(worktree.path, 'add', 'local.txt')
    await git(worktree.path, 'commit', '-m', 'local commit')
    const head = await git(worktree.path, 'rev-parse', 'HEAD')
    expect(await remove(ctx, agent, worktree, () => false)).toBe(false)
    await access(worktree.path)
    expect(await remove(ctx, agent, worktree)).toBe(true)
    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'rev-parse', worktree.branch)).toBe(head)
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain(worktree.path)
    expect(await ctx.worktrees.restore(agent, worktree)).toEqual({ path: worktree.path, branchRecreated: false })
    expect(await git(worktree.path, 'rev-parse', 'HEAD')).toBe(head)
  })

  it.each(['modified', 'staged', 'untracked'] as const)(
    'retains %s files', async (kind) => {
      const { ctx, agent, worktree } = await fixture()
      if (kind === 'untracked') await writeFile(join(worktree.path, 'new.txt'), 'keep')
      else {
        await writeFile(join(worktree.path, 'tracked.txt'), 'keep\n')
        if (kind === 'staged') await git(worktree.path, 'add', 'tracked.txt')
      }
      expect(await remove(ctx, agent, worktree)).toBe(false)
      await access(worktree.path)
    },
  )

  it.each(['assume-unchanged', 'skip-worktree'] as const)(
    'removes a checkout whose only edits are to %s files, which git status hides', async (flag) => {
      const { ctx, agent, worktree } = await fixture()
      await writeFile(join(worktree.path, 'tracked.txt'), 'hidden edit\n')
      await git(worktree.path, 'update-index', `--${flag}`, 'tracked.txt')
      expect(await git(worktree.path, 'status', '--porcelain')).toBe('')
      expect(await remove(ctx, agent, worktree)).toBe(true)
      await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('retains a checkout holding a submodule repository, which Git refuses to remove', async () => {
    const { ctx, agent, worktree, root } = await fixture()
    const source = await repository()
    disposers.push(() => rm(source, { recursive: true, force: true }))
    await git(worktree.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'nested')
    await git(worktree.path, 'commit', '-m', 'submodule')
    expect(await git(worktree.path, 'status', '--porcelain')).toBe('')
    expect(await remove(ctx, agent, worktree)).toBe(false)
    await access(join(worktree.path, 'nested', 'tracked.txt'))
    await expect(git(root, 'worktree', 'remove', worktree.path)).rejects.toThrow('working trees containing submodules cannot be moved or removed')
  })

  it('removes a checkout whose submodule was never initialized there, as Git does', async () => {
    const root = await repository()
    disposers.push(() => rm(root, { recursive: true, force: true }))
    const source = await repository()
    disposers.push(() => rm(source, { recursive: true, force: true }))
    await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'nested')
    await git(root, 'commit', '-m', 'submodule')
    const ctx = await harness(root)
    disposers.push(() => ctx.fiber.dispose())
    const agent = testAgent(ctx, root)
    const worktree = await ctx.worktrees.create(agent, { name: 'archive-me' })
    expect(await git(worktree.path, 'ls-files', '--stage', 'nested')).toMatch(/^160000 /)
    expect(await remove(ctx, agent, worktree)).toBe(true)
    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves a committed embedded repository to Git, which refuses the removal', async () => {
    const { ctx, agent, worktree } = await fixture()
    const source = await repository()
    disposers.push(() => rm(source, { recursive: true, force: true }))
    await git(worktree.path, 'clone', source, 'nested')
    await git(worktree.path, 'add', '-A')
    await git(worktree.path, 'commit', '-m', 'embedded repository')
    expect(await git(worktree.path, 'status', '--porcelain')).toBe('')
    await expect(remove(ctx, agent, worktree)).rejects.toThrow('working trees containing submodules cannot be moved or removed')
    await access(join(worktree.path, 'nested', 'tracked.txt'))
  })

  it('removes a checkout that holds only ignored files, as Git does without force', async () => {
    const { ctx, agent, worktree } = await fixture()
    await git(worktree.path, 'config', 'core.excludesFile', join(worktree.repositoryRoot, 'exclude'))
    await writeFile(join(worktree.repositoryRoot, 'exclude'), '.env\nnode_modules/\n')
    await writeFile(join(worktree.path, '.env'), 'private fixture')
    await mkdir(join(worktree.path, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(worktree.path, 'node_modules', 'dep', 'index.js'), 'module.exports = 1')
    expect(await remove(ctx, agent, worktree)).toBe(true)
    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(worktree.repositoryRoot, 'rev-parse', worktree.branch)).toBe(worktree.baseCommit)
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
      expect(await remove(ctx, agent, request)).toBe(false)
      expect(await git(root, 'rev-parse', worktree.branch)).toBe(worktree.baseCommit)
    },
  )

  it.each(['repository identity', 'registration', 'checked-out branch'] as const)(
    'retains a checkout when the %s changes during inspection', async (changed) => {
      const { ctx, worktree, root } = await fixture()
      const read = vi.fn(async (directory: string, args: string[]) => {
        if (changed === 'repository identity' && args[0] === 'rev-parse') return { stdout: worktree.path, exitCode: 0 }
        if (changed === 'checked-out branch' && args[0] === 'symbolic-ref') return { stdout: 'refs/heads/other', exitCode: 0 }
        return { stdout: await git(directory, ...args), exitCode: 0 }
      })
      const listed: GitScan = async (directory, args, onField) => changed === 'registration' && args[0] === 'worktree'
        ? scanText(`worktree ${root}\0branch refs/heads/main\0\0`, onField)
        : await scan(directory, args, onField)
      expect(await inspectRemoval(ctx, '.agents/worktrees', worktree, { read, scan: listed }, new AbortController().signal)).toBe(false)
      await access(worktree.path)
    },
  )


  it('restores over the identity checks removal shares, rejecting a target outside the pool', async () => {
    const { ctx, agent, worktree, root } = await fixture()
    await git(root, 'worktree', 'remove', worktree.path)
    await expect(ctx.worktrees.restore(agent, { ...worktree, path: join(root, 'outside-pool') })).rejects.toThrow('canonical directory inside the configured pool')
    expect(await ctx.worktrees.restore(agent, worktree)).toEqual({ path: worktree.path, branchRecreated: false })
  })

})
