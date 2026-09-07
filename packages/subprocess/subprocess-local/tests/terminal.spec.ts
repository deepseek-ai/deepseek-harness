import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IDisposable, IPty } from 'node-pty'
import { LocalTerminalHandle } from '@deepseek-ai/dsh-subprocess-local/src/terminal.ts'
import { createProcessInspector } from '@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts'
import type {
  ProcessIdentity,
  ProcessInspector,
  ProcessInspectorInternals,
  ProcessSnapshot,
} from '@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts'
import type { BoundProcessOwner } from '@deepseek-ai/dsh-subprocess-local/src/managed-owner.ts'
import type { SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'

class FakePty {
  pid = 123
  readonly writes: string[] = []
  readonly kills: string[] = []
  autoExitOnKill = true
  throwKill = false
  onKill?: () => void
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

  readonly onData = (listener: (data: string) => void): IDisposable => {
    this.dataListeners.add(listener)
    return { dispose: () => { this.dataListeners.delete(listener) } }
  }

  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.exitListeners.add(listener)
    return { dispose: () => { this.exitListeners.delete(listener) } }
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  emitExit(exitCode = 0, signal?: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, ...signal === undefined ? {} : { signal } })
  }

  write(data: string): void { this.writes.push(data) }

  kill(signal?: string): void {
    if (this.throwKill) throw new Error('process raced')
    this.kills.push(signal ?? 'SIGHUP')
    this.onKill?.()
    if (this.autoExitOnKill) this.emitExit(0, signal === 'SIGKILL' ? 9 : 15)
  }

  asPty(): IPty {
    return this as unknown as IPty
  }
}

class FakeInspector implements ProcessInspector {
  pgid: number | undefined = 456
  waiting = false
  /** The shell's own row, present like the real /proc- and ps-backed scans; tests recycle or drop it. */
  root: ProcessIdentity | undefined = { pid: 123, started: 'shell' }
  members: ProcessIdentity[] = []
  sessionMembers: ProcessIdentity[] = []
  readonly alive = new Set<number>()
  readonly groups: Array<[number, SubprocessTerminalSignal]> = []
  readonly processes: Array<[number, 'SIGTERM' | 'SIGKILL']> = []
  readonly stdinChecks: Array<[number, number]> = []
  throwGroup = false
  throwProcess = false
  removeOnSignal = true

  foregroundPgid() { return this.pgid }
  isStdinWaiting(pgid: number, shellPid: number) {
    this.stdinChecks.push([pgid, shellPid])
    return this.waiting
  }
  /** Per-question table reads; tests replace one to stage a scan without rebuilding the fake. */
  readTree: () => ProcessIdentity[] = () => this.root === undefined ? this.members : [this.root, ...this.members]
  readSession: () => ProcessIdentity[] = () => this.sessionMembers
  readAlive: (identity: ProcessIdentity) => boolean = identity => this.alive.has(identity.pid)
  /** Liveness as of right now; tests diverge it from readAlive to stage an exit between scan and signal. */
  readCurrentAlive: (identity: ProcessIdentity) => boolean = identity => this.readAlive(identity)
  /** Counts process-table captures so read-amplification cases can pin them. */
  captures = 0

  snapshot(): ProcessSnapshot {
    this.captures += 1
    return {
      tree: () => this.readTree(),
      session: () => this.readSession(),
      alive: identity => this.readAlive(identity),
    }
  }

  isAlive(identity: ProcessIdentity) { return this.readCurrentAlive(identity) }
  signalGroup(pgid: number, signal: SubprocessTerminalSignal) {
    if (this.throwGroup) throw new Error('group failed')
    this.groups.push([pgid, signal])
  }
  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL') {
    // Mirrors the real inspectors' alive-gated signalling.
    if (this.throwProcess) throw new Error('process raced')
    if (!this.isAlive(identity)) return
    this.processes.push([identity.pid, signal])
    if (this.removeOnSignal) this.alive.delete(identity.pid)
  }
}

