import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { launcherPath } from '@deepseek-ai/node-addon-system/landlock-run'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/**
 * KEYLESS consumer-integration proof: the REAL `LocalSandboxProvider` (bwrap
 * rung forced off, so the workspace `landlock-run` launcher confines) underneath the
 * REAL `SandboxBashExecutor`, driven through the executor's public run/start
 * paths. Verifies the WORLD (files exist or don't) plus the stamped result
 * facts; the backend-only confinement proofs live with
 * `@deepseek-ai/dsh-sandbox-local`.
 *
 * Self-skips when the running kernel does not enforce Landlock. CI builds the launcher from
 * `native/system` before running this file.
 */

const probe = spawnSync(launcherPath(), ['--probe'], { timeout: 5_000, encoding: 'utf8' })
const landlockUsable = probe.status === 0
/** The kernel's enforcement level from the probe report — stamped facts below must match it. */
const enforcement = /partially enforced/.test(probe.stdout ?? '') ? 'partial' : 'full'

let ctx: Context | undefined
const tempDirs: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(base: string): Promise<string> {
  const dir = await mkdtemp(join(base, 'dsh-landlock-e2e-'))
  tempDirs.push(dir)
  return dir
}

async function sandboxedBash(workspace: string, mode: 'read-only' | 'workspace-write'): Promise<SandboxBashExecutor> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  ;(ctx.sandbox as LocalSandboxProvider).internals = { probeBwrap: () => false }
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 30_000 })
  return ctx.shell as SandboxBashExecutor
}

describe.skipIf(!landlockUsable)('bash-sandbox: real Landlock confinement through ctx.shell', () => {
  it('read-only denies a write — the file must NOT exist, the result carries denial + enforcement facts', async () => {
    const workdir = await tempDir(tmpdir())
    const bash = await sandboxedBash(workdir, 'read-only')
    const result = await bash.run(bash.resolve({ command: `echo hi > ${workdir}/denied.txt` }))
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement })
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('workspace-write lands a write inside the workspace root and still denies one beside it', async () => {
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'workspace-write')

    const inside = await bash.run(bash.resolve({ command: `printf landlock-ok > ${workdir}/allowed.txt` }))
    expect(inside.exitCode).toBe(0)
    expect(inside.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement })
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('landlock-ok')

    const denied = await bash.run(bash.resolve({ command: `echo hi > ${outside}/denied.txt` }))
    expect(denied.exitCode).not.toBe(0)
    expect(denied.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement })
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
  })

  it('classifies a background denial once the task settles', async () => {
    const workdir = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'read-only')
    const task = await bash.start(bash.resolve({ command: `echo hi > ${workdir}/bg-denied.txt` }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement })
    expect(existsSync(join(workdir, 'bg-denied.txt'))).toBe(false)
  })

  it('an approved escalated retry — the spec-level workspace-write override — lands the exact write read-only denied', async () => {
    const workdir = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'read-only')
    const command = `printf escalated > ${workdir}/escalated.txt`
    const strict = await bash.run(bash.resolve({ command }))
    expect(strict.exitCode).not.toBe(0)
    expect(strict.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: enforcement })
    expect(existsSync(join(workdir, 'escalated.txt'))).toBe(false)
    const retried = await bash.run(bash.resolve({ command, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workdir } }))
    expect(retried.exitCode).toBe(0)
    expect(retried.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: enforcement })
    expect(readFileSync(join(workdir, 'escalated.txt'), 'utf8')).toBe('escalated')
  })
})
