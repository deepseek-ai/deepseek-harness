/**
 * Deterministic real-process proofs for runner classification: the real local
 * provider and sandbox bash executor exercise direct runner-spawn failures
 * and a POSIX fake Landlock launcher that prints its notice before exec.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LAUNCHER_FAILURE_EXIT } from '@deepseek-ai/node-addon-landlock-run'
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const NOTICE = 'landlock-run: partial enforcement (older Landlock ABI)'
const FATAL_PREFIX = 'landlock-run: '
const FATAL = `${FATAL_PREFIX}landlock ruleset error: Invalid argument`

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Write a fake native launcher that reports partial enforcement, then execs or fails. */
async function fakeLauncher(fatalExit?: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-partial-landlock-'))
  tempDirs.push(dir)
  const launcher = join(dir, 'landlock-run')
  const fatalBranch = fatalExit === undefined ? '' : `printf '%s\\n' '${FATAL}' >&2\nexit ${fatalExit}\n`
  await writeFile(launcher, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ro|--rw) shift 2 ;;
    --) shift; break ;;
    *) printf '%s\\n' '${FATAL_PREFIX}usage error: unexpected fake argument' >&2; exit ${LAUNCHER_FAILURE_EXIT} ;;
  esac
done
printf '%s\\n' '${NOTICE}' >&2
${fatalBranch}exec "$@"
`, { mode: 0o755 })
  return launcher
}

async function setup(fatalExit?: number): Promise<SandboxBashExecutor> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = {
    platform: 'linux',
    probeBwrap: () => false,
    probeLandlock: () => 'partial',
    landlockLauncher: await fakeLauncher(fatalExit),
  }
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { cwd: process.cwd(), timeoutMs: 5_000 })
  return ctx.shell as SandboxBashExecutor
}

async function setupConfiguredRunner(runner: string): Promise<SandboxBashExecutor> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalSandboxProvider, {
    runnerCommand: [runner],
    runnerFailureSignatures: ['configured-runner: fatal'],
  })
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { cwd: process.cwd(), timeoutMs: 5_000 })
  return ctx.shell as SandboxBashExecutor
}

describe('partial Landlock runner-failure classification', () => {
  it.each(['missing', 'unexecutable', 'missing-interpreter'] as const)('classifies a %s configured runner through the direct spawn error channel', async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-unusable-sandbox-runner-'))
    tempDirs.push(dir)
    const runner = join(dir, `${kind}-runner`)
    if (kind === 'unexecutable') await writeFile(runner, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    if (kind === 'missing-interpreter') {
      await writeFile(runner, '#!/dsh-definitely-missing-sandbox-interpreter\nexit 0\n', { mode: 0o755 })
    }
    const bash = await setupConfiguredRunner(runner)

    const error = await bash.run(bash.resolve({ command: 'true' })).catch((value: unknown) => value)
    expect(error).toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(runner)

    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done
    expect(task.status).toBe('killed')
    expect(task.readOutput().delta).toContain(`subprocess failed before reporting an outcome: Error: spawn ${runner}`)
    expect(task.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'full',
      runnerFailed: true,
    })
    const accounting = (bash as unknown as { processFacts: Map<unknown, unknown> }).processFacts
    expect(accounting.size).toBe(0)
  })

  it.each(['bare-name', 'relative'] as const)(
    'classifies a %s runner whose shebang interpreter is missing',
    async (form) => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-argv-form-sandbox-runner-'))
      tempDirs.push(dir)
      const filename = 'missing-interpreter-runner'
      const runner = form === 'bare-name' ? filename : `./${filename}`
      await writeFile(join(dir, filename), '#!/dsh-definitely-missing-sandbox-interpreter\nexit 0\n', { mode: 0o755 })
      const bash = await setupConfiguredRunner(runner)
      const request = form === 'bare-name'
        ? { command: 'true', env: { PATH: dir } }
        : { command: 'true', workdir: dir }

      const error = await bash.run(bash.resolve(request)).catch((value: unknown) => value)
      expect(error).toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
      expect(error).toBeInstanceOf(Error)
      // Empirically, Darwin and Linux Node 24 preserve the passed bare/relative
      // argv[0] in this spawn error rather than resolving it to an absolute path.
      expect((error as Error).message).toContain(`spawn ${runner} ENOENT`)

      const task = bash.start(bash.resolve(request))
      await task.done
      expect(task.status).toBe('killed')
      expect(task.readOutput().delta).toContain(`subprocess failed before reporting an outcome: Error: spawn ${runner} ENOENT`)
      expect(task.sandbox).toEqual({
        mode: 'read-only',
        denied: false,
        enforcement: 'full',
        runnerFailed: true,
      })
    },
  )

  it('keeps a real malformed executable ordinary across no-shebang spawn behavior', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-malformed-sandbox-runner-'))
    tempDirs.push(dir)
    const runner = join(dir, 'malformed-runner')
    await writeFile(runner, 'not a native executable or shebang script\n', { mode: 0o755 })
    const bash = await setupConfiguredRunner(runner)
    const request = { command: 'true' }

    // Node/libuv may expose execve's ENOEXEC directly (Darwin) or retry a
    // no-shebang executable through /bin/sh (Linux). Neither path supplies the
    // ENOENT/EACCES with the exact failed executable path required for runner attribution.
    const foreground = await bash.run(bash.resolve(request)).catch((value: unknown) => value)
    expect(foreground).not.toBeInstanceOf(SandboxUnavailableError)

    if (foreground instanceof Error) {
      expect(foreground).toMatchObject({ code: 'ENOEXEC', syscall: 'spawn' })
      expect((foreground as { path?: unknown }).path).toBeUndefined()

      let background: unknown
      try {
        bash.start(bash.resolve(request))
      } catch (error) {
        background = error
      }
      expect(background).toMatchObject({ code: 'ENOEXEC', syscall: 'spawn' })
      expect((background as { path?: unknown }).path).toBeUndefined()
      expect(background).not.toBeInstanceOf(SandboxUnavailableError)
    } else {
      expect(foreground).toMatchObject({
        exitCode: 127,
        signal: null,
        sandbox: { mode: 'read-only', denied: false, enforcement: 'full' },
      })
      expect((foreground as { stderr: { text: string } }).stderr.text.length).toBeGreaterThan(0)

      const background = bash.start(bash.resolve(request))
      await background.done
      expect(background.status).toBe('completed')
      expect(background.exitCode).toBe(127)
      expect(background.signal).toBeNull()
      expect(background.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
      const output = background.readOutput().delta
      expect(output.startsWith('[stderr]\n')).toBe(true)
      expect(output.length).toBeGreaterThan('[stderr]\n'.length)
      expect(output).not.toContain('subprocess failed before reporting an outcome:')
    }

    const accounting = (bash as unknown as { processFacts: Map<unknown, unknown> }).processFacts
    expect(accounting.size).toBe(0)
  })

  it.each([0, 1, 2, LAUNCHER_FAILURE_EXIT])(
    'keeps child exit %i ordinary when the partial-enforcement notice is the only runner line',
    async (exitCode) => {
      const bash = await setup()
      const result = await bash.run(bash.resolve({ command: `exit ${exitCode}` }))
      expect(result.exitCode).toBe(exitCode)
      expect(result.stderr.text).toBe(`${NOTICE}\n`)
      expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
    },
  )

  it.each([126, 127])('keeps a successfully launched Landlock child exit %i as an ordinary outcome', async (exitCode) => {
    const bash = await setup()
    const result = await bash.run(bash.resolve({ command: `exit ${exitCode}` }))
    expect(result.exitCode).toBe(exitCode)
    expect(result.stderr.text).toBe(`${NOTICE}\n`)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })

  it.each([1, 2])('keeps a Landlock fatal line at exit %i as insufficient runner-failure evidence', async (exitCode) => {
    const bash = await setup(exitCode)
    const result = await bash.run(bash.resolve({ command: 'true' }))
    expect(result.exitCode).toBe(exitCode)
    expect(result.stderr.text).toBe(`${NOTICE}\n${FATAL}\n`)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })

  it('reports the fatal line after the notice as SANDBOX_UNAVAILABLE detail', async () => {
    const bash = await setup(LAUNCHER_FAILURE_EXIT)
    const error = await bash.run(bash.resolve({ command: 'true' })).catch((value: unknown) => value)
    expect(error).toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(`Runner failure: ${FATAL}`)
    expect((error as Error).message).not.toContain(NOTICE)
  })

  it('classifies a notice plus child Permission denied as a denial, not runner failure', async () => {
    const bash = await setup()
    const result = await bash.run(bash.resolve({ command: 'printf "%s\\n" "child: Permission denied" >&2; exit 1' }))
    expect(result.stderr.text).toBe(`${NOTICE}\nchild: Permission denied\n`)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
  })

  it('applies the same evidence rule to notice-only background exits', async () => {
    const bash = await setup()
    for (const command of ['exit 1', 'exit 2', `exit ${LAUNCHER_FAILURE_EXIT}`]) {
      const task = bash.start(bash.resolve({ command }))
      await task.done
      expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
      expect(task.readOutput().delta).toContain(NOTICE)
    }
  })

  it('classifies a background notice plus child Permission denied as denial', async () => {
    const bash = await setup()
    const task = bash.start(bash.resolve({ command: 'printf "%s\\n" "child: Permission denied" >&2; exit 1' }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
    expect(task.readOutput().delta).toContain(NOTICE)
  })

  it('makes a background fatal line outrank denial text after the notice', async () => {
    const bash = await setup(LAUNCHER_FAILURE_EXIT)
    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done
    expect(task.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'partial',
      runnerFailed: true,
    })
    const output = task.readOutput().delta
    expect(output).toContain(NOTICE)
    expect(output).toContain(FATAL)
  })
})
