import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
})
