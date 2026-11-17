import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
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

  it('creates from a linked checkout once the policy grants its shared Git administration directory', async () => {
    root = await repository(process.cwd())
    const administration = join(root, '.git')
    const linked = join(root, 'linked')
    await git(root, 'worktree', 'add', '-b', 'linked', linked)
    ctx = await harness(linked, {}, 'workspace-write')
    const agent = testAgent(ctx, linked)
    const confine = vi.spyOn(ctx.sandbox, 'confine')
    const created = await ctx.worktrees.create(agent, { name: 'shared-admin' })
    const checkout = join(linked, '.agents', 'worktrees', 'shared-admin')

    expect(created.path).toBe(checkout)
    expect(await git(checkout, 'branch', '--show-current')).toBe('shared-admin')
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${checkout}`)
    expect(ctx.workingDirectory.get(agent.session)).toBe(checkout)
    expect(confine.mock.calls.every(call => call[1].mode === 'workspace-write' && call[1].workspaceRoot === linked)).toBe(true)
    // The registration write lands in the shared Git directory outside the linked root; only the derived grant admits it.
    expect(confine.mock.calls.some(call => call[1].additionalWritableRoots?.includes(administration))).toBe(true)
  })

  it('fetches the remote base branch from a linked checkout under the granted shared Git administration directory', async () => {
    root = await repository(process.cwd())
    const clone = join(root, 'clone')
    await git(root, 'clone', pathToFileURL(root).href, clone)
    await git(clone, 'config', 'core.autocrlf', 'false')
    const linked = join(clone, 'linked')
    await git(clone, 'worktree', 'add', '-b', 'linked', linked)
    await writeFile(join(root, 'tracked.txt'), 'remote\n')
    await git(root, 'commit', '-am', 'remote')
    const fetched = await git(root, 'rev-parse', 'HEAD')
    ctx = await harness(linked, {}, 'workspace-write')
    const agent = testAgent(ctx, linked)
    const confine = vi.spyOn(ctx.sandbox, 'confine')

    const created = await ctx.worktrees.create(agent, { name: 'fetched', from: 'refs/remotes/origin/main', fetch: true })

    // The fetch writes the remote-tracking branch into the shared Git directory outside the linked root.
    expect(created.baseCommit).toBe(fetched)
    expect(await git(clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(fetched)
    const fetches = confine.mock.calls.filter(call => call[0].includes('fetch'))
    expect(fetches).toHaveLength(1)
    expect(fetches[0]![1]).toMatchObject({ mode: 'workspace-write', workspaceRoot: linked, additionalWritableRoots: [join(clone, '.git')] })
  })

  it('restores a missing worktree of a linked source checkout in a process that never worked in it', async () => {
    root = await repository(process.cwd())
    const linked = join(root, 'linked')
    await git(root, 'worktree', 'add', '-b', 'linked', linked)
    const first = await harness(linked, {}, 'workspace-write')
    let created
    try {
      created = await first.worktrees.create(testAgent(first, linked), { name: 'cold' })
    } finally {
      await first.fiber.dispose()
    }
    await rm(created.path, { recursive: true, force: true })
    // A new process: nothing is derived yet, and the Session's own root no longer exists.
    ctx = await harness(linked, {}, 'workspace-write')
    const agent = testAgent(ctx, linked, 'cold-resumed')
    agent.session.append('workspace-root/change', { cwd: created.path })
    expect(ctx.workingDirectory.get(agent.session)).toBe(created.path)
    const confine = vi.spyOn(ctx.sandbox, 'confine')

    expect(await ctx.worktrees.restore(agent, created)).toEqual({ path: created.path, branchRecreated: false })

    // The source checkout's shared Git directory lies outside it; the worktree service adds the derived grant.
    expect(await git(created.path, 'branch', '--show-current')).toBe('cold')
    expect(confine.mock.calls.every(call => call[1].workspaceRoot === linked && call[1].additionalWritableRoots?.includes(join(root!, '.git')))).toBe(true)
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
