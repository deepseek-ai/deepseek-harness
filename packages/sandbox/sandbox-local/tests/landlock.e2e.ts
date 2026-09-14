import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { launcherPath } from '@deepseek-ai/node-addon-system/landlock-run'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

/**
 * Keyless backend integration through `confine()` and the workspace `landlock-run` launcher, with
 * bwrap forced off. Tests assert real world effects; consumer coverage lives in dsh-bash-sandbox.
 * Skips when the platform package or enforcing kernel is unavailable. HOME-based workspaces avoid
 * Landlock's wholesale `/tmp` grant, so workspace-write proves the workspace-root grant itself.
 */

const probe = spawnSync(launcherPath(), ['--probe'], { timeout: 5_000, encoding: 'utf8' })
const landlockUsable = probe.status === 0
/** The running kernel's enforcement level, from the launcher's probe report — every wrap below must carry exactly this. */
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

async function provider(): Promise<LocalSandboxProvider> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { probeBwrap: () => false }
  return sandbox
}

/** Confine a shell command under `policy` and run it for real; returns the spawn result and the wrap's enforcement. */
async function runConfined(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy) {
  const confined = await sandbox.confine(['bash', '-c', command], policy)
  const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
  return { result, enforcement: confined.enforcement }
}

describe.skipIf(!landlockUsable)('sandbox-local: real Landlock confinement through the bundled launcher', () => {
  it('read-only denies a write — the file must NOT exist, the wrap reports the probed enforcement', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result, enforcement: wrapped } = await runConfined(sandbox, `echo hi > ${workdir}/denied.txt`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    expect(wrapped).toBe(enforcement)
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('read-only keeps the tree readable/executable and /dev/null writable', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, 'ls / > /dev/null && echo dev-ok', { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('dev-ok\n')
  })

  it('read-only denies a write beneath the host /dev (the /dev/shm tmpfs must stay untouched)', async () => {
    // The grant is /dev/null the FILE, not /dev the directory: /dev/shm is a
    // world-writable host tmpfs, and a write landing there would be exactly
    // the persistent host effect read-only promises never happen.
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const target = `/dev/shm/dsh-landlock-e2e-${process.pid}`
    const { result } = await runConfined(sandbox, `echo hi > ${target}`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  it('workspace-write lands a write inside the workspace root and still denies one beside it', async () => {
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const sandbox = await provider()

    const inside = await runConfined(sandbox, `printf landlock-ok > ${workdir}/allowed.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(inside.result.status).toBe(0)
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('landlock-ok')

    const denied = await runConfined(sandbox, `echo hi > ${outside}/denied.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(denied.result.status).not.toBe(0)
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
  })

  it('workspace-write grants the host /tmp (the documented Landlock-profile difference)', async () => {
    const workdir = await tempDir(homedir())
    const scratch = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, `printf tmp-ok > ${scratch}/scratch.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(readFileSync(join(scratch, 'scratch.txt'), 'utf8')).toBe('tmp-ok')
  })
})
