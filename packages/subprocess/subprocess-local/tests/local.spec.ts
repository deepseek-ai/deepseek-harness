import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { basename, dirname, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { childEnv } from '../src/spawn.ts'

function mockWin32ForIsolatedRuntime(): void {
  vi.doMock('@deepseek-ai/dsh-win32-process', () => ({
    loadWin32ProcessBindings: vi.fn(),
    probeCurrentTokenJobSupport: vi.fn(),
  }))
}

function unmockWin32ForIsolatedRuntime(): void {
  vi.doUnmock('@deepseek-ai/dsh-win32-process')
}

function spec(command: string, overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  // Windows has no bash; the suite's simple commands translate to node one-liners.
  const argv = process.platform === 'win32'
    ? [process.execPath, '-e', {
      'echo managed': 'console.log("managed")',
      'sleep 60': 'setTimeout(() => {}, 60000)',
      'true': '',
    }[command] ?? command]
    : ['bash', '-c', command]
  return {
    argv,
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } },
      stderr: { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } },
    },
    graceMs: 200,
    ...overrides,
  }
}

describe('LocalSubprocessRuntime', () => {
  it('places the host-exit finalizer before listeners that predate the service', async () => {
    const baseline = new Set(process.listeners('exit'))
    const prior = vi.fn()
    process.on('exit', prior)
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const listeners = process.listeners('exit')
      const finalizer = listeners.find(candidate => !baseline.has(candidate) && candidate !== prior)
      expect(finalizer).toBeTypeOf('function')
      expect(listeners.indexOf(finalizer!)).toBeLessThan(listeners.indexOf(prior))
    } finally {
      process.off('exit', prior)
      await fiber.dispose()
    }
  })

  it('keeps the host-exit finalizer active until normal disposal reaches quiescence', async () => {
    const before = new Set(process.listeners('exit'))
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const listener = process.listeners('exit').find(candidate => !before.has(candidate))
    expect(listener).toBeTypeOf('function')

    let finishExit!: () => void
    const exited = new Promise<void>((resolve) => { finishExit = resolve })
    const terminate = vi.fn()
    const terminateForHostExit = vi.fn()
    const live = (ctx.subprocess as unknown as {
      live: Set<{
        done: Promise<{ exitCode: number; signal: null }>
        terminate(): void
        terminateForHostExit(): void
        waitForExit(): Promise<boolean>
      }>
    }).live
    live.add({
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate,
      terminateForHostExit,
      waitForExit: async () => { await exited; return true },
    })

    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    expect(live.size).toBe(1)
    listener?.(0)
    expect(terminate).toHaveBeenCalledOnce()
    expect(terminateForHostExit).toHaveBeenCalledOnce()

    finishExit()
    await disposing
    expect(live.size).toBe(0)
    expect(process.listeners('exit')).not.toContain(listener)
  })

  it('observes range failure without waiting for a stuck direct result', async () => {
    const before = new Set(process.listeners('exit'))
    const ctx = new Context()
    const disposalErrors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { disposalErrors.push(error) }) as typeof ctx.logger.error
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const listener = process.listeners('exit').find(candidate => !before.has(candidate))
    const rangeFailure = new Error('managed range became unreadable')
    const terminate = vi.fn()
    const terminateForHostExit = vi.fn()
    const live = (ctx.subprocess as unknown as {
      live: Set<{
        done: Promise<never>
        terminate(): void
        terminateForHostExit(): void
        waitForExit(): Promise<boolean>
      }>
    }).live
    live.add({
      done: new Promise<never>(() => {}),
      terminate,
      terminateForHostExit,
      waitForExit: async () => { throw rangeFailure },
    })

    await expect(Promise.race([
      fiber.dispose().then(() => 'disposed'),
      new Promise<string>(resolve => setTimeout(() => { resolve('timeout') }, 100)),
    ])).resolves.toBe('disposed')
    expect(terminate).toHaveBeenCalledOnce()
    expect(terminateForHostExit).toHaveBeenCalledOnce()
    expect(disposalErrors).toEqual([rangeFailure])
    expect(live.size).toBe(1)
    expect(process.listeners('exit')).toContain(listener)
    listener?.(0)
    expect(terminateForHostExit).toHaveBeenCalledTimes(2)
    if (listener !== undefined) process.off('exit', listener)
  })

  it('contains each host-exit termination failure and continues with the other targets', async () => {
    const before = new Set(process.listeners('exit'))
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const listener = process.listeners('exit').find(candidate => !before.has(candidate))
    expect(listener).toBeTypeOf('function')
    const ordinaryFailure = vi.fn(() => { throw new Error('ordinary failed') })
    const ordinarySuccess = vi.fn()
    const terminalFailure = vi.fn(() => { throw new Error('terminal failed') })
    const terminalSuccess = vi.fn()
    const service = ctx.subprocess as unknown as {
      live: Set<{ terminateForHostExit(): void }>
      terminals: Set<{ terminateForHostExit(): void }>
    }
    service.live.add({ terminateForHostExit: ordinaryFailure })
    service.live.add({ terminateForHostExit: ordinarySuccess })
    service.terminals.add({ terminateForHostExit: terminalFailure })
    service.terminals.add({ terminateForHostExit: terminalSuccess })

    expect(() => { listener?.(0) }).not.toThrow()
    expect(ordinaryFailure).toHaveBeenCalledOnce()
    expect(ordinarySuccess).toHaveBeenCalledOnce()
    expect(terminalFailure).toHaveBeenCalledOnce()
    expect(terminalSuccess).toHaveBeenCalledOnce()

    service.live.clear()
    service.terminals.clear()
    await fiber.dispose()
  })

  it('resolves absolute and PATH executables and honors lookup cancellation', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    expect(await ctx.subprocess.resolveExecutable(process.execPath)).toBe(process.execPath)
    expect(await ctx.subprocess.resolveExecutable(basename(process.execPath), {
      PATH: dirname(process.execPath),
    })).toBe(process.execPath)
    expect(await ctx.subprocess.resolveExecutable(basename(process.execPath), {
      PATH: relative(process.cwd(), dirname(process.execPath)) || '.',
    })).toBe(process.execPath)
    await expect(ctx.subprocess.resolveExecutable('')).rejects.toThrow('must be non-empty')
    await expect(ctx.subprocess.resolveExecutable('./bin/tsserver'))
      .rejects.toThrow('is a relative path')
    await expect(ctx.subprocess.resolveExecutable('node_modules/.bin/server'))
      .rejects.toThrow('is a relative path')
    await expect(ctx.subprocess.resolveExecutable('dsh-command-that-does-not-exist', { PATH: '' }))
      .rejects.toThrow('was not found on PATH')
    await expect(ctx.subprocess.resolveExecutable('/dsh-absolute-command-that-does-not-exist'))
      .rejects.toThrow('is not an executable file')
    await expect(ctx.subprocess.resolveExecutable(process.cwd()))
      .rejects.toThrow('is not an executable file')
    await expect(ctx.subprocess.resolveExecutable(process.execPath, {}, AbortSignal.abort('stop')))
      .rejects.toBe('stop')
    await fiber.dispose()
  })

  it('builds Windows executable candidates with case-insensitive overrides', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const service = ctx.subprocess as LocalSubprocessRuntime
    const candidates = (service as unknown as {
      executableCandidates(command: string, env: NodeJS.ProcessEnv): string[]
    }).executableCandidates.bind(service)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      expect(Object.keys(childEnv()).filter(key => key.toUpperCase() === 'PATH')).toHaveLength(1)
      const explicit = childEnv({ Path: '/bin', PathExt: '.EXE;.CMD' })
      expect(Object.keys(explicit).filter(key => key.toUpperCase() === 'PATH')).toEqual(['Path'])
      expect(Object.keys(explicit).filter(key => key.toUpperCase() === 'PATHEXT')).toEqual(['PathExt'])
      expect(candidates('tool', explicit)).toEqual([resolve('/bin', 'tool.EXE'), resolve('/bin', 'tool.CMD')])
      expect(candidates('tool', { Path: '/ambient', PATH: '/explicit', PATHEXT: '.EXE' }))
        .toEqual([resolve('/explicit', 'tool.EXE')])
      expect(candidates('tool.exe', {})).toEqual([resolve(process.cwd(), 'tool.exe')])
      expect(candidates('tool', { PATH: '/bin' })).toHaveLength(4)
      await expect(ctx.subprocess.resolveExecutable(String.raw`bin\server.exe`))
        .rejects.toThrow('is a relative path')
    } finally {
      platform.mockRestore()
      await fiber.dispose()
    }
  })

  it('validates terminal allocation inputs before allocating a PTY', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const base: SubprocessTerminalSpawnSpec = {
      argv: ['bash'], cwd: process.cwd(), rows: 24, cols: 80, graceMs: 10,
    }
    await expect(ctx.subprocess.spawnTerminal({ ...base, argv: [] })).rejects.toThrow('must contain a program')
    await expect(ctx.subprocess.spawnTerminal({ ...base, argv: [''] })).rejects.toThrow('must contain a program')
    await expect(ctx.subprocess.spawnTerminal({ ...base, signal: AbortSignal.abort('stop') })).rejects.toBe('stop')
    await fiber.dispose()
  })

  it('terminates and joins an owned terminal during disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const terminate = vi.fn(async () => {})
    const terminal: SubprocessTerminalHandle = {
      pid: 1,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      inspectForeground: async () => undefined,
      signalForeground: async () => 1,
      terminate,
    }
    const terminals = (ctx.subprocess as unknown as { terminals: Set<SubprocessTerminalHandle> }).terminals
    terminals.add(terminal)
    await fiber.dispose()
    expect(terminate).toHaveBeenCalledOnce()
    expect(terminals.size).toBe(0)
  })

  it('waits for every terminal cleanup and aggregates teardown failures', async () => {
    const before = new Set(process.listeners('exit'))
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const listener = process.listeners('exit').find(candidate => !before.has(candidate))
    expect(listener).toBeTypeOf('function')
    const service = ctx.subprocess
    const firstFailure = new Error('first cleanup failure')
    const secondFailure = new Error('second cleanup failure')
    const disposalErrors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { disposalErrors.push(error) }) as typeof ctx.logger.error
    const failedTerminal: SubprocessTerminalHandle = {
      pid: 1,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      inspectForeground: async () => undefined,
      signalForeground: async () => 1,
      terminate: vi.fn(async () => { throw firstFailure }),
    }
    const secondFailedTerminal: SubprocessTerminalHandle = {
      ...failedTerminal,
      terminate: vi.fn(async () => { throw secondFailure }),
    }
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const drainingTerminal: SubprocessTerminalHandle = {
      ...failedTerminal,
      terminate: vi.fn(() => cleanup),
    }
    const terminals = (service as unknown as { terminals: Set<SubprocessTerminalHandle> }).terminals
    terminals.add(failedTerminal)
    terminals.add(secondFailedTerminal)
    terminals.add(drainingTerminal)

    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    finishCleanup()
    await disposing
    expect(terminals).toEqual(new Set([failedTerminal, secondFailedTerminal]))
    expect(disposalErrors).toHaveLength(1)
    expect(disposalErrors[0]).toMatchObject({
      errors: [firstFailure, secondFailure],
      message: 'local subprocess teardown failed',
    })
    expect(process.listeners('exit')).toContain(listener)
    if (listener !== undefined) process.off('exit', listener)
  })

  it('reports one cleanup failure without wrapping it', async () => {
    const before = new Set(process.listeners('exit'))
    const ctx = new Context()
    const failure = new Error('single cleanup failure')
    const disposalErrors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { disposalErrors.push(error) }) as typeof ctx.logger.error
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const listener = process.listeners('exit').find(candidate => !before.has(candidate))
    expect(listener).toBeTypeOf('function')
    const service = ctx.subprocess
    const terminal: SubprocessTerminalHandle = {
      pid: 1,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      inspectForeground: async () => undefined,
      signalForeground: async () => 1,
      terminate: vi.fn(async () => { throw failure }),
    }
    const terminals = (service as unknown as { terminals: Set<SubprocessTerminalHandle> }).terminals
    terminals.add(terminal)

    await fiber.dispose()

    expect(disposalErrors).toEqual([failure])
    expect(terminals.has(terminal)).toBe(true)
    expect(process.listeners('exit')).toContain(listener)
    if (listener !== undefined) process.off('exit', listener)
  })

  it('force-terminates and retains failed disposal targets for host exit', async () => {
    const before = new Set(process.listeners('exit'))
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const listener = process.listeners('exit').find(candidate => !before.has(candidate))
    expect(listener).toBeTypeOf('function')
    const failure = new Error('cleanup failed')
    const terminateForHostExit = vi.fn(() => {
      expect(process.listeners('exit')).toContain(listener)
    })
    const terminal = {
      terminate: vi.fn(async () => { throw failure }),
      terminateForHostExit,
    }
    const terminals = (ctx.subprocess as unknown as { terminals: Set<typeof terminal> }).terminals
    terminals.add(terminal)

    await fiber.dispose()

    expect(terminateForHostExit).toHaveBeenCalledOnce()
    expect(terminals.size).toBe(1)
    expect(process.listeners('exit')).toContain(listener)
    listener?.(0)
    expect(terminateForHostExit).toHaveBeenCalledTimes(2)
    if (listener !== undefined) process.off('exit', listener)
  })

  it('releases a terminal after top-level exit reaches quiescence', async () => {
    let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined
    const inspector = {
      foregroundPgid: () => undefined,
      isStdinWaiting: () => false,
      snapshot: () => ({ tree: () => [], session: () => [], alive: () => false }),
      isAlive: () => false,
      signalGroup: () => {},
      signalProcess: () => {},
    }
    const terminal = {
      pid: 123,
      onData: () => ({ dispose: () => {} }),
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListener = listener
        return { dispose: () => {} }
      },
      write: () => {},
      kill: () => {},
    }
    vi.resetModules()
    mockWin32ForIsolatedRuntime()
    vi.doMock('node-pty', () => ({ spawn: () => terminal }))
    vi.doMock('../src/process-inspector.ts', async importOriginal => ({
      ...await importOriginal<typeof import('../src/process-inspector.ts')>(),
      createProcessInspector: () => inspector,
    }))
    try {
      const { default: IsolatedLocalSubprocessRuntime } = await import('../src/index.ts')
      const ctx = new Context()
      const fiber = await ctx.plugin(IsolatedLocalSubprocessRuntime)
      const service = ctx.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>
      const handle = await ctx.subprocess.spawnTerminal({
        argv: ['shell'], cwd: process.cwd(), rows: 24, cols: 80, graceMs: 1,
      })
      expect((service as unknown as { terminals: Set<SubprocessTerminalHandle> }).terminals.size).toBe(1)
      exitListener?.({ exitCode: 0 })
      await handle.done
      await new Promise(resolve => setImmediate(resolve))
      expect((service as unknown as { terminals: Set<SubprocessTerminalHandle> }).terminals.size).toBe(0)
      await fiber.dispose()
    } finally {
      vi.doUnmock('node-pty')
      vi.doUnmock('../src/process-inspector.ts')
      unmockWin32ForIsolatedRuntime()
      vi.resetModules()
    }
  })

  it('wraps Linux terminals in the selected scope and binds owner liveness', async () => {
    let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined
    let launcherRunning: (() => boolean) | undefined
    let launcherSignal: ((signal: 'SIGTERM' | 'SIGKILL') => void) | undefined
    const terminalKill = vi.fn(() => { throw new Error('terminal already exited') })
    const terminal = {
      pid: 123,
      onData: () => ({ dispose: () => {} }),
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListener = listener
        return { dispose: () => {} }
      },
      write: () => {},
      kill: terminalKill,
    }
    const nodePtySpawn = vi.fn(() => terminal)
    const owner = {
      signal: vi.fn(),
      waitForExit: vi.fn(async () => {}),
      terminateForHostExit: vi.fn(),
    }
    const launcherStates: boolean[] = []
    const bindOwner = vi.fn((direct: { running(): boolean; signal(signal: 'SIGTERM' | 'SIGKILL'): void }) => {
      launcherRunning = () => direct.running()
      launcherSignal = (signal) => { direct.signal(signal) }
      launcherStates.push(direct.running())
      return owner
    })
    const prepareLinuxTerminalScope = vi.fn(() => ({
      command: '/usr/bin/systemd-run',
      args: ['--user', '--scope', '--quiet', '--collect', '--', '/usr/bin/node', '/runner.js', '--', 'shell', '--literal'],
      cwd: '/bootstrap',
      env: { BOOTSTRAP: 'yes' },
      bindOwner,
      resolveOutcome: (outcome: unknown) => outcome,
      cleanup: vi.fn(),
    }))
    const probeLinuxNative = vi.fn(() => true)
    const probeLinuxManager = vi.fn(() => true)
    const inspector = {
      foregroundPgid: () => undefined,
      isStdinWaiting: () => false,
      snapshot: () => ({
        tree: () => [{ pid: 123, started: 'shell' }],
        session: () => [],
        alive: () => false,
      }),
      isAlive: () => false,
      signalGroup: () => {},
      signalProcess: () => {},
    }

    vi.resetModules()
    mockWin32ForIsolatedRuntime()
    vi.doMock('node-pty', () => ({ spawn: nodePtySpawn }))
    vi.doMock('../src/linux-scope.ts', () => ({
      launchLinuxScope: vi.fn(),
      prepareLinuxTerminalScope,
      probeLinuxManager,
      probeLinuxNative,
    }))
    let fiber: { dispose(): Promise<void> } | undefined
    try {
      const { default: IsolatedLocalSubprocessRuntime } = await import('../src/index.ts')
      const ctx = new Context()
      fiber = await ctx.plugin(IsolatedLocalSubprocessRuntime)
      const runtime = ctx.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>
      runtime.internals = { platform: 'linux' }
      runtime.terminalInspector = inspector

      const targetCwd = process.cwd()
      const handle = await runtime.spawnTerminal({
        argv: ['shell', '--literal'],
        cwd: targetCwd,
        rows: 24,
        cols: 80,
        graceMs: 10,
        env: { PWD: '/stale-parent-cwd', TERM: 'xterm-256color', TARGET_VALUE: 'preserved' },
      })

      expect(probeLinuxNative).toHaveBeenCalledOnce()
      expect(prepareLinuxTerminalScope).toHaveBeenCalledWith(
        expect.objectContaining({ argv: ['shell', '--literal'] }),
        expect.objectContaining({ PWD: targetCwd, TERM: 'dumb', TARGET_VALUE: 'preserved' }),
      )
      expect(nodePtySpawn).toHaveBeenCalledWith(
        '/usr/bin/systemd-run',
        ['--user', '--scope', '--quiet', '--collect', '--', '/usr/bin/node', '/runner.js', '--', 'shell', '--literal'],
        expect.objectContaining({ rows: 24, cols: 80, cwd: '/bootstrap', env: { BOOTSTRAP: 'yes' } }),
      )
      expect(bindOwner).toHaveBeenCalledOnce()
      expect(launcherStates).toEqual([true])
      expect(launcherRunning?.()).toBe(true)
      expect(() => { launcherSignal?.('SIGTERM') }).not.toThrow()
      expect(terminalKill).toHaveBeenCalledExactlyOnceWith('SIGTERM')

      exitListener?.({ exitCode: 0 })
      expect(launcherRunning?.()).toBe(false)
      await handle.done
      await new Promise(resolve => setImmediate(resolve))
      expect(owner.signal).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(owner.waitForExit).toHaveBeenCalledOnce()
    } finally {
      await fiber?.dispose()
      vi.doUnmock('node-pty')
      vi.doUnmock('../src/linux-scope.ts')
      unmockWin32ForIsolatedRuntime()
      vi.resetModules()
    }
  })

  it('cleans the Linux terminal launch protocol when node-pty throws synchronously', async () => {
    const launchFailure = new Error('node-pty launch failed')
    const cleanup = vi.fn()
    const nodePtySpawn = vi.fn(() => { throw launchFailure })
    const prepareLinuxTerminalScope = vi.fn(() => ({
      command: '/usr/bin/systemd-run',
      args: ['--user', '--scope', '--', 'shell'],
      cwd: '/bootstrap',
      env: { BOOTSTRAP: 'yes' },
      bindOwner: vi.fn(),
      resolveOutcome: (outcome: unknown) => outcome,
      cleanup,
    }))
    const inspector = {
      foregroundPgid: () => undefined,
      isStdinWaiting: () => false,
      snapshot: () => ({
        tree: () => [{ pid: 123, started: 'shell' }],
        session: () => [],
        alive: () => false,
      }),
      isAlive: () => false,
      signalGroup: () => {},
      signalProcess: () => {},
    }

    vi.resetModules()
    mockWin32ForIsolatedRuntime()
    vi.doMock('node-pty', () => ({ spawn: nodePtySpawn }))
    vi.doMock('../src/linux-scope.ts', () => ({
      launchLinuxScope: vi.fn(),
      prepareLinuxTerminalScope,
      probeLinuxManager: () => true,
      probeLinuxNative: () => true,
    }))
    let fiber: { dispose(): Promise<void> } | undefined
    try {
      const { default: IsolatedLocalSubprocessRuntime } = await import('../src/index.ts')
      const ctx = new Context()
      fiber = await ctx.plugin(IsolatedLocalSubprocessRuntime)
      const runtime = ctx.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>
      runtime.internals = { platform: 'linux' }
      runtime.terminalInspector = inspector

      await expect(runtime.spawnTerminal({
        argv: ['shell'], cwd: process.cwd(), rows: 24, cols: 80, graceMs: 10,
      })).rejects.toBe(launchFailure)
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      await fiber?.dispose()
      vi.doUnmock('node-pty')
      vi.doUnmock('../src/linux-scope.ts')
      unmockWin32ForIsolatedRuntime()
      vi.resetModules()
    }
  })

  it('retains a terminal whose automatic cleanup fails', async () => {
    let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined
    const terminal = {
      pid: 123,
      onData: () => ({ dispose: () => {} }),
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListener = listener
        return { dispose: () => {} }
      },
      write: () => {},
      kill: () => {},
    }
    vi.resetModules()
    mockWin32ForIsolatedRuntime()
    vi.doMock('node-pty', () => ({ spawn: () => terminal }))
    try {
      const { default: IsolatedLocalSubprocessRuntime } = await import('../src/index.ts')
      const ctx = new Context()
      const disposalErrors: unknown[] = []
      ctx.logger.error = ((error: unknown) => { disposalErrors.push(error) }) as typeof ctx.logger.error
      const fiber = await ctx.plugin(IsolatedLocalSubprocessRuntime)
      const alive = new Set([124])
      ;(ctx.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>).terminalInspector = {
        foregroundPgid: () => 123,
        isStdinWaiting: () => false,
        snapshot: () => ({
          tree: () => [{ pid: 123, started: 'shell' }, { pid: 124, started: 'child' }],
          session: () => [],
          alive: identity => alive.has(identity.pid),
        }),
        isAlive: identity => alive.has(identity.pid),
        signalGroup: () => {},
        signalProcess: () => {},
      }
      const handle = await ctx.subprocess.spawnTerminal({
        argv: ['shell'], cwd: process.cwd(), rows: 24, cols: 80, graceMs: 1,
      })
      exitListener?.({ exitCode: 0 })
      await handle.done
      await new Promise(resolve => setTimeout(resolve, 10))
      expect((ctx.subprocess as unknown as { terminals: Set<SubprocessTerminalHandle> }).terminals.size).toBe(1)
      await fiber.dispose()
      expect(disposalErrors).toHaveLength(1)
    } finally {
      vi.doUnmock('node-pty')
      unmockWin32ForIsolatedRuntime()
      vi.resetModules()
    }
  })

  it('registers as ctx.subprocess and spawns managed handles', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = ctx.subprocess.spawn(spec('echo managed'))
    expect(handle).not.toHaveProperty('pid')
    const result = await handle.done
    expect(result.exitCode).toBe(0)
    expect(handle.collected.stdout!.readFrom(0).text).toBe('managed\n')
    await fiber.dispose()
  })

  it('warns once when ordinary spawns use the weaker macOS fallback', async () => {
    const ctx = new Context()
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const runtime = ctx.subprocess as LocalSubprocessRuntime
    runtime.internals = { platform: 'darwin' }
    try {
      const first = runtime.spawn(spec('true'))
      const second = runtime.spawn(spec('true'))
      await Promise.all([first.done, second.done])
      expect(warning).toHaveBeenCalledOnce()
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('descendants that escape the process group'),
      )
    } finally {
      warning.mockRestore()
      await fiber.dispose()
    }
  })

  it('reports the platform-specific reason for every fallback mode', async () => {
    for (const [platform, kind, reason, selectedReason] of [
      ['darwin', 'ordinary', 'macOS has no supported persistent process-range owner', undefined],
      ['linux', 'ordinary', 'the private Linux subprocess runner is unavailable', 'the private Linux subprocess runner is unavailable'],
      ['win32', 'ordinary', 'the Win32 Job runner is unavailable', undefined],
      ['win32', 'terminal', 'Windows ConPTY remains outside Job containment', undefined],
      ['freebsd', 'ordinary', 'platform freebsd has no native managed range', undefined],
    ] as const) {
      const ctx = new Context()
      const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const fiber = await ctx.plugin(LocalSubprocessRuntime)
      const runtime = ctx.subprocess as unknown as {
        warnFallback(platform: NodeJS.Platform, kind: 'ordinary' | 'terminal', selectedReason?: string): void
      }
      try {
        runtime.warnFallback(platform, kind, selectedReason)
        expect(warning).toHaveBeenLastCalledWith(
          expect.stringContaining(reason),
        )
      } finally {
        warning.mockRestore()
        await fiber.dispose()
      }
    }
  })

  it('rechecks native prerequisites for every eligible spawn and prepares storage before launch', async () => {
    const linuxLaunch = { kind: 'linux' }
    const windowsLaunch = { kind: 'windows' }
    const launchLinuxScope = vi.fn(() => linuxLaunch)
    const launchWindowsJob = vi.fn(() => windowsLaunch)
    const probeLinuxNative = vi.fn(() => true)
    const probeLinuxManager = vi.fn(() => true)
    const probeWindowsJob = vi.fn(() => true)
    const prepareManagedProcessBinding = vi.fn(() => ({ spillDir: '/tmp/dsh-test-spill' }))
    const handles = [true, false, false].map((failFirstWait) => {
      let waits = 0
      return {
        collected: {},
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: vi.fn(),
        terminateForHostExit: vi.fn(),
        waitForExit: vi.fn(async () => {
          waits += 1
          if (failFirstWait && waits === 1) throw new Error('release observation failed')
          return true
        }),
      }
    })
    const bindManagedProcess = vi.fn((_spec: unknown, _launch: unknown, _binding: unknown) => {
      const handle = handles.shift()
      if (handle === undefined) throw new Error('missing fake handle')
      return handle
    })
    const spawnSubprocess = vi.fn()

    vi.resetModules()
    mockWin32ForIsolatedRuntime()
    vi.doMock('../src/linux-scope.ts', () => ({
      launchLinuxScope,
      prepareLinuxTerminalScope: vi.fn(),
      probeLinuxManager,
      probeLinuxNative,
    }))
    vi.doMock('../src/windows-job.ts', () => ({ launchWindowsJob, probeWindowsJob }))
    vi.doMock('../src/spawn.ts', async importOriginal => ({
      ...await importOriginal<typeof import('../src/spawn.ts')>(),
      bindManagedProcess,
      prepareManagedProcessBinding,
      spawnSubprocess,
    }))
    const fibers: Array<{ dispose(): Promise<void> }> = []
    try {
      const { default: IsolatedLocalSubprocessRuntime } = await import('../src/index.ts')
      const linuxContext = new Context()
      const linuxFiber = await linuxContext.plugin(IsolatedLocalSubprocessRuntime)
      fibers.push(linuxFiber)
      const linuxRuntime = linuxContext.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>
      linuxRuntime.internals = { platform: 'linux' }
      const preparationFailure = new Error('spill directory unavailable')
      prepareManagedProcessBinding.mockImplementationOnce(() => { throw preparationFailure })
      expect(() => linuxRuntime.spawn(spec('true'))).toThrow(preparationFailure)
      expect(launchLinuxScope).not.toHaveBeenCalled()
      await linuxRuntime.spawn(spec('true')).done
      await new Promise(resolve => setImmediate(resolve))
      await linuxRuntime.spawn(spec('true')).done
      await new Promise(resolve => setImmediate(resolve))
      expect(probeLinuxNative).toHaveBeenCalledOnce()
      expect(probeLinuxManager).toHaveBeenCalledTimes(2)
      expect(launchLinuxScope).toHaveBeenCalledTimes(2)

      const windowsContext = new Context()
      const windowsFiber = await windowsContext.plugin(IsolatedLocalSubprocessRuntime)
      fibers.push(windowsFiber)
      const windowsRuntime = windowsContext.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>
      windowsRuntime.internals = { platform: 'win32' }
      await windowsRuntime.spawn(spec('true')).done
      await new Promise(resolve => setImmediate(resolve))
      expect(probeWindowsJob).toHaveBeenCalledOnce()
      expect(launchWindowsJob).toHaveBeenCalledOnce()
      expect(bindManagedProcess.mock.calls.map(([, launch]) => launch)).toEqual([
        linuxLaunch,
        linuxLaunch,
        windowsLaunch,
      ])
      expect(prepareManagedProcessBinding).toHaveBeenCalledTimes(4)
      expect(spawnSubprocess).not.toHaveBeenCalled()
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      vi.doUnmock('../src/linux-scope.ts')
      vi.doUnmock('../src/windows-job.ts')
      vi.doUnmock('../src/spawn.ts')
      unmockWin32ForIsolatedRuntime()
      vi.resetModules()
    }
  })

  it('retries failed Linux deep probes, caches the first success, and rechecks the manager', async () => {
    const probeLinuxNative = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const probeLinuxManager = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const probeWindowsJob = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)

    vi.resetModules()
    mockWin32ForIsolatedRuntime()
    vi.doMock('../src/linux-scope.ts', () => ({
      launchLinuxScope: vi.fn(),
      prepareLinuxTerminalScope: vi.fn(),
      probeLinuxManager,
      probeLinuxNative,
    }))
    vi.doMock('../src/windows-job.ts', () => ({ launchWindowsJob: vi.fn(), probeWindowsJob }))
    const fibers: Array<{ dispose(): Promise<void> }> = []
    try {
      const { default: IsolatedLocalSubprocessRuntime } = await import('../src/index.ts')
      const linuxContext = new Context()
      vi.spyOn(linuxContext.logger, 'warn').mockImplementation(() => {})
      const linuxFiber = await linuxContext.plugin(IsolatedLocalSubprocessRuntime)
      fibers.push(linuxFiber)
      const linuxRuntime = linuxContext.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>
      linuxRuntime.internals = { platform: 'linux' }
      const linuxSelect = (linuxRuntime as unknown as {
        selectContainmentMode(kind: 'ordinary' | 'terminal'): 'linux-scope' | 'windows-job' | 'fallback'
      }).selectContainmentMode.bind(linuxRuntime)

      expect(linuxSelect('ordinary')).toBe('fallback')
      expect(linuxSelect('ordinary')).toBe('fallback')
      expect(linuxSelect('ordinary')).toBe('fallback')
      expect(linuxSelect('ordinary')).toBe('linux-scope')
      expect(linuxSelect('ordinary')).toBe('fallback')
      expect(linuxSelect('ordinary')).toBe('linux-scope')
      expect(probeLinuxNative).toHaveBeenCalledTimes(4)
      expect(probeLinuxManager).toHaveBeenCalledTimes(2)

      const windowsContext = new Context()
      vi.spyOn(windowsContext.logger, 'warn').mockImplementation(() => {})
      const windowsFiber = await windowsContext.plugin(IsolatedLocalSubprocessRuntime)
      fibers.push(windowsFiber)
      const windowsRuntime = windowsContext.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>
      windowsRuntime.internals = { platform: 'win32' }
      const windowsSelect = (windowsRuntime as unknown as {
        selectContainmentMode(kind: 'ordinary' | 'terminal'): 'linux-scope' | 'windows-job' | 'fallback'
      }).selectContainmentMode.bind(windowsRuntime)

      expect(windowsSelect('ordinary')).toBe('fallback')
      expect(windowsSelect('ordinary')).toBe('windows-job')
      expect(windowsSelect('ordinary')).toBe('windows-job')
      expect(probeWindowsJob).toHaveBeenCalledTimes(3)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      vi.doUnmock('../src/linux-scope.ts')
      vi.doUnmock('../src/windows-job.ts')
      unmockWin32ForIsolatedRuntime()
      vi.resetModules()
    }
  })

  it('disposal kills still-running processes and awaits their exit', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = ctx.subprocess.spawn(spec('sleep 60'))
    await fiber.dispose()
    const outcome = await handle.done
    // Windows teardown terminates through taskkill, which reports no signal.
    expect(outcome.signal).toBe(process.platform === 'win32' ? null : 'SIGTERM')
  })

  it('a settled process leaves the live set (disposal does not re-kill it)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = ctx.subprocess.spawn(spec('true'))
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    await fiber.dispose()
  })

  it('disposal tolerates a handle whose spawn already failed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = ctx.subprocess.spawn(spec('true', { cwd: '/nonexistent-dir-dsh-subprocess-test' }))
    await expect(handle.done).rejects.toThrow()
    await fiber.dispose()
  })

  it('disposal contains a spawn-failure rejection that races teardown', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    // Dispose before the rejection continuation removes the handle from the
    // live set, so teardown itself must swallow the rejected done.
    const handle = ctx.subprocess.spawn(spec('true', { cwd: '/nonexistent-dir-dsh-subprocess-test' }))
    await fiber.dispose()
    await expect(handle.done).rejects.toThrow()
  })

  it('loading a second implementation throws (one processes service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    class SecondManager extends LocalSubprocessRuntime {}
    await expect(ctx.plugin(SecondManager)).rejects.toThrow(/service "subprocess" has been registered/)
  })
})
