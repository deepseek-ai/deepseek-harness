import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import { runCommand } from '../src/process.ts'
import { filterCommand, git, harness, repository, testAgent } from './harness.ts'

let ctx: Context | undefined
let root: string | undefined

const sandboxUsable = await (async () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return false
  const probe = new Context()
  try {
    await probe.plugin(LocalSandbox)
    await probe.sandbox.confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot: process.cwd() })
    return true
  } catch (error: unknown) {
    if (error instanceof SandboxUnavailableError) return false
    throw error
  } finally {
    await probe.fiber.dispose()
  }
})()

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

// The local sandbox's POSIX kernel runners are covered here; Windows ACL enforcement has its own native lane.
// Source-tree repositories stay outside the temporary directories independently writable under workspace-write.
describe.skipIf(!sandboxUsable)('worktree standing sandbox policy', () => {
  it('refuses creation under read-only policy without changing the Session directory', async () => {
    root = await repository(process.cwd())
    const pool = join(root, '.agents', 'worktrees')
    await mkdir(pool, { recursive: true })
    ctx = await harness(root, {}, 'read-only')
    const agent = testAgent(ctx, root)
    const confine = vi.spyOn(ctx.sandbox, 'confine')
    await expect(ctx.worktrees.create(agent, { name: 'denied' })).rejects.toThrow(/permission denied|operation not permitted|read-only file system/i)
    expect(await readdir(pool)).toEqual([])
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect(await git(root, 'branch', '--list', 'denied')).toBe('')
    expect(confine.mock.calls.length).toBeGreaterThan(0)
    expect(confine.mock.calls.every(call => call[1].mode === 'read-only' && call[1].workspaceRoot === root)).toBe(true)
  })

  it('creates an unfiltered checkout in the default pool under the source workspace-write grant', async () => {
    root = await repository(process.cwd())
    await writeFile(join(root, '.gitattributes'), '*.txt filter=configured -text\n')
    await git(root, 'add', '.gitattributes')
    await git(root, 'commit', '-m', 'attributes')
    const { command, marker } = await filterCommand(root)
    await git(root, 'config', 'filter.configured.smudge', command)
    await git(root, 'config', 'filter.configured.required', 'true')
    ctx = await harness(root, {}, 'workspace-write')
    const agent = testAgent(ctx, root)
    const confine = vi.spyOn(ctx.sandbox, 'confine')
    const created = await ctx.worktrees.create(agent, { name: 'allowed' })
    const checkout = join(root, '.agents', 'worktrees', 'allowed')

    expect(created.path).toBe(checkout)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('initial\n')
    expect(await git(checkout, 'branch', '--show-current')).toBe('allowed')
    expect(await git(root, 'branch', '--show-current')).toBe('main')
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${checkout}`)
    expect(ctx.workingDirectory.get(agent.session)).toBe(checkout)
    expect(confine.mock.calls.length).toBeGreaterThan(0)
    expect(confine.mock.calls.every(call => call[1].mode === 'workspace-write' && call[1].workspaceRoot === root)).toBe(true)
  })

  it('enters an existing worktree under read-only policy with confined read commands, and the boundary follows', async () => {
    root = await repository(process.cwd())
    const checkout = join(root, '.agents', 'worktrees', 'existing')
    await git(root, 'worktree', 'add', '-b', 'existing', checkout)
    const before = await git(root, 'worktree', 'list', '--porcelain')
    ctx = await harness(root, {}, 'read-only')
    const agent = testAgent(ctx, root)
    const confine = vi.spyOn(ctx.sandbox, 'confine')

    await expect(ctx.worktrees.enter(agent, { name: 'existing' })).resolves.toEqual({ path: checkout, branch: 'existing', repositoryRoot: root })
    expect(confine.mock.calls.length).toBeGreaterThan(0)
    expect(confine.mock.calls.every(call => call[1].mode === 'read-only' && call[1].workspaceRoot === root)).toBe(true)
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot).toBe(checkout)
    expect(await git(root, 'worktree', 'list', '--porcelain')).toBe(before)
    await expect(ctx.worktrees.exit(agent)).resolves.toMatchObject({ path: checkout })
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot).toBe(root)
  })

  it('does not widen a linked-checkout grant to the shared Git administration directory', async () => {
    root = await repository(process.cwd())
    const linked = join(root, 'linked')
    await git(root, 'worktree', 'add', '-b', 'linked', linked)
    ctx = await harness(linked, {}, 'workspace-write')
    const agent = testAgent(ctx, linked)
    const confine = vi.spyOn(ctx.sandbox, 'confine')
    await expect(ctx.worktrees.create(agent, { name: 'denied-admin' })).rejects.toThrow(/permission denied|operation not permitted|read-only file system/i)
    expect(ctx.workingDirectory.get(agent.session)).toBe(linked)
    expect(await git(root, 'branch', '--list', 'denied-admin')).toBe('')
    expect(confine.mock.calls.every(call => call[1].mode === 'workspace-write' && call[1].workspaceRoot === linked)).toBe(true)
  })

  it('creates and restores from a linked checkout once a registered grant covers its shared Git administration directory', async () => {
    root = await repository(process.cwd())
    const administration = join(root, '.git')
    const linked = join(root, 'linked')
    await git(root, 'worktree', 'add', '-b', 'linked', linked)
    ctx = await harness(linked, {}, 'workspace-write')
    const agent = testAgent(ctx, linked)
    ctx.sandboxPolicy.registerWritableRoot(agent.session, administration)
    const created = await ctx.worktrees.create(agent, { name: 'shared-admin' })
    const checkout = join(linked, '.agents', 'worktrees', 'shared-admin')

    expect(created.path).toBe(checkout)
    expect(await git(checkout, 'branch', '--show-current')).toBe('shared-admin')
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${checkout}`)
    expect(ctx.workingDirectory.get(agent.session)).toBe(checkout)

    // The Session's root is now the removed checkout; restoration is bounded by the linked source checkout and keeps the grant.
    await rm(checkout, { recursive: true, force: true })
    const confine = vi.spyOn(ctx.sandbox, 'confine')
    expect(await ctx.worktrees.restore(agent, created)).toEqual({ path: checkout, branchRecreated: false })
    expect(await git(checkout, 'branch', '--show-current')).toBe('shared-admin')
    expect(confine.mock.calls.length).toBeGreaterThan(0)
    const bounded = confine.mock.calls
      .every(call => call[1].workspaceRoot === linked && call[1].additionalWritableRoots?.includes(administration))
    expect(bounded).toBe(true)
  })

  it('denies a commit inside the Session\'s worktree under workspace-write until a grant covers the repository\'s Git directory', async () => {
    root = await repository(process.cwd())
    ctx = await harness(root, {}, 'workspace-write')
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(agent, { name: 'committing' })
    const limits = { timeoutMs: 30_000, graceMs: 1_000, maxOutputBytes: 65_536 }
    const commit = () => runCommand(
      ctx!, limits, ctx!.sandboxPolicy.resolve({ session: agent.session }), created.path,
      ['git', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'from the worktree'], new AbortController().signal,
    )

    // The worktree's index and the repository's objects live in the source checkout's Git directory, outside the Session's root.
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot).toBe(created.path)
    await expect(commit()).rejects.toThrow(/permission denied|operation not permitted|read-only file system/i)
    expect(await git(created.path, 'rev-parse', 'HEAD')).toBe(created.baseCommit)

    ctx.sandboxPolicy.registerWritableRoot(agent.session, join(root, '.git'))
    await commit()
    expect(await git(created.path, 'log', '-1', '--format=%s')).toBe('from the worktree')
  })

  it('restores a removed worktree under the source checkout boundary while the Session root is the removed directory', async () => {
    root = await repository(process.cwd())
    ctx = await harness(root, {}, 'workspace-write')
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(agent, { name: 'restored' })
    expect(ctx.workingDirectory.get(agent.session)).toBe(created.path)
    await rm(created.path, { recursive: true, force: true })
    const confine = vi.spyOn(ctx.sandbox, 'confine')

    expect(await ctx.worktrees.restore(agent, created)).toEqual({ path: created.path, branchRecreated: false })

    expect(await git(created.path, 'branch', '--show-current')).toBe('restored')
    expect(confine.mock.calls.length).toBeGreaterThan(0)
    expect(confine.mock.calls.every(call => call[1].mode === 'workspace-write' && call[1].workspaceRoot === root)).toBe(true)
  })
})
