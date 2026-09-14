import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { LocalPtySession } from '@deepseek-ai/dsh-terminal-bash/src/session.ts'
import type { ResolvedConfig } from '@deepseek-ai/dsh-terminal-bash/src/config.ts'
import type { TerminalSendOperation, TerminalSessionStatus, TerminalSignal } from '@deepseek-ai/dsh-terminal'
import type {
  SubprocessOutcome,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
} from '@deepseek-ai/dsh-subprocess'
import { TerminalError } from '@deepseek-ai/dsh-terminal'
import type {
  ProcessIdentity,
  ProcessInspector,
} from '@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts'

class FakeInspector implements ProcessInspector {
  pgid: number | undefined = 456
  waiting = false
  members: ProcessIdentity[] = []
  alive = new Set<number>()
  groups: Array<[number, TerminalSignal]> = []
  processes: Array<[number, 'SIGTERM' | 'SIGKILL']> = []
  throwGroup = false
  throwProcess = false
  removeOnSignal = true

  foregroundPgid() { return this.pgid }
  isStdinWaiting() { return this.waiting }
  snapshot() {
    return {
      tree: () => this.members,
      session: () => [],
      alive: (identity: ProcessIdentity) => this.alive.has(identity.pid),
    }
  }
  isAlive(identity: ProcessIdentity) { return this.alive.has(identity.pid) }
  signalGroup(pgid: number, signal: TerminalSignal) {
    if (this.throwGroup) throw new Error('group failed')
    this.groups.push([pgid, signal])
  }
  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL') {
    if (this.throwProcess) throw new Error('process raced')
    this.processes.push([identity.pid, signal])
    if (this.removeOnSignal) this.alive.delete(identity.pid)
  }
}

class FakeTerminal implements SubprocessTerminalHandle {
  pid = 123
  readonly output = new PassThrough()
  readonly writes: string[] = []
  readonly kills: string[] = []
  readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  readonly done = this.outcome.promise
  throwWrite = false
  throwKill = false
  autoExitOnKill = true
  terminateError: Error | undefined
  private cleanup: Promise<void> | undefined

  constructor(public inspector = new FakeInspector()) {}

  emitData(data: string): void {
    this.output.write(Buffer.from(data, 'utf8'))
  }

  emitBytes(data: Uint8Array): void {
    this.output.write(data)
  }

  emitError(error: Error): void {
    this.output.emit('error', error)
  }

  emitFailure(error: unknown): void {
    this.output.end()
    this.outcome.reject(error)
  }

  emitExit(exitCode = 0, signal?: number): void {
    this.output.end()
    this.outcome.resolve({
      exitCode: signal === undefined || signal === 0 ? exitCode : null,
      signal: signal === 9 ? 'SIGKILL' : signal === 15 ? 'SIGTERM' : null,
    })
  }

  async resize(_cols: number, _rows: number): Promise<void> {}

  async write(data: string): Promise<void> {
    if (this.throwWrite) throw new Error('write failed')
    this.writes.push(data)
  }

  async inspectForeground() {
    const processGroupId = this.inspector.foregroundPgid()
    return processGroupId === undefined
      ? undefined
      : { processGroupId, inputWaiting: this.inspector.isStdinWaiting() }
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const foreground = await this.inspectForeground()
    if (foreground === undefined) throw new Error(`cannot resolve foreground process group for terminal ${this.pid}`)
    if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
      throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead')
    }
    this.inspector.signalGroup(foreground.processGroupId, signal)
    return foreground.processGroupId
  }

  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    const cleanup = this.terminateOnce()
    this.cleanup = cleanup
    void cleanup.catch(() => { this.cleanup = undefined })
    return cleanup
  }

  private async terminateOnce(): Promise<void> {
    if (this.terminateError !== undefined) throw this.terminateError
    if (this.throwKill) throw new Error('kill failed')
    this.kills.push('SIGTERM')
    if (this.autoExitOnKill) this.emitExit(0, 15)
  }
}

function makeSession(
  terminal: FakeTerminal,
  inspector: FakeInspector,
  resolved: ResolvedConfig,
): LocalPtySession {
  terminal.inspector = inspector
  return new LocalPtySession(terminal, resolved)
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    backendType: 'shell', shellDialect: 'bash', shellPath: '/bin/bash', shellArgs: [], rows: 24, cols: 80,
    scrollbackLines: 10, scrollbackMaxBytes: 128, maxReadBytes: 64,
    pollIntervalMs: 10, exactProbeAfterMs: 20, idleSilenceMs: 50, handoffGraceMs: 10, timeoutMs: 100,
    disposeGraceMs: 20,
    ...overrides,
  }
}

afterEach(() => { vi.useRealTimers() })

async function initialize(session: LocalPtySession, terminal: FakeTerminal): Promise<void> {
  const pending = session.initialize()
  terminal.emitData('\x1b]133;D;0\x07dsh> ')
  await vi.advanceTimersByTimeAsync(10)
  await pending
}

