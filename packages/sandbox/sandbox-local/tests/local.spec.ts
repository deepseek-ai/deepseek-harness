/**
 * LocalSandboxProvider tests. No real runner is assumed to exist on the test
 * host: `runnerCommand` injects deterministic runner argvs, and `internals`
 * injects probe verdicts plus fake Landlock launcher / `sandbox-exec`
 * scripts, so profile dialects, ladder selection, verdict caching,
 * probe-report parsing, per-rung denial signatures, and fail-closed behavior
 * are all exercised through the real `confine()` path.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LAUNCHER_FAILURE_EXIT } from '@deepseek-ai/node-addon-landlock-run'
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import {
  LocalSandboxProvider,
} from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

const RO: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' }
const WW: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/ws' }

/** Every temp dir created by this file (fake launchers and runner entries), removed after each test. */
const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(config: Config = {}, internals: LocalSandboxProvider['internals'] = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, config)
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = internals
  return { ctx, sandbox }
}

/**
 * A path inside a fresh temp dir where no file is written, pinning the
 * built-entry `existsSync` check to false. Without it the resolution depends on
 * whether the checkout has run `build:lib:host`, which emits
 * `sandbox-windows-acl/lib/runner.js`.
 */
function absentRunnerEntry(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-absent-acl-entry-'))
  tempDirs.push(dir)
  return join(dir, 'runner.js')
}

/** Write an executable fake `landlock-run` that answers `--probe` with `report`. */
function fakeLauncher(report = 'landlock: fully enforced'): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-landlock-'))
  tempDirs.push(dir)
  const launcher = join(dir, 'landlock-run')
  writeFileSync(launcher, `#!/bin/sh\nif [ "$1" = "--probe" ]; then echo "${report}"; exit 0; fi\nexit ${LAUNCHER_FAILURE_EXIT}\n`, { mode: 0o755 })
  return launcher
}

/** Write an executable fake `sandbox-exec` that exits `status` for any invocation. */
function fakeSeatbeltExec(status: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-seatbelt-'))
  tempDirs.push(dir)
  const exec = join(dir, 'sandbox-exec')
  writeFileSync(exec, `#!/bin/sh\nexit ${status}\n`, { mode: 0o755 })
  return exec
}

/** The seatbelt read-only profile — every seatbelt profile starts with these forms. */
const SEATBELT_RO_PROFILE = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))'

describe('profile dialects', () => {
  it('bwrap read-only: whole tree read-only with fresh /dev and private PID-scoped /proc, no writable mounts', () => {
    expect(bwrapProfileArgs(RO)).toEqual(['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent'])
  })

  it('bwrap workspace-write: adds an ephemeral /tmp and rebinds the workspace root', () => {
    expect(bwrapProfileArgs(WW)).toEqual([
      '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent',
      '--tmpfs', '/tmp', '--bind', '/ws', '/ws',
    ])
  })

  it('landlock read-only: readable tree plus a writable /dev/null, nothing else', () => {
    // /dev/null specifically, NOT /dev: a whole-/dev grant would let confined
    // commands write real host paths beneath it (/dev/shm) under read-only.
    expect(landlockProfileArgs(RO)).toEqual(['--ro', '/', '--rw', '/dev/null'])
  })

  it('landlock workspace-write: adds the host /tmp and the workspace root', () => {
    expect(landlockProfileArgs(WW)).toEqual(['--ro', '/', '--rw', '/dev/null', '--rw', '/tmp', '--rw', '/ws'])
  })

  it('seatbelt read-only: allow-default with every file write denied except the /dev/null literal', () => {
    expect(seatbeltProfileArgs(RO)).toEqual(['-p', SEATBELT_RO_PROFILE])
  })

  it('seatbelt workspace-write: one more allow for the canonicalized workspace root, /tmp, and the user temp dir', () => {
    // `/ws` does not exist, so it is granted as spelled (the canonicalization
    // fallback); `/tmp` and `os.tmpdir()` exist everywhere and are granted
    // CANONICALIZED — Seatbelt matches resolved paths (`/tmp` IS
    // `/private/tmp` on macOS), and both collapse to one grant on hosts
    // where they resolve to the same directory.
    const roots = [...new Set(['/ws', realpathSync('/tmp'), realpathSync(tmpdir())])]
    const allow = `(allow file-write* ${roots.map(root => `(subpath "${root}")`).join(' ')})`
    expect(seatbeltProfileArgs(WW)).toEqual(['-p', `${SEATBELT_RO_PROFILE} ${allow}`])
  })

  it('seatbelt workspace-write dedups a workspace root that already IS the temp dir', () => {
    const profile = seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: tmpdir() })[1] as string
    const grant = `(subpath "${realpathSync(tmpdir())}")`
    expect(profile).toContain(grant)
    expect(profile.split(grant)).toHaveLength(2)
  })
})

