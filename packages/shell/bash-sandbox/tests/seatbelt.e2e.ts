import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { seatbeltProfileArgs } from '@deepseek-ai/dsh-sandbox-local/src/profiles.ts'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/**
 * Keyless macOS integration of the real provider and executor through public run/start paths.
 * Linux rungs are forced off so Seatbelt is selected. The tests check world effects and stamped
 * facts, including EPERM classification through the wrap-carried dialect; backend-only
 * confinement is covered by `@deepseek-ai/dsh-sandbox-local`. Skips off macOS or when
 * `sandbox-exec` rejects the profile.
 */

const probe = spawnSync('sandbox-exec', [...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const seatbeltUsable = probe.status === 0

let ctx: Context | undefined
const tempDirs: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(base: string): Promise<string> {
  const dir = await mkdtemp(join(base, 'dsh-seatbelt-e2e-'))
  tempDirs.push(dir)
  return dir
}

async function sandboxedBash(workspace: string, mode: 'read-only' | 'workspace-write'): Promise<SandboxBashExecutor> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  ;(ctx.sandbox as LocalSandboxProvider).internals = { probeBwrap: () => false, probeLandlock: () => 'unusable' }
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 30_000 })
  return ctx.shell as SandboxBashExecutor
}

describe.skipIf(!seatbeltUsable)('bash-sandbox: real Seatbelt confinement through ctx.shell', () => {
  it('read-only denies a write — the file must NOT exist, and EPERM text classifies as a denial', async () => {
    const workdir = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'read-only')
    const result = await bash.run(bash.resolve({ command: `echo hi > ${workdir}/denied.txt` }))
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('workspace-write lands a write inside the workspace root and still denies one beside it', async () => {
    // HOME-based dirs on purpose: workspace-write grants /tmp and the
    // per-user temp dir wholesale, so only paths outside both prove the
    // workspace-root boundary.
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'workspace-write')

    const inside = await bash.run(bash.resolve({ command: `printf seatbelt-ok > ${workdir}/allowed.txt` }))
    expect(inside.exitCode).toBe(0)
    expect(inside.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('seatbelt-ok')

    const denied = await bash.run(bash.resolve({ command: `echo hi > ${outside}/denied.txt` }))
    expect(denied.exitCode).not.toBe(0)
    expect(denied.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement: 'full' })
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
  })

  it('evaluates BASH_ENV only after Seatbelt confines the inner Bash', async () => {
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const hook = join(workdir, 'bash-env-hook.sh')
    const insideProbe = join(workdir, 'hook-ran.txt')
    const outsideProbe = join(outside, 'escaped.txt')
    await writeFile(hook, [
      'printf hook > "$DSH_BASH_ENV_INSIDE"',
      'printf escaped > "$DSH_BASH_ENV_OUTSIDE"',
      '',
    ].join('\n'))
    const bash = await sandboxedBash(workdir, 'workspace-write')

    await bash.run(bash.resolve({
      command: 'true',
      env: { BASH_ENV: hook },
      dshEnv: {
        DSH_BASH_ENV_INSIDE: insideProbe,
        DSH_BASH_ENV_OUTSIDE: outsideProbe,
      },
    }))

    expect(readFileSync(insideProbe, 'utf8')).toBe('hook')
    expect(existsSync(outsideProbe)).toBe(false)
  })

  it('classifies a background denial once the task settles', async () => {
    const workdir = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'read-only')
    const task = await bash.start(bash.resolve({ command: `echo hi > ${workdir}/bg-denied.txt` }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    expect(existsSync(join(workdir, 'bg-denied.txt'))).toBe(false)
  })

  it('an approved escalated retry — the spec-level workspace-write override — lands the exact write read-only denied', async () => {
    const workdir = await tempDir(homedir())
    const bash = await sandboxedBash(workdir, 'read-only')
    const command = `printf escalated > ${workdir}/escalated.txt`
    const strict = await bash.run(bash.resolve({ command }))
    expect(strict.exitCode).not.toBe(0)
    expect(strict.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    expect(existsSync(join(workdir, 'escalated.txt'))).toBe(false)
    const retried = await bash.run(bash.resolve({ command, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workdir } }))
    expect(retried.exitCode).toBe(0)
    expect(retried.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(readFileSync(join(workdir, 'escalated.txt'), 'utf8')).toBe('escalated')
  })
})