afterEach(() => { vi.useRealTimers() })

function makeHandle(pty: FakePty, inspector: ProcessInspector, graceMs: number): LocalTerminalHandle {
  // The suite pins POSIX signalling semantics deterministically on every host;
  // the win32 branches get their own platform-explicit tests below.
  return new LocalTerminalHandle(pty.asPty(), inspector, graceMs, 'linux')
}

describe('LocalTerminalHandle', () => {
  it('terminates a managed range with TERM when it stops within the grace period', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const stopped = Promise.withResolvers<undefined>()
    const signals: Array<'SIGTERM' | 'SIGKILL'> = []
    const owner: BoundProcessOwner = {
      signal(signal) {
        signals.push(signal)
        if (signal === 'SIGTERM') {
          pty.emitExit(0, 15)
          stopped.resolve(undefined)
        }
      },
      waitForExit: () => stopped.promise,
      terminateForHostExit: vi.fn(),
    }
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10, 'linux', owner)

    await handle.terminate()

    expect(signals).toEqual(['SIGTERM'])
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the terminal-exit grace when the pty exits first', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const stopped = Promise.withResolvers<undefined>()
    const signals: Array<'SIGTERM' | 'SIGKILL'> = []
    const owner: BoundProcessOwner = {
      signal(signal) {
        signals.push(signal)
        if (signal === 'SIGTERM') {
          stopped.resolve(undefined)
          setTimeout(() => { pty.emitExit(0, 15) }, 1)
        }
      },
      waitForExit: () => stopped.promise,
      terminateForHostExit: vi.fn(),
    }
    const handle = new LocalTerminalHandle(pty.asPty(), new FakeInspector(), 100, 'linux', owner)

    const terminating = handle.terminate()
    await vi.advanceTimersByTimeAsync(1)
    await terminating

    expect(signals).toEqual(['SIGTERM'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('escalates a managed range to KILL after the TERM grace expires', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const stopped = Promise.withResolvers<undefined>()
    const signals: Array<'SIGTERM' | 'SIGKILL'> = []
    const owner: BoundProcessOwner = {
      signal(signal) {
        signals.push(signal)
        if (signal === 'SIGKILL') {
          pty.emitExit(0, 9)
          stopped.resolve(undefined)
        }
      },
      waitForExit: () => stopped.promise,
      terminateForHostExit: vi.fn(),
    }
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10, 'linux', owner)

    const terminating = handle.terminate()
    await vi.advanceTimersByTimeAsync(10)
    await terminating

    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('force-kills and retries a managed range when observation first rejects', async () => {
    const pty = new FakePty()
    const failure = new Error('scope became unreadable')
    const signals: Array<'SIGTERM' | 'SIGKILL'> = []
    const waitForExit = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined)
    const owner: BoundProcessOwner = {
      signal: (signal) => { signals.push(signal) },
      waitForExit,
      terminateForHostExit: vi.fn(),
    }
    const handle = new LocalTerminalHandle(pty.asPty(), new FakeInspector(), 10, 'linux', owner)

    await expect(handle.terminate()).rejects.toBe(failure)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(waitForExit).toHaveBeenCalledTimes(2)
  })

  it('preserves both failed managed-range observations after force-kill', async () => {
    const pty = new FakePty()
    const firstFailure = new Error('scope became unreadable')
    const finalFailure = new Error('scope stayed unreadable')
    const signals: Array<'SIGTERM' | 'SIGKILL'> = []
    const owner: BoundProcessOwner = {
      signal: (signal) => { signals.push(signal) },
      waitForExit: vi.fn()
        .mockRejectedValueOnce(firstFailure)
        .mockRejectedValueOnce(finalFailure),
      terminateForHostExit: vi.fn(),
    }
    const handle = new LocalTerminalHandle(pty.asPty(), new FakeInspector(), 10, 'linux', owner)

    await expect(handle.terminate()).rejects.toMatchObject({
      errors: [firstFailure, finalFailure],
      message: 'terminal managed-range cleanup failed',
    })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('routes managed terminal host exit directly to KILL', () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const signal = vi.fn()
    const terminateForHostExit = vi.fn()
    const owner: BoundProcessOwner = { signal, waitForExit: async () => {}, terminateForHostExit }
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10, 'linux', owner)

    handle.terminateForHostExit()

    expect(signal).not.toHaveBeenCalled()
    expect(terminateForHostExit).toHaveBeenCalledOnce()
    expect(inspector.processes).toEqual([])
    expect(pty.kills).toEqual([])
  })

  it('rejects managed outcome conversion and cleans through its owner exactly once', async () => {
    const pty = new FakePty()
    const failure = new Error('invalid bootstrap outcome')
    const cleanup = vi.fn()
    const owner: BoundProcessOwner = {
      signal: vi.fn(),
      waitForExit: async () => {},
      terminateForHostExit: vi.fn(),
      cleanup,
    }
    const handle = new LocalTerminalHandle(
      pty.asPty(),
      new FakeInspector(),
      10,
      'linux',
      owner,
      () => { throw failure },
    )

    pty.emitExit()
    await expect(handle.done).rejects.toBe(failure)
    await expect(handle.terminate()).resolves.toBeUndefined()
    await expect(handle.terminate()).resolves.toBeUndefined()
    await vi.waitFor(() => { expect(cleanup).toHaveBeenCalledOnce() })
  })

  it('runs owner cleanup once after repeated failed managed termination attempts', async () => {
    const pty = new FakePty()
    const failure = new Error('scope stayed unreadable')
    const cleanup = vi.fn()
    const owner: BoundProcessOwner = {
      signal: vi.fn(),
      waitForExit: vi.fn(async () => { throw failure }),
      terminateForHostExit: vi.fn(),
      cleanup,
    }
    const handle = new LocalTerminalHandle(pty.asPty(), new FakeInspector(), 10, 'linux', owner)

    await expect(handle.terminate()).rejects.toThrow('terminal managed-range cleanup failed')
    await expect(handle.terminate()).rejects.toThrow('terminal managed-range cleanup failed')
    expect(cleanup).not.toHaveBeenCalled()
    pty.emitExit()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await vi.waitFor(() => { expect(cleanup).toHaveBeenCalledOnce() })
  })

  it('waits for the node-pty exit event after the managed range becomes empty', async () => {
    const pty = new FakePty()
    const owner: BoundProcessOwner = {
      signal: vi.fn(),
      waitForExit: async () => {},
      terminateForHostExit: vi.fn(),
    }
    const handle = new LocalTerminalHandle(pty.asPty(), new FakeInspector(), 100, 'linux', owner)
    let settled = false

    const terminating = handle.terminate().then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)

    pty.emitExit()
    await terminating
  })

  it('rejects when a managed range stops but node-pty never publishes exit', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const signals: Array<'SIGTERM' | 'SIGKILL'> = []
    const owner: BoundProcessOwner = {
      signal: (signal) => { signals.push(signal) },
      waitForExit: async () => {},
      terminateForHostExit: vi.fn(),
    }
    const handle = new LocalTerminalHandle(pty.asPty(), new FakeInspector(), 10, 'linux', owner)

    const terminating = handle.terminate()
    const rejected = expect(terminating).rejects.toThrow('terminal cleanup failed; surviving pid: 123')
    await vi.advanceTimersByTimeAsync(10)
    await rejected
    expect(signals).toEqual(['SIGTERM'])
  })

  it('force-kills descendants around the shell during synchronous host exit', () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const first = { pid: 124, started: 'first' }
    const late = { pid: 125, started: 'late' }
    inspector.members = [first]
    inspector.alive.add(pty.pid)
    inspector.alive.add(first.pid)
    const signalProcess = inspector.signalProcess.bind(inspector)
    inspector.signalProcess = (identity, signal) => {
      signalProcess(identity, signal)
      if (identity.pid === pty.pid) {
        inspector.members = [first, late]
        inspector.alive.add(late.pid)
      }
    }
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10)

    handle.terminateForHostExit()
    expect(inspector.processes).toEqual([
      [first.pid, 'SIGKILL'],
      [pty.pid, 'SIGKILL'],
      [late.pid, 'SIGKILL'],
    ])
    expect(pty.kills).toEqual([])

    pty.emitExit()
    handle.terminateForHostExit()
    expect(pty.kills).toEqual([])
  })

  it('uses captured identities and contains shell races when final inspection fails', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const captured = { pid: 124, started: 'captured' }
    inspector.members = [captured]
    inspector.alive.add(pty.pid)
    inspector.alive.add(captured.pid)
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10)
    await handle.inspectForeground()
    inspector.readTree = () => { throw new Error('process table unavailable') }
    inspector.throwProcess = true

    expect(() => { handle.terminateForHostExit() }).not.toThrow()
    expect(inspector.processes).toEqual([])
    expect(pty.kills).toEqual([])
  })

  it('uses node-pty only when the shell start identity was unavailable', () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.root = undefined
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10)

    handle.terminateForHostExit()
    expect(pty.kills).toEqual(['SIGKILL'])

    const racingPty = new FakePty()
    const racingInspector = new FakeInspector()
    racingInspector.root = undefined
    racingPty.throwKill = true
    const racingHandle = new LocalTerminalHandle(racingPty.asPty(), racingInspector, 10)
    expect(() => { racingHandle.terminateForHostExit() }).not.toThrow()
  })

  it('does not signal a recycled terminal root before its delayed exit callback', () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.alive.add(pty.pid)
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10)
    inspector.root = { pid: pty.pid, started: 'recycled' }
    inspector.readAlive = identity => identity.started === 'recycled'

    handle.terminateForHostExit()

    expect(inspector.processes).toEqual([])
    expect(pty.kills).toEqual([])
  })

  it('bridges terminal bytes, foreground control, and signalled exit facts', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.waiting = true
    const handle = makeHandle(pty, inspector, 10)
    const chunks: Buffer[] = []
    handle.output.on('data', (chunk: Buffer) => { chunks.push(chunk) })

    pty.emitData('hello €')
    await handle.write('input\r')
    expect(pty.writes).toEqual(['input\r'])
    expect(await handle.inspectForeground()).toEqual({ processGroupId: 456, inputWaiting: true })
    expect(inspector.stdinChecks).toEqual([[456, 123]])
    expect(await handle.signalForeground('SIGINT')).toBe(456)
    expect(inspector.groups).toEqual([[456, 'SIGINT']])

    pty.emitExit(7, 9)
    pty.emitExit(0)
    expect(await handle.done).toEqual({ exitCode: null, signal: 'SIGKILL' })
    await handle.terminate()
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello €')
  })

  it('rejects unsafe foreground signals and writes after exit', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const handle = makeHandle(pty, inspector, 10)
    inspector.pgid = handle.pid
    await expect(handle.signalForeground('SIGKILL')).rejects.toThrow('terminate the terminal session')
    inspector.pgid = undefined
    expect(await handle.inspectForeground()).toBeUndefined()
    await expect(handle.signalForeground('SIGTERM')).rejects.toThrow('cannot resolve')

    pty.emitExit(3)
    expect(await handle.done).toEqual({ exitCode: 3, signal: null })
    await handle.terminate()
    await expect(handle.write('late')).rejects.toThrow('has exited')
  })

  it('keeps the shell alive until forced descendants leave', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.members = [{ pid: 124, started: 'child' }]
    inspector.alive.add(124)
    inspector.removeOnSignal = false
    const handle = makeHandle(pty, inspector, 20)

    const quiescent = handle.terminate()
    expect(handle.terminate()).toBe(quiescent)
    await vi.advanceTimersByTimeAsync(20)
    expect(inspector.processes).toContainEqual([124, 'SIGKILL'])
    expect(pty.kills).toEqual([])

    inspector.alive.delete(124)
    await vi.advanceTimersByTimeAsync(20)
    await quiescent
    expect(pty.kills).toEqual(['SIGTERM'])
  })

  it('keeps an early exit wait pending through descendant cleanup', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.members = [{ pid: 124, started: 'child' }]
    inspector.alive.add(124)
    inspector.removeOnSignal = false
    const handle = makeHandle(pty, inspector, 20)
    pty.emitExit()
    const waiting = handle.terminate()
    let settled = false
    void waiting.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe(false)

    inspector.alive.delete(124)
    await vi.advanceTimersByTimeAsync(20)
    await waiting
  })

  it('cleans a same-session descendant after the top-level shell exits naturally', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const disowned = { pid: 124, started: 'disowned' }
    inspector.readSession = () => inspector.alive.has(disowned.pid) ? [disowned] : []
    inspector.alive.add(124)
    const handle = makeHandle(pty, inspector, 20)

    pty.emitExit()

    await handle.terminate()
    expect(inspector.processes).toEqual([[124, 'SIGTERM']])
  })

  it('retains an inspected descendant after it reparents away from the shell', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const descendant = { pid: 124, started: 'observed' }
    inspector.members = [descendant]
    inspector.alive.add(descendant.pid)
    const handle = makeHandle(pty, inspector, 20)

    await handle.inspectForeground()
    inspector.members = []
    pty.emitExit()

    await handle.terminate()
    expect(inspector.processes).toEqual([[124, 'SIGTERM']])
  })

  it('does not adopt the children of a recycled shell pid', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const handle = makeHandle(pty, inspector, 10)

    pty.emitExit()
    const imposterChild = { pid: 999, started: 'imposter-child' }
    inspector.root = { pid: 123, started: 'imposter' }
    inspector.members = [imposterChild]
    inspector.alive.add(imposterChild.pid)

    await handle.terminate()
    expect(inspector.processes).toEqual([])
  })

  it('adopts nothing when the shell identity was never observable', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.root = undefined
    const orphan = { pid: 321, started: 'unverifiable' }
    inspector.members = [orphan]
    inspector.alive.add(orphan.pid)
    const handle = makeHandle(pty, inspector, 10)

    await handle.terminate()
    expect(inspector.processes).toEqual([])
    expect(pty.kills).toEqual(['SIGTERM'])
  })

  it('rescans for descendants forked during TERM', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const root = { pid: 123, started: 'shell' }
    let reads = 0
    inspector.readTree = () => {
      reads += 1
      if (reads === 1) return [root]
      if (reads === 2) {
        inspector.alive.add(124)
        return [root, { pid: 124, started: 'first' }]
      }
      if (reads === 3) {
        inspector.alive.add(125)
        return [root, { pid: 125, started: 'late' }]
      }
      return []
    }
    const handle = makeHandle(pty, inspector, 10)
    await handle.terminate()
    expect(inspector.processes).toEqual([[124, 'SIGTERM'], [125, 'SIGKILL']])
    expect(pty.kills).toEqual(['SIGTERM'])
  })

  it('sweeps a same-session descendant forked while the shell handles TERM', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const late = { pid: 124, started: 'shell-term-trap' }
    pty.onKill = () => {
      inspector.sessionMembers = [late]
      inspector.alive.add(late.pid)
    }
    const handle = makeHandle(pty, inspector, 10)

    await handle.terminate()

    expect(inspector.processes).toEqual([[late.pid, 'SIGTERM']])
    expect(pty.kills).toEqual(['SIGTERM'])
  })

  it('retries failed cleanup after a surviving descendant leaves', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const late = { pid: 124, started: 'shell-term-survivor' }
    inspector.removeOnSignal = false
    pty.onKill = () => {
      inspector.sessionMembers = [late]
      inspector.alive.add(late.pid)
    }
    const handle = makeHandle(pty, inspector, 10)

    const first = handle.terminate()
    const failed = expect(first).rejects.toThrow('surviving pids: 124')
    await vi.advanceTimersByTimeAsync(25)
    await failed

    inspector.alive.delete(late.pid)
    const retry = handle.terminate()
    expect(retry).not.toBe(first)
    await retry
    expect(inspector.processes).toEqual([[late.pid, 'SIGTERM'], [late.pid, 'SIGKILL']])
  })

  it('retains captured descendants after reparenting', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const captured = { pid: 124, started: 'captured' }
    const root = { pid: 123, started: 'shell' }
    let reads = 0
    inspector.alive.add(captured.pid)
    inspector.readTree = () => { reads += 1; return reads === 1 ? [root] : reads === 2 ? [root, captured] : [] }
    inspector.signalProcess = (identity, signal) => {
      inspector.processes.push([identity.pid, signal])
      if (signal === 'SIGKILL') inspector.alive.delete(identity.pid)
    }
    const handle = makeHandle(pty, inspector, 20)
    const quiescent = handle.terminate()
    await vi.advanceTimersByTimeAsync(25)
    await quiescent
    expect(inspector.processes).toEqual([[124, 'SIGTERM'], [124, 'SIGKILL']])
  })

  it('reports a top-level process that ignores escalation', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    pty.autoExitOnKill = false
    const handle = makeHandle(pty, new FakeInspector(), 10)
    const failed = expect(handle.terminate()).rejects.toThrow('surviving pid: 123')
    await vi.advanceTimersByTimeAsync(25)
    await failed
    expect(pty.kills).toEqual(['SIGTERM', 'SIGKILL'])

    pty.emitExit(0, 999)
    expect(await handle.done).toEqual({ exitCode: null, signal: null })
    await handle.terminate()
  })

  it('contains process races while reporting surviving descendants', async () => {
    const pty = new FakePty()
    pty.throwKill = true
    const inspector = new FakeInspector()
    inspector.members = [{ pid: 124, started: 'child' }]
    inspector.alive.add(124)
    inspector.throwProcess = true
    const handle = makeHandle(pty, inspector, 1)
    await expect(handle.terminate()).rejects.toThrow('surviving pids: 124')
  })
})