describe('runnerCommand config', () => {
  it('a non-empty runnerCommand skips the chain: runner argv + bwrap-shaped profile + -- + caller argv, asserted full', async () => {
    const probeBwrap = vi.fn(() => false)
    const probeLandlock = vi.fn(() => 'unusable' as const)
    const probeSeatbelt = vi.fn(() => false)
    const { sandbox } = await setup({
      runnerCommand: ['fake-runner', '--flag'],
      runnerFailureSignatures: ['fake-runner: profile rejected'],
    }, { probeBwrap, probeLandlock, probeSeatbelt })
    const confined = sandbox.confine(['bash', '-c', 'echo hi'], WW)
    expect(confined).toEqual({
      argv: ['fake-runner', '--flag', ...bwrapProfileArgs(WW), '--', 'bash', '-c', 'echo hi'],
      enforcement: 'full',
      // An operator runner's kernel mechanism is unknown: both Linux
      // file-denial dialects, never bare EPERM.
      denialSignatures: ['read-only file system', 'permission denied'],
      runnerFailureRules: [{ fatalSignatures: ['fake-runner: profile rejected'] }],
    })
    expect(probeBwrap).not.toHaveBeenCalled()
    expect(probeLandlock).not.toHaveBeenCalled()
    expect(probeSeatbelt).not.toHaveBeenCalled()
  })

  it('an EMPTY runnerCommand means unconfigured: the platform chain still gates the wrap', async () => {
    const probeBwrap = vi.fn(() => false)
    const { sandbox } = await setup({ runnerCommand: [] }, { platform: 'linux', probeBwrap, probeLandlock: () => 'unusable' })
    expect(() => sandbox.confine(['true'], RO)).toThrow(SandboxUnavailableError)
    expect(probeBwrap).toHaveBeenCalledTimes(1)
  })

  it('requires an operator-owned failure dialect for every configured runner', async () => {
    await expect(setup({ runnerCommand: ['fake-runner'] })).rejects.toThrow(
      'runnerCommand requires at least one runnerFailureSignatures entry',
    )
  })

  it('rejects runner failure signatures when no custom runner consumes them', async () => {
    await expect(setup({ runnerFailureSignatures: ['profile rejected'] })).rejects.toThrow(
      'runnerFailureSignatures requires runnerCommand',
    )
  })

  it.each(['  ', 'fatal\ncontinued', 'fatal\rcontinued'])(
    'rejects an unusable configured-runner failure signature %j',
    async (signature) => {
      await expect(setup({ runnerCommand: ['fake-runner'], runnerFailureSignatures: [signature] })).rejects.toThrow(
        'runnerFailureSignatures entries must be non-empty single-line strings',
      )
    },
  )
})

