import { existsSync } from 'node:fs'
import { access, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import WorktreeService from '../src/index.ts'
import type { RestoreWorktreeRequest } from '../src/index.ts'
import { contents, git, harness, repository, testAgent } from './harness.ts'

let ctx: Context | undefined
const roots: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function repo(): Promise<string> {
  const root = await repository()
  roots.push(root)
  return root
}

describe('creating and entering retained worktrees', () => {
  it('pins HEAD, preserves source edits and index, enters the new branch, and ignores its new pool', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const baseCommit = await git(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'tracked.txt'), 'staged\n')
    await git(root, 'add', 'tracked.txt')
    await writeFile(join(root, 'tracked.txt'), 'unstaged\n')
    await writeFile(join(root, 'untracked.txt'), 'local\n')
    const before = await git(root, 'status', '--porcelain')

    const result = await ctx.worktrees.create(agent, { name: 'topic' })
    expect(result).toEqual({ path: join(root, '.agents/worktrees/topic'), branch: 'topic', baseCommit, repositoryRoot: root })
    expect(ctx.workingDirectory.get(agent.session)).toBe(result.path)
    expect(await git(result.path, 'symbolic-ref', '--short', 'HEAD')).toBe('topic')
    expect(await contents(join(result.path, 'tracked.txt'))).toBe('initial\n')
    expect(await git(root, 'show', ':tracked.txt')).toBe('staged')
    expect(await contents(join(root, 'tracked.txt'))).toBe('unstaged\n')
    expect(await git(root, 'status', '--porcelain')).toBe(before)
    expect(await contents(join(root, '.agents/worktrees/.gitignore'))).toBe('*\n')
    expect(await git(root, 'check-ignore', '.agents/worktrees/.gitignore')).toBe('.agents/worktrees/.gitignore')

    await ctx.workingDirectory.set(agent, root)
    expect(await git(root, 'rev-parse', 'topic')).toBe(baseCommit)
    expect(await contents(join(result.path, 'tracked.txt'))).toBe('initial\n')
  })

  it('reports the prepare stage, then the checkout stage, before each begins', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const phases: string[] = []

    const result = await ctx.worktrees.create(agent, { name: 'staged' }, undefined, (phase) => {
      phases.push(`${phase}:${String(ctx?.workingDirectory.get(agent.session) === root)}`)
    })

    expect(phases).toEqual(['prepare:true', 'checkout:true'])
    expect(ctx.workingDirectory.get(agent.session)).toBe(result.path)
  })

  it('uses current cwd for repository discovery and accepts an annotated local tag', async () => {
    const original = await repo()
    const root = await repo()
    await mkdir(join(root, 'nested'))
    await git(root, 'tag', '-a', 'baseline', '-m', 'baseline')
    const baseCommit = await git(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'tracked.txt'), 'later\n')
    await git(root, 'commit', '-am', 'later')
    ctx = await harness(original)
    const agent = testAgent(ctx, original)
    await ctx.workingDirectory.set(agent, join(root, 'nested'))

    const result = await ctx.worktrees.create(agent, { name: 'topic/nested', from: 'baseline' })
    expect(result).toEqual({ path: join(root, '.agents/worktrees/topic/nested'), branch: 'topic/nested', baseCommit, repositoryRoot: root })
    expect(await contents(join(result.path, 'tracked.txt'))).toBe('initial\n')
    expect(await git(original, 'branch', '--list', 'topic/nested')).toBe('')
  })

  it('keeps existing pool files and honors configured location and generated-name prefix', async () => {
    const root = await repo()
    await mkdir(join(root, 'checkouts'))
    await writeFile(join(root, 'checkouts/.gitignore'), 'custom\n')
    ctx = await harness(root, { directory: 'checkouts', namePrefix: 'task-' })
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(agent)
    expect(created.branch).toMatch(/^task-[0-9a-f]{8}$/)
    expect(created.path).toBe(join(root, 'checkouts', created.branch))
    expect(await contents(join(root, 'checkouts/.gitignore'))).toBe('custom\n')
  })

  it('names a generated worktree after the UUID in the Session id', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root, 'session-6B1F02C4-61de-44ee-813f-1191894bc2c5')
    const created = await ctx.worktrees.create(agent)
    expect(created.branch).toMatch(/^dsh-6b1f02c4-[0-9a-f]{4}$/)
    expect(created.path).toBe(join(root, '.agents/worktrees', created.branch))
  })

  it('creates from a linked checkout using its own commit and default pool', async () => {
    const root = await repo()
    const linked = join(root, 'linked')
    await git(root, 'worktree', 'add', '-b', 'linked', linked)
    await writeFile(join(linked, 'tracked.txt'), 'linked revision\n')
    await git(linked, 'commit', '-am', 'linked revision')
    const baseCommit = await git(linked, 'rev-parse', 'HEAD')
    ctx = await harness(linked)
    const agent = testAgent(ctx, linked)

    const result = await ctx.worktrees.create(agent, { name: 'from-linked' })

    expect(result).toEqual({
      path: join(linked, '.agents/worktrees/from-linked'),
      branch: 'from-linked', baseCommit, repositoryRoot: linked,
    })
    expect(await contents(join(result.path, 'tracked.txt'))).toBe('linked revision\n')
    expect(await contents(join(root, 'tracked.txt'))).toBe('initial\n')
    expect(await git(result.path, 'symbolic-ref', '--short', 'HEAD')).toBe('from-linked')
    expect(await git(linked, 'symbolic-ref', '--short', 'HEAD')).toBe('linked')
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${result.path.split(sep).join('/')}`)
    expect(ctx.workingDirectory.get(agent.session)).toBe(result.path)
  })

  it.each(['preflight', 'allocation'] as const)('refuses a regular file at the pool path during %s without replacing it or creating a branch', async (stage) => {
    const root = await repo()
    const pool = join(root, 'checkouts')
    ctx = await harness(root, { directory: 'checkouts' })
    const agent = testAgent(ctx, root)
    if (stage === 'preflight') {
      await writeFile(pool, 'retain this file\n')
    } else {
      const inspect = ctx.fs.lstat.bind(ctx.fs)
      vi.spyOn(ctx.fs, 'lstat').mockImplementationOnce(async (...args) => {
        const found = await inspect(...args)
        await writeFile(pool, 'retain this file\n')
        return found
      })
    }

    await expect(ctx.worktrees.create(agent, { name: 'blocked' })).rejects.toThrow(stage === 'preflight'
      ? 'a parent path segment is not a directory' : 'EEXIST')

    expect(await contents(pool)).toBe('retain this file\n')
    expect(await git(root, 'branch', '--list', 'blocked')).toBe('')
    expect((await git(root, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')))
      .toEqual([`worktree ${root.split(sep).join('/')}`])
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
  })

  it('keeps the resolved commit when HEAD advances before checkout allocation', async () => {
    const root = await repo()
    const baseCommit = await git(root, 'rev-parse', 'HEAD')
    ctx = await harness(root)
    const original = ctx.fs.lstat.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'lstat').mockImplementationOnce(async (...args) => {
      const value = await original(...args)
      await writeFile(join(root, 'tracked.txt'), 'advanced\n')
      await git(root, 'commit', '-am', 'advance')
      return value
    })
    const result = await ctx.worktrees.create(testAgent(ctx, root), { name: 'pinned' })
    expect(result.baseCommit).toBe(baseCommit)
    expect(await git(root, 'rev-parse', 'HEAD')).not.toBe(baseCommit)
    expect(await contents(join(result.path, 'tracked.txt'))).toBe('initial\n')
  })

  it('refuses missing partial-clone objects without fetching from the available local remote', async () => {
    const source = await repo()
    await git(source, 'config', 'uploadpack.allowFilter', 'true')
    const partial = join(source, 'partial')
    await git(source, 'clone', '--filter=blob:none', '--no-checkout', pathToFileURL(source).href, partial)
    const missing = await git(partial, 'rev-list', '--objects', '--missing=print', 'HEAD')
    expect(missing.split('\n').filter(line => line.startsWith('?'))).toHaveLength(1)
    ctx = await harness(partial)
    const agent = testAgent(ctx, partial)

    await expect(ctx.worktrees.create(agent, { name: 'local-only' })).rejects.toThrow('worktree command failed')

    expect(await git(partial, 'rev-list', '--objects', '--missing=print', 'HEAD')).toBe(missing)
    expect(ctx.workingDirectory.get(agent.session)).toBe(partial)
  })

  it('aborts pending commands and waits for their settlement before service disposal completes', async () => {
    const root = await repo()
    ctx = await harness(root)
    const service = ctx.worktrees
    const [fiber] = [...ctx.registry.get(WorktreeService)!.fibers]
    const entered = Promise.withResolvers<AbortSignal>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const resolveExecutable = ctx.subprocess.resolveExecutable.bind(ctx.subprocess)
    const probe = vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementationOnce(async (command, env, signal) => {
      if (signal === undefined) throw new Error('worktree commands require cancellation')
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve(signal)
      await release.promise
      signal.throwIfAborted()
      return resolveExecutable(command, env, signal)
    })
    const operation = service.create(testAgent(ctx, root), { name: 'cancelled' })
    const rejection = expect(operation).rejects.toThrow('worktree service disposed')
    let disposal: Promise<void> | undefined
    try {
      const signal = await entered.promise
      let disposed = false
      disposal = fiber!.dispose().then(() => { disposed = true })
      expect(await Promise.race([
        aborted.promise.then(() => 'aborted'),
        disposal.then(() => 'disposed'),
      ])).toBe('aborted')
      expect(signal.aborted).toBe(true)
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await rejection
      await disposal
      expect(disposed).toBe(true)
      expect(await readdir(root)).toEqual(['.git', 'tracked.txt'])
      await expect(service.create(testAgent(ctx, root, 'after-disposal'))).rejects.toThrow('worktree service disposed')
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([operation, rejection, disposal])
      probe.mockRestore()
    }
  })

  it('claims one checkout when concurrent callers choose the same new name', async () => {
    const root = await repo()
    ctx = await harness(root)
    const first = testAgent(ctx, root, 'first')
    const second = testAgent(ctx, root, 'second')
    const original = ctx.fs.lstat.bind(ctx.fs)
    let observed = 0
    let release!: () => void
    const bothAbsent = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(ctx.fs, 'lstat').mockImplementation(async (...args) => {
      const value = await original(...args)
      observed++
      if (observed === 2) release()
      await bothAbsent
      return value
    })
    const results = await Promise.allSettled([
      ctx.worktrees.create(first, { name: 'shared' }),
      ctx.worktrees.create(second, { name: 'shared' }),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect([ctx.workingDirectory.get(first.session), ctx.workingDirectory.get(second.session)].sort())
      .toEqual([root, join(root, '.agents/worktrees/shared')].sort())
    expect(await contents(join(root, '.agents/worktrees/shared/tracked.txt'))).toBe('initial\n')
  })

  it('leaves an existing pool without a gitignore unchanged', async () => {
    const root = await repo()
    await mkdir(join(root, '.agents/worktrees'), { recursive: true })
    ctx = await harness(root)
    await ctx.worktrees.create(testAgent(ctx, root), { name: 'topic' })
    expect(await readdir(join(root, '.agents/worktrees'))).toEqual(['topic'])
  })

  it('refuses branch or destination reuse and invalid local revisions before changing cwd', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    await git(root, 'branch', 'existing')
    await mkdir(join(root, '.agents/worktrees/occupied'), { recursive: true })
    await expect(ctx.worktrees.create(agent, { name: 'existing' })).rejects.toThrow('branch already exists')
    await expect(ctx.worktrees.create(agent, { name: 'occupied' })).rejects.toThrow('path already exists')
    await expect(ctx.worktrees.create(agent, { name: 'missing', from: 'unavailable' })).rejects.toThrow('command failed')
    await expect(ctx.worktrees.create(agent, { name: '../escape' })).rejects.toThrow('relative Git branch')
    await expect(ctx.worktrees.create(agent, { name: 'invalid name' })).rejects.toThrow('command failed')
    await expect(ctx.worktrees.create(agent, { from: '' })).rejects.toThrow('from must name')
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain('/occupied')
    expect(await readdir(join(root, '.agents/worktrees'))).toEqual(['occupied'])
  })

  it('retains the checkout and branch if publishing the new cwd fails', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    await ctx.workingDirectory.ensure(agent)
    vi.spyOn(ctx.workingDirectory, 'set').mockRejectedValueOnce(new Error('directory publication failed'))
    await expect(ctx.worktrees.create(agent, { name: 'retained' })).rejects.toThrow('Any created checkout and branch are retained')
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect(await git(root, 'branch', '--list', 'retained')).toContain('retained')
    expect(await contents(join(root, '.agents/worktrees/retained/tracked.txt'))).toBe('initial\n')
  })

  it('does not spawn Git when the sandbox refuses the standing workspace-write policy', async () => {
    const root = await repo()
    ctx = await harness(root, {}, 'workspace-write')
    const agent = testAgent(ctx, root)
    const failure = new Error('fixture sandbox refused confinement')
    const confine = vi.spyOn(ctx.sandbox, 'confine').mockRejectedValue(failure)
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')

    await expect(ctx.worktrees.create(agent, { name: 'denied-confinement' })).rejects.toBe(failure)

    expect(confine).toHaveBeenCalledOnce()
    expect(confine.mock.calls[0]?.[1]).toMatchObject({ mode: 'workspace-write', workspaceRoot: root })
    expect(spawn).not.toHaveBeenCalled()
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect(await readdir(root)).toEqual(['.git', 'tracked.txt'])
  })

  it('does not reset the dirty source when shared Git configuration points at it', async () => {
    const root = await repo()
    await git(root, 'config', 'core.worktree', root)
    await writeFile(join(root, 'tracked.txt'), 'dirty source\n')
    const config = await contents(join(root, '.git/config'))
    ctx = await harness(root)
    const result = await ctx.worktrees.create(testAgent(ctx, root), { name: 'configured' })
    expect(await contents(join(root, 'tracked.txt'))).toBe('dirty source\n')
    expect(await contents(join(root, '.git/config'))).toBe(config)
    expect(await contents(join(result.path, 'tracked.txt'))).toBe('initial\n')
    expect(await git(result.path, 'rev-parse', '--show-toplevel')).toBe(result.path.split(sep).join('/'))
  })

  it('rejects cancellation and invalid deployment config before allocating a checkout', async () => {
    const root = await repo()
    for (const config of [{ directory: '../escape' }, { namePrefix: '-bad' }, { gitCommand: '' }, { timeoutMs: 0 }]) {
      await expect(harness(root, config)).rejects.toThrow('worktree:')
    }
    ctx = await harness(root)
    await expect(ctx.worktrees.create(testAgent(ctx, root), {}, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
    expect(await readdir(root)).toEqual(['.git', 'tracked.txt'])
  })

  it('refuses truncated Git metadata before allocating a checkout', async () => {
    const root = await repo()
    ctx = await harness(root, { maxOutputBytes: 1 })
    const agent = testAgent(ctx, root)
    await expect(ctx.worktrees.create(agent, { name: 'bounded' })).rejects.toThrow('output exceeds maxOutputBytes')
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect(await readdir(root)).toEqual(['.git', 'tracked.txt'])
  })

  it('retains a caller cancellation reason when allocation is cancelled before its child starts', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const controller = new AbortController()
    const resolveExecutable = ctx.subprocess.resolveExecutable.bind(ctx.subprocess)
    const probe = vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation(async (command, env, signal) => {
      if (command === 'node') controller.abort('caller stopped')
      return resolveExecutable(command, env, signal)
    })
    try {
      await expect(ctx.worktrees.create(agent, { name: 'cancelled-allocation' }, controller.signal)).rejects.toThrow('caller stopped')
      expect(ctx.workingDirectory.get(agent.session)).toBe(root)
      expect(await readdir(root)).toEqual(['.git', 'tracked.txt'])
    } finally {
      probe.mockRestore()
    }
  })
})

describe('restoring removed worktrees', () => {
  /** The checkout directories Git registers for `root`, in Git's notation. */
  async function registered(root: string): Promise<string[]> {
    return (await git(root, 'worktree', 'list', '--porcelain')).split('\n')
      .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
  }

  /** `path` in the notation Git prints. */
  function gitPath(path: string): string {
    return path.split(sep).join('/')
  }

  /** Commit one new file on the branch checked out at `checkout`. */
  async function commitIn(checkout: string, file: string): Promise<string> {
    await writeFile(join(checkout, file), `${file}\n`)
    await git(checkout, 'add', file)
    await git(checkout, 'commit', '-m', file)
    return await git(checkout, 'rev-parse', 'HEAD')
  }

  it('checks the branch out again at its latest commit after removing only its stale registration, without entering the checkout', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(agent, { name: 'topic' })
    const tip = await commitIn(created.path, 'later.txt')
    const abandoned = await ctx.worktrees.create(testAgent(ctx, root, 'abandoned'), { name: 'abandoned' })
    await ctx.workingDirectory.set(agent, root)
    await rm(created.path, { recursive: true, force: true })
    await rm(abandoned.path, { recursive: true, force: true })

    const phases: string[] = []
    const restored = await ctx.worktrees.restore(agent, created, undefined, (phase) => {
      phases.push(`${phase}:${String(existsSync(created.path))}`)
    })

    expect(phases).toEqual(['prepare:false', 'checkout:true'])
    expect(restored).toEqual({ path: created.path, branchRecreated: false })
    expect(await git(created.path, 'symbolic-ref', '--short', 'HEAD')).toBe('topic')
    expect(await git(created.path, 'rev-parse', 'HEAD')).toBe(tip)
    expect(await contents(join(created.path, 'later.txt'))).toBe('later.txt\n')
    expect(await git(created.path, 'status', '--porcelain')).toBe('')
    expect(await registered(root)).toEqual([gitPath(root), gitPath(abandoned.path), gitPath(created.path)])
    expect(await git(root, 'branch', '--list', 'abandoned')).toContain('abandoned')
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
  })

  it('creates a deleted branch again at its base commit, without the commits it had gained', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(agent, { name: 'topic' })
    await commitIn(created.path, 'later.txt')
    await commitIn(root, 'advanced.txt')
    await git(root, 'worktree', 'remove', '--force', created.path)
    await git(root, 'branch', '-D', 'topic')

    const restored = await ctx.worktrees.restore(agent, created)

    expect(restored).toEqual({ path: created.path, branchRecreated: true })
    expect(await git(root, 'rev-parse', 'topic')).toBe(created.baseCommit)
    expect(await git(created.path, 'symbolic-ref', '--short', 'HEAD')).toBe('topic')
    expect(await contents(join(created.path, 'tracked.txt'))).toBe('initial\n')
    await expect(access(join(created.path, 'later.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(created.path, 'advanced.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ctx.workingDirectory.get(agent.session)).toBe(created.path)
  })

  it('refuses a directory that exists before running any command', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(agent, { name: 'topic' })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')

    await expect(ctx.worktrees.restore(agent, created)).rejects.toThrow(`worktree path already exists: ${created.path}`)

    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects an unavailable recorded base before allocating files or removing registrations', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const path = join(root, '.agents/worktrees/vanished')
    const request: RestoreWorktreeRequest = { path, branch: 'vanished', baseCommit: 'f'.repeat(40), repositoryRoot: root }
    await expect(ctx.worktrees.restore(agent, request)).rejects.toThrow('worktree command failed')
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'branch', '--list', 'vanished')).toBe('')
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
  })

  it.each([new Error('caller stopped'), 'caller stopped'])('retains cancellation reason %s when restoration is cancelled before its allocation starts', async (reason) => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(agent, { name: 'topic' })
    await rm(created.path, { recursive: true, force: true })
    const controller = new AbortController()
    const resolveExecutable = ctx.subprocess.resolveExecutable.bind(ctx.subprocess)
    const probe = vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation(async (command, env, signal) => {
      if (command === 'node') controller.abort(reason)
      return resolveExecutable(command, env, signal)
    })
    try {
      await expect(ctx.worktrees.restore(agent, created, controller.signal))
        .rejects.toThrow(`Could not restore worktree topic at ${created.path}. Any created checkout and branch are retained. caller stopped`)
      await expect(access(created.path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      probe.mockRestore()
    }
  })

  it('rejects a cancelled restoration, and every restoration after service disposal, before running any command', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const request: RestoreWorktreeRequest = {
      path: join(root, '.agents/worktrees/topic'), branch: 'topic', baseCommit: await git(root, 'rev-parse', 'HEAD'), repositoryRoot: root,
    }
    const service = ctx.worktrees
    const [fiber] = [...ctx.registry.get(WorktreeService)!.fibers]
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')

    await expect(service.restore(agent, request, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
    await fiber!.dispose()
    await expect(service.restore(agent, request)).rejects.toThrow('worktree service disposed')

    expect(spawn).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual(['.git', 'tracked.txt'])
  })
})


describe('restoration validation', () => {
  it.each(['outside', 'traversal', 'branch', 'unsafe-branch', 'commit', 'root', 'nested-root'] as const)('rejects invalid %s before mutating the repository', async (kind) => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(agent, { name: 'topic' })
    await rm(created.path, { recursive: true, force: true })
    const before = await git(root, 'worktree', 'list', '--porcelain')
    const request = { ...created }
    if (kind === 'outside') request.path = join(root, 'outside')
    if (kind === 'traversal') request.path = `${root}/.agents/worktrees/../../outside`
    if (kind === 'branch') request.branch = 'bad name'
    if (kind === 'unsafe-branch') request.branch = '../topic'
    if (kind === 'commit') request.baseCommit = 'HEAD'
    if (kind === 'root') request.repositoryRoot = join(root, '.agents')
    if (kind === 'nested-root') {
      request.repositoryRoot = join(root, '.agents')
      request.path = join(request.repositoryRoot, '.agents/worktrees/topic')
    }
    await expect(ctx.worktrees.restore(agent, request)).rejects.toThrow()
    expect(await git(root, 'worktree', 'list', '--porcelain')).toBe(before)
    await expect(access(created.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a locked missing worktree registration', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(agent, { name: 'topic' })
    await git(root, 'worktree', 'lock', created.path)
    await rm(created.path, { recursive: true, force: true })
    const before = await git(root, 'worktree', 'list', '--porcelain')
    await expect(ctx.worktrees.restore(agent, created)).rejects.toThrow('worktree is locked')
    expect(await git(root, 'worktree', 'list', '--porcelain')).toBe(before)
  })
})


it('rejects a restore path redirected outside the pool by a symlink', async () => {
  const root = await repo()
  ctx = await harness(root)
  const agent = testAgent(ctx, root)
  const created = await ctx.worktrees.create(agent, { name: 'topic' })
  await rm(created.path, { recursive: true, force: true })
  const outside = join(root, 'outside')
  const link = join(root, '.agents/worktrees/redirect')
  await mkdir(outside)
  await symlink(outside, link, 'junction')
  const before = await git(root, 'worktree', 'list', '--porcelain')
  await expect(ctx.worktrees.restore(agent, { ...created, path: join(link, 'topic') })).rejects.toThrow('configured pool')
  expect(await readdir(outside)).toEqual([])
  expect(await git(root, 'worktree', 'list', '--porcelain')).toBe(before)
})


it('does not remove a registration when its directory reappears during restoration validation', async () => {
  const root = await repo()
  ctx = await harness(root)
  const agent = testAgent(ctx, root)
  const created = await ctx.worktrees.create(agent, { name: 'topic' })
  await rm(created.path, { recursive: true, force: true })
  const resolve = ctx.fs.resolve.bind(ctx.fs)
  const target = await resolve(created.path)
  let targetReads = 0
  const probe = vi.spyOn(ctx.fs, 'resolve').mockImplementation(async (path, options) => {
    const resolved = await resolve(path, options)
    if (resolved.targetKey === target.targetKey && ++targetReads === 2) await mkdir(created.path)
    return resolved
  })
  try {
    await expect(ctx.worktrees.restore(agent, created)).rejects.toThrow('worktree path already exists')
    expect(targetReads).toBe(2)
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${created.path.split(sep).join('/')}`)
  } finally { probe.mockRestore() }
})
