import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from './snapshot-workspace-parent.ts'

// Host disk exhaustion is not simulated: placement and the real write fence are the regression oracles.
describe('snapshot workspace parent', () => {
  // Windows directory permissions and root bypass do not enforce POSIX write bits.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('uses home when the temp parent is not writable', async () => {
    const base = await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-snapshot-readonly-'))
    try {
      const temporary = join(base, '_temp')
      await mkdir(temporary)
      await chmod(base, 0o500)
      expect(outsideTempWorkspaceParent(temporary)).toBe(homedir())
    } finally {
      await chmod(base, 0o700)
      await rm(base, { recursive: true, force: true })
    }
  })

  it('uses home when a temp sibling would require a system directory or inherit its grant', () => {
    expect(outsideTempWorkspaceParent('/tmp')).toBe(homedir())
    expect(outsideTempWorkspaceParent(parse(tmpdir()).root)).toBe(homedir())
    expect(outsideTempWorkspaceParent(join(canonicalPath('/tmp'), 'runner', '_temp'))).toBe(homedir())
  })

  it('rejects automatically writable temporary workspaces, including symlink aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-parent-'))
    try {
      expect(() => { assertWorkspaceOutsideTemp(root) }).toThrow('must be outside temporary writable root')
      const alias = join(root, 'alias')
      await symlink(tmpdir(), alias, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => { assertWorkspaceOutsideTemp(alias) }).toThrow('must be outside temporary writable root')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows the allocated workspace but denies sibling writes and cleans the complete tree', async () => {
    const base = await mkdtemp(join(outsideTempWorkspaceParent(), 'dsh-snapshot-parent-'))
    const ctx = new Context()
    const fibers: Awaited<ReturnType<Context['plugin']>>[] = []
    try {
      const temporary = join(base, '_temp')
      await mkdir(temporary)
      expect(outsideTempWorkspaceParent(temporary)).toBe(canonicalPath(base))
      const workspace = await mkdtemp(join(outsideTempWorkspaceParent(temporary), 'workspace-'))
      const outside = join(base, 'outside.txt')
      assertWorkspaceOutsideTemp(workspace)
      expect(dirname(workspace)).toBe(canonicalPath(base))
      expect((await stat(workspace)).dev).toBe((await stat(temporary)).dev)
      fibers.push(await ctx.plugin(SessionProjectionRegistry))
      fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace }))
      fibers.push(await ctx.plugin(SandboxedFileSystem, { cwd: workspace }))
      const inside = join(workspace, 'inside.txt')
      await ctx.fs.writeText(await ctx.fs.resolve(inside), 'inside')
      expect(await readFile(inside, 'utf8')).toBe('inside')
      await expect(ctx.fs.writeText(await ctx.fs.resolve(outside), 'outside'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(existsSync(outside)).toBe(false)
    } finally {
      try {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    }
    expect(existsSync(base)).toBe(false)
  })
})
