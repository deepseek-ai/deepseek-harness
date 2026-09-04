/**
 * Consumer-side `SandboxBashExecutor` tests. A fake Cordis sandbox service makes wrapping,
 * policy hand-off, fail-closed propagation, classification, and fact stamping deterministic;
 * real-provider integration lives in `tests/landlock.e2e.ts`. A mode-0555 directory supplies
 * the Unix denial signature used by the classifier without requiring a real sandbox runner.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ShellRunResult, CollectedOutput } from '@deepseek-ai/dsh-shell'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SANDBOX_UNAVAILABLE, SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure } from '../src/helpers.ts'
import type { Config } from '@deepseek-ai/dsh-bash-sandbox'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-sandbox-spec-'))

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
})

/** One recorded provider call: the argv handed over and the policy it rode with. */
interface ConfineCall {
  argv: string[]
  policy: SandboxPolicy
}

/** The Linux file-denial dialects the fake wraps carry — matches the unix-permission denials the tests below produce. */
const UNIX_SIGNATURES = ['read-only file system', 'permission denied'] as const

/** The runner-failure rule the fake wraps carry (a fake-runner: error line marks the sandbox itself failing). */
const RUNNER_FAILURE = [{ fatalSignatures: ['fake-runner: '] }] as const

/** Provider argv[0] forms that all share the caller-owned cwd spawn precondition. */
const RUNNER_FORMS = [
  ['absolute', process.execPath],
  ['bare', 'node'],
  ['relative', './sandbox-runner'],
] as const

/** A passthrough wrap: the caller's argv unchanged, asserted full — commands run unconfined, deterministically. */
const passthrough = (argv: readonly string[]): ConfinedArgv =>
  ({ argv: [...argv], enforcement: 'full', denialSignatures: UNIX_SIGNATURES, runnerFailureRules: RUNNER_FAILURE })

/**
 * Boot a context with a recording fake `ctx.sandbox` (behavior injectable
 * per test) and the executor under test on top of it.
 */
async function setup(
  config: { mode?: SandboxMode; workspaceRoot?: string } & Config = {},
  behavior: (argv: readonly string[], policy: SandboxPolicy) => ConfinedArgv = passthrough,
) {
  const { mode, workspaceRoot, ...execConfig } = config
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
  await ctx.plugin(SandboxPolicyService, {
    ...mode !== undefined ? { mode } : {},
    ...workspaceRoot !== undefined ? { workspaceRoot } : {},
  })
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(SandboxBashExecutor, { graceMs: 200, ...execConfig })
  const bash = ctx.shell as SandboxBashExecutor
  return { ctx, bash, calls }
}

function output(text: string): CollectedOutput {
  return { text, truncated: false }
}

function runResult(exitCode: number | null, stderr: string): ShellRunResult {
  return { exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: output(''), stderr: output(stderr) }
}

function executionPolicy(mode: SandboxMode, workspaceRoot = resolve(process.cwd())): SandboxExecutionPolicy {
  return { mode, workspaceRoot }
}

