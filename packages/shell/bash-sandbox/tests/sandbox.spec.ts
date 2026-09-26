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
import type { CollectedOutput, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SANDBOX_UNAVAILABLE, SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { classifyDenial } from '../src/helpers.ts'

/** Historical foreground shorthand over the unified execute() seam. */
async function run(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellRunResult> {
  return (await x.execute(spec)).result()
}

/** Historical background shorthand: execute with no deadline armed. */
function start(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellExecution> {
  return x.execute({ ...spec, onExpiry: 'none' })
}


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
  config: { mode?: SandboxMode; workspaceRoot?: string } & NonNullable<Parameters<typeof SandboxBashExecutor.Config>[0]> = {},
  behavior: (argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal) => ConfinedArgv | Promise<ConfinedArgv> = passthrough,
) {
  const { mode, workspaceRoot, ...execConfig } = config
  const calls: ConfineCall[] = []
  class FakeSandboxProvider extends SandboxProvider {
    async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
      calls.push({ argv: [...argv], policy })
      return behavior(argv, policy, signal)
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
  it('reports caller cancellation when a failed launch result is read after abort', async () => {
    const { ctx, bash } = await setup({}, () => passthrough(['node']))
    const controller = new AbortController()
    const reason = new Error('caller abandoned the failed launch')
    const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => {
      throw Object.assign(new Error('launch refused'), { code: 'ENOENT', syscall: 'spawn node', path: 'node' })
    })
    try {
      const execution = await bash.execute(bash.resolve({ command: 'true', signal: controller.signal }))
      await execution.done
      controller.abort(reason)
      await expect(execution.result()).rejects.toBe(reason)
    } finally {
      spawn.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('preserves cancellation when a pending subprocess launch later rejects', async () => {
    const { ctx, bash } = await setup({}, () => passthrough(['node']))
    const entered = Promise.withResolvers<undefined>()
    const completion = Promise.withResolvers<never>()
    const controller = new AbortController()
    const reason = new Error('caller cancelled pending launch')
    const reader: SubprocessOutputReader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => {
      entered.resolve(undefined)
      return {
        stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        collected: { stdout: reader, stderr: reader }, done: completion.promise,
        terminate: () => {}, waitForExit: () => Promise.resolve(true),
      }
    })
    const pending = run(bash, bash.resolve({ command: 'true', signal: controller.signal }))
    const rejected = expect(pending).resolves.toMatchObject({ aborted: true, timedOut: false })
    try {
      await entered.promise
      controller.abort(reason)
      completion.reject(Object.assign(new Error('launch refused'), { code: 'ENOENT', syscall: 'spawn node', path: 'node' }))
      await rejected
    } finally {
      completion.reject(reason)
      await pending.catch(() => {})
      await ctx.fiber.dispose()
    }
  })

  it.each(['kill', 'none'] as const)('cancels %s while confinement is pending without spawning', async (onExpiry) => {
    const entered = Promise.withResolvers<AbortSignal>()
    const response = Promise.withResolvers<ConfinedArgv>()
    const { ctx, bash } = await setup({}, (_argv, _policy, signal) => {
      entered.resolve(signal!)
      return response.promise
    })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const controller = new AbortController()
    const reason = new Error('cancel pending confinement')
    const pending = bash.execute(bash.resolve({ onExpiry, command: 'true', signal: controller.signal }))
    const rejected = expect(pending).rejects.toBe(reason)
    try {
      const signal = await entered.promise
      expect(spawn).not.toHaveBeenCalled()
      controller.abort(reason)
      expect(signal.aborted).toBe(true)
      response.resolve(passthrough(['bash', '-c', 'true']))
      await rejected
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      response.resolve(passthrough(['bash', '-c', 'true']))
      await pending.catch(() => {})
      await ctx.fiber.dispose()
    }
  })

  it('publishes a background process only after confinement completes', async () => {
    const entered = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<ConfinedArgv>()
    const { ctx, bash } = await setup({}, () => { entered.resolve(undefined); return response.promise })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    let published = false
    const pending = start(bash, bash.resolve({ command: 'printf ready' })).then((process) => { published = true; return process })
    try {
      await entered.promise
      expect(published).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
      response.resolve(passthrough(['bash', '-c', 'printf ready']))
      const process = await pending
      await process.done
      expect(process.readOutput().delta).toBe('ready')
      expect(spawn).toHaveBeenCalledOnce()
    } finally {
      response.resolve(passthrough(['bash', '-c', 'printf ready']))
      await ctx.fiber.dispose()
    }
  })

  it('hands the provider the exact bash argv and the per-call policy, and runs the returned argv', async () => {
    const { bash, calls } = await setup()
    const result = await run(bash, bash.resolve({ command: 'echo \'a b\' "c\'d"' }))
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
    const result = await run(bash, bash.resolve({ command: 'printf "%s" "$DSH_WRAP"' }))
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
      const result = await run(bash, bash.resolve({
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
    const result = await run(bash, bash.resolve({ command: 'true' }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(calls[0]?.policy).toEqual({ mode: 'workspace-write', workspaceRoot: resolve(process.cwd()) })
  })

  it('an explicit workspaceRoot on the policy wins', async () => {
    const { calls, bash } = await setup({ mode: 'workspace-write', workspaceRoot: '/ws', cwd: tmpdir() })
    await run(bash, bash.resolve({ command: 'true' }))
    expect(calls[0]?.policy.workspaceRoot).toBe(resolve('/ws'))
  })

  it('the provider is consulted per wrap (no caching in the consumer): run and start each hand off', async () => {
    const { bash, calls } = await setup()
    await run(bash, bash.resolve({ command: 'true' }))
    const task = (await start(bash, bash.resolve({ command: 'true' })))
    await task.done
    expect(calls).toHaveLength(2)
  })

})

describe('fail closed', () => {
  it('propagates the provider\'s structured SANDBOX_UNAVAILABLE on run() and start()', async () => {
    const { bash } = await setup({}, () => { throw new SandboxUnavailableError('read-only') })
    const spec = bash.resolve({ command: 'echo hi' })
    await expect(run(bash, spec)).rejects.toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    await expect(start(bash, spec)).rejects.toThrow(SandboxUnavailableError)
  })

  it('preserves an already-aborted foreground call as cancellation', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const reason = new Error('caller cancelled before spawn')
    controller.abort(reason)
    await expect(run(bash, bash.resolve({ command: 'true', signal: controller.signal }))).rejects.toBe(reason)
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
        const failure = await run(bash, bash.resolve({ command: 'true', workdir: join(parent, 'missing') }))
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
      const failure = await run(bash, bash.resolve({ command: 'true', workdir: join(parent, 'missing') }))
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

    const foreground = await run(bash, bash.resolve({ command: 'true' })).catch((error: unknown) => error)
    expect(foreground).toMatchObject({ code: 'ENOEXEC', syscall: 'spawn' })
    expect(foreground).not.toBeInstanceOf(SandboxUnavailableError)

    // Containment: the handle settles killed instead of the spawn throwing,
    // and the projection carries the original error, never the fail-closed one.
    const background = (await start(bash, bash.resolve({ command: 'true' })))
    await background.done
    expect(background.status).toBe('killed')
    const backgroundError = await background.result().catch((error: unknown) => error)
    expect(backgroundError).toMatchObject({ code: 'ENOEXEC', syscall: 'spawn' })
    expect(backgroundError).not.toBeInstanceOf(SandboxUnavailableError)
    expect(background.readOutput().delta).toContain('subprocess failed before reporting an outcome:')
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

    await expect(run(bash, bash.resolve({ command: 'true' })))
      .rejects.toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    // The background view of the same failure: a killed handle whose facts
    // attribute the launch failure to the runner.
    const background = (await start(bash, bash.resolve({ command: 'true' })))
    await background.done
    expect(background.status).toBe('killed')
    expect(background.sandbox).toMatchObject({ runnerFailed: true })
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
      const background = (await start(bash, bash.resolve({ command: 'true', workdir })))
      await background.done
      expect(background.status).toBe('killed')
      // A cwd-owned failure keeps the original error: not the runner's fault.
      const thrown = await background.result().catch((error: unknown) => error)
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
    const result = await run(bash, bash.resolve({ command: 'echo free' }))
    expect(result.stdout.text).toBe('free\n')
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(calls).toHaveLength(0)
  })

  it('start() passes through unwrapped and stamps nothing at settle', async () => {
    const { bash, calls } = await setup({ mode: 'danger-full-access' })
    const task = (await start(bash, bash.resolve({ command: 'echo free-bg' })))
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
    await run(bash, bash.resolve({ command: 'true', sandboxPolicy: explicit }))
    await run(bash, bash.resolve({ command: 'true' }))
    expect(calls.map(call => call.policy)).toEqual([explicit, executionPolicy('read-only')])
  })

  it('an escalated run reports the mode it ACTUALLY ran under', async () => {
    const { bash } = await setup()
    const result = await run(bash, bash.resolve({ command: 'true', sandboxPolicy: executionPolicy('workspace-write') }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
  })

  it('escalating to danger-full-access bypasses the provider entirely — the grant, not a probe, is the authority there', async () => {
    const { bash, calls } = await setup()
    const result = await run(bash, bash.resolve({ command: 'echo free', sandboxPolicy: executionPolicy('danger-full-access') }))
    expect(result.stdout.text).toBe('free\n')
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(calls).toHaveLength(0)
  })

  it('overlapping background jobs settle with their OWN modes (an escalated task next to a default one)', async () => {
    // With per-call policy, tasks under different modes are in flight at
    // once — anything keyed off the configured default would misreport the
    // escalated one at its settle stamp.
    const { bash } = await setup()
    const escalated = (await start(bash, bash.resolve({ command: 'sleep 0.3; echo "x: Permission denied" >&2; exit 1', sandboxPolicy: executionPolicy('workspace-write') })))
    const plain = (await start(bash, bash.resolve({ command: 'true' })))
    await plain.done
    await escalated.done
    expect(escalated.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement: 'full' })
    expect(plain.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('an escalated danger-full-access background job carries no facts (nothing confined it)', async () => {
    const { bash, calls } = await setup()
    const task = (await start(bash, bash.resolve({ command: 'echo bg-free', sandboxPolicy: executionPolicy('danger-full-access') })))
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

describe('result facts', () => {
  it.each([126, 127])('keeps a successfully launched wrapped child exit %i as an ordinary outcome', async (exitCode) => {
    const { bash } = await setup({}, argv => ({
      argv: ['env', ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    const result = await run(bash, bash.resolve({ command: `exit ${exitCode}` }))
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
      const result = await run(bash, bash.resolve({ command: `echo x > ${lockedDir}/f` }))
      expect(result.exitCode).not.toBe(0)
      expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    } finally {
      rmSync(deniedRoot, { recursive: true, force: true })
    }
  })

  it('carries the provider\'s partial-enforcement fact through unchanged', async () => {
    const { bash } = await setup({}, argv => ({ argv: [...argv], enforcement: 'partial', denialSignatures: UNIX_SIGNATURES, runnerFailureRules: RUNNER_FAILURE }))
    const result = await run(bash, bash.resolve({ command: 'true' }))
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
      const task = (await start(bash, bash.resolve({ command: 'true', workdir: join(parent, 'missing') })))
      await task.done

      expect(task.status).toBe('killed')
      expect(task.readOutput().delta).toContain('subprocess failed before reporting an outcome:')
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

  it('does not invent runner evidence when a provider rejection has no structured reason', async () => {
    const { ctx, bash } = await setup()
    const emptyReader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
    }
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue({
      control: undefined,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout: emptyReader, stderr: emptyReader },
      // Arbitrary subprocess providers can reject without a value or public stage.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      done: Promise.reject(undefined),
      terminate: vi.fn(),
      waitForExit: async () => true,
    } satisfies SubprocessHandle)

    const task = (await start(bash, bash.resolve({ command: 'true' })))
    await task.done

    expect(task.readOutput().delta).toContain('subprocess failed before reporting an outcome: undefined')
    expect(task.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'full',
    })
  })

  it('stamps a settled denial: nonzero exit + permission stderr under a confined mode', async () => {
    const { bash } = await setup()
    const task = (await start(bash, bash.resolve({ command: 'echo "x: Permission denied" >&2; exit 1' })))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
  })

  it('a foreground runner failure throws the fail-closed error, never a task result', async () => {
    // The wrap's runner prefix on a failed run means the SANDBOX broke and
    // the command never ran — the late twin of the confine-time throw, with
    // the matched fatal stderr line carried as the cause.
    const { bash } = await setup()
    const pending = run(bash, bash.resolve({ command: 'echo "fake-runner: ruleset rejected" >&2; exit 125' }))
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
    await expect(pending).rejects.toThrow('fake-runner: ruleset rejected')
  })

  it('a foreground runner failure outranks denial: runner error text may contain denial words', async () => {
    const { bash } = await setup()
    await expect(run(bash, bash.resolve({ command: 'echo "fake-runner: cannot open rule path: /x: Permission denied" >&2; exit 125' })))
      .rejects.toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
  })

  it('a settled background runner failure stamps runnerFailed (no error channel remains), not denied', async () => {
    const { bash } = await setup()
    const task = (await start(bash, bash.resolve({ command: 'echo "fake-runner: cannot open rule path: /x: Permission denied" >&2; exit 125' })))
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
    const slow = (await start(bash, bash.resolve({ command: 'sleep 0.4; echo "x: Permission denied" >&2; exit 1' })))
    const quick = (await start(bash, bash.resolve({ command: 'true' })))
    await quick.done
    await slow.done
    expect(slow.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
    expect(quick.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('a signal-killed task is never a denial (null exit code)', async () => {
    const { bash } = await setup()
    const task = (await start(bash, bash.resolve({ command: 'echo "Permission denied" >&2; sleep 30' })))
    // Let the stderr land before the kill so the classifier sees the
    // signature and must still refuse it on the null exit code alone.
    await vi.waitFor(() => { expect(task.readOutput().delta).toContain('Permission denied') })
    task.kill()
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('disposal kills wrapped background jobs (inherited HMR safety)', async () => {
    const { ctx, bash } = await setup()
    const task = (await start(bash, bash.resolve({ command: 'sleep 30' })))
    await ctx.fiber.dispose()
    expect(task.status).toBe('killed')
  })
})