describe('LocalTerminalHandle on Windows', () => {
  const win32 = 'win32' as NodeJS.Platform

  it('delivers SIGINT as a Ctrl-C input write without inspector signalling', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10, win32)
    await expect(handle.signalForeground('SIGINT')).resolves.toBe(456)
    expect(pty.writes).toEqual(['\x03'])
    expect(inspector.groups).toEqual([])
  })

  it('rejects SIGTSTP and SIGHUP as unavailable on Windows', async () => {
    const handle = new LocalTerminalHandle(new FakePty().asPty(), new FakeInspector(), 10, win32)
    await expect(handle.signalForeground('SIGTSTP')).rejects.toThrow('unsupported on Windows')
    await expect(handle.signalForeground('SIGHUP')).rejects.toThrow('unsupported on Windows')
  })

  it('routes SIGTERM through the inspector tree with the pseudo foreground group', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10, win32)
    await expect(handle.signalForeground('SIGTERM')).resolves.toBe(456)
    expect(inspector.groups).toEqual([[456, 'SIGTERM']])
    expect(pty.writes).toEqual([])
  })

  it('still refuses to SIGKILL the terminal shell on Windows', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10, win32)
    inspector.pgid = handle.pid
    await expect(handle.signalForeground('SIGKILL')).rejects.toThrow('terminate the terminal session')
  })

  it('escalates the shell through taskkill tiers instead of node-pty signal kills', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.alive.add(123)
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10, win32)
    const quiescent = handle.terminate()
    await vi.advanceTimersByTimeAsync(5)
    expect(inspector.processes).toEqual([[123, 'SIGTERM']])
    expect(pty.kills).toEqual([])

    pty.emitExit()
    await quiescent
    expect(inspector.processes).toEqual([[123, 'SIGTERM']])
    expect(pty.kills).toEqual([])
  })

  it('reports a shell that survives both taskkill tiers', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.alive.add(123)
    inspector.removeOnSignal = false
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10, win32)
    const failed = expect(handle.terminate()).rejects.toThrow('surviving pid: 123')
    await vi.advanceTimersByTimeAsync(25)
    await failed
    expect(inspector.processes).toEqual([[123, 'SIGTERM'], [123, 'SIGKILL']])
    expect(pty.kills).toEqual([])

    pty.emitExit()
    await handle.terminate()
  })

  it('skips taskkill escalation entirely when the shell already exited', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.alive.add(123)
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10, win32)
    pty.emitExit()
    await handle.terminate()
    expect(inspector.processes).toEqual([])
    expect(pty.kills).toEqual([])
  })

  it('falls back to the bare node-pty kill when the shell identity was never observable', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.root = undefined
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10, win32)
    await handle.terminate()
    expect(pty.kills).toHaveLength(1)
    expect(inspector.processes).toEqual([])
  })
})