describe('the platform chains', () => {
  it('linux probes bwrap first: a passing probe wraps with the bwrap dialect at full enforcement', async () => {
    const probeBwrap = vi.fn(() => true)
    const probeLandlock = vi.fn(() => 'full' as const)
    const { sandbox } = await setup({}, { platform: 'linux', probeBwrap, probeLandlock })
    const confined = sandbox.confine(['true'], RO)
    expect(confined).toEqual({
      argv: ['bwrap', ...bwrapProfileArgs(RO), '--', 'true'],
      enforcement: 'full',
      denialSignatures: ['read-only file system'],
      runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }],
    })
    expect(probeLandlock).not.toHaveBeenCalled()
  })

  it('linux falls back to the launcher when the bwrap probe fails, speaking the landlock dialect', async () => {
    const probeBwrap = vi.fn(() => false)
    const probeLandlock = vi.fn(() => 'full' as const)
    const launcher = fakeLauncher()
    const { sandbox } = await setup({}, { platform: 'linux', probeBwrap, probeLandlock, landlockLauncher: launcher })
    const confined = sandbox.confine(['bash', '-c', 'echo hi'], WW)
    expect(confined).toEqual({
      argv: [launcher, ...landlockProfileArgs(WW), '--', 'bash', '-c', 'echo hi'],
      enforcement: 'full',
      denialSignatures: ['permission denied'],
      runnerFailureRules: [{
        allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
        fatalSignatures: ['landlock-run: '],
        informationalLines: ['landlock-run: partial enforcement (older Landlock ABI)'],
      }],
    })
    expect(probeLandlock).toHaveBeenCalledWith(launcher)
  })

  it('darwin selects its sole candidate WITHOUT probing: nothing to arbitrate', async () => {
    // The safety property moves to execution time: an unusable sandbox-exec
    // refuses to run the command, and the wrap's runnerFailureRules let
    // the consumer classify that as a sandbox failure, not a task failure.
    const probeSeatbelt = vi.fn(() => true)
    const { sandbox } = await setup({}, { platform: 'darwin', probeSeatbelt })
    const confined = sandbox.confine(['bash', '-c', 'echo hi'], RO)
    expect(confined).toEqual({
      argv: ['sandbox-exec', ...seatbeltProfileArgs(RO), '--', 'bash', '-c', 'echo hi'],
      enforcement: 'full',
      denialSignatures: ['operation not permitted'],
      runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }],
    })
    expect(probeSeatbelt).not.toHaveBeenCalled()
  })

  it('a platform with no chain fails closed without a single probe: the command never runs', async () => {
    const probeBwrap = vi.fn(() => true)
    const probeLandlock = vi.fn(() => 'full' as const)
    const probeSeatbelt = vi.fn(() => true)
    const { sandbox } = await setup({}, { platform: 'freebsd', probeBwrap, probeLandlock, probeSeatbelt })
    expect(() => sandbox.confine(['true'], RO)).toThrow(expect.objectContaining({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE }))
    expect(probeBwrap).not.toHaveBeenCalled()
    expect(probeLandlock).not.toHaveBeenCalled()
    expect(probeSeatbelt).not.toHaveBeenCalled()
  })

  // The win32 chain's argv contract, denial dialect, and runner-failure rules
  // live in @deepseek-ai/dsh-sandbox-windows-acl/tests/provider-chain.spec.ts
  // (platform-independent assertions that run in every CI lane, including
  // Windows where this package's POSIX-only suites are excluded).

  it('caches the verdict for the provider lifetime: one chain walk across wraps', async () => {
    const probeBwrap = vi.fn(() => true)
    const { sandbox } = await setup({}, { platform: 'linux', probeBwrap })
    sandbox.confine(['true'], RO)
    sandbox.confine(['true'], WW)
    expect(probeBwrap).toHaveBeenCalledTimes(1)
  })

  it('the unavailable verdict is cached too, and the error is structured', async () => {
    const probeBwrap = vi.fn(() => false)
    const probeLandlock = vi.fn(() => 'unusable' as const)
    const { sandbox } = await setup({}, { platform: 'linux', probeBwrap, probeLandlock })
    expect(() => sandbox.confine(['true'], RO)).toThrow(expect.objectContaining({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE }))
    expect(() => sandbox.confine(['true'], RO)).toThrow(SandboxUnavailableError)
    expect(probeBwrap).toHaveBeenCalledTimes(1)
    expect(probeLandlock).toHaveBeenCalledTimes(1)
  })

  it('a multi-rung chain probes a seatbelt rung like any other (the walk, not the platform table, decides)', async () => {
    // The product chains reach seatbelt only as darwin's sole (unprobed)
    // candidate; the probe chain exercises the path it would take in
    // a grown chain, keeping the default seatbelt probe honest.
    const exec = fakeSeatbeltExec(0)
    const probeBwrap = vi.fn(() => false)
    const { sandbox } = await setup({}, { chain: ['bwrap', 'seatbelt'], probeBwrap, seatbeltExec: exec })
    const confined = sandbox.confine(['true'], RO)
    expect(confined.argv[0]).toBe(exec)
    expect(confined.enforcement).toBe('full')
    expect(probeBwrap).toHaveBeenCalledTimes(1)
  })

  it('a rogue chain entry throws via the probe walk\'s exhaustiveness guard (closed union)', async () => {
    // Same convention as the wrap switch below: the union is closed, so a runner added later
    // fails to compile at the probe switch instead of silently selecting without a probe.
    const { sandbox } = await setup({}, { chain: ['chroot', 'bwrap'] as unknown as readonly ['bwrap'] })
    expect(() => sandbox.confine(['true'], RO)).toThrow('unreachable variant')
  })

  it('a rogue cached runner tag throws via the exhaustiveness guard (closed union)', async () => {
    // Only a cast can create this rogue closed-union tag. It must hit `assertNever`, ensuring a new
    // runner cannot silently use another runner's wrap or denial dialect.
    const { sandbox } = await setup()
    ;(sandbox as unknown as { selectedRunner: unknown }).selectedRunner = { runner: 'chroot', enforcement: 'full' }
    expect(() => sandbox.confine(['true'], RO)).toThrow('unreachable variant')
  })

  it('runs the real default probes on the linux chain when none are injected (usable here or fail closed there)', async () => {
    // Pinning the platform (not the probes) makes the REAL defaultProbeBwrap
    // spawn run on every host: bwrap answers on a Linux box, ENOENT reads as
    // an unusable rung anywhere else — either way the walk is genuine.
    const { sandbox } = await setup({}, { platform: 'linux' })
    const verdict = (() => {
      try {
        sandbox.confine(['true'], RO)
        return 'usable'
      } catch (error: unknown) {
        if (error instanceof SandboxUnavailableError) return 'unavailable'
        throw error
      }
    })()
    expect(['usable', 'unavailable']).toContain(verdict)
  })

  it('walks the real platform chain when nothing is injected (usable here or fail closed there)', async () => {
    const { sandbox } = await setup({}, {})
    const verdict = (() => {
      try {
        sandbox.confine(['true'], RO)
        return 'usable'
      } catch (error: unknown) {
        if (error instanceof SandboxUnavailableError) return 'unavailable'
        throw error
      }
    })()
    expect(['usable', 'unavailable']).toContain(verdict)
  })
})

