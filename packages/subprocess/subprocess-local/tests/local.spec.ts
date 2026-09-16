import { PassThrough } from 'node:stream'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { basename, dirname, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { childEnv } from '../src/spawn.ts'
import { signalLinuxDirectProcess } from '../src/linux-scope.ts'

function mockWin32ForIsolatedRuntime(): void {
  vi.doMock('@deepseek-ai/dsh-win32-process', () => ({
    loadWin32ProcessBindings: vi.fn(),
    probeCurrentTokenJobSupport: vi.fn(),
  }))
}

function unmockWin32ForIsolatedRuntime(): void {
  vi.doUnmock('@deepseek-ai/dsh-win32-process')
}

function mockNodePtyForIsolatedRuntime(spawn: unknown): void {
  vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
    createLazyRequire: (specifier: string) => () => {
      if (specifier === 'node-pty') return { spawn }
      throw new Error(`unexpected lazy dependency ${specifier}`)
    },
  }))
}

function unmockLazyRequireForIsolatedRuntime(): void {
  vi.doUnmock('@deepseek-ai/dsh-lazy-require')
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
  it('discovers the platform shell without inventing a missing default and honors cancellation', async () => {
    let loginShell: string | null = '/account/shell'
    const userInfo = vi.spyOn(os, 'userInfo').mockImplementation(() => ({
      uid: 1, gid: 1, username: 'terminal-user', homedir: '/home/terminal-user', shell: loginShell,
    }))
    let fiber: Awaited<ReturnType<Context['plugin']>> | undefined
    let restorePlatform: (() => void) | undefined
    try {
      syncBuiltinESMExports()
      const ctx = new Context()
      fiber = await ctx.plugin(LocalSubprocessRuntime)
      const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      restorePlatform = () => { platform.mockRestore() }
      vi.stubEnv('SHELL', '/environment/shell')
      await expect(ctx.subprocess.terminalEnvironment()).resolves.toEqual({
        platform: 'posix', defaultShell: '/environment/shell',
      })
      expect(userInfo).not.toHaveBeenCalled()
      vi.stubEnv('SHELL', undefined)
      await expect(ctx.subprocess.terminalEnvironment()).resolves.toEqual({
        platform: 'posix', defaultShell: '/account/shell',
      })
      vi.stubEnv('SHELL', '')
      await expect(ctx.subprocess.terminalEnvironment()).resolves.toEqual({ platform: 'posix', defaultShell: '/account/shell' })
      loginShell = ''
      await expect(ctx.subprocess.terminalEnvironment()).resolves.toEqual({ platform: 'posix' })
      loginShell = null
      await expect(ctx.subprocess.terminalEnvironment()).resolves.toEqual({ platform: 'posix' })
      platform.mockReturnValue('win32')
      vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe')
      await expect(ctx.subprocess.terminalEnvironment()).resolves.toEqual({
        platform: 'windows', defaultShell: 'C:\\Windows\\System32\\cmd.exe',
      })
      vi.stubEnv('ComSpec', undefined)
      await expect(ctx.subprocess.terminalEnvironment()).resolves.toEqual({ platform: 'windows' })
      vi.stubEnv('ComSpec', '')
      await expect(ctx.subprocess.terminalEnvironment()).resolves.toEqual({ platform: 'windows' })
      platform.mockReturnValue('linux')
      userInfo.mockClear()
      const reason = new Error('terminal inspection cancelled')
      await expect(ctx.subprocess.terminalEnvironment(AbortSignal.abort(reason))).rejects.toBe(reason)
      expect(userInfo).not.toHaveBeenCalled()
    } finally {
      restorePlatform?.()
      vi.unstubAllEnvs()
      userInfo.mockRestore()
      syncBuiltinESMExports()
      await fiber?.dispose()
    }
  })

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
      argv: ['bash'], cwd: process.cwd(), rows: 24, cols: 80, terminalType: 'dumb', graceMs: 10,
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
      resize: async () => {},
      inspectActivity: async () => ({ state: 'unknown' as const, revision: 0 }),
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
      resize: async () => {},
      inspectActivity: async () => ({ state: 'unknown' as const, revision: 0 }),
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
      resize: async () => {},
      inspectActivity: async () => ({ state: 'unknown' as const, revision: 0 }),
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
    mockNodePtyForIsolatedRuntime(() => terminal)
    vi.doMock('../src/process-inspector.ts', async importOriginal => ({
      ...await importOriginal<typeof import('../src/process-inspector.ts')>(),
      createProcessInspector: () => inspector,
    }))
    vi.doMock('../src/linux-scope.ts', async importOriginal => ({
      ...await importOriginal<typeof import('../src/linux-scope.ts')>(),
      probeLinuxNative: () => false,
    }))
    try {
      const { default: IsolatedLocalSubprocessRuntime } = await import('../src/index.ts')
      const ctx = new Context()
      const fiber = await ctx.plugin(IsolatedLocalSubprocessRuntime)
      const service = ctx.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>
      const handle = await ctx.subprocess.spawnTerminal({
        argv: ['shell'], cwd: process.cwd(), rows: 24, cols: 80, terminalType: 'dumb', graceMs: 1,
      })
      expect((service as unknown as { terminals: Set<SubprocessTerminalHandle> }).terminals.size).toBe(1)
      exitListener?.({ exitCode: 0 })
      await handle.done
      await expect.poll(() => (service as unknown as { terminals: Set<SubprocessTerminalHandle> }).terminals.size).toBe(0)
      await fiber.dispose()
    } finally {
      unmockLazyRequireForIsolatedRuntime()
      vi.doUnmock('../src/process-inspector.ts')
      vi.doUnmock('../src/linux-scope.ts')
      unmockWin32ForIsolatedRuntime()
      vi.resetModules()
    }
  })

  it('wraps Linux terminals in the selected scope and binds owner liveness', async () => {
    let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined
    let launcherRunning: (() => boolean) | undefined
    let launcherSignal: ((signal: 'SIGTERM' | 'SIGKILL') => boolean) | undefined
    let launcherSettlement: Promise<unknown> | undefined
    const directProbe = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) return true
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    const terminalKill = vi.fn(() => {})
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
    const bindOwner = vi.fn((direct: { running(): boolean; signal(signal: 'SIGTERM' | 'SIGKILL'): boolean; settled: Promise<unknown> }) => {
      launcherRunning = () => direct.running()
      launcherSignal = signal => direct.signal(signal)
      launcherSettlement = direct.settled
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
    mockNodePtyForIsolatedRuntime(nodePtySpawn)
    vi.doMock('../src/linux-scope.ts', () => ({
      signalLinuxDirectProcess,
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
        terminalType: 'dumb',
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
      expect(launcherSignal?.('SIGTERM')).toBe(false)
      expect(terminalKill).not.toHaveBeenCalled()
      directProbe.mockImplementationOnce(() => true)
      expect(launcherSignal?.('SIGKILL')).toBe(true)
      directProbe.mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }) })
      expect(launcherSignal?.('SIGKILL')).toBe(true)
      expect(directProbe.mock.calls).toEqual([
        [123, 'SIGTERM'], [123, 0], [123, 'SIGKILL'], [123, 'SIGKILL'], [123, 0],
      ])
      let directSettled = false
      void launcherSettlement?.then(() => { directSettled = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(directSettled).toBe(false)

      exitListener?.({ exitCode: 0 })
      expect(launcherRunning?.()).toBe(false)
      await launcherSettlement
      expect(directSettled).toBe(true)
      await handle.done
      await new Promise(resolve => setImmediate(resolve))
      expect(owner.signal).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(owner.waitForExit).toHaveBeenCalledOnce()
    } finally {
      await fiber?.dispose()
      directProbe.mockRestore()
      unmockLazyRequireForIsolatedRuntime()
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
    mockNodePtyForIsolatedRuntime(nodePtySpawn)
    vi.doMock('../src/linux-scope.ts', () => ({
      signalLinuxDirectProcess,
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
        argv: ['shell'], cwd: process.cwd(), rows: 24, cols: 80, terminalType: 'dumb', graceMs: 10,
      })).rejects.toBe(launchFailure)
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      await fiber?.dispose()
      unmockLazyRequireForIsolatedRuntime()
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
    mockNodePtyForIsolatedRuntime(() => terminal)
    try {
      const { default: IsolatedLocalSubprocessRuntime } = await import('../src/index.ts')
      const ctx = new Context()
      const disposalErrors: unknown[] = []
      ctx.logger.error = ((error: unknown) => { disposalErrors.push(error) }) as typeof ctx.logger.error
      const fiber = await ctx.plugin(IsolatedLocalSubprocessRuntime)
      const alive = new Set([124])
      // Pins the containment choice: with the host's native scope a mocked PTY
      // exit races the scope bootstrap.
      ;(ctx.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>).internals = { platform: 'darwin' }
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
        argv: ['shell'], cwd: process.cwd(), rows: 24, cols: 80, terminalType: 'dumb', graceMs: 1,
      })
      const terminate = vi.spyOn(handle, 'terminate')
      exitListener?.({ exitCode: 0 })
      await handle.done
      await expect.poll(() => terminate.mock.calls.length).toBe(1)
      await expect(terminate.mock.results[0]?.value).rejects.toThrow('surviving pids: 124')
      expect((ctx.subprocess as unknown as { terminals: Set<SubprocessTerminalHandle> }).terminals.size).toBe(1)
      await fiber.dispose()
      expect(disposalErrors).toHaveLength(1)
    } finally {
      unmockLazyRequireForIsolatedRuntime()
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
      signalLinuxDirectProcess,
      launchLinuxScope,
      prepareLinuxTerminalScope: vi.fn(),
      probeLinuxManager,
      probeLinuxNative,
    }))
    vi.doMock('../src/windows-job.ts', () => ({ launchWindowsJob, probeWindowsJob }))
    vi.doMock('../src/spawn.ts', async importOriginal => ({
      ...await importOriginal<typeof import('../src/spawn.ts')>(),
      bindManagedProcess,
      spawnSubprocess,
    }))
    vi.doMock('../src/output.ts', async importOriginal => ({
      ...await importOriginal<typeof import('../src/output.ts')>(), prepareManagedProcessBinding,
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
      vi.doUnmock('../src/output.ts')
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
      signalLinuxDirectProcess,
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

  it('waits for retained control endpoint closure after a process range completes', async () => {
    const destroying = Promise.withResolvers<undefined>()
    const finishClose = Promise.withResolvers<undefined>()
    const control = new PassThrough({
      destroy(_error, callback) {
        destroying.resolve(undefined)
        void finishClose.promise.then(() => { callback(null) })
      },
    })
    const terminate = vi.fn()
    const waitForExit = vi.fn(() => Promise.resolve(true))
    const handle = {
      control,
      collected: {},
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate,
      terminateForHostExit: vi.fn(),
      waitForExit,
    }
    vi.resetModules()
    mockWin32ForIsolatedRuntime()
    vi.doMock('../src/spawn.ts', async importOriginal => ({
      ...await importOriginal<typeof import('../src/spawn.ts')>(),
      spawnSubprocess: vi.fn(() => handle),
    }))
    let fiber: { dispose(): Promise<void> } | undefined
    try {
      const { default: IsolatedLocalSubprocessRuntime } = await import('../src/index.ts')
      const ctx = new Context()
      fiber = await ctx.plugin(IsolatedLocalSubprocessRuntime)
      const runtime = ctx.subprocess as InstanceType<typeof IsolatedLocalSubprocessRuntime>
      runtime.internals = { platform: 'darwin' }
      const spawned = runtime.spawn(spec('true', {
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', control: 'pipe' },
      }))
      await spawned.done
      await new Promise(resolve => setImmediate(resolve))
      expect(waitForExit).toHaveBeenCalledOnce()
      expect(control.destroyed).toBe(false)

      let disposed = false
      const disposal = fiber.dispose().then(() => { disposed = true })
      await destroying.promise
      expect(control.destroyed).toBe(true)
      expect(control.closed).toBe(false)
      expect(disposed).toBe(false)
      expect(terminate).not.toHaveBeenCalled()
      finishClose.resolve(undefined)
      await disposal
      expect(control.closed).toBe(true)
    } finally {
      finishClose.resolve(undefined)
      control.destroy()
      await fiber?.dispose()
      vi.doUnmock('../src/spawn.ts')
      unmockWin32ForIsolatedRuntime()
      vi.resetModules()
    }
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
    // live set, so teardown itself must swallow the rejected done. Two
    // settlements are valid and the winner is a race: a bootstrap that
    // publishes its pre-exec failure rejects with that failure, and a teardown
    // that stops the bootstrap first settles as the requested termination —
    // the recorded failure only outranks the stop when it was published before
    // the stop landed.
    const handle = ctx.subprocess.spawn(spec('true', { cwd: '/nonexistent-dir-dsh-subprocess-test' }))
    await fiber.dispose()
    const settlement = await handle.done.then(
      outcome => ({ kind: 'stopped' as const, outcome }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    )
    if (settlement.kind === 'failed') {
      expect(settlement.error).toBeInstanceOf(Error)
    } else {
      // Only the Linux scope records a stop this way: the win32 job owner
      // rejects a cancelled start and the fallback launcher rejects the ENOENT,
      // so neither can produce the stopped branch.
      expect(settlement.outcome.signal).toBe('SIGTERM')
    }
  })

  it('loading a second implementation throws (one processes service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    class SecondManager extends LocalSubprocessRuntime {}
    await expect(ctx.plugin(SecondManager)).rejects.toThrow(/service "subprocess" has been registered/)
  })
})