describe('signalling freshness and containment', () => {
  it('keeps synchronous host exit going when the process table cannot be captured', () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.alive.add(pty.pid)
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10)
    inspector.snapshot = () => { throw new Error('process table unavailable') }

    expect(() => { handle.terminateForHostExit() }).not.toThrow()

    // forceStopShell still runs: a failed scan must not cost the PTY root.
    expect(inspector.processes).toEqual([[pty.pid, 'SIGKILL']])
  })

  it('captures no process table for a signalling round with no members', () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.alive.add(pty.pid)
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10)
    // Only the shell exists, so every descendant scan yields an empty round.
    inspector.readTree = () => [{ pid: pty.pid, started: 'shell' }]
    inspector.captures = 0

    handle.terminateForHostExit()

    // Two descendant scans and nothing else: no capture for either empty
    // signalling round, and none for the identity-fenced shell kill.
    expect(inspector.captures).toBe(2)
  })
})

describe('process-table read amplification', () => {
  // The macOS inspector answers every question by forking `/bin/ps`, so a
  // readiness poll that asks per descendant scales its blocking cost with the
  // command's process tree. These pin the read count, not the wall time.
  function darwinInternals(table: string): { internals: ProcessInspectorInternals; tableReads: string[] } {
    const tableReads: string[] = []
    const unreachable = (): never => { throw new Error('darwin inspection uses exec and kill only') }
    return {
      tableReads,
      internals: {
        readFile: unreachable,
        readDir: unreachable,
        readLink: unreachable,
        stat: unreachable,
        open: unreachable,
        read: unreachable,
        close: unreachable,
        exec(_file, args) {
          if (args.includes('tpgid=')) return '456\n'
          tableReads.push(args.join(' '))
          return table
        },
        kill() {},
      },
    }
  }

  /** A shell at pid 123 with `count` descendants chained beneath it. */
  function shellTable(count: number): string {
    const rows = [' 123 1 Mon Jul 21 10:00:00 2026']
    for (let index = 0; index < count; index += 1) {
      rows.push(` ${String(124 + index)} ${String(123 + index)} Mon Jul 21 10:00:${String(index + 1).padStart(2, '0')} 2026`)
    }
    return `${rows.join('\n')}\n`
  }

  async function tableReadsForOnePoll(descendants: number): Promise<number> {
    const { internals, tableReads } = darwinInternals(shellTable(descendants))
    const inspector = createProcessInspector('darwin', 'arm64', internals)
    const handle = new LocalTerminalHandle(new FakePty().asPty(), inspector, 10, 'darwin')
    tableReads.length = 0
    const foreground = await handle.inspectForeground()
    expect(foreground).toEqual({ processGroupId: 456, inputWaiting: false })
    return tableReads.length
  }

  it('reads the macOS process table once per foreground inspection regardless of descendant count', async () => {
    expect(await tableReadsForOnePoll(0)).toBe(1)
    expect(await tableReadsForOnePoll(2)).toBe(1)
    expect(await tableReadsForOnePoll(10)).toBe(1)
  })
})
