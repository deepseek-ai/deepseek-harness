import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createServer, type Socket } from 'node:net'
import { basename, delimiter, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ConfinedArgv, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Config } from '../src/index.ts'
import { PythonPtcRuntime } from '../src/index.ts'
import { createRuntimeContext } from './setup.ts'

/** Probe the provider independently so a Python launch regression cannot skip confinement tests. */
const sandboxUsable = await (async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Sandbox, {})
    await ctx.sandbox.confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot: process.cwd() })
    return true
  } catch (error: unknown) {
    if (error instanceof SandboxUnavailableError) return false
    throw error
  } finally { await ctx.fiber.dispose() }
})()

async function setup(mode: SandboxMode = 'read-only', config: Config = {}) {
  // A home-directory fixture stays outside the Linux backend's writable /tmp.
  const root = await mkdtemp(join(homedir(), '.dsh-python-sandbox-test-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const ctx = await createRuntimeContext({ mode, workspaceRoot: cwd })
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const fiber = await ctx.plugin(PythonPtcRuntime, config)
  const runtime = ctx.ptcRuntime as PythonPtcRuntime
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [] }))
  return { ctx, fiber, runtime, root, cwd, run }
}

/** Controlled provider response for testing metadata independently of the host backend. */
function confinement(argv: readonly string[]): ConfinedArgv {
  return {
    argv: [...argv], enforcement: 'partial', denialSignatures: ['permission denied'],
    runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['sandbox-fatal:'] }],
  }
}

