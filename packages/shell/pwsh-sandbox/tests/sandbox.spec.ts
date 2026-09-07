/**
 * Consumer-side `SandboxPwshExecutor` tests. A fake Cordis sandbox service
 * makes wrapping, policy hand-off, fail-closed propagation, and fact stamping
 * deterministic; real-provider integration lives in `tests/acl.e2e.ts`.
 * Requires pwsh for the integration block (skips without it — same gate as
 * pwsh-local's suites); the helpers block is pure and always runs.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, RunnerFailureRule, SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SandboxPwshExecutor } from '../src/index.ts'
import { classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from '../src/helpers.ts'

// The same probe pwsh-local's suites and the vitest coverage exemption use:
// spawnSync never throws on a missing binary (it reports status null), and
// `where.exe pwsh` exits 1 when pwsh is absent — only the status is truth.
function pwshAvailable(): boolean {
  return spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0
}

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-pwsh-sandbox-spec-'))

/** One recorded provider call: the argv handed over and the policy it rode with. */
interface ConfineCall {
  argv: string[]
  policy: SandboxPolicy
}

/** A passthrough wrap: the caller's argv unchanged, asserted full — commands run unconfined, deterministically. */
const passthrough = (argv: readonly string[]): ConfinedArgv =>
  ({ argv: [...argv], enforcement: 'full', denialSignatures: ['access is denied', 'access to the path'], runnerFailureRules: [] })

/** A subprocess service whose spawn() throws SYNCHRONOUSLY — the paths the async service never produces. */
function throwingSubprocessRuntime(error: unknown): new (ctx: Context) => Service {
  return class extends Service {
    constructor(ctx: Context) {
      super(ctx, 'subprocess')
    }

    spawn(): never {
      throw error
    }
  }
}

async function setup(
  behavior: (argv: readonly string[], policy: SandboxPolicy) => ConfinedArgv = passthrough,
  subprocess: new (ctx: Context) => Service = LocalSubprocessRuntime,
): Promise<{ executor: SandboxPwshExecutor; calls: ConfineCall[] }> {
  const calls: ConfineCall[] = []
  class FakeSandboxProvider extends SandboxProvider {
    confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
      calls.push({ argv: [...argv], policy })
      return behavior(argv, policy)
    }
  }
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: spillDir })
  await ctx.plugin(subprocess)
  if (ctx.subprocess instanceof LocalSubprocessRuntime) {
    ctx.subprocess.internals = { spillDir }
  }
  await ctx.plugin(SandboxPwshExecutor, { graceMs: 200 })
  return { executor: ctx.shell as SandboxPwshExecutor, calls }
}