describe('LocalPtySession readiness and output', () => {
  it('polls startup and settles sends without assembling scrollback for status checks', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config())
    const snapshot = vi.spyOn(session['scrollback'], 'snapshot')
    try {
      const pending = session.initialize()
      await vi.advanceTimersByTimeAsync(20)
      expect(snapshot).not.toHaveBeenCalled()
      terminal.emitData('x'.repeat(200) + '\x1b]133;D;0\x07dsh> ')
      await vi.advanceTimersByTimeAsync(20)
      await pending
      expect(snapshot).not.toHaveBeenCalled()
      expect(session.read({})).toMatchObject({ text: 'x'.repeat(59) + 'dsh> ', truncated: true })
      expect(snapshot).toHaveBeenCalledTimes(1)
    } finally {
      snapshot.mockRestore()
      await session.close('status check cleanup')
    }
  })

  it('answers split cursor-position queries before publishing prompt readiness', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    const responseGate = Promise.withResolvers<undefined>()
    terminal.write = async (data) => {
      terminal.writes.push(data)
      await responseGate.promise
    }

    let initialized = false
    const pending = session.initialize().then(() => { initialized = true })
    terminal.emitData('\x1b]133;D;0\x07dsh> \x1b[')
    terminal.emitData('6n')
    await vi.advanceTimersByTimeAsync(20)

    expect(terminal.writes).toContain('\x1b[1;6R')
    expect(initialized).toBe(false)
    responseGate.resolve(undefined)
    await vi.advanceTimersByTimeAsync(10)
    await pending
    expect(session.motd).toBe('dsh> ')
  })

  it('drains terminal replies before caller input and re-inspects after concurrent output', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)
    const firstInspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    const secondInspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    let inspections = 0
    terminal.inspectForeground = async () => {
      inspections += 1
      if (inspections === 1) return await firstInspection.promise
      if (inspections === 2) return await secondInspection.promise
      return { processGroupId: 456, inputWaiting: false }
    }
    const responseGate = Promise.withResolvers<undefined>()
    terminal.write = async (data) => {
      terminal.writes.push(data)
      if (data === '\x1b[1;6R') await responseGate.promise
    }

    const operation = session.startSend({ text: 'caller input', submit: true })
    await Promise.resolve()
    terminal.emitData('\x1b[6n')
    await vi.advanceTimersByTimeAsync(0)
    firstInspection.resolve({ processGroupId: 456, inputWaiting: true })
    await Promise.resolve()

    expect(terminal.writes).toEqual(['\x1b[1;6R'])
    responseGate.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(inspections).toBe(2)
    terminal.emitData('\x1b[6n')
    await vi.advanceTimersByTimeAsync(0)
    secondInspection.resolve({ processGroupId: 456, inputWaiting: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(inspections).toBe(3)
    expect(terminal.writes).toEqual(['\x1b[1;6R', '\x1b[1;6R', 'caller input\r'])

    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    expect((await operation.done).waitReason).toBe('stdin_read')
  })

  it('drains a terminal reply that is pending when caller input starts', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)
    const responseGate = Promise.withResolvers<undefined>()
    terminal.write = async (data) => {
      terminal.writes.push(data)
      if (data === '\x1b[1;6R') await responseGate.promise
    }
    terminal.emitData('\x1b[6n')
    await vi.advanceTimersByTimeAsync(0)

    const operation = session.startSend({ text: 'caller input', submit: true })
    await Promise.resolve()
    expect(terminal.writes).toEqual(['\x1b[1;6R'])
    responseGate.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(terminal.writes).toEqual(['\x1b[1;6R', 'caller input\r'])

    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    expect((await operation.done).waitReason).toBe('stdin_read')
  })

  it('resamples readiness foreground state after protocol activity during inspection', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)
    const operation = session.startSend({ text: '', submit: false })
    await Promise.resolve()
    await Promise.resolve()
    const internal = session as unknown as {
      stopReadinessPolling(): void
      pollReadiness(operation: TerminalSendOperation): Promise<void>
      settleActive(reason: 'timeout'): void
    }
    internal.stopReadinessPolling()
    await vi.advanceTimersByTimeAsync(20)

    const firstInspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    let inspections = 0
    terminal.inspectForeground = async () => {
      inspections += 1
      return inspections === 1
        ? await firstInspection.promise
        : { processGroupId: 456, inputWaiting: false }
    }
    const polling = internal.pollReadiness(operation)
    await Promise.resolve()
    terminal.emitData('\x1b[6n')
    await vi.advanceTimersByTimeAsync(0)
    firstInspection.resolve({ processGroupId: 456, inputWaiting: true })
    await polling

    expect(inspections).toBe(2)
    expect((operation as unknown as { settled: boolean }).settled).toBe(false)
    internal.settleActive('timeout')
    expect((await operation.done).waitReason).toBe('timeout')
  })

  it('retains send ownership while a failed inspection drains a terminal reply', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)
    const operation = session.startSend({ text: '', submit: false })
    await Promise.resolve()
    await Promise.resolve()
    const internal = session as unknown as {
      stopReadinessPolling(): void
      pollReadiness(operation: TerminalSendOperation): Promise<void>
    }
    internal.stopReadinessPolling()

    const inspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    terminal.inspectForeground = async () => await inspection.promise
    const responseGate = Promise.withResolvers<undefined>()
    terminal.write = async (data) => {
      terminal.writes.push(data)
      await responseGate.promise
    }
    const polling = internal.pollReadiness(operation)
    await Promise.resolve()
    terminal.emitData('\x1b[6n')
    await vi.advanceTimersByTimeAsync(0)
    inspection.reject(new Error('inspection failed with reply pending'))
    await Promise.resolve()

    expect(() => session.startSend({ text: 'successor', submit: true })).toThrow('active send')
    responseGate.resolve(undefined)
    await polling
    await expect(operation.done).rejects.toThrow('inspection failed with reply pending')
  })

  it('retains pre-write ownership when inspection fails with a terminal reply pending', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)
    const inspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    terminal.inspectForeground = async () => await inspection.promise
    const responseGate = Promise.withResolvers<undefined>()
    terminal.write = async (data) => {
      terminal.writes.push(data)
      await responseGate.promise
    }

    const operation = session.startSend({ text: 'must not execute', submit: true })
    await Promise.resolve()
    terminal.emitData('\x1b[6n')
    await vi.advanceTimersByTimeAsync(0)
    inspection.reject(new Error('pre-write inspection failed with reply pending'))
    await Promise.resolve()

    expect(() => session.startSend({ text: 'successor', submit: true })).toThrow('active send')
    responseGate.resolve(undefined)
    await expect(operation.done).rejects.toThrow('pre-write inspection failed with reply pending')
    expect(terminal.writes).toEqual(['\x1b[1;6R'])
  })

  it('retains a timed-out send until its terminal-protocol response settles', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)
    const responseGate = Promise.withResolvers<undefined>()
    terminal.write = async (data) => {
      terminal.writes.push(data)
      await responseGate.promise
    }

    const operation = session.startSend({ text: '', submit: false })
    terminal.emitData('\x1b[6n')
    await vi.advanceTimersByTimeAsync(100)
    expect((await operation.done).waitReason).toBe('timeout')
    expect(() => session.startSend({ text: 'successor', submit: true })).toThrow('active send')

    responseGate.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    const successor = session.startSend({ text: '', submit: false })
    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    expect((await successor.done).waitReason).toBe('stdin_read')
  })

  it('contains terminal emulator and protocol-response failures', async () => {
    const responseTerminal = new FakeTerminal()
    responseTerminal.throwWrite = true
    const responseSession = new LocalPtySession(responseTerminal, config())
    const responseOperation = responseSession.startSend({ text: '', submit: false })
    responseTerminal.emitData('\x1b[6n')
    await expect(responseOperation.done).rejects.toThrow('write failed')
    expect(responseSession.status()).toEqual({ kind: 'exited', exitCode: null, signal: null })

    const emulatorTerminal = new FakeTerminal()
    const emulatorSession = new LocalPtySession(emulatorTerminal, config())
    const emulatorOperation = emulatorSession.startSend({ text: '', submit: false })
    const emulator = (emulatorSession as unknown as {
      emulator: { write(data: string, callback?: () => void): void }
    }).emulator
    emulator.write = () => { throw new Error('emulator failed') }
    emulatorTerminal.emitData('output')
    await expect(emulatorOperation.done).rejects.toThrow('emulator failed')
    expect(emulatorSession.status()).toEqual({ kind: 'exited', exitCode: null, signal: null })
  })

  it('ignores terminal-protocol failures after closing starts and drains changing queues', async () => {
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config())
    const internal = session as unknown as {
      closing: boolean
      emulator: { write(data: string, callback?: () => void): void }
      emulatorWrites: Promise<void>
      responseWrites: Promise<void>
      drainTerminalProtocol(): Promise<void>
      closeEmulator(): void
    }
    internal.closing = true
    terminal.throwWrite = true
    terminal.emitData('\x1b[6n')
    await internal.emulatorWrites
    await internal.responseWrites
    expect(session.status()).toEqual({ kind: 'running' })

    internal.emulator.write = () => { throw new Error('late emulator failure') }
    terminal.emitData('late output')
    await internal.emulatorWrites
    expect(session.status()).toEqual({ kind: 'running' })

    const first = Promise.withResolvers<undefined>()
    internal.emulatorWrites = first.promise
    const draining = internal.drainTerminalProtocol()
    internal.emulatorWrites = Promise.resolve()
    first.resolve(undefined)
    await draining
    internal.closeEmulator()
    internal.closeEmulator()
    terminal.emitData('after emulator close')
    expect(session.status()).toEqual({ kind: 'running' })
  })

  it('coalesces terminal output that arrives while an emulator parse is pending', async () => {
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config())
    const writes: Array<{ data: string; done: () => void }> = []
    const internal = session as unknown as {
      emulator: { write(data: string, callback?: () => void): void }
      emulatorWrites: Promise<void>
      closeEmulator(): void
    }
    internal.emulator.write = (data, callback) => {
      writes.push({ data, done: callback ?? (() => {}) })
    }

    terminal.emitData('first')
    terminal.emitData('second')
    terminal.emitData('third')
    await Promise.resolve()
    expect(writes.map(write => write.data)).toEqual(['first'])

    writes[0]!.done()
    await Promise.resolve()
    expect(writes.map(write => write.data)).toEqual(['first', 'secondthird'])
    writes[1]!.done()
    await internal.emulatorWrites
    internal.closeEmulator()
  })

  it('lets queued terminal output run before the first post-write readiness poll', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const inspect = terminal.inspectForeground.bind(terminal)
    let inspections = 0
    terminal.inspectForeground = async () => {
      inspections += 1
      return await inspect()
    }
    const operation = session.startSend({ text: 'true', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(inspections).toBe(1)

    await vi.advanceTimersByTimeAsync(0)
    expect(inspections).toBe(1)
    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    expect((await operation.done).waitReason).toBe('stdin_read')
  })

  it('discards prompt readiness observed during asynchronous pre-write inspection', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config())
    await initialize(session, terminal)

    const inspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    terminal.inspectForeground = async () => await inspection.promise
    const operation = session.startSend({ text: 'long-running-command', submit: true })
    let settled = false
    void operation.done.then(() => { settled = true })

    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    inspection.resolve({ processGroupId: 456, inputWaiting: true })
    await vi.advanceTimersByTimeAsync(20)
    expect(terminal.writes).toEqual(['long-running-command\r'])
    expect(settled).toBe(false)

    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    expect((await operation.done).waitReason).toBe('stdin_read')
  })

  it('captures prompt MOTD, writes submit explicitly, and settles exact stdin waits', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)
    expect(session.motd).toBe('dsh> ')

    inspector.waiting = true
    const operation = session.startSend({ text: 'python3', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(terminal.writes).toEqual(['python3\r'])
    inspector.pgid = 789
    terminal.emitData('Python\r\n>>> ')
    await vi.advanceTimersByTimeAsync(20)
    expect(await operation.done).toMatchObject({ waitReason: 'stdin_read', viewport: 'Python\n>>> ', sessionStatus: { kind: 'running' } })
    expect(operation.cancel()).toBe(false)
  })

  it('does not reuse a pre-write stdin wait as post-write readiness', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    inspector.waiting = true
    const operation = session.startSend({ text: 'echo ready', submit: true })
    let settled = false
    void operation.done.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(20)
    expect(settled).toBe(false)

    inspector.waiting = false
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe(false)
    inspector.waiting = true
    await vi.advanceTimersByTimeAsync(10)
    expect((await operation.done).waitReason).toBe('stdin_read')
  })

  it('tracks a pre-write wait exit before exact probing begins', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config({
      exactProbeAfterMs: 50,
      idleSilenceMs: 100,
      timeoutMs: 200,
    }))
    await initialize(session, terminal)

    inspector.waiting = true
    const operation = session.startSend({ text: 'fast command', submit: true })
    let settled = false
    void operation.done.then(() => { settled = true })
    inspector.waiting = false
    await vi.advanceTimersByTimeAsync(10)
    inspector.waiting = true
    await vi.advanceTimersByTimeAsync(30)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe(true)
    expect((await operation.done).waitReason).toBe('stdin_read')
  })

  it('distinguishes inferred idle, timeout, exit signal, and operation reads', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)
    inspector.pgid = undefined

    const inferred = session.startSend({ text: 'sleep', submit: false })
    terminal.emitData('working')
    expect(inferred.readOutput()).toEqual({ delta: 'working', truncated: false })
    await vi.advanceTimersByTimeAsync(60)
    expect((await inferred.done).waitReason).toBe('inferred_idle')

    const timeout = session.startSend({ text: 'blocked', submit: false })
    await vi.advanceTimersByTimeAsync(40)
    terminal.emitData('.')
    await vi.advanceTimersByTimeAsync(40)
    terminal.emitData('.')
    await vi.advanceTimersByTimeAsync(30)
    expect((await timeout.done).waitReason).toBe('timeout')

    const exiting = session.startSend({ text: 'exit', submit: true })
    terminal.emitExit(7, 9)
    expect(await exiting.done).toMatchObject({ waitReason: 'session_exit', sessionStatus: { kind: 'exited', exitCode: null, signal: 'SIGKILL' } })
    expect(() => session.startSend({ text: '', submit: false })).toThrow('has exited')
  })

  it('cancels with foreground-group SIGINT, observes AbortSignal, and contains write failures', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const controller = new AbortController()
    const operation = session.startSend({ text: 'sleep', submit: true, signal: controller.signal })
    expect(() => session.startSend({ text: 'again', submit: true })).toThrow('active send')
    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(inspector.groups).toContainEqual([456, 'SIGINT'])
    expect(terminal.writes).not.toContain('\x03')
    terminal.emitData('\x1b]133;D;130\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    await operation.done

    const aborted = new AbortController()
    aborted.abort()
    expect(() => session.startSend({ text: '', submit: false, signal: aborted.signal })).toThrow('aborted before write')

    terminal.throwWrite = true
    const failed = session.startSend({ text: 'x', submit: false })
    await expect(failed.done).rejects.toThrow('write failed')
    const failedInternal = failed as unknown as { append(text: string): void; fail(error: unknown): void }
    failedInternal.append('ignored')
    failedInternal.fail(new Error('ignored'))
  })

  it('does not write a send canceled during asynchronous foreground inspection', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const inspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    terminal.inspectForeground = async () => await inspection.promise
    const controller = new AbortController()
    const operation = session.startSend({ text: 'must not execute', submit: true, signal: controller.signal })
    controller.abort()
    inspection.resolve({ processGroupId: 456, inputWaiting: false })
    await Promise.resolve()
    await Promise.resolve()

    expect(terminal.writes).toEqual([])
    expect(inspector.groups).toContainEqual([456, 'SIGINT'])
    terminal.emitData('\x1b]133;D;130\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    await operation.done
  })

  it('retains a canceled send when the pre-write inspection rejects while its signal is in flight', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const failed = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    terminal.inspectForeground = async () => await failed.promise
    const uncanceled = session.startSend({ text: 'plain failure', submit: true })
    failed.reject(new Error('inspect failed before write'))
    await expect(uncanceled.done).rejects.toThrow('inspect failed before write')

    terminal.inspectForeground = FakeTerminal.prototype.inspectForeground.bind(terminal)
    const inspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    terminal.inspectForeground = async () => await inspection.promise
    const signalGate = Promise.withResolvers<undefined>()
    terminal.signalForeground = async (signal) => {
      await signalGate.promise
      inspector.signalGroup(456, signal)
      return 456
    }
    const controller = new AbortController()
    const operation = session.startSend({ text: 'must stay owned', submit: true, signal: controller.signal })
    controller.abort()
    inspection.reject(new Error('transient inspection failure'))
    await Promise.resolve()
    await Promise.resolve()

    // The slot stays reserved while the cancellation's foreground signal is in flight.
    expect(() => session.startSend({ text: 'successor', submit: true })).toThrow('active send')
    terminal.inspectForeground = async () => ({ processGroupId: 456, inputWaiting: false })
    signalGate.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(inspector.groups).toContainEqual([456, 'SIGINT'])

    terminal.emitData('\x1b]133;D;130\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    await operation.done
  })

  it('retains a canceled send until asynchronous foreground signalling settles', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const signalGate = Promise.withResolvers<undefined>()
    terminal.signalForeground = async (signal) => {
      await signalGate.promise
      const foreground = await terminal.inspectForeground()
      if (foreground === undefined) throw new Error('cannot resolve foreground')
      inspector.signalGroup(foreground.processGroupId, signal)
      return foreground.processGroupId
    }
    const operation = session.startSend({ text: 'first', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(operation.cancel()).toBe(true)

    terminal.emitData('\x1b]133;D;130\x07dsh> ')
    await vi.advanceTimersByTimeAsync(100)
    expect((await operation.done).waitReason).toBe('timeout')
    expect(() => session.startSend({ text: 'successor', submit: true })).toThrow('active send')
    signalGate.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(inspector.groups).toContainEqual([456, 'SIGINT'])
    expect(inspector.groups).not.toContainEqual([789, 'SIGINT'])
  })

  it('does not let an in-flight readiness inspection release a canceled send before signalling settles', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const readiness = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    let inspections = 0
    terminal.inspectForeground = async () => {
      inspections += 1
      if (inspections === 1) return { processGroupId: 456, inputWaiting: false }
      if (inspections === 2) return await readiness.promise
      return { processGroupId: 456, inputWaiting: true }
    }
    const signalling = Promise.withResolvers<undefined>()
    const signalled = Promise.withResolvers<number>()
    terminal.signalForeground = async (signal) => {
      await signalling.promise
      const foreground = await terminal.inspectForeground()
      if (foreground === undefined) throw new Error('cannot resolve foreground')
      inspector.signalGroup(foreground.processGroupId, signal)
      signalled.resolve(foreground.processGroupId)
      return foreground.processGroupId
    }

    const operation = session.startSend({ text: 'first', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(inspections).toBe(2)
    await vi.advanceTimersByTimeAsync(50)
    expect(operation.cancel()).toBe(true)
    let settled = false
    void operation.done.then(() => { settled = true })

    readiness.resolve({ processGroupId: 456, inputWaiting: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(() => session.startSend({ text: 'successor', submit: true })).toThrow(TerminalError)

    signalling.resolve(undefined)
    expect(await signalled.promise).toBe(456)
    expect(inspector.groups).toContainEqual([456, 'SIGINT'])
    await session.close('test complete')
    expect((await operation.done).waitReason).toBe('session_exit')
  })

  it('does not let an in-flight readiness failure release a canceled send before signalling settles', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const readiness = Promise.withResolvers<never>()
    let inspections = 0
    terminal.inspectForeground = async () => {
      inspections += 1
      if (inspections === 1) return { processGroupId: 456, inputWaiting: false }
      if (inspections === 2) return await readiness.promise
      return { processGroupId: 456, inputWaiting: true }
    }
    const signalling = Promise.withResolvers<undefined>()
    const signalled = Promise.withResolvers<number>()
    terminal.signalForeground = async (signal) => {
      await signalling.promise
      const foreground = await terminal.inspectForeground()
      if (foreground === undefined) throw new Error('cannot resolve foreground')
      inspector.signalGroup(foreground.processGroupId, signal)
      signalled.resolve(foreground.processGroupId)
      return foreground.processGroupId
    }

    const operation = session.startSend({ text: 'first', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(inspections).toBe(2)
    expect(operation.cancel()).toBe(true)
    let settled = false
    void operation.done.then(() => { settled = true })

    readiness.reject(new Error('inspection failed during cancellation'))
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(() => session.startSend({ text: 'successor', submit: true })).toThrow(TerminalError)

    signalling.resolve(undefined)
    expect(await signalled.promise).toBe(456)
    expect(inspector.groups).toContainEqual([456, 'SIGINT'])
    await session.close('test complete')
    expect((await operation.done).waitReason).toBe('session_exit')
  })

  it('signals only after an in-flight provider write lands', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const writeGate = Promise.withResolvers<undefined>()
    terminal.write = async () => { await writeGate.promise }
    const operation = session.startSend({ text: 'must be interrupted', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(operation.cancel()).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    expect(inspector.groups).toEqual([])

    writeGate.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(inspector.groups).toContainEqual([456, 'SIGINT'])
    terminal.emitData('\x1b]133;D;130\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    await operation.done
  })

  it('does not signal when a cancelled provider write rejects', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const writeGate = Promise.withResolvers<undefined>()
    terminal.write = async () => { await writeGate.promise }
    const operation = session.startSend({ text: 'rejected write', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(operation.cancel()).toBe(true)

    const rejected = expect(operation.done).rejects.toThrow('write failed after cancellation')
    writeGate.reject(new Error('write failed after cancellation'))
    await rejected
    expect(inspector.groups).toEqual([])

    const next = session.startSend({ text: '', submit: false })
    await vi.advanceTimersByTimeAsync(100)
    expect((await next.done).waitReason).toBe('inferred_idle')
  })

  it('releases a timed-out cancellation after the provider write and signal settle', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const writeGate = Promise.withResolvers<undefined>()
    terminal.write = async () => { await writeGate.promise }
    const operation = session.startSend({ text: 'slow cancelled write', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(operation.cancel()).toBe(true)
    await vi.advanceTimersByTimeAsync(100)

    expect((await operation.done).waitReason).toBe('timeout')
    expect(() => session.startSend({ text: 'must wait', submit: true })).toThrow(expect.objectContaining({
      code: 'SEND_ACTIVE',
    }))

    writeGate.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(inspector.groups).toContainEqual([456, 'SIGINT'])

    const next = session.startSend({ text: '', submit: false })
    await vi.advanceTimersByTimeAsync(100)
    expect((await next.done).waitReason).toBe('inferred_idle')
  })

  it('retains the absolute timeout after cancellation while output stays active', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const operation = session.startSend({ text: 'ignore-sigint-and-write', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(operation.cancel()).toBe(true)
    for (let elapsed = 20; elapsed <= 100; elapsed += 20) {
      terminal.emitData('.')
      await vi.advanceTimersByTimeAsync(20)
    }

    expect(await operation.done).toMatchObject({ waitReason: 'timeout' })
  })

  it('does not resume cancellation polling after the terminal exits during signalling', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const signalGate = Promise.withResolvers<undefined>()
    terminal.signalForeground = async () => {
      await signalGate.promise
      return 456
    }
    const operation = session.startSend({ text: 'first', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(operation.cancel()).toBe(true)
    terminal.emitExit(0)
    await expect(operation.done).resolves.toMatchObject({ waitReason: 'session_exit' })

    signalGate.resolve(undefined)
    await vi.advanceTimersByTimeAsync(10)
    expect(session.status()).toEqual({ kind: 'exited', exitCode: 0, signal: null })
  })

  it('retains send ownership after timeout until an asynchronous provider write settles', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const writeGate = Promise.withResolvers<undefined>()
    terminal.write = async () => { await writeGate.promise }
    const operation = session.startSend({ text: 'slow write', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(100)

    expect((await operation.done).waitReason).toBe('timeout')
    expect(() => session.startSend({ text: 'must wait', submit: true })).toThrow('active send')

    writeGate.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    const rejectedWrite = Promise.withResolvers<undefined>()
    terminal.write = async () => { await rejectedWrite.promise }
    const rejected = session.startSend({ text: 'late rejection', submit: true })
    await vi.advanceTimersByTimeAsync(100)
    expect((await rejected.done).waitReason).toBe('timeout')
    rejectedWrite.reject(new Error('write failed after timeout'))
    await Promise.resolve()
    await Promise.resolve()

    const next = session.startSend({ text: '', submit: false })
    await vi.advanceTimersByTimeAsync(100)
    expect((await next.done).waitReason).toBe('inferred_idle')
  })

  it('retains send ownership when cancellation signalling fails during an asynchronous write', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const writeGate = Promise.withResolvers<undefined>()
    terminal.write = async () => { await writeGate.promise }
    let signalCalls = 0
    terminal.signalForeground = async () => {
      signalCalls += 1
      throw new Error('interrupt failed')
    }
    const operation = session.startSend({ text: 'slow write', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(operation.cancel()).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    expect(signalCalls).toBe(0)
    expect(() => session.startSend({ text: 'must wait', submit: true })).toThrow('active send')

    writeGate.resolve(undefined)
    await expect(operation.done).rejects.toThrow('interrupt failed')
    expect(signalCalls).toBe(1)
    expect(session.status()).toEqual({ kind: 'exited', exitCode: null, signal: null })
    expect(() => session.startSend({ text: '', submit: false })).toThrow('has exited')
  })

  it('handles startup exit, unknown exit signals, cancel-write failure, and stale polls', async () => {
    vi.useFakeTimers()
    const startupTerminal = new FakeTerminal()
    const startup = new LocalPtySession(startupTerminal, config())
    const initializing = startup.initialize(new AbortController().signal)
    startupTerminal.emitExit(1)
    await expect(initializing).rejects.toThrow('exited during startup')
    expect(startup.status()).toEqual({ kind: 'exited', exitCode: 1, signal: null })

    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config())
    await initialize(session, terminal)
    const operation = session.startSend({ text: '', submit: false })
    const operationInternal = operation as unknown as {
      append(text: string): void
      settle(reason: 'timeout', status: TerminalSessionStatus, inherited: boolean): void
    }
    operationInternal.append('')
    const sessionInternal = session as unknown as {
      pollReadiness(operation: TerminalSendOperation): void
      interrupt(operation: TerminalSendOperation): void
      schedulePoll(operation: TerminalSendOperation): void
      polling: boolean
      statusValue: TerminalSessionStatus
      appendOutput(text: string): void
    }
    sessionInternal.appendOutput('')
    sessionInternal.pollReadiness({} as TerminalSendOperation)
    sessionInternal.schedulePoll({} as TerminalSendOperation)
    sessionInternal.polling = true
    sessionInternal.schedulePoll(operation)
    sessionInternal.polling = false
    sessionInternal.interrupt({} as TerminalSendOperation)
    sessionInternal.statusValue = { kind: 'exited', exitCode: 2, signal: null }
    sessionInternal.pollReadiness(operation)
    await operation.done
    operationInternal.settle('timeout', { kind: 'running' }, false)

    const unknownTerminal = new FakeTerminal()
    const unknown = new LocalPtySession(unknownTerminal, config())
    unknownTerminal.emitExit(1, 999)
    await vi.waitFor(() => {
      expect(unknown.status()).toEqual({ kind: 'exited', exitCode: null, signal: null })
    })

    const cancelTerminal = new FakeTerminal()
    const cancelInspector = new FakeInspector()
    const cancel = makeSession(cancelTerminal, cancelInspector, config())
    await initialize(cancel, cancelTerminal)
    const cancellable = cancel.startSend({ text: '', submit: false })
    cancelInspector.throwGroup = true
    expect(cancellable.cancel()).toBe(true)
    await expect(cancellable.done).rejects.toThrow('group failed')
    expect(cancellable.cancel()).toBe(false)

    const missingGroupTerminal = new FakeTerminal()
    const missingGroupInspector = new FakeInspector()
    const missingGroup = makeSession(missingGroupTerminal, missingGroupInspector, config())
    await initialize(missingGroup, missingGroupTerminal)
    missingGroupInspector.pgid = undefined
    const unresolved = missingGroup.startSend({ text: '', submit: false })
    expect(unresolved.cancel()).toBe(true)
    await expect(unresolved.done).rejects.toThrow('cannot resolve foreground process group')
  })

  it('does not treat zero-output startup silence as readiness and fails on startup timeout', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config())
    let settled = false
    const initializing = session.initialize().then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(60)
    expect(settled).toBe(false)
    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    await initializing

    const timeoutTerminal = new FakeTerminal()
    const timeout = new LocalPtySession(timeoutTerminal, config())
    const timedOut = expect(timeout.initialize()).rejects.toThrow('startup timeout')
    await vi.advanceTimersByTimeAsync(100)
    await timedOut
  })

  it('preserves the caller abort reason when startup cannot resolve a foreground group', async () => {
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    inspector.pgid = undefined
    const session = makeSession(terminal, inspector, config())
    const controller = new AbortController()
    const reason = new Error('startup cancelled')

    const initializing = session.initialize(controller.signal)
    const rejected = expect(initializing).rejects.toBe(reason)
    controller.abort(reason)

    await rejected
  })

  it('waits for printable prompt text when the startup marker is split from PS1', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config())
    let settled = false
    const initializing = session.initialize().then(() => { settled = true })

    terminal.emitData('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(20)
    expect(settled).toBe(false)

    terminal.emitData('dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    await initializing
    expect(session.motd).toBe('dsh> ')
  })

  it('does not attribute a delayed prior prompt to the current send', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config({ idleSilenceMs: 100, timeoutMs: 200 }))
    await initialize(session, terminal)

    const operation = session.startSend({ text: "printf 'PID=%s\\n' \"$!\"", submit: true })
    let settled = false
    void operation.done.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()

    terminal.emitData('\x1b]133;D;0\x07dsh> printf \'PID=%s\\n\' "$!"\r\n')
    await vi.advanceTimersByTimeAsync(20)
    expect(settled).toBe(false)

    terminal.emitData('PID=123\r\n\x1b]133;D;0\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    expect(await operation.done).toMatchObject({ waitReason: 'stdin_read' })
  })

  it('retains a prompt marker until the startup shell regains the foreground group', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const operation = session.startSend({ text: 'run', submit: true })
    let settled = false
    void operation.done.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    inspector.pgid = 789
    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toBe(false)

    inspector.pgid = 456
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe(true)
    expect((await operation.done).waitReason).toBe('stdin_read')
  })

  it('holds the idle fallback for the configured handoff grace, not one poll', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config({ handoffGraceMs: 40 }))
    await initialize(session, terminal)

    const operation = session.startSend({ text: 'run', submit: true })
    let settled = false
    void operation.done.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    inspector.pgid = 789
    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    // One poll past the silence bound would already have settled inferred_idle.
    await vi.advanceTimersByTimeAsync(70)
    expect(settled).toBe(false)

    inspector.pgid = 456
    await vi.advanceTimersByTimeAsync(10)
    expect((await operation.done).waitReason).toBe('stdin_read')
  })

  it('falls back to inferred idle when a foreground child emits an inherited prompt marker', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const operation = session.startSend({ text: 'bash -i', submit: true })
    inspector.pgid = 789
    terminal.emitData('\x1b]133;D;0\x07child> ')
    await vi.advanceTimersByTimeAsync(100)

    expect((await operation.done).waitReason).toBe('inferred_idle')
  })

  it('contains terminal transport failures and preserves the first failure', async () => {
    const terminal = new FakeTerminal()
    terminal.terminateError = new Error('cleanup after transport failure')
    const session = new LocalPtySession(terminal, config())
    const operation = session.startSend({ text: '', submit: false })
    terminal.output.emit('data', 'plain text')
    terminal.emitError(new Error('output transport failed'))
    ;(session as unknown as { onTransportFailure(error: unknown): void })
      .onTransportFailure(new Error('later failure'))
    await expect(operation.done).rejects.toThrow('output transport failed')
    expect(session.status()).toEqual({ kind: 'exited', exitCode: null, signal: null })
    terminal.terminateError = undefined
    await expect(session.close('transport')).rejects.toThrow('output transport failed')

    const rejectedTerminal = new FakeTerminal()
    const rejected = new LocalPtySession(rejectedTerminal, config())
    const rejectedOperation = rejected.startSend({ text: '', submit: false })
    rejectedTerminal.emitFailure('raw transport failure')
    await expect(rejectedOperation.done).rejects.toThrow('raw transport failure')
  })

  it('replaces invalid UTF-8 terminal output', async () => {
    const chunkTerminal = new FakeTerminal()
    const chunkSession = new LocalPtySession(chunkTerminal, config())
    const chunkOperation = chunkSession.startSend({ text: '', submit: false })
    chunkTerminal.emitBytes(Uint8Array.from([0xff]))
    expect(chunkOperation.readOutput()).toEqual({ delta: '�', truncated: false })
    chunkTerminal.emitExit()
    await chunkOperation.done

    const endTerminal = new FakeTerminal()
    const endSession = new LocalPtySession(endTerminal, config())
    const endOperation = endSession.startSend({ text: '', submit: false })
    endTerminal.emitBytes(Uint8Array.from([0xe2]))
    endTerminal.emitExit()
    expect((await endOperation.done).viewport).toBe('�')
  })

  it('contains readiness inspection failure and a stale inspection result', async () => {
    vi.useFakeTimers()
    const failedTerminal = new FakeTerminal()
    const failedSession = new LocalPtySession(failedTerminal, config())
    const failedOperation = failedSession.startSend({ text: '', submit: false })
    await Promise.resolve()
    await Promise.resolve()
    failedTerminal.inspectForeground = async () => { throw new Error('inspect failed') }
    const failedInternal = failedSession as unknown as {
      pollReadiness(operation: TerminalSendOperation): Promise<void>
    }
    await failedInternal.pollReadiness(failedOperation)
    await expect(failedOperation.done).rejects.toThrow('inspect failed')

    const staleTerminal = new FakeTerminal()
    const staleSession = new LocalPtySession(staleTerminal, config())
    const staleOperation = staleSession.startSend({ text: '', submit: false })
    await Promise.resolve()
    await Promise.resolve()
    const gate = Promise.withResolvers<ReturnType<FakeTerminal['inspectForeground']> extends Promise<infer T> ? T : never>()
    staleTerminal.inspectForeground = async () => await gate.promise
    const staleInternal = staleSession as unknown as {
      active: TerminalSendOperation | undefined
      pollReadiness(operation: TerminalSendOperation): Promise<void>
    }
    const polling = staleInternal.pollReadiness(staleOperation)
    staleInternal.active = undefined
    gate.resolve({ processGroupId: 456, inputWaiting: false })
    await polling
    ;(staleOperation as unknown as {
      settle(reason: 'timeout', status: TerminalSessionStatus, inherited: boolean): void
    }).settle('timeout', { kind: 'running' }, false)
  })

  it('reschedules readiness for a new send after a stale remote inspection releases the poll slot', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const old = session.startSend({ text: '', submit: false })
    await Promise.resolve()
    await Promise.resolve()
    const inspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    let block = true
    terminal.inspectForeground = async () => block
      ? await inspection.promise
      : { processGroupId: 456, inputWaiting: false }
    const internals = session as unknown as {
      pollReadiness(operation: TerminalSendOperation): Promise<void>
      settleActive(reason: 'timeout'): void
    }
    const stalePoll = internals.pollReadiness(old)
    internals.settleActive('timeout')
    await old.done

    block = false
    const current = session.startSend({ text: '', submit: false })
    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    await Promise.resolve()
    await Promise.resolve()
    inspection.resolve({ processGroupId: 456, inputWaiting: false })
    await vi.advanceTimersByTimeAsync(0)
    await stalePoll
    await vi.advanceTimersByTimeAsync(10)

    expect((await current.done).waitReason).toBe('stdin_read')
  })

  it('does not poll a successor before its own pre-write inspection and write complete', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    await initialize(session, terminal)

    const old = session.startSend({ text: '', submit: false })
    await Promise.resolve()
    await Promise.resolve()
    const staleInspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    const successorInspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    let inspectCalls = 0
    terminal.inspectForeground = async () => {
      inspectCalls += 1
      return inspectCalls === 1 ? await staleInspection.promise : await successorInspection.promise
    }
    const internals = session as unknown as {
      pollReadiness(operation: TerminalSendOperation): Promise<void>
      settleActive(reason: 'timeout'): void
    }
    const stalePoll = internals.pollReadiness(old)
    internals.settleActive('timeout')
    await old.done

    const current = session.startSend({ text: 'successor', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    staleInspection.resolve({ processGroupId: 456, inputWaiting: false })
    await stalePoll
    await vi.advanceTimersByTimeAsync(10)
    expect(inspectCalls).toBe(2)
    expect(terminal.writes).toEqual([])

    successorInspection.resolve({ processGroupId: 456, inputWaiting: false })
    await Promise.resolve()
    await Promise.resolve()
    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    expect(terminal.writes).toEqual(['successor\r'])
    expect((await current.done).waitReason).toBe('stdin_read')
  })

  it('contains stale timer, write, inspection, and interrupt continuations', async () => {
    vi.useFakeTimers()
    const settle = (operation: TerminalSendOperation): void => {
      ;(operation as unknown as {
        settle(reason: 'timeout', status: TerminalSessionStatus, inherited: boolean): void
      }).settle('timeout', { kind: 'running' }, false)
    }

    const deadlineTerminal = new FakeTerminal()
    const deadlineSession = new LocalPtySession(deadlineTerminal, config())
    const deadlineOperation = deadlineSession.startSend({ text: '', submit: false })
    ;(deadlineSession as unknown as { active: TerminalSendOperation | undefined }).active = undefined
    await vi.advanceTimersByTimeAsync(100)
    settle(deadlineOperation)

    const writeTerminal = new FakeTerminal()
    const writeGate = Promise.withResolvers<undefined>()
    writeTerminal.write = async () => { await writeGate.promise }
    const writeSession = new LocalPtySession(writeTerminal, config())
    const writeOperation = writeSession.startSend({ text: 'x', submit: false })
    await Promise.resolve()
    await Promise.resolve()
    ;(writeSession as unknown as { closing: boolean }).closing = true
    writeGate.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    settle(writeOperation)

    const beginTerminal = new FakeTerminal()
    const beginGate = Promise.withResolvers<never>()
    beginTerminal.inspectForeground = async () => await beginGate.promise
    const beginSession = new LocalPtySession(beginTerminal, config())
    const beginOperation = beginSession.startSend({ text: '', submit: false })
    ;(beginSession as unknown as { active: TerminalSendOperation | undefined }).active = undefined
    beginGate.reject(new Error('stale begin failure'))
    await Promise.resolve()
    await Promise.resolve()
    settle(beginOperation)

    const scheduledTerminal = new FakeTerminal()
    const scheduledSession = new LocalPtySession(scheduledTerminal, config())
    const scheduledOperation = scheduledSession.startSend({ text: '', submit: false })
    await Promise.resolve()
    await Promise.resolve()
    const scheduledInternal = scheduledSession as unknown as {
      schedulePoll(operation: TerminalSendOperation, delayMs?: number): void
      settleActive(reason: 'timeout'): void
    }
    scheduledInternal.schedulePoll(scheduledOperation, 5)
    scheduledInternal.settleActive('timeout')
    await scheduledOperation.done

    const pollTerminal = new FakeTerminal()
    const pollSession = new LocalPtySession(pollTerminal, config())
    const pollOperation = pollSession.startSend({ text: '', submit: false })
    await Promise.resolve()
    await Promise.resolve()
    const pollGate = Promise.withResolvers<never>()
    pollTerminal.inspectForeground = async () => await pollGate.promise
    const pollInternal = pollSession as unknown as {
      active: TerminalSendOperation | undefined
      pollReadiness(operation: TerminalSendOperation): Promise<void>
    }
    const stalePoll = pollInternal.pollReadiness(pollOperation)
    pollInternal.active = undefined
    pollGate.reject(new Error('stale poll failure'))
    await stalePoll
    settle(pollOperation)

    const interruptTerminal = new FakeTerminal()
    const interruptGate = Promise.withResolvers<never>()
    interruptTerminal.signalForeground = async () => await interruptGate.promise
    const interruptSession = new LocalPtySession(interruptTerminal, config())
    const interruptOperation = interruptSession.startSend({ text: '', submit: false })
    expect(interruptOperation.cancel()).toBe(true)
    ;(interruptSession as unknown as { active: TerminalSendOperation | undefined }).active = undefined
    interruptGate.reject(new Error('stale interrupt failure'))
    await Promise.resolve()
    await Promise.resolve()
    settle(interruptOperation)
  })
})

describe('LocalPtySession bounds, signals, and teardown', () => {
  it('validates pagination and enforces line/UTF-8 bounds', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(
      terminal,
      config({ scrollbackLines: 3, scrollbackMaxBytes: 12, maxReadBytes: 6 }),
    )
    expect(session.read({})).toMatchObject({ text: '' })
    await initialize(session, terminal)
    const operation = session.startSend({ text: '', submit: false })
    terminal.emitData('一\n二\n三\n四')
    await vi.advanceTimersByTimeAsync(60)
    expect((await operation.done).truncated).toBe(true)
    const page = session.read({ offset: 0, count: 3 })
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(6)
    expect(page.truncated).toBe(true)
    expect(session.read({ offset: 999 })).toMatchObject({ text: '', lineBegin: 999, lineEnd: 999 })
    expect(() => session.read({ offset: -1 })).toThrow('offset')
    expect(() => session.read({ count: 0 })).toThrow('count')

    const tinyTerminal = new FakeTerminal()
    const tiny = new LocalPtySession(tinyTerminal, config({ maxReadBytes: 1 }))
    await initialize(tiny, tinyTerminal)
    const tinyOperation = tiny.startSend({ text: '', submit: false })
    tinyTerminal.emitData('一')
    await vi.advanceTimersByTimeAsync(60)
    await tinyOperation.done
    expect(tiny.read({ offset: 0, count: 1 }).text).toBe('')
  })

  it('signals verified groups and refuses unresolved or shell-targeted hard kills', async () => {
    const terminal = new FakeTerminal()
    const inspector = new FakeInspector()
    const session = makeSession(terminal, inspector, config())
    expect(await session.signal('SIGINT')).toEqual({ delivered: true, targetPgid: 456 })
    inspector.pgid = terminal.pid
    await expect(session.signal('SIGKILL')).rejects.toThrow('terminate the terminal session')
    inspector.pgid = undefined
    await expect(session.signal('SIGTERM')).rejects.toThrow('cannot resolve')
  })

  it('closes idempotently and rejects new signals', async () => {
    const terminal = new FakeTerminal()
    terminal.throwKill = true
    const session = new LocalPtySession(terminal, config({ disposeGraceMs: 1 }))
    const closing = session.close('test')
    expect(session.close('other')).toBe(closing)
    await expect(closing).rejects.toThrow('PTY cleanup failed (test)')
    expect(() => session.startSend({ text: '', submit: false })).toThrow('closing')
    await expect(session.signal('SIGTERM')).rejects.toThrow('closing')
  })

  it('reports cleanup failure without waiting for top-level exit and permits retry', async () => {
    const terminal = new FakeTerminal()
    terminal.autoExitOnKill = false
    terminal.terminateError = new Error('terminal cleanup failed; surviving pids: 456')
    const session = new LocalPtySession(terminal, config())

    await expect(session.close('survivor')).rejects.toMatchObject({
      message: 'PTY cleanup failed (survivor)',
      cause: terminal.terminateError,
    })
    expect((session as unknown as { emulatorClosed: boolean }).emulatorClosed).toBe(true)
    expect(terminal.kills).toEqual([])

    terminal.terminateError = undefined
    terminal.autoExitOnKill = true
    await expect(session.close('retry')).resolves.toBeUndefined()
    expect(terminal.kills).toEqual(['SIGTERM'])
  })

  it('settles an active send as session_exit when closed mid-operation', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config({ disposeGraceMs: 50 }))
    await initialize(session, terminal)
    const operation = session.startSend({ text: 'run', submit: true })
    // The shell returns to its prompt while the send is active; a running
    // readiness poll would otherwise mis-settle this as stdin_read once close
    // begins, so teardown must stop polling before its grace period.
    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    terminal.autoExitOnKill = false
    const closing = session.close('mid-send')
    await vi.advanceTimersByTimeAsync(20)
    terminal.emitExit(0, 15)
    expect((await operation.done).waitReason).toBe('session_exit')
    await closing
  })

  it('settles a closing send when provider termination cancels inspection', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config())
    await initialize(session, terminal)
    const write = Promise.withResolvers<undefined>()
    terminal.write = async () => { await write.promise }
    const writeOperation = session.startSend({ text: 'pending write', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    await session.close('pending write')
    expect((await writeOperation.done).waitReason).toBe('session_exit')
    // The rejection lands after close released the send; it must stay contained.
    write.reject(new Error('write rejected during close'))
    await Promise.resolve()
    await Promise.resolve()
  })

  it('settles a closing send when provider termination cancels a pending inspection', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config())
    await initialize(session, terminal)
    const inspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    terminal.inspectForeground = async () => await inspection.promise
    const terminate = terminal.terminate.bind(terminal)
    terminal.terminate = async () => {
      inspection.reject(new Error('terminal terminated'))
      await terminate()
    }
    const operation = session.startSend({ text: 'pending inspection', submit: true })
    await Promise.resolve()

    await session.close('pending inspection')

    expect((await operation.done).waitReason).toBe('session_exit')
    expect(terminal.writes).toEqual([])
  })

  it('does not let an in-flight readiness inspection outrun close', async () => {
    vi.useFakeTimers()
    const terminal = new FakeTerminal()
    const session = new LocalPtySession(terminal, config())
    await initialize(session, terminal)
    const inspection = Promise.withResolvers<{ processGroupId: number; inputWaiting: boolean }>()
    const originalInspect = terminal.inspectForeground.bind(terminal)
    let inspections = 0
    terminal.inspectForeground = async () => {
      inspections += 1
      return inspections === 1 ? await originalInspect() : await inspection.promise
    }
    const operation = session.startSend({ text: 'pending readiness', submit: true })
    await Promise.resolve()
    await Promise.resolve()
    terminal.emitData('\x1b]133;D;0\x07dsh> ')
    await vi.advanceTimersByTimeAsync(10)
    expect(inspections).toBe(2)

    const termination = Promise.withResolvers<undefined>()
    terminal.terminate = async () => {
      await termination.promise
      terminal.emitExit(0, 15)
    }
    const closing = session.close('in-flight readiness')
    let settled = false
    void operation.done.then(() => { settled = true })
    inspection.resolve({ processGroupId: 456, inputWaiting: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    termination.resolve(undefined)
    await closing
    expect((await operation.done).waitReason).toBe('session_exit')
  })

})