describe('the default landlock probe (launcher CLI contract)', () => {
  it('parses a fully-enforced probe report as full enforcement', async () => {
    const { sandbox } = await setup({}, { platform: 'linux', probeBwrap: () => false, landlockLauncher: fakeLauncher() })
    expect(sandbox.confine(['true'], RO).enforcement).toBe('full')
  })

  it('parses a partially-enforced (older-ABI) probe report as partial enforcement', async () => {
    const launcher = fakeLauncher('landlock: partially enforced (older ABI)')
    const { sandbox } = await setup({}, { platform: 'linux', probeBwrap: () => false, landlockLauncher: launcher })
    expect(sandbox.confine(['true'], RO).enforcement).toBe('partial')
  })

  it('reads a failing launcher as unusable: the chain ends and fails closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-landlock-'))
    tempDirs.push(dir)
    const launcher = join(dir, 'landlock-run')
    writeFileSync(launcher, `#!/bin/sh\nexit ${LAUNCHER_FAILURE_EXIT}\n`, { mode: 0o755 })
    const { sandbox } = await setup({}, { platform: 'linux', probeBwrap: () => false, landlockLauncher: launcher })
    expect(() => sandbox.confine(['true'], RO)).toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
  })
})

describe('probeTimeoutMs config', () => {
  it('rejects 0 at construction: Node treats a 0 spawnSync timeout as UNBOUNDED, the opposite of the field', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(LocalSandboxProvider, { probeTimeoutMs: 0 }))
      .rejects.toThrow(/probeTimeoutMs must be a positive finite number/)
  })

  it('bounds the default probes: a launcher slower than the configured timeout reads as unusable', async () => {
    // The same 1s launcher reads usable under a generous budget and unusable
    // under a 250ms one — the config demonstrably reaches spawnSync. Both bounds
    // keep a wide margin from the launcher's 1s runtime so a loaded host (where
    // spawnSync blocks the worker and fork/exec latency inflates wall-clock)
    // cannot flip either verdict; the vitest timeout clears the patient budget.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-slow-landlock-'))
    tempDirs.push(dir)
    const launcher = join(dir, 'landlock-run')
    writeFileSync(launcher, '#!/bin/sh\nsleep 1\necho "landlock: fully enforced"\nexit 0\n', { mode: 0o755 })

    const patient = await setup(
      { probeTimeoutMs: 15_000 },
      { platform: 'linux', probeBwrap: () => false, landlockLauncher: launcher },
    )
    expect(patient.sandbox.confine(['true'], RO).enforcement).toBe('full')

    const impatient = await setup(
      { probeTimeoutMs: 250 },
      { platform: 'linux', probeBwrap: () => false, landlockLauncher: launcher },
    )
    expect(() => impatient.sandbox.confine(['true'], RO)).toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
  }, 30_000)
})

describe('the default seatbelt probe (sandbox-exec contract)', () => {
  // The product chains reach seatbelt only unprobed (darwin's sole
  // candidate), so the default probe's contract is pinned through the provider
  // chain: a grown chain must probe it like any other rung.
  it('selects the rung when the executable applies the read-only profile and exits 0', async () => {
    const exec = fakeSeatbeltExec(0)
    const { sandbox } = await setup({}, { chain: ['bwrap', 'seatbelt'], probeBwrap: () => false, seatbeltExec: exec })
    const confined = sandbox.confine(['true'], RO)
    expect(confined).toEqual({
      argv: [exec, ...seatbeltProfileArgs(RO), '--', 'true'],
      enforcement: 'full',
      denialSignatures: ['operation not permitted'],
      runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }],
    })
  })

  it('reads a failing executable as unusable: the chain ends and fails closed', async () => {
    const { sandbox } = await setup({}, { chain: ['bwrap', 'seatbelt'], probeBwrap: () => false, seatbeltExec: fakeSeatbeltExec(1) })
    expect(() => sandbox.confine(['true'], RO)).toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
  })
})