describe('helpers (pure)', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-pwsh-sandbox-helpers-'))
  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  describe('isRunnerSpawnFailure', () => {
    const absolute = process.execPath
    const bare = 'node'
    const relative = './sandbox-runner'

    it('attributes ENOENT/EACCES with argv[0] provenance and a usable workdir', () => {
      for (const runnerProgram of [absolute, bare, relative]) {
        expect(isRunnerSpawnFailure({ code: 'ENOENT', syscall: `spawn ${runnerProgram}`, path: runnerProgram }, runnerProgram, workdir)).toBe(true)
        expect(isRunnerSpawnFailure({ code: 'EACCES', syscall: `spawn ${runnerProgram}`, path: runnerProgram }, runnerProgram, workdir)).toBe(true)
        expect(isRunnerSpawnFailure({ code: 'ENOENT', syscall: 'spawn', path: runnerProgram }, runnerProgram, workdir)).toBe(true)
        expect(isRunnerSpawnFailure({ code: 'ENOENT', syscall: `spawn ${runnerProgram}` }, runnerProgram, workdir)).toBe(true)
      }
    })

    it('rejects mismatched provenance, foreign codes, unusable workdirs, and non-object errors', () => {
      expect(isRunnerSpawnFailure({ code: 'ENOENT', syscall: 'spawn', path: 'other' }, 'node', workdir)).toBe(false)
      expect(isRunnerSpawnFailure({ code: 'ENOENT', syscall: 'spawn other', path: 'node' }, 'node', workdir)).toBe(false)
      expect(isRunnerSpawnFailure({ code: 'EMFILE', syscall: 'spawn', path: 'node' }, 'node', workdir)).toBe(false)
      expect(isRunnerSpawnFailure({ code: 'ENOENT', path: 'node' }, 'node', workdir)).toBe(false)
      expect(isRunnerSpawnFailure({ code: 'ENOENT', syscall: 'spawn' }, 'node', join(workdir, 'missing'))).toBe(false)
      expect(isRunnerSpawnFailure({ code: 'ENOENT', syscall: 'spawn' }, undefined, workdir)).toBe(false)
      expect(isRunnerSpawnFailure('boom', 'node', workdir)).toBe(false)
      expect(isRunnerSpawnFailure(null, 'node', workdir)).toBe(false)
      // An existing FILE (not a directory) workdir is unusable without throwing.
      const fileWorkdir = join(workdir, 'a-file')
      writeFileSync(fileWorkdir, 'x')
      expect(isRunnerSpawnFailure({ code: 'ENOENT', syscall: 'spawn', path: 'node' }, 'node', fileWorkdir)).toBe(false)
    })
  })

  describe('classifyRunnerFailure', () => {
    const rules: readonly RunnerFailureRule[] = [{
      allowedExitCodes: [127],
      fatalSignatures: ['fake-runner: '],
      informationalLines: ['fake-runner: partial enforcement'],
    }]

    it('matches a fatal signature on a gated exit code, skipping informational lines', () => {
      expect(classifyRunnerFailure(127, 'fake-runner: partial enforcement\nfake-runner: profile refused\n', rules))
        .toEqual({ detail: 'fake-runner: profile refused' })
    })

    it('rejects zero/null exits, gate mismatches, and empty signatures', () => {
      expect(classifyRunnerFailure(0, 'fake-runner: x', rules)).toBeUndefined()
      expect(classifyRunnerFailure(null, 'fake-runner: x', rules)).toBeUndefined()
      expect(classifyRunnerFailure(1, 'fake-runner: x', rules)).toBeUndefined()
      expect(classifyRunnerFailure(127, 'clean output', rules)).toBeUndefined()
      expect(classifyRunnerFailure(127, 'fake-runner: x', [{ fatalSignatures: ['  '] }])).toBeUndefined()
    })

    it('the windows-acl rule is exit-gated on 127: a confined command that merely prints the signature on a non-127 exit is NOT a runner failure', () => {
      const windowsAclRules: readonly RunnerFailureRule[] = [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }]
      expect(classifyRunnerFailure(3, 'windows-acl-run: something the command printed', windowsAclRules)).toBeUndefined()
      expect(classifyRunnerFailure(127, 'windows-acl-run: missing --workspace', windowsAclRules))
        .toEqual({ detail: 'windows-acl-run: missing --workspace' })
    })
  })

  describe('matchesSignature', () => {
    it('matches non-zero exits case-insensitively, never zero or signal exits', () => {
      expect(matchesSignature(1, 'Access to the path is denied.', ['access to the path'])).toBe(true)
      expect(matchesSignature(1, 'ACCESS IS DENIED.', ['access is denied'])).toBe(true)
      expect(matchesSignature(1, 'clean', ['access is denied'])).toBe(false)
      expect(matchesSignature(0, 'access is denied', ['access is denied'])).toBe(false)
      expect(matchesSignature(null, 'access is denied', ['access is denied'])).toBe(false)
    })
  })
})