describe('the provider hand-off', () => {
  it('hands the provider the exact bash argv and the per-call policy, and runs the returned argv', async () => {
    const { bash, calls } = await setup()
    const result = await bash.run(bash.resolve({ command: 'echo \'a b\' "c\'d"' }))
    expect(result.stdout.text).toBe('a b c\'d\n')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
    expect(calls).toEqual([{
      argv: ['bash', '-c', 'echo \'a b\' "c\'d"'],
      policy: { mode: 'read-only', workspaceRoot: resolve(process.cwd()) },
    }])
  })

  it('hands the provider\'s returned argv directly to ctx.subprocess.spawn', async () => {
    const returnedArgv = ['env', 'DSH_WRAP=1', 'bash', '-c', 'printf "%s" "$DSH_WRAP"']
    const { ctx, bash } = await setup({}, () => ({ argv: returnedArgv, enforcement: 'full', denialSignatures: UNIX_SIGNATURES, runnerFailureRules: RUNNER_FAILURE }))
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const result = await bash.run(bash.resolve({ command: 'printf "%s" "$DSH_WRAP"' }))
    expect(result.stdout.text).toBe('1')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0].argv).toEqual(returnedArgv)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('starts a non-Bash runner before the confined inner Bash evaluates BASH_ENV', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-env-order-'))
    const hook = join(dir, 'hook.sh')
    const order = join(dir, 'order.txt')
    writeFileSync(hook, 'printf "hook\\n" >> "$DSH_ORDER_FILE"\n')
    const runnerScript = [
      'const { appendFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      'appendFileSync(process.env.DSH_ORDER_FILE, "runner\\n");',
      'const child = spawnSync(process.argv[1], process.argv.slice(2), { env: process.env, stdio: "inherit" });',
      'process.exit(child.status ?? 125);',
    ].join('')
    const { bash } = await setup({}, argv => ({
      argv: [process.execPath, '-e', runnerScript, ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))

    try {
      const result = await bash.run(bash.resolve({
        command: 'true',
        env: { BASH_ENV: hook },
        dshEnv: { DSH_ORDER_FILE: order },
      }))
      expect(result.exitCode).toBe(0)
      expect(readFileSync(order, 'utf8')).toBe('runner\nhook\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('workspace-write rides the policy, workspaceRoot falling back to process.cwd() when not configured', async () => {
    const { bash, calls } = await setup({ mode: 'workspace-write' })
    const result = await bash.run(bash.resolve({ command: 'true' }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(calls[0]?.policy).toEqual({ mode: 'workspace-write', workspaceRoot: resolve(process.cwd()) })
  })

  it('an explicit workspaceRoot on the policy wins', async () => {
    const { calls, bash } = await setup({ mode: 'workspace-write', workspaceRoot: '/ws', cwd: tmpdir() })
    await bash.run(bash.resolve({ command: 'true' }))
    expect(calls[0]?.policy.workspaceRoot).toBe(resolve('/ws'))
  })

  it('the provider is consulted per wrap (no caching in the consumer): run and start each hand off', async () => {
    const { bash, calls } = await setup()
    await bash.run(bash.resolve({ command: 'true' }))
    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done
    expect(calls).toHaveLength(2)
  })

})

describe('fail closed', () => {
  it('propagates the provider\'s structured SANDBOX_UNAVAILABLE on run() and start()', async () => {
    const { bash } = await setup({}, () => { throw new SandboxUnavailableError('read-only') })
    const spec = bash.resolve({ command: 'echo hi' })
    await expect(bash.run(spec)).rejects.toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    expect(() => bash.start(spec)).toThrow(SandboxUnavailableError)
  })

  it('preserves an already-aborted foreground call as cancellation', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const reason = new Error('caller cancelled before spawn')
    controller.abort(reason)
    await expect(bash.run(bash.resolve({ command: 'true', signal: controller.signal }))).rejects.toBe(reason)
  })

  it.each(RUNNER_FORMS)(
    'keeps an invalid workdir ordinary with the %s provider-runner form',
    async (_form, runner) => {
      const { bash } = await setup({}, argv => ({
        argv: [runner, ...argv],
        enforcement: 'full',
        denialSignatures: UNIX_SIGNATURES,
        runnerFailureRules: RUNNER_FAILURE,
      }))
      const parent = mkdtempSync(join(tmpdir(), 'dsh-sandbox-missing-cwd-'))
      try {
        const failure = await bash.run(bash.resolve({ command: 'true', workdir: join(parent, 'missing') }))
          .catch((error: unknown) => error)
        expect(failure).toMatchObject({ code: 'ENOENT' })
        expect(failure).not.toBeInstanceOf(SandboxUnavailableError)
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  it('keeps an invalid workdir ordinary when danger-full-access bypasses the provider', async () => {
    const { bash } = await setup({ mode: 'danger-full-access' })
    const parent = mkdtempSync(join(tmpdir(), 'dsh-sandbox-missing-cwd-'))
    try {
      const failure = await bash.run(bash.resolve({ command: 'true', workdir: join(parent, 'missing') }))
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'ENOENT' })
      expect(failure).not.toBeInstanceOf(SandboxUnavailableError)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('keeps Node-shaped synchronous ENOEXEC ordinary in run() and start()', async () => {
    const runner = join(spillDir, 'malformed-runner')
    const { ctx, bash } = await setup({}, argv => ({
      argv: [runner, ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => {
      throw Object.assign(new Error('spawn ENOEXEC'), { code: 'ENOEXEC', syscall: 'spawn' })
    })

    const foreground = await bash.run(bash.resolve({ command: 'true' })).catch((error: unknown) => error)
    expect(foreground).toMatchObject({ code: 'ENOEXEC', syscall: 'spawn' })
    expect(foreground).not.toBeInstanceOf(SandboxUnavailableError)

    let background: unknown
    try {
      bash.start(bash.resolve({ command: 'true' }))
    } catch (error) {
      background = error
    }
    expect(background).toMatchObject({ code: 'ENOEXEC', syscall: 'spawn' })
    expect(background).not.toBeInstanceOf(SandboxUnavailableError)
  })

  it('classifies a synchronous SubprocessRuntime EACCES with the exact runner path', async () => {
    const runner = join(spillDir, 'unexecutable-runner')
    const { ctx, bash } = await setup({}, argv => ({
      argv: [runner, ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    // This pins an alternative SubprocessRuntime's synchronous seam, not the
    // shipped local behavior.
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES', syscall: 'spawn', path: runner })
    })

    await expect(bash.run(bash.resolve({ command: 'true' })))
      .rejects.toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    expect(() => bash.start(bash.resolve({ command: 'true' })))
      .toThrow(expect.objectContaining({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE }))
  })

  it('keeps a synchronous cwd-owned ENOENT as the original start() error', async () => {
    const runner = './sandbox-runner'
    const { ctx, bash } = await setup({}, argv => ({
      argv: [runner, ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    const parent = mkdtempSync(join(tmpdir(), 'dsh-sandbox-missing-cwd-'))
    const workdir = join(parent, 'missing')
    const failure = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', syscall: `spawn ${runner}`, path: runner })
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => { throw failure })
    try {
      let thrown: unknown
      try {
        bash.start(bash.resolve({ command: 'true', workdir }))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(failure)
      expect(thrown).not.toBeInstanceOf(SandboxUnavailableError)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('danger-full-access', () => {
  it('runs unwrapped: the provider is never consulted, facts carry no enforcement', async () => {
    const { bash, calls } = await setup({ mode: 'danger-full-access' })
    const result = await bash.run(bash.resolve({ command: 'echo free' }))
    expect(result.stdout.text).toBe('free\n')
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(calls).toHaveLength(0)
  })

  it('start() passes through unwrapped and stamps nothing at settle', async () => {
    const { bash, calls } = await setup({ mode: 'danger-full-access' })
    const task = bash.start(bash.resolve({ command: 'echo free-bg' }))
    await task.done
    expect(task.sandbox).toBeUndefined()
    expect(task.readOutput().delta).toContain('free-bg')
    expect(calls).toHaveLength(0)
  })
})

describe('per-call sandbox policy (the session and escalation carrier)', () => {
  it('exposes the configured default as the capability fact, and resolve() stamps it', async () => {
    const { bash } = await setup()
    expect(bash.sandboxMode).toBe('read-only')
    expect(bash.resolve({ command: 'true' }).sandboxPolicy).toEqual(executionPolicy('read-only'))
  })

  it('an explicit policy outranks the default at resolve(), and the wrap follows its mode and root', async () => {
    const { bash, calls } = await setup()
    const explicit = executionPolicy('workspace-write', '/session/project')
    expect(bash.resolve({ command: 'true', sandboxPolicy: explicit }).sandboxPolicy).toEqual(explicit)
    await bash.run(bash.resolve({ command: 'true', sandboxPolicy: explicit }))
    await bash.run(bash.resolve({ command: 'true' }))
    expect(calls.map(call => call.policy)).toEqual([explicit, executionPolicy('read-only')])
  })

  it('an escalated run reports the mode it ACTUALLY ran under', async () => {
    const { bash } = await setup()
    const result = await bash.run(bash.resolve({ command: 'true', sandboxPolicy: executionPolicy('workspace-write') }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
  })

  it('escalating to danger-full-access bypasses the provider entirely — the grant, not a probe, is the authority there', async () => {
    const { bash, calls } = await setup()
    const result = await bash.run(bash.resolve({ command: 'echo free', sandboxPolicy: executionPolicy('danger-full-access') }))
    expect(result.stdout.text).toBe('free\n')
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(calls).toHaveLength(0)
  })

  it('overlapping background jobs settle with their OWN modes (an escalated task next to a default one)', async () => {
    // With per-call policy, tasks under different modes are in flight at
    // once — anything keyed off the configured default would misreport the
    // escalated one at its settle stamp.
    const { bash } = await setup()
    const escalated = bash.start(bash.resolve({ command: 'sleep 0.3; echo "x: Permission denied" >&2; exit 1', sandboxPolicy: executionPolicy('workspace-write') }))
    const plain = bash.start(bash.resolve({ command: 'true' }))
    await plain.done
    await escalated.done
    expect(escalated.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement: 'full' })
    expect(plain.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('an escalated danger-full-access background job carries no facts (nothing confined it)', async () => {
    const { bash, calls } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo bg-free', sandboxPolicy: executionPolicy('danger-full-access') }))
    await task.done
    expect(task.sandbox).toBeUndefined()
    expect(task.readOutput().delta).toContain('bg-free')
    expect(calls).toHaveLength(0)
  })
})

describe('classifyDenial', () => {
  it('never classifies a clean exit or a signal kill as a denial', () => {
    expect(classifyDenial(runResult(0, 'Permission denied'), UNIX_SIGNATURES)).toBe(false)
    expect(classifyDenial(runResult(null, 'Permission denied'), UNIX_SIGNATURES)).toBe(false)
  })

  it('classifies failed runs by the wrap\'s own dialect, conservatively', () => {
    expect(classifyDenial(runResult(1, 'touch: cannot touch /x: Read-only file system'), UNIX_SIGNATURES)).toBe(true)
    expect(classifyDenial(runResult(1, 'sh: /x: Permission denied'), UNIX_SIGNATURES)).toBe(true)
    // Bare EPERM is not a Linux runner's dialect: mount/kill/ptrace fail with
    // it unsandboxed too, and the mode vocabulary governs file effects only —
    // claiming a file denial here would tell the model the sandbox blocked
    // something it never governed.
    expect(classifyDenial(runResult(1, 'mount: Operation not permitted'), UNIX_SIGNATURES)).toBe(false)
    expect(classifyDenial(runResult(1, 'No such file or directory'), UNIX_SIGNATURES)).toBe(false)
  })

  it('matches exactly the active backend\'s dialect: EPERM classifies under Seatbelt, EACCES does not under bwrap', () => {
    // The same stderr flips meaning with the backend: under Seatbelt, EPERM
    // text IS how the kernel refuses a governed file write; under bwrap's
    // EROFS-only dialect, `Permission denied` is ordinary DAC, not the
    // sandbox — per-wrap signatures are what keep both classifications honest.
    expect(classifyDenial(runResult(1, 'bash: /etc/x: Operation not permitted'), ['operation not permitted'])).toBe(true)
    expect(classifyDenial(runResult(1, 'sh: /x: Permission denied'), ['read-only file system'])).toBe(false)
  })
})

describe('isRunnerSpawnFailure', () => {
  it.each(['EACCES', 'ENOENT'])(
    'attributes executable-class spawn code %s to argv[0] once cwd ambiguity is eliminated',
    (code) => {
      const runner = join(spillDir, 'runner')
      const error = Object.assign(new Error('spawn failed'), { code, syscall: `spawn ${runner}`, path: runner })
      expect(isRunnerSpawnFailure(error, runner, process.cwd())).toBe(true)
    },
  )

  it.each(['ENOEXEC', 'ENOTDIR', 'EPERM'])(
    'keeps unproven executable code %s ordinary despite synthetic argv[0] fields',
    (code) => {
      const runner = join(spillDir, 'runner')
      const error = Object.assign(new Error('spawn failed'), { code, syscall: `spawn ${runner}`, path: runner })
      expect(isRunnerSpawnFailure(error, runner, process.cwd())).toBe(false)
    },
  )

  it('requires a usable caller cwd before classifying absolute, bare, or relative runners', () => {
    const missingWorkdir = join(spillDir, 'missing-workdir')
    for (const [, runner] of RUNNER_FORMS) {
      const error = Object.assign(new Error('spawn failed'), { code: 'ENOENT', syscall: `spawn ${runner}`, path: runner })
      expect(isRunnerSpawnFailure(error, runner, missingWorkdir)).toBe(false)
    }
    const fileWorkdir = join(spillDir, 'not-a-workdir')
    writeFileSync(fileWorkdir, '')
    const error = Object.assign(new Error('spawn failed'), { code: 'ENOTDIR', syscall: 'spawn node', path: 'node' })
    expect(isRunnerSpawnFailure(error, 'node', fileWorkdir)).toBe(false)
  })

  it('rejects resource, non-spawn, mismatched-program, and unstructured failures', () => {
    const missingRunner = join(spillDir, 'definitely-missing-runner')
    const spawnError = (code: unknown, syscall: unknown = `spawn ${missingRunner}`, path: unknown = missingRunner) =>
      Object.assign(new Error('spawn failed'), { code, syscall, path })
    const spawnErrorWithoutPath = (syscall: string) =>
      Object.assign(new Error('spawn failed'), { code: 'ENOENT', syscall })

    expect(isRunnerSpawnFailure(spawnError('EMFILE'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOMEM'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError(2), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'open'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 1), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'spawn', process.execPath), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'spawn', 1), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'spawn', ''), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnErrorWithoutPath('spawn'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnErrorWithoutPath('spawn other-runner'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(undefined, missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(null, missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT'), undefined, process.cwd())).toBe(false)
  })

  it('accepts only syscall and error-path facts that identify the exact runner program', () => {
    const runner = join(spillDir, 'runner with spaces')
    const spawnError = (syscall: string, path?: string) =>
      Object.assign(new Error('spawn failed'), { code: 'ENOENT', syscall, path })

    expect(isRunnerSpawnFailure(spawnError('spawn', runner), runner, process.cwd())).toBe(true)
    expect(isRunnerSpawnFailure(spawnError(`spawn ${runner}`, runner), runner, process.cwd())).toBe(true)
    expect(isRunnerSpawnFailure(spawnError(`spawn ${runner}`), runner, process.cwd())).toBe(true)
    expect(isRunnerSpawnFailure(spawnError('spawn other-runner', runner), runner, process.cwd())).toBe(false)
  })
})

describe('classifyRunnerFailure', () => {
  it('ignores empty and whitespace-only fatal signatures instead of treating exit status or notice text as evidence', () => {
    const notice = 'landlock-run: partial enforcement (older Landlock ABI)'
    const emptyRule = [{ allowedExitCodes: [125], fatalSignatures: ['', ' ', '\t'] }]
    expect(classifyRunnerFailure(125, '', emptyRule)).toBeUndefined()
    expect(classifyRunnerFailure(125, notice, emptyRule)).toBeUndefined()
  })

  it('keeps valid fatal signatures active beside an ignored empty entry', () => {
    const notice = 'landlock-run: partial enforcement (older Landlock ABI)'
    const fatal = 'landlock-run: ruleset creation failed'
    const rules = [{
      allowedExitCodes: [125],
      fatalSignatures: ['', ' ', 'landlock-run: '],
      informationalLines: [notice],
    }]
    expect(classifyRunnerFailure(125, `${notice}\nchild diagnostic\n${fatal}`, rules)).toEqual({ detail: fatal })
  })

  it('requires Landlock exit 125 plus a non-notice fatal line and returns that original line', () => {
    const notice = 'landlock-run: partial enforcement (older Landlock ABI)'
    const rules = [{ allowedExitCodes: [125], fatalSignatures: ['landlock-run: '], informationalLines: [notice] }]
    expect(classifyRunnerFailure(1, notice, rules)).toBeUndefined()
    expect(classifyRunnerFailure(2, notice, rules)).toBeUndefined()
    expect(classifyRunnerFailure(125, notice, rules)).toBeUndefined()
    expect(classifyRunnerFailure(125, notice.toUpperCase(), rules)).toBeUndefined()
    expect(classifyRunnerFailure(125, `${notice}: extra detail`, rules))
      .toEqual({ detail: `${notice}: extra detail` })
    expect(classifyRunnerFailure(125, `${notice}\nlandlock-run: exec failed: No such file or directory`, rules))
      .toEqual({ detail: 'landlock-run: exec failed: No such file or directory' })
  })

  it.each([
    'landlock-run: usage error: missing `-- <argv>...` command',
    'landlock-run: landlock is not enforced by this kernel (ABI unsupported or disabled)',
    'landlock-run: cannot open rule path: /gone: No such file or directory',
    'landlock-run: landlock ruleset error: Invalid argument',
    'landlock-run: exec failed: Permission denied',
    'landlock-run: out of memory',
    'landlock-run: future fatal diagnostic',
  ])('keeps known and future Landlock fatal diagnostics fail-closed: %s', (fatal) => {
    const rules = [{
      allowedExitCodes: [125],
      fatalSignatures: ['landlock-run: '],
      informationalLines: ['landlock-run: partial enforcement (older Landlock ABI)'],
    }]
    expect(classifyRunnerFailure(125, fatal, rules)).toEqual({ detail: fatal })
  })
})

describe('result facts', () => {
  it.each([126, 127])('keeps a successfully launched wrapped child exit %i as an ordinary outcome', async (exitCode) => {
    const { bash } = await setup({}, argv => ({
      argv: ['env', ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    const result = await bash.run(bash.resolve({ command: `exit ${exitCode}` }))
    expect(result.exitCode).toBe(exitCode)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('reports a real permission failure as a sandbox denial with the mode it ran under', async () => {
    const { bash } = await setup()
    const deniedRoot = mkdtempSync(join(tmpdir(), 'dsh-sandbox-denied-'))
    try {
      const lockedDir = join(deniedRoot, 'locked')
      mkdirSync(lockedDir)
      chmodSync(lockedDir, 0o555)
      const result = await bash.run(bash.resolve({ command: `echo x > ${lockedDir}/f` }))
      expect(result.exitCode).not.toBe(0)
      expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    } finally {
      rmSync(deniedRoot, { recursive: true, force: true })
    }
  })

  it('carries the provider\'s partial-enforcement fact through unchanged', async () => {
    const { bash } = await setup({}, argv => ({ argv: [...argv], enforcement: 'partial', denialSignatures: UNIX_SIGNATURES, runnerFailureRules: RUNNER_FAILURE }))
    const result = await bash.run(bash.resolve({ command: 'true' }))
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })
})

describe('background sandbox facts', () => {
  it.each(RUNNER_FORMS)('keeps an invalid-workdir rejection ordinary for the %s provider-runner form', async (_form, runner) => {
    const { bash } = await setup({}, argv => ({
      argv: [runner, ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    const parent = mkdtempSync(join(tmpdir(), 'dsh-sandbox-missing-cwd-'))
    try {
      const task = bash.start(bash.resolve({ command: 'true', workdir: join(parent, 'missing') }))
      await task.done

      expect(task.status).toBe('killed')
      expect(task.readOutput().delta).toContain('spawn failed:')
      expect(task.sandbox).toEqual({
        mode: 'read-only',
        denied: false,
        enforcement: 'full',
      })
      const accounting = (bash as unknown as { processFacts: Map<unknown, unknown> }).processFacts
      expect(accounting.size).toBe(0)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('does not invent runner evidence when a spawn rejection has no structured reason', async () => {
    const { ctx, bash } = await setup()
    const emptyReader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
    }
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue({
      pid: -1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout: emptyReader, stderr: emptyReader },
      // Arbitrary subprocess providers can reject without a value; that edge is the point of this test.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      done: Promise.reject(undefined),
      terminate: vi.fn(),
      waitForExit: async () => true,
    } satisfies SubprocessHandle)

    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done

    expect(task.readOutput().delta).toContain('spawn failed: undefined')
    expect(task.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'full',
    })
  })

  it('stamps a settled denial: nonzero exit + permission stderr under a confined mode', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo "x: Permission denied" >&2; exit 1' }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
  })

  it('a foreground runner failure throws the fail-closed error, never a task result', async () => {
    // The wrap's runner prefix on a failed run means the SANDBOX broke and
    // the command never ran — the late twin of the confine-time throw, with
    // the matched fatal stderr line carried as the cause.
    const { bash } = await setup()
    const run = bash.run(bash.resolve({ command: 'echo "fake-runner: ruleset rejected" >&2; exit 125' }))
    await expect(run).rejects.toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
    await expect(run).rejects.toThrow('fake-runner: ruleset rejected')
  })

  it('a foreground runner failure outranks denial: runner error text may contain denial words', async () => {
    const { bash } = await setup()
    await expect(bash.run(bash.resolve({ command: 'echo "fake-runner: cannot open rule path: /x: Permission denied" >&2; exit 125' })))
      .rejects.toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
  })

  it('a settled background runner failure stamps runnerFailed (no error channel remains), not denied', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo "fake-runner: cannot open rule path: /x: Permission denied" >&2; exit 125' }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full', runnerFailed: true })
  })

  it('overlapping background jobs keep their OWN wrap facts (per-task, not latest-wrap)', async () => {
    // Facts belong to each wrap and may vary between calls. The slow task settles after the
    // quick task starts; a shared latest-wrap field would classify and stamp it with the wrong
    // task's dialect and enforcement.
    const wraps: Array<Pick<ConfinedArgv, 'enforcement' | 'denialSignatures'>> = [
      { enforcement: 'partial', denialSignatures: ['permission denied'] },
      { enforcement: 'full', denialSignatures: ['read-only file system'] },
    ]
    let call = 0
    const { bash } = await setup({}, (argv) => {
      const wrap = wraps[Math.min(call++, wraps.length - 1)] as Pick<ConfinedArgv, 'enforcement' | 'denialSignatures'>
      return { argv: [...argv], ...wrap, runnerFailureRules: RUNNER_FAILURE }
    })
    const slow = bash.start(bash.resolve({ command: 'sleep 0.4; echo "x: Permission denied" >&2; exit 1' }))
    const quick = bash.start(bash.resolve({ command: 'true' }))
    await quick.done
    await slow.done
    expect(slow.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
    expect(quick.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('a signal-killed task is never a denial (null exit code)', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo "Permission denied" >&2; sleep 30' }))
    // Let the stderr land before the kill so the classifier sees the
    // signature and must still refuse it on the null exit code alone.
    await vi.waitFor(() => { expect(task.readOutput().delta).toContain('Permission denied') })
    task.kill()
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('disposal kills wrapped background jobs (inherited HMR safety)', async () => {
    const { ctx, bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'sleep 30' }))
    await ctx.fiber.dispose()
    expect(task.status).toBe('killed')
  })
})