describe('the windows-acl probe (runner invocation contract)', () => {
  // The product chain reaches windows-acl only unprobed (win32's sole
  // candidate), so the probe case and the runner-entry resolution are pinned
  // through the chain seam, mirroring the seatbelt default-probe contract.
  it('selects the rung when the injected probe passes, speaking the ACL dialect', async () => {
    const probeWindowsAcl = vi.fn(() => true)
    const { sandbox } = await setup({}, {
      chain: ['windows-acl', 'bwrap'],
      probeWindowsAcl,
      probeBwrap: () => false,
      windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'],
    })
    const confined = sandbox.confine(['true'], RO)
    expect(probeWindowsAcl).toHaveBeenCalledTimes(1)
    expect(confined.argv.slice(-4)).toEqual(['--mode', 'read-only', '--', 'true'])
    expect(confined.enforcement).toBe('partial')
    expect(confined.denialSignatures).toEqual(['access is denied', 'access to the path', 'permission denied'])
    expect(confined.runnerFailureRules).toEqual([{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }])
  })

  it('reads a failing probe as unusable and walks to the next rung', async () => {
    const probeWindowsAcl = vi.fn(() => false)
    const { sandbox } = await setup({}, { chain: ['windows-acl', 'bwrap'], probeWindowsAcl, probeBwrap: () => true })
    const confined = sandbox.confine(['true'], RO)
    expect(confined.argv[0]).toBe('bwrap')
    expect(probeWindowsAcl).toHaveBeenCalledTimes(1)
  })

  it('runs the REAL default probe against the resolved runner invocation when none is injected', async () => {
    // No entry injected: this covers the production resolution through
    // import.meta.resolve. Which arm of the existsSync check it takes depends
    // on whether the checkout has run build:lib:host (which emits
    // sandbox-windows-acl/lib/runner.js), so this asserts only what holds
    // either way — the runner cannot init off win32, so the probe reads
    // unusable and the walk falls through to the injected bwrap verdict.
    const { sandbox } = await setup({}, { chain: ['windows-acl', 'bwrap'], probeBwrap: () => true })
    const confined = sandbox.confine(['true'], RO)
    expect(confined.argv[0]).toBe('bwrap')
  }, 30_000)

  it('falls back to the runner source through tsx when the built entry is absent', async () => {
    // The absent entry pins the source-through-tsx arm regardless of build
    // state: on a checkout where build:lib:host has run, the real resolution
    // above takes the built-entry arm instead and would leave this uncovered.
    const { sandbox } = await setup({}, {
      chain: ['windows-acl', 'bwrap'],
      probeWindowsAcl: () => true,
      windowsAclRunnerEntry: absentRunnerEntry(),
    })
    const confined = sandbox.confine(['true'], RO)
    expect(confined.argv.slice(0, 3)).toEqual([process.execPath, '--import', 'tsx/esm'])
    expect(confined.argv[3]).toMatch(/runner\.ts$/)
  })

  it('reads an empty runner invocation as unusable (the probe\'s empty-argv guard)', async () => {
    // windowsAclRunnerInvocation always yields [node, ...] in product; an
    // override returning [] exercises the default probe's empty-argv guard.
    const { sandbox } = await setup({}, { chain: ['windows-acl', 'bwrap'], probeBwrap: () => true, windowsAclRunnerArgs: [] })
    const confined = sandbox.confine(['true'], RO)
    expect(confined.argv[0]).toBe('bwrap')
  })

  it('prefers the built lib/runner.js entry when the resolved file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-acl-entry-'))
    tempDirs.push(dir)
    const builtEntry = join(dir, 'runner.js')
    writeFileSync(builtEntry, '')
    const { sandbox } = await setup({}, {
      chain: ['windows-acl', 'bwrap'],
      probeWindowsAcl: () => true,
      windowsAclRunnerEntry: builtEntry,
    })
    const confined = sandbox.confine(['true'], RO)
    expect(confined.argv.slice(0, 2)).toEqual([process.execPath, builtEntry])
  })
})