describe('Python file sandbox', () => {
  it.each(['sandbox', 'sandboxPolicy'] as const)('does not register without the required %s service', async (missing) => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    if (missing !== 'sandbox') await ctx.plugin(Sandbox, {})
    if (missing !== 'sandboxPolicy') {
      await ctx.plugin(SessionProjections)
      await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
    }
    await ctx.plugin(PythonPtcRuntime)
    expect(ctx.get('ptcRuntime')).toBeUndefined()
  })

  it.skipIf(!sandboxUsable)('denies direct Python writes under the standing read-only policy', async () => {
    const { run, cwd } = await setup()
    const target = join(cwd, 'protected.txt')
    await writeFile(target, 'original')
    const result = await run(`open(${JSON.stringify(target)}, "w").write("escaped")`)
    expect(await readFile(target, 'utf8')).toBe('original')
    expect(result.error?.kind).toBe('exception')
    expect(result.sandbox).toMatchObject({ mode: 'read-only', denied: true })
  })

  it.skipIf(!sandboxUsable)('permits workspace writes while denying direct and symlink writes outside it', async () => {
    const { run, cwd, root } = await setup('workspace-write')
    const allowed = join(cwd, 'allowed.txt')
    const result = await run('open("allowed.txt", "w").write("allowed")\nreturn 42')
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(42)
    expect(result.sandbox).toMatchObject({ mode: 'workspace-write', denied: false })
    expect(await readFile(allowed, 'utf8')).toBe('allowed')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(cwd, 'escape'))
    for (const path of [join(outside, 'denied.txt'), join(cwd, 'escape', 'denied.txt')]) {
      const denied = await run(`open(${JSON.stringify(path)}, "w").write("escaped")`)
      expect(denied.error?.kind).toBe('exception')
      expect(denied.sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
      await expect(readFile(join(outside, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('forwards a complete explicit policy and defaults cwd to its workspace', async () => {
    const { ctx, runtime, root } = await setup()
    const selected = { mode: 'workspace-write' as const, workspaceRoot: root, sessionId: SessionId('python-policy-test') }
    const wrap = vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async argv => confinement(argv))
    const spec = runtime.resolve({ program: 'import os\nreturn os.getcwd()', bindings: [], sandboxPolicy: selected })
    expect(spec.sandboxPolicy).toBe(selected)
    expect(spec.cwd).toBe(root)
    expect((await runtime.run(spec)).value).toBe(root)
    expect(wrap).toHaveBeenCalledExactlyOnceWith(expect.any(Array), selected, expect.any(AbortSignal))
    expect(runtime.sandboxMode).toBe('read-only')
  })

  it('honors a one-call full-access override without changing the standing policy', async () => {
    const { ctx, runtime, root } = await setup()
    const confine = vi.spyOn(ctx.sandbox, 'confine')
    const target = join(root, 'outside.txt')
    const result = await runtime.run(runtime.resolve({
      program: `open(${JSON.stringify(target)}, "w").write("allowed")\nreturn 42`, bindings: [],
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: root },
    }))
    expect(result.error).toBeUndefined()
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(await readFile(target, 'utf8')).toBe('allowed')
    expect(confine).not.toHaveBeenCalled()
    expect(runtime.resolve({ program: '', bindings: [] }).sandboxPolicy?.mode).toBe('read-only')
  })

  it('fails closed when confinement cannot be prepared', async () => {
    const { ctx, run, cwd } = await setup()
    const target = join(cwd, 'denied.txt')
    const confine = vi.spyOn(ctx.sandbox, 'confine').mockRejectedValue(new SandboxUnavailableError('read-only'))
    const result = await run(`open(${JSON.stringify(target)}, "w").write("escaped")`)
    expect(result.error?.kind).toBe('sandbox-unavailable')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false })
    expect(confine).toHaveBeenCalledTimes(1)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports an unexpected provider failure without running the program', async () => {
    const { ctx, run } = await setup()
    vi.spyOn(ctx.sandbox, 'confine').mockRejectedValue(new Error('provider transport failed'))
    const result = await run('return 42')
    expect(result.error).toEqual({ kind: 'worker-exit', message: 'provider transport failed' })
    expect(result.value).toBeUndefined()
  })

  it.each([{ argv: [] }, { argv: ['/definitely-missing-python-sandbox-runner'] }])('fails closed for unusable runner argv $argv', async ({ argv }) => {
    const { ctx, run } = await setup()
    vi.spyOn(ctx.sandbox, 'confine').mockResolvedValue(confinement(argv))
    const result = await run('return 42')
    expect(result.error?.kind).toBe('sandbox-unavailable')
    expect(result.value).toBeUndefined()
  })

  it.skipIf(!sandboxUsable)('finds a confining launcher on the host PATH without exposing PATH to Python', async () => {
    const { ctx, run, root } = await setup()
    const confine = ctx.sandbox.confine.bind(ctx.sandbox)
    const { resolvePythonBin } = await import('../src/index.ts')
    const selected = await confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot: root })
    const executable = resolvePythonBin(selected.argv[0]!)
    if (executable === undefined) throw new Error('expected an executable sandbox launcher')
    const alias = 'python-test-private-sandbox-launcher'
    await symlink(executable, join(root, alias))
    vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH ?? ''}`)
    onTestFinished(() => { vi.unstubAllEnvs() })
    vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async (argv, policy, signal) => {
      const confined = await confine(argv, policy, signal)
      return { ...confined, argv: [alias, ...confined.argv.slice(1)] }
    })
    const result = await run('import os\nreturn os.environ.get("PATH")')
    expect(result.error).toBeUndefined()
    expect(result.value).toBeNull()
  })

  it('preserves partial enforcement on successful execution', async () => {
    const { ctx, run } = await setup()
    vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async argv => confinement(argv))
    const result = await run('return 42')
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(42)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })

  it.each([
    { program: 'raise PermissionError("permission denied")', denied: true },
    { program: 'raise PermissionError("read-only file system")', denied: false },
    { program: 'print("permission denied")\nreturn 42', denied: false },
  ])('uses only the selected backend denial dialect for $program', async ({ program, denied }) => {
    const { ctx, run } = await setup()
    vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async argv => confinement(argv))
    expect((await run(program)).sandbox).toEqual({ mode: 'read-only', denied, enforcement: 'partial' })
  })

  it.each([
    { code: 127, diagnostic: 'sandbox-fatal: permission denied', kind: 'sandbox-unavailable', denied: false },
    { code: 1, diagnostic: 'sandbox-fatal: permission denied', kind: 'worker-exit', denied: false },
    { code: 127, diagnostic: 'ordinary permission denied', kind: 'worker-exit', denied: false },
  ])('requires runner evidence and its exit-code gate: $diagnostic ($code)', async ({ code, diagnostic, kind, denied }) => {
    const { ctx, run } = await setup()
    vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async argv => confinement([
      argv[0]!, '-I', '-c', `import os,sys; sys.stdin.read(); os.write(2, ${JSON.stringify(`${diagnostic}\n`)}.encode()); os._exit(${code})`,
    ]))
    const result = await run('return 42')
    expect(result.error?.kind).toBe(kind)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied, enforcement: 'partial' })
  })

  it.skipIf(!sandboxUsable)('boots under confinement with stdin EOF, fd-3 bindings, resource limits and a scrubbed environment', async () => {
    const { runtime } = await setup('read-only', { cpuSeconds: 7 })
    vi.stubEnv('DSH_PYTHON_TEST_SECRET', 'must-not-inherit')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const result = await runtime.run(runtime.resolve({
      program: 'import sys, os, resource\nreturn [sys.stdin.read(), await tools.echo(42), resource.getrlimit(resource.RLIMIT_CPU)[0], os.environ.get("DSH_PYTHON_TEST_SECRET")]',
      bindings: [{ global: 'tools', functions: { echo: async args => args as number } }],
    }))
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual(['', 42, 7, null])
    expect(result.sandbox).toMatchObject({ mode: 'read-only', denied: false })
  })

  it.skipIf(!sandboxUsable)('retains the read-only policy in Python child processes', async () => {
    const { run, cwd } = await setup()
    const target = join(cwd, 'protected.txt')
    await writeFile(target, 'original')
    const child = `open(${JSON.stringify(target)}, "w").write("escaped")`
    const result = await run(`import subprocess,sys\nchild = subprocess.run([sys.executable, "-I", "-c", ${JSON.stringify(child)}], capture_output=True, text=True)\nreturn child.returncode`)
    expect(result.error).toBeUndefined()
    expect(result.value).not.toBe(0)
    expect(await readFile(target, 'utf8')).toBe('original')
  })

  it.skipIf(!sandboxUsable)('reports CPU termination according to the selected launcher signal transport', async () => {
    const { ctx, run } = await setup('read-only', { cpuSeconds: 1, maxWallMs: 30_000 })
    const confine = ctx.sandbox.confine.bind(ctx.sandbox)
    let mapsSignalsToExitCodes = false
    vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async (argv, policy, signal) => {
      const result = await confine(argv, policy, signal)
      mapsSignalsToExitCodes = basename(result.argv[0]!) === 'bwrap'
      return result
    })
    const result = await run('while True: pass')
    expect(result.error?.kind).toBe(mapsSignalsToExitCodes ? 'worker-exit' : 'timeout')
    expect(result.error?.message).toContain(mapsSignalsToExitCodes ? 'code=152, signal=null' : 'CPU time exhausted')
    expect(result.sandbox).toMatchObject({ mode: 'read-only', denied: false })
  })

  it.each([
    { program: 'while True: pass', kind: 'worker-exit' },
    {
      program: 'import signal,time\nsignal.signal(signal.SIGXCPU, signal.SIG_IGN)\nend = time.process_time() + 1.05\nwhile time.process_time() < end: pass\nreturn "escaped"',
      kind: 'timeout',
    },
    { program: 'import os\nos._exit(152)', kind: 'worker-exit' },
  ])('distinguishes CPU exhaustion from a numeric exit behind a signal-mapping launcher: $kind', async ({ program, kind }) => {
    const { ctx, run } = await setup('read-only', { cpuSeconds: 1, maxWallMs: 30_000 })
    // Linux bwrap converts a child's signal into a numeric exit; preserve fd 3
    // and exercise that launcher behavior independently of the host platform.
    const launcher = 'import subprocess,sys\nchild = subprocess.Popen(sys.argv[1:], pass_fds=(3,))\ncode = child.wait()\nsys.exit(128 - code if code < 0 else code)'
    vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async argv => confinement([
      argv[0]!, '-I', '-c', launcher, ...argv,
    ]))
    const result = await run(program)
    expect(result.error?.kind).toBe(kind)
    expect(result.value).toBeUndefined()
    if (kind === 'timeout') expect(result.error?.message).toContain('CPU time exhausted')
  })

  it.skipIf(!sandboxUsable).each(['abort', 'dispose', 'timeout'] as const)('closes a running confined program socket on %s', async (stop) => {
    const { fiber, runtime } = await setup('read-only', { maxWallMs: stop === 'timeout' ? 5000 : 30_000 })
    const connected = Promise.withResolvers<Socket>()
    let socket: Socket | undefined
    const server = createServer((accepted) => { socket = accepted; connected.resolve(accepted) })
    onTestFinished(async () => {
      socket?.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')
    const entered = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const pending = runtime.run(runtime.resolve({
      program: `import socket,asyncio\nconnection = socket.create_connection(("127.0.0.1", ${address.port}))\nawait tools.ready(None)\nawait asyncio.Event().wait()`,
      bindings: [{ global: 'tools', functions: { ready: async () => { entered.resolve(undefined); return null } } }],
      signal: controller.signal,
    }))
    try {
      await entered.promise
      socket = await connected.promise
      const closed = new Promise<void>((resolve) => { socket!.once('close', () => { resolve() }); socket!.resume() })
      if (stop === 'abort') controller.abort('stop confined program')
      else if (stop === 'dispose') await fiber.dispose()
      const result = await pending
      await closed
      expect(result.error?.kind).toBe(stop === 'timeout' ? 'timeout' : 'abort')
      expect(result.sandbox).toMatchObject({ mode: 'read-only', denied: false })
      expect(socket.destroyed).toBe(true)
    } finally {
      controller.abort('test cleanup')
      await pending
    }
  }, 30_000)

  it.each(['abort', 'dispose', 'timeout'] as const)('does not start a program when %s wins during confinement', async (stop) => {
    const { ctx, fiber, runtime, cwd } = await setup('read-only', { maxWallMs: 5000 })
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<ConfinedArgv>()
    let selectedArgv: readonly string[] = []
    const confine = vi.spyOn(ctx.sandbox, 'confine').mockImplementation((argv, _policy, signal) => {
      selectedArgv = argv
      if (signal === undefined) throw new Error('confinement needs a cancellation signal')
      entered.resolve(signal)
      return release.promise
    })
    const target = join(cwd, 'late-program.txt')
    const controller = new AbortController()
    if (stop === 'timeout') vi.useFakeTimers()
    const pending = runtime.run(runtime.resolve({
      program: `open(${JSON.stringify(target)}, "w").write("escaped")`, bindings: [], signal: controller.signal,
    }))
    let disposed: Promise<void> | undefined
    try {
      const signal = await entered.promise
      expect(signal.aborted).toBe(false)
      const stopped = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      if (stop === 'abort') controller.abort('cancel preparation')
      else if (stop === 'dispose') disposed = fiber.dispose()
      else await vi.advanceTimersByTimeAsync(5000)
      await stopped
      expect(signal.aborted).toBe(true)
      release.resolve(confinement(selectedArgv))
      const result = await pending
      await disposed
      expect(result.error?.kind).toBe(stop === 'timeout' ? 'timeout' : 'abort')
      expect(result.value).toBeUndefined()
      expect(result.sandbox).toMatchObject({ mode: 'read-only', denied: false })
      expect(confine).toHaveBeenCalledTimes(1)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.useRealTimers()
      controller.abort('test cleanup')
      release.resolve(confinement(selectedArgv))
      await pending
      await disposed
    }
  })
})