describe.skipIf(!pwshAvailable())('SandboxPwshExecutor', () => {
  // Denial device for the POSIX classification cases: a mode-0555 directory
  // INSIDE a temp scratch tree (the same device as bash-sandbox's suites) —
  // unit tests never attempt writes outside the system temp directory. On
  // win32 there is no POSIX mode denial; the real-sandbox denial coverage
  // lives in tests/acl.e2e.ts, where the ACL runner denies scratch paths.
  const readOnlyDir = mkdtempSync(join(tmpdir(), 'dsh-pwsh-sandbox-ro-'))
  if (process.platform !== 'win32') chmodSync(readOnlyDir, 0o555)
  const deniedWriteCommand = `[IO.File]::WriteAllText('${join(readOnlyDir, 'probe.txt')}', 'x')`

  afterAll(() => {
    if (process.platform !== 'win32') chmodSync(readOnlyDir, 0o755)
    rmSync(readOnlyDir, { recursive: true, force: true })
    rmSync(spillDir, { recursive: true, force: true })
  })

  const RO: SandboxExecutionPolicy = { mode: 'read-only', workspaceRoot: '/ws' }

  it('wraps the exact pwsh argv through ctx.sandbox with the per-call policy', async () => {
    const { executor, calls } = await setup()
    const result = await executor.run(executor.resolve({ command: 'echo wrapped', sandboxPolicy: RO }))
    expect(result.exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.policy).toEqual(RO)
    // The confined argv is the pwsh invocation, ready for a runner prefix.
    expect(call?.argv[0]).toMatch(/pwsh(\.exe)?$/u)
    expect(call?.argv).toContain('-NonInteractive')
    expect(call?.argv.at(-1)).toContain('echo wrapped')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  }, 30_000)

  it('advertises the deployment default mode and stamps the deployment policy when none rides the request', async () => {
    const { executor, calls } = await setup()
    expect(executor.sandboxMode).toBe('workspace-write')
    const result = await executor.run(executor.resolve({ command: 'echo fallback' }))
    expect(result.exitCode).toBe(0)
    expect(calls[0]?.policy.mode).toBe('workspace-write')
  }, 30_000)

  it('danger-full-access bypasses confine entirely and stamps full-access facts', async () => {
    const { executor, calls } = await setup()
    const result = await executor.run(executor.resolve({ command: 'echo full', sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/ws' } }))
    expect(result.exitCode).toBe(0)
    expect(calls).toHaveLength(0)
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
  }, 30_000)

  it('an aborted caller signal outranks runner-spawn attribution', async () => {
    const controller = new AbortController()
    controller.abort('caller-cancel')
    const { executor } = await setup(() => ({
      argv: ['definitely-not-a-real-runner', '--', 'pwsh'],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }))
    await expect(executor.run(executor.resolve({ command: 'echo never', sandboxPolicy: RO, signal: controller.signal })))
      .rejects.toThrow('caller-cancel')
  }, 30_000)

  // POSIX-only: the denial device is a mode-0555 scratch dir. On win32 the
  // real-sandbox denial classification is covered by tests/acl.e2e.ts
  // (the ACL runner denies scratch paths — unit tests never leave temp).
  it.skipIf(process.platform === 'win32')('classifies a failed write against the backend denial dialect', async () => {
    const { executor } = await setup()
    const result = await executor.run(executor.resolve({
      command: deniedWriteCommand,
      sandboxPolicy: RO,
    }))
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
  }, 30_000)

  it('a runner launch refusal fails closed with SANDBOX_UNAVAILABLE, never unconfined', async () => {
    const { executor } = await setup(() => ({
      argv: ['definitely-not-a-real-runner', '--', 'pwsh'],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [{ fatalSignatures: ['fake-runner: '] }],
    }))
    await expect(executor.run(executor.resolve({ command: 'echo never-runs', sandboxPolicy: RO })))
      .rejects.toThrow(SandboxUnavailableError)
  }, 30_000)

  it('a SYNCHRONOUS attributable spawn rejection in run() fails closed, an unattributable one rethrows', async () => {
    const attributable = Object.assign(new Error('sync-enoent'), { code: 'ENOENT', syscall: 'spawn node', path: 'node' })
    const { executor: closed } = await setup(() => ({
      argv: ['node', '--', 'pwsh'],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [{ fatalSignatures: ['fake-runner: '] }],
    }), throwingSubprocessRuntime(attributable))
    await expect(closed.run(closed.resolve({ command: 'echo never', sandboxPolicy: RO })))
      .rejects.toThrow(SandboxUnavailableError)

    const foreign = Object.assign(new Error('sync-emfile'), { code: 'EMFILE', syscall: 'spawn', path: 'node' })
    const { executor: passthroughError } = await setup(undefined, throwingSubprocessRuntime(foreign))
    await expect(passthroughError.run(passthroughError.resolve({ command: 'echo never', sandboxPolicy: RO })))
      .rejects.toThrow('sync-emfile')
  }, 30_000)

  it('a SYNCHRONOUS spawn rejection in start() follows the same attribution split', async () => {
    const attributable = Object.assign(new Error('sync-enoent-start'), { code: 'ENOENT', syscall: 'spawn node', path: 'node' })
    const { executor: closed } = await setup(() => ({
      argv: ['node', '--', 'pwsh'],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [{ fatalSignatures: ['fake-runner: '] }],
    }), throwingSubprocessRuntime(attributable))
    expect(() => closed.start(closed.resolve({ command: 'echo never', sandboxPolicy: RO })))
      .toThrow(SandboxUnavailableError)

    const foreign = Object.assign(new Error('sync-emfile-start'), { code: 'EMFILE', syscall: 'spawn', path: 'node' })
    const { executor: passthroughError } = await setup(undefined, throwingSubprocessRuntime(foreign))
    expect(() => passthroughError.start(passthroughError.resolve({ command: 'echo never', sandboxPolicy: RO })))
      .toThrow('sync-emfile-start')
  }, 30_000)

  it('a runner that REFUSES at runtime (fatal signature, nonzero exit) fails closed too', async () => {
    const { executor } = await setup(() => ({
      argv: [process.execPath, '-e', 'console.error(\'fake-runner: profile refused\'); process.exit(127)', '--'],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [{ fatalSignatures: ['fake-runner: '] }],
    }))
    await expect(executor.run(executor.resolve({ command: 'echo never-runs', sandboxPolicy: RO })))
      .rejects.toThrow(SandboxUnavailableError)
  }, 30_000)

  it('background confined runs stamp clean facts at settlement', async () => {
    const { executor } = await setup()
    const clean = executor.start(executor.resolve({ command: 'echo background-ok', sandboxPolicy: RO }))
    await clean.done
    expect(clean.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  }, 30_000)

  // POSIX-only denial device (mode-0555 scratch); win32 real-sandbox denial
  // coverage lives in tests/acl.e2e.ts.
  it.skipIf(process.platform === 'win32')('background denied writes stamp denied facts at settlement', async () => {
    const { executor } = await setup()
    const denied = executor.start(executor.resolve({
      command: deniedWriteCommand,
      sandboxPolicy: RO,
    }))
    await denied.done
    expect(denied.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
  }, 30_000)

  it('background provider rejections with runner provenance settle as runnerFailed facts', async () => {
    const { executor } = await setup(() => ({
      argv: ['definitely-not-a-real-runner', '--', 'pwsh'],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [{ fatalSignatures: ['fake-runner: '] }],
    }))
    const proc = executor.start(executor.resolve({ command: 'echo never', sandboxPolicy: RO }))
    await proc.done
    expect(proc.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full', runnerFailed: true })
    // The failure note surfaces through the read path.
    const read = proc.readOutput()
    expect(read.delta).toContain('subprocess failed before reporting an outcome')
  }, 30_000)

  it('danger-full-access background runs bypass confine and carry no facts', async () => {
    const { executor, calls } = await setup()
    const proc = executor.start(executor.resolve({
      command: 'echo full-bg',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/ws' },
    }))
    await proc.done
    expect(calls).toHaveLength(0)
    expect(proc.sandbox).toBeUndefined()
  }, 30_000)
})
