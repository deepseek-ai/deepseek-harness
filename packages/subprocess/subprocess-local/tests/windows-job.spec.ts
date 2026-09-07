import { EventEmitter } from 'node:events'
import { fstatSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  launchWindowsJob,
  probeWindowsJob,
} from '../src/windows-job.ts'
import { bindManagedProcess } from '../src/spawn.ts'

class FakeChild extends EventEmitter {
  pid: number | undefined = 432
  connected = true
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  targetStdin = new PassThrough()
  targetStdout = new PassThrough()
  targetStderr = new PassThrough()
  stdio = [null, null, null, null, this.targetStdin, this.targetStdout, this.targetStderr]
  sent: unknown[] = []
  killed: NodeJS.Signals[] = []
  sendError: Error | undefined
  deferSendCallbacks = false
  pendingSendCallbacks: Array<(error: Error | null) => void> = []
  throwOnSendCall: number | undefined
  sendThrown: unknown = new Error('send threw')
  private sendCalls = 0

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sendCalls += 1
    if (this.sendCalls === this.throwOnSendCall) throw this.sendThrown
    this.sent.push(message)
    if (callback !== undefined && this.deferSendCallbacks) {
      this.pendingSendCallbacks.push(callback)
    } else {
      queueMicrotask(() => { callback?.(this.sendError ?? null) })
    }
    return true
  }
  deliverNextSend(error: Error | null): void {
    const callback = this.pendingSendCallbacks.shift()
    if (callback === undefined) throw new Error('no deferred send callback')
    callback(error)
  }
  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal)
    return true
  }
}

const spec = {
  argv: ['tool.exe', 'literal arg'],
  cwd: 'C:\\target',
  env: { TARGET: 'yes' },
  stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  graceMs: 100,
} as const

function launch(
  child = new FakeChild(),
  request: Parameters<typeof launchWindowsJob>[0] = spec,
  emitSpawn = true,
) {
  const spawn = vi.fn((_command: string, _args: readonly string[], _options: unknown) => child)
  const result = launchWindowsJob(request, { TARGET: 'yes' }, {
    spawn: spawn as never,
    runnerInvocation: ['C:\\node.exe', 'C:\\runner.js'],
  })
  if (emitSpawn) child.emit('spawn')
  return { child, result, spawn }
}

