import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { bwrapProfileArgs } from '@deepseek-ai/dsh-sandbox-local/src/profiles.ts'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** Historical foreground shorthand over the unified execute() seam. */
async function run(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellRunResult> {
  return (await x.execute(spec)).result()
}

/** Historical background shorthand: execute with no deadline armed. */
function start(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellExecution> {
  return x.execute({ ...spec, onExpiry: 'none' })
}


/**
 * Keyless integration of the real provider and executor through public run/start paths. With
 * no rung forced, a passing bwrap probe selects the ladder's first rung. The tests check world
 * effects and stamped facts, including EROFS classification through the wrap-carried dialect;
 * backend-only confinement is covered by `@deepseek-ai/dsh-sandbox-local`.
 *
 * Skips when bwrap or unprivileged user namespaces are unavailable. HOME-based paths are
 * intentional because bwrap replaces `/tmp`, which cannot prove the workspace-root boundary.
 */

const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const bwrapUsable = probe.status === 0

let ctx: Context | undefined
const tempDirs: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(base: string): Promise<string> {
  const dir = await mkdtemp(join(base, 'dsh-bwrap-e2e-'))
  tempDirs.push(dir)
  return dir
}

async function sandboxedBash(workspace: string, mode: 'read-only' | 'workspace-write'): Promise<SandboxBashExecutor> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 30_000 })
  return ctx.shell as SandboxBashExecutor
}

describe.skipIf(!bwrapUsable)('bash-sandbox: real bwrap confinement through ctx.shell', () => {
  it('read-only denies a write — the file must NOT exist, and EROFS text classifies as a denial', async () => {
    const workdir = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'read-only')
    const result = await run(bash, bash.resolve({ command: `echo hi > ${workdir}/denied.txt` }))
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('workspace-write lands a write inside the workspace root and still denies one beside it', async () => {
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'workspace-write')

    const inside = await run(bash, bash.resolve({ command: `printf bwrap-ok > ${workdir}/allowed.txt` }))
    expect(inside.exitCode).toBe(0)
    expect(inside.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('bwrap-ok')

    const denied = await run(bash, bash.resolve({ command: `echo hi > ${outside}/denied.txt` }))
    expect(denied.exitCode).not.toBe(0)
    expect(denied.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement: 'full' })
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
  })

  it('classifies a background denial once the task settles', async () => {
    const workdir = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'read-only')
    const task = (await start(bash, bash.resolve({ command: `echo hi > ${workdir}/bg-denied.txt` })))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    expect(existsSync(join(workdir, 'bg-denied.txt'))).toBe(false)
  })

  it('an approved escalated retry — the spec-level workspace-write override — lands the exact write read-only denied', async () => {
    const workdir = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'read-only')
    const command = `printf escalated > ${workdir}/escalated.txt`
    const strict = await run(bash, bash.resolve({ command }))
    expect(strict.exitCode).not.toBe(0)
    expect(strict.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    expect(existsSync(join(workdir, 'escalated.txt'))).toBe(false)
    const retried = await run(bash, bash.resolve({ command, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workdir } }))
    expect(retried.exitCode).toBe(0)
    expect(retried.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(readFileSync(join(workdir, 'escalated.txt'), 'utf8')).toBe('escalated')
  })
})
