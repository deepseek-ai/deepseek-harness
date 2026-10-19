import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { seatbeltProfileArgs } from '../src/profiles.ts'
import { checkExtraWrites, checkRedirectedRoot } from './extra-roots.ts'

/**
 * Keyless backend integration through `confine()` and a real macOS Seatbelt process, with Linux
 * rungs forced off. Tests assert world effects and that the kernel denial matches the advertised
 * dialect; consumer coverage lives in dsh-bash-sandbox. Skips off macOS or when the profile probe
 * fails. HOME-based workspaces avoid Seatbelt's wholesale temp-directory grants, so
 * workspace-write proves the workspace-root grant itself.
 */

const probe = spawnSync('sandbox-exec', [...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const seatbeltUsable = probe.status === 0
const gitUsable = spawnSync('git', ['--version'], { timeout: 5_000, stdio: 'ignore' }).status === 0

/** Quote one path for the confined `bash -c` command line. */
function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

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

async function provider(): Promise<LocalSandboxProvider> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { probeBwrap: () => false, probeLandlock: () => 'unusable' }
  return sandbox
}

/** Confine a shell command under `policy` and run it for real; returns the spawn result and the wrap's facts. */
async function runConfined(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy, env?: NodeJS.ProcessEnv) {
  const confined = await sandbox.confine(['bash', '-c', command], policy)
  const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8', env })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return { result, confined }
}

describe.skipIf(!seatbeltUsable)('sandbox-local: real Seatbelt confinement through sandbox-exec', () => {
  it('grants explicit directories while denying unrelated and read-only writes', async () => {
    await checkExtraWrites(await provider(), tempDir)
  })
  it('rejects a directory grant redirected by a confined command', async () => {
    await checkRedirectedRoot(await provider(), tempDir)
  })
  it('read-only denies a write — the file must NOT exist, and the kernel speaks the advertised dialect', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result, confined } = await runConfined(sandbox, `echo hi > ${workdir}/denied.txt`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    expect(confined.enforcement).toBe('full')
    // The wrap's denialSignatures must be what the kernel actually prints.
    expect(result.stderr.toLowerCase()).toContain('operation not permitted')
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('read-only keeps the tree readable/executable and /dev/null writable', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, 'ls / > /dev/null && echo dev-ok', { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('dev-ok\n')
  })

  it('read-only grants no temp area: a write under the user temp dir is denied too', async () => {
    // The per-user darwin temp dir is a workspace-write grant, not a
    // read-only one — under read-only the only write-shaped path is /dev/null.
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const target = join(workdir, 'tmp-denied.txt')
    const { result } = await runConfined(sandbox, `echo hi > ${target}`, { mode: 'read-only', workspaceRoot: await tempDir(homedir()) })
    expect(result.status).not.toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  it('workspace-write lands a write inside the workspace root and still denies one beside it', async () => {
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const sandbox = await provider()

    const inside = await runConfined(sandbox, `printf seatbelt-ok > ${workdir}/allowed.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(inside.result.status).toBe(0)
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('seatbelt-ok')

    const denied = await runConfined(sandbox, `echo hi > ${outside}/denied.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(denied.result.status).not.toBe(0)
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
  })

  it('workspace-write grants /tmp and the user temp dir (the documented Seatbelt-profile temp areas)', async () => {
    const workdir = await tempDir(homedir())
    const hostTmp = await tempDir('/tmp')
    const userTmp = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(
      sandbox,
      `printf tmp-ok > ${quote(join(hostTmp, 'scratch.txt'))} && printf user-tmp-ok > ${quote(join(userTmp, 'scratch.txt'))}`,
      { mode: 'workspace-write', workspaceRoot: workdir },
    )
    expect(result.status).toBe(0)
    expect(readFileSync(join(hostTmp, 'scratch.txt'), 'utf8')).toBe('tmp-ok')
    expect(readFileSync(join(userTmp, 'scratch.txt'), 'utf8')).toBe('user-tmp-ok')
  })

  it.skipIf(!gitUsable).each(['inside', 'outside'])('allows a linked worktree %s the repository to stage and commit with an explicit Git grant', async (placement) => {
    // HOME-based roots keep both fixtures outside the Seatbelt temp grants, so
    // the extra grant is what makes the common git directory writable.
    const primary = await tempDir(homedir())
    const linked = placement === 'inside'
      ? join(primary, '.agents', 'worktrees', 'linked')
      : join(await tempDir(homedir()), 'linked')
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'DSH Test',
      GIT_AUTHOR_EMAIL: 'dsh-test@example.invalid',
      GIT_COMMITTER_NAME: 'DSH Test',
      GIT_COMMITTER_EMAIL: 'dsh-test@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    }
    execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: gitEnv })
    writeFileSync(join(primary, 'tracked.txt'), 'one\n')
    writeFileSync(join(primary, 'source.txt'), 'source\n')
    execFileSync('git', ['-C', primary, 'add', 'tracked.txt'], { env: gitEnv })
    execFileSync('git', ['-C', primary, 'commit', '-qm', 'init'], { env: gitEnv })
    execFileSync('git', ['-C', primary, 'worktree', 'add', '-q', linked], { env: gitEnv })
    writeFileSync(join(linked, 'linked.txt'), 'linked\n')
    const sandbox = await provider()
    const addCommand = `cd ${quote(linked)} && git add linked.txt && git -c commit.gpgSign=false commit -qm linked`

    const baseline = await runConfined(sandbox, addCommand, { mode: 'workspace-write', workspaceRoot: linked }, gitEnv)
    expect(baseline.result.status).not.toBe(0)
    expect(baseline.result.stderr).toContain('index.lock')

    const gitDir = realpathSync.native(join(primary, '.git'))
    const allowed = await runConfined(sandbox, addCommand, {
      mode: 'workspace-write',
      workspaceRoot: linked,
      additionalWritableRoots: [gitDir],
    }, gitEnv)
    expect(allowed.result.status, allowed.result.stderr).toBe(0)
    expect(execFileSync('git', ['-C', linked, 'show', 'HEAD:linked.txt'], { env: gitEnv, encoding: 'utf8' })).toBe('linked\n')
    expect(existsSync(join(primary, 'source.txt'))).toBe(true)

    const denied = await runConfined(sandbox, `printf hijack > ${quote(join(primary, 'source.txt'))}`, {
      mode: 'workspace-write',
      workspaceRoot: linked,
      additionalWritableRoots: [gitDir],
    })
    expect(denied.result.status).not.toBe(0)
    expect(readFileSync(join(primary, 'source.txt'), 'utf8')).toBe('source\n')
    const readOnly = await runConfined(sandbox, `printf denied > ${quote(join(gitDir, 'denied.txt'))}`, {
      mode: 'read-only', workspaceRoot: linked, additionalWritableRoots: [gitDir],
    })
    expect(readOnly.result.status).not.toBe(0)
    expect(existsSync(join(gitDir, 'denied.txt'))).toBe(false)
  })
})