describe('Windows Job capability', () => {
  it('uses the production dependency paths by default', async () => {
    vi.resetModules()
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const load = vi.fn(() => ({ bindings: true }) as never)
    const probe = vi.fn()
    vi.doMock('node:child_process', async importOriginal => ({
      ...await importOriginal<typeof import('node:child_process')>(),
      spawn,
    }))
    vi.doMock('@deepseek-ai/dsh-win32-process', () => ({
      loadWin32ProcessBindings: load,
      probeCurrentTokenJobSupport: probe,
    }))
    try {
      const isolated = await import('../src/windows-job.ts')
      expect(isolated.probeWindowsJob()).toBe(true)
      expect(load).toHaveBeenCalledOnce()
      expect(probe).toHaveBeenCalledOnce()

      const result = isolated.launchWindowsJob(spec, { TARGET: 'yes' })
      expect(spawn).toHaveBeenCalledOnce()
      child.emit('spawn')
      child.emit('message', { type: 'target-exit', exitCode: 0 })
      child.connected = false
      child.emit('close', 0, null)
      await expect(result.direct).resolves.toEqual({ exitCode: 0, signal: null })
      await expect(result.owner.waitForExit()).resolves.toBeUndefined()
    } finally {
      vi.doUnmock('node:child_process')
      vi.doUnmock('@deepseek-ai/dsh-win32-process')
      vi.resetModules()
    }
  })

  it('rechecks runner and empty Job support on every eligible spawn', () => {
    const runnerAvailable = vi.fn(() => true)
    const load = vi.fn(() => ({ bindings: true }) as never)
    const probe = vi.fn()
    const inputs = {
      runnerInvocation: ['C:\\node.exe', 'C:\\runner.js'] as [string, ...string[]],
      runnerAvailable,
      loadWin32ProcessBindings: load,
      probeCurrentTokenJobSupport: probe,
    }
    expect(probeWindowsJob(inputs)).toBe(true)
    expect(probeWindowsJob(inputs)).toBe(true)
    expect(runnerAvailable).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('falls back when either runner or current Job capability is unavailable', () => {
    expect(probeWindowsJob({
      resolveRunnerInvocation: () => { throw new Error('runner resolution failed') },
    })).toBe(false)
    expect(probeWindowsJob({ runnerInvocation: ['/missing'], runnerAvailable: () => false })).toBe(false)
    expect(probeWindowsJob({
      runnerInvocation: ['C:\\node.exe'],
      runnerAvailable: () => true,
      loadWin32ProcessBindings: () => { throw new Error('bindings missing') },
    })).toBe(false)
  })
})

describe('Windows parent runner contract', () => {
  it('isolates runner stdio, carries target stdio on fd 4 through fd 6, and sends cwd/env', () => {
    const { child, result, spawn } = launch()
    expect(spawn).toHaveBeenCalledWith('C:\\node.exe', [
      'C:\\runner.js', '--', 'tool.exe', 'literal arg',
    ], expect.objectContaining({
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 2],
    }))
    expect(child.sent).toEqual([{ type: 'start', cwd: 'C:\\target', env: { TARGET: 'yes' } }])
    expect(result.stdin).toBe(child.targetStdin)
    expect(result.stdout).toBe(child.targetStdout)
    expect(result.stderr).toBe(child.targetStderr)
  })

  it('carries a null-device fd 4 for ignored stdin and closes the parent descriptor after spawn', () => {
    const child = new FakeChild()
    const ignored = {
      ...spec,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
    } as const
    const { result, spawn } = launch(child, ignored)
    expect(spawn).toHaveBeenCalledWith('C:\\node.exe', expect.any(Array), expect.objectContaining({
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', expect.any(Number), 'pipe', 2],
    }))
    const options = spawn.mock.calls[0]?.[2] as { stdio: unknown[] }
    const carrier = options.stdio[4]
    if (typeof carrier !== 'number') throw new Error('expected numeric null-device carrier')
    expect(() => fstatSync(carrier)).toThrow()
    expect(result.stdin).toBeNull()
  })

  it('closes the ignored-stdin descriptor when runner spawn throws synchronously', () => {
    const ignored = {
      ...spec,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
    } as const
    let carrier: number | undefined
    const spawn = vi.fn((_command: string, _args: readonly string[], options: unknown) => {
      const candidate = (options as { stdio: unknown[] }).stdio[4]
      if (typeof candidate !== 'number') throw new Error('expected numeric null-device carrier')
      carrier = candidate
      throw new Error('runner spawn failed')
    })

    expect(() => launchWindowsJob(ignored, { TARGET: 'yes' }, {
      spawn: spawn as never,
      runnerInvocation: ['C:\\node.exe', 'C:\\runner.js'],
    })).toThrow('runner spawn failed')
    if (carrier === undefined) throw new Error('runner spawn was not attempted')
    const closedCarrier = carrier
    expect(() => fstatSync(closedCarrier)).toThrow()
  })

  it('maps target-exit to direct outcome and clean close to range quiescence', async () => {
    const { child, result } = launch()
    child.emit('message', { type: 'target-exit', exitCode: 7 })
    await expect(result.direct).resolves.toEqual({ exitCode: 7, signal: null })
    child.connected = false
    child.emit('close', 0, null)
    await expect(result.owner.waitForExit()).resolves.toBeUndefined()
  })

  it('latches target-exit while stdio drains and leaves later runner failure to waitForExit', async () => {
    const { child, result } = launch()
    const handle = bindManagedProcess(spec, result)
    child.emit('message', { type: 'target-exit', exitCode: 7 })
    await Promise.resolve()
    child.connected = false
    child.emit('close', 127, null)
    child.targetStdout.end()
    child.targetStderr.end()
    await expect(handle.done).resolves.toEqual({ exitCode: 7, signal: null })
    await expect(handle.waitForExit()).rejects.toThrow('exit code 127')
  })

  it('maps errors and restores raw start-cancellation reasons from the parent latch', async () => {
    const spawned = launch()
    spawned.child.emit('message', {
      type: 'error', error: { name: 'Error', message: 'missing', code: 'ENOENT' },
    })
    await expect(spawned.result.direct).rejects.toMatchObject({ code: 'ENOENT' })
    spawned.child.connected = false
    spawned.child.emit('close', 0, null)
    await expect(spawned.result.owner.waitForExit()).resolves.toBeUndefined()

    const cancelled = launch()
    const reason = new Error('caller aborted')
    cancelled.result.owner.signal('SIGTERM', reason)
    expect(cancelled.child.sent.at(-1)).toEqual({ type: 'terminate' })
    cancelled.child.emit('message', {
      type: 'error',
      error: {
        name: 'Error', message: 'subprocess target start was cancelled',
      },
    })
    await expect(cancelled.result.direct).rejects.toBe(reason)
    cancelled.child.connected = false
    cancelled.child.emit('close', 0, null)
    await expect(cancelled.result.owner.waitForExit()).resolves.toBeUndefined()

    const nullCancelled = launch()
    nullCancelled.result.owner.signal('SIGTERM', null)
    nullCancelled.result.owner.signal('SIGKILL', new Error('later reason'))
    nullCancelled.child.emit('message', {
      type: 'error',
      error: {
        name: 'Error', message: 'subprocess target start was cancelled',
      },
    })
    await expect(nullCancelled.result.direct).rejects.toBeNull()
    nullCancelled.child.connected = false
    nullCancelled.child.emit('close', 0, null)
    await expect(nullCancelled.result.owner.waitForExit()).resolves.toBeUndefined()

    const implicit = launch()
    implicit.result.owner.signal('SIGTERM')
    implicit.child.emit('message', {
      type: 'error',
      error: {
        name: 'Error', message: 'subprocess target start was cancelled',
      },
    })
    await expect(implicit.result.direct).rejects.toBeUndefined()
    implicit.child.connected = false
    implicit.child.emit('close', 0, null)
    await expect(implicit.result.owner.waitForExit()).resolves.toBeUndefined()
  })

  it('preserves a strict provider error after a termination request', async () => {
    const spawned = launch()
    const localReason = new Error('caller aborted after target commit')
    spawned.result.owner.signal('SIGTERM', localReason)
    spawned.child.emit('message', {
      type: 'error',
      error: {
        name: 'Error',
        message: 'poll failed',
        code: 'EIO',
        syscall: 'QueryInformationJobObject',
      },
    })

    const failure = await spawned.result.direct.catch((error: unknown) => error)
    expect(failure).not.toBe(localReason)
    expect(failure).toMatchObject({
      message: 'poll failed',
      code: 'EIO',
      syscall: 'QueryInformationJobObject',
    })
    spawned.child.connected = false
    spawned.child.emit('close', 127, null)
    await expect(spawned.result.owner.waitForExit()).rejects.toThrow('exit code 127')
  })

  it('rejects direct and wait for runner error or abnormal runner exit', async () => {
    const failed = launch()
    failed.child.emit('message', {
      type: 'error', error: { name: 'Error', message: 'Job assignment failed' },
    })
    await expect(failed.result.direct).rejects.toThrow('Job assignment failed')
    failed.child.connected = false
    failed.child.emit('close', 127, null)
    await expect(failed.result.owner.waitForExit()).rejects.toThrow('exit code 127')

    const missing = launch()
    missing.child.connected = false
    missing.child.emit('close', null, 'SIGKILL')
    await expect(missing.result.direct).rejects.toThrow('signal SIGKILL')

    const statusless = launch()
    statusless.child.connected = false
    statusless.child.emit('close', null, null)
    await expect(statusless.result.direct).rejects.toThrow('without an exit status')
  })

  it('fails closed on malformed/duplicate result, runner spawn error, and start-send error', async () => {
    const malformed = launch()
    malformed.child.emit('message', { type: 'target-exit', exitCode: -1 })
    expect(malformed.child.killed).toEqual(['SIGKILL'])
    await expect(malformed.result.direct).rejects.toThrow('invalid target-exit')
    await expect(malformed.result.owner.waitForExit()).rejects.toThrow('invalid target-exit')

    const duplicate = launch()
    duplicate.child.emit('message', { type: 'target-exit', exitCode: 0 })
    duplicate.child.emit('message', { type: 'target-exit', exitCode: 0 })
    await expect(duplicate.result.direct).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(duplicate.result.owner.waitForExit()).rejects.toThrow('more than one direct result')

    const errored = launch(new FakeChild(), spec, false)
    const spawnError = new Error('runner executable missing')
    errored.child.emit('error', spawnError)
    await expect(errored.result.direct).rejects.toBe(spawnError)
    await expect(errored.result.owner.waitForExit()).resolves.toBeUndefined()
    errored.child.emit('close', 127, null)

    const postSpawnError = launch()
    const infrastructureError = new Error('runner failed after spawn')
    postSpawnError.child.emit('error', infrastructureError)
    await expect(postSpawnError.result.direct).rejects.toBe(infrastructureError)
    await expect(postSpawnError.result.owner.waitForExit()).rejects.toBe(infrastructureError)

    const sendFailedChild = new FakeChild()
    sendFailedChild.sendError = new Error('IPC send failed')
    const sendFailed = launch(sendFailedChild)
    await expect(sendFailed.result.direct).rejects.toThrow('IPC send failed')
    await expect(sendFailed.result.owner.waitForExit()).rejects.toThrow('IPC send failed')
    expect(sendFailedChild.killed).toEqual(['SIGKILL'])

    const noIpc = new FakeChild()
    Object.defineProperty(noIpc, 'send', { value: undefined })
    const noIpcResult = launch(noIpc).result
    await expect(noIpcResult.direct).rejects.toThrow('has no IPC channel')
    await expect(noIpcResult.owner.waitForExit()).rejects.toThrow('has no IPC channel')

    const nonError = new FakeChild()
    nonError.throwOnSendCall = 1
    nonError.sendThrown = 'start send failed'
    const nonErrorResult = launch(nonError).result
    await expect(nonErrorResult.direct).rejects.toBe('start send failed')
    await expect(nonErrorResult.owner.waitForExit()).rejects.toBe('start send failed')
  })

  it('fails infrastructure and kills the runner when termination delivery fails', async () => {
    const callback = launch()
    await Promise.resolve()
    callback.child.sendError = new Error('terminate callback failed')
    callback.result.owner.signal('SIGTERM')
    await expect(callback.result.direct).rejects.toThrow('terminate callback failed')
    await expect(callback.result.owner.waitForExit()).rejects.toThrow('terminate callback failed')
    expect(callback.child.killed).toEqual(['SIGKILL'])

    const throwingChild = new FakeChild()
    throwingChild.throwOnSendCall = 2
    throwingChild.sendThrown = 'terminate send threw'
    const throwing = launch(throwingChild)
    throwing.result.owner.signal('SIGTERM')
    await expect(throwing.result.direct).rejects.toBe('terminate send threw')
    await expect(throwing.result.owner.waitForExit()).rejects.toBe('terminate send threw')
    expect(throwing.child.killed).toEqual(['SIGKILL'])

    const errorChild = new FakeChild()
    errorChild.throwOnSendCall = 2
    const error = launch(errorChild)
    error.result.owner.signal('SIGTERM')
    await expect(error.result.direct).rejects.toThrow('send threw')
    await expect(error.result.owner.waitForExit()).rejects.toThrow('send threw')
  })

  it('accepts clean range settlement after a direct error races redundant termination delivery', async () => {
    const child = new FakeChild()
    const launched = launch(child)
    const handle = bindManagedProcess(spec, launched.result)
    await Promise.resolve()
    child.deferSendCallbacks = true
    child.emit('message', {
      type: 'error', error: { name: 'Error', message: 'target start failed', code: 'ENOENT' },
    })
    await expect(handle.done).rejects.toMatchObject({ code: 'ENOENT' })
    expect(child.pendingSendCallbacks).toHaveLength(1)

    expect(child.connected).toBe(true)
    child.deliverNextSend(new Error('late EPIPE'))
    await Promise.resolve()
    expect(child.killed).toEqual([])
    child.connected = false
    child.emit('close', 0, null)
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('accepts clean range settlement when a target result races redundant termination delivery', async () => {
    const child = new FakeChild()
    const launched = launch(child)
    const handle = bindManagedProcess(spec, launched.result)
    await Promise.resolve()
    child.deferSendCallbacks = true
    child.emit('message', { type: 'target-exit', exitCode: 7 })
    child.targetStdout.end()
    child.targetStderr.end()
    await expect(handle.done).resolves.toEqual({ exitCode: 7, signal: null })

    launched.result.owner.signal('SIGTERM')
    expect(child.pendingSendCallbacks).toHaveLength(1)

    expect(child.connected).toBe(true)
    child.deliverNextSend(new Error('late EPIPE'))
    await Promise.resolve()
    expect(child.killed).toEqual([])
    child.connected = false
    child.emit('close', 0, null)
    await expect(handle.done).resolves.toEqual({ exitCode: 7, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('uses synchronous runner termination for host exit and isolates repeated control', () => {
    const { child, result } = launch()
    result.owner.signal('SIGTERM', new Error('first'))
    result.owner.signal('SIGKILL', new Error('second'))
    expect(child.sent.filter(message => (message as { type?: string }).type === 'terminate')).toHaveLength(1)
    result.owner.terminateForHostExit()
    expect(child.killed).toEqual(['SIGKILL'])
  })
})
