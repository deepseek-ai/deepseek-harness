/** SSH startup identity and request lifetimes over the actual administrative protocol. */
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer } from '../src/protocol.ts'
import { SshConnection } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), connect: vi.fn(), tls: vi.fn(), directory: vi.fn(), remove: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: transport.spawn, execFile: transport.exec }))
vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), createConnection: transport.connect }))
vi.mock('node:tls', async original => ({ ...await original<typeof import('node:tls')>(), connect: transport.tls }))
vi.mock('node:fs/promises', () => ({ mkdtemp: transport.directory, rm: transport.remove }))

class Stream extends Duplex {
  finishDestroy: ((error: Error | null) => void) | undefined
  holdDestroy = false
  override _read(): void {}
  override _write(_bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback() }
  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (this.holdDestroy) this.finishDestroy = callback
    else callback(error)
  }
  releaseDestroy(): void {
    const callback = this.finishDestroy
    this.finishDestroy = undefined
    callback?.(null)
  }
  disableRenegotiation(): void {}
}

class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  readonly terminating = Promise.withResolvers<undefined>()
  ignoreTerm = false
  closed = false
  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal)
    this.terminating.resolve(undefined)
    if (this.ignoreTerm && signal !== 'SIGKILL') return true
    if (!this.closed) {
      this.closed = true
      queueMicrotask(() => { this.emit('close', 0, null) })
    }
    return true
  }
}

const config: Config = {
  host: 'test-alias', node: '/remote/node', helper: '/remote/helper.js', helperHash: 'a'.repeat(64), workspace: '/remote/workspace',
  requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
}
const hello = {
  protocol: 1, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: 'v24.19.0',
  node: '/canonical/node', root: '/tmp/remote-helper', workspace: '/canonical/workspace',
}

function setup(options: {
  config?: Partial<Config>
  hello?: Record<string, unknown>
  holdHello?: boolean
  holdConnect?: boolean
  forwardFailure?: Error
  heartbeatFailure?: Error
  directoryFailure?: Error
} = {}) {
  const ctx = new Context()
  const child = new Child()
  const raw = new Stream()
  const secure = new Stream()
  const releaseHello = Promise.withResolvers<undefined>()
  const helloEntered = Promise.withResolvers<undefined>()
  const requestEntered = Promise.withResolvers<AbortSignal>()
  const released = Promise.withResolvers<null>()
  const calls: { method: string; params: unknown }[] = []
  const helper = new SshRpcPeer(child.stdin, child.stdout, 4096, 8, async (method, params, signal) => {
    calls.push({ method, params })
    if (method === 'hello') {
      helloEntered.resolve(undefined)
      if (options.holdHello) await releaseHello.promise
      return { ...hello, ...options.hello }
    }
    if (method === 'held') { requestEntered.resolve(signal); return released.promise }
    if (method === 'echo') return params
    if (method === 'heartbeat' && options.heartbeatFailure !== undefined) throw options.heartbeatFailure
    if (method === 'heartbeat' || method === 'close') return null
    throw new Error(`unexpected helper request ${method}`)
  })
  transport.directory.mockResolvedValue('/virtual/ssh-startup')
  if (options.directoryFailure !== undefined) transport.directory.mockRejectedValueOnce(options.directoryFailure)
  transport.remove.mockResolvedValue(undefined)
  transport.spawn.mockReturnValue(child)
  transport.exec.mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: Error | null) => void) => {
    const command = new Child()
    queueMicrotask(() => { callback(args.includes('forward') ? options.forwardFailure ?? null : null); command.kill() })
    return command
  })
  transport.connect.mockImplementation(() => {
    if (!options.holdConnect) queueMicrotask(() => { raw.emit('connect') })
    return raw
  })
  transport.tls.mockImplementation(() => {
    raw.on('error', (error) => { secure.destroy(error) })
    raw.once('close', () => { secure.destroy() })
    secure.once('close', () => { raw.destroy() })
    queueMicrotask(() => { secure.emit('secureConnect') })
    return secure
  })
  // oxlint-disable-next-line eslint/prefer-const -- Failed construction still runs the pre-registered fixture cleanup.
  let service: SshConnection | undefined
  onTestFinished(async () => {
    releaseHello.resolve(undefined)
    released.resolve(null)
    raw.releaseDestroy()
    secure.releaseDestroy()
    try { await service?.dispose() }
    finally {
      raw.destroy(); secure.destroy(); helper.close(); child.stderr.destroy(); child.kill()
      await ctx.fiber.dispose()
      vi.restoreAllMocks()
      for (const mock of Object.values(transport)) mock.mockReset()
    }
  })
  service = new SshConnection(ctx, { ...config, ...options.config })
  return { service, child, helper, raw, secure, calls, requestEntered: requestEntered.promise,
    helloEntered: helloEntered.promise, releaseHello: () => { releaseHello.resolve(undefined) }, release: () => { released.resolve(null) } }
}

describe.skipIf(process.platform === 'win32')('SSH connection startup', () => {
  it.each([
    { host: '-option' }, { host: 'alias; command' }, { node: 'relative' }, { helperHash: 'bad' },
    { bootstrapPath: '/remote/bootstrap.js' }, { bootstrapHash: 'b'.repeat(64) },
    { requestTimeoutMs: 0 }, { requestTimeoutMs: 2_147_483_648 },
    { maxFrameBytes: 64 * 1024 * 1024 + 1 }, { maxPending: 129 }, { leaseMs: 2999 },
  ])('rejects invalid deployment configuration before SSH starts: %j', (invalid) => {
    expect(() => setup({ config: invalid })).toThrow()
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('rejects a non-POSIX client before starting SSH', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try { expect(() => setup()).toThrow('POSIX client') }
    finally { platform.mockRestore() }
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('publishes only verified remote coordinates and quotes the configured executable paths', async () => {
    const test = setup({ holdHello: true, config: { helper: "/remote/helper's file.js", bootstrapPath: '/remote/process.js', bootstrapHash: 'b'.repeat(64) }, hello: { bootstrapHash: 'b'.repeat(64) } })
    expect(() => test.service.nodeExecutable).toThrow('not ready')
    expect(() => test.service.bootstrapPath).toThrow('verified bootstrapPath')
    await test.helloEntered
    test.releaseHello()
    await test.service[Service.init]()
    expect(test.service.nodeExecutable).toBe('/canonical/node')
    expect(test.service.bootstrapPath).toBe('/remote/process.js')
    const argv = transport.spawn.mock.calls[0]?.[1] as string[]
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('ForwardAgent=no')
    expect(argv.at(-1)).toBe("'/remote/node' '--disable-sigusr1' '/remote/helper'\\''s file.js'")
    expect(test.calls[0]?.params).toEqual({ protocol: 1, workspace: '/remote/workspace', leaseMs: 30_000, bootstrapPath: '/remote/process.js' })
  })

  it('permits filesystem-only deployments and refuses an unconfigured PTC bootstrap getter', async () => {
    const test = setup()
    await test.service.ready
    expect(test.service.nodeExecutable).toBe('/canonical/node')
    expect(() => test.service.bootstrapPath).toThrow('verified bootstrapPath')
    expect(await test.service.request('echo', { value: 42 }, z.object({ value: z.number() }))).toEqual({ value: 42 })
  })

  it.each([
    { hello: { hash: 'c'.repeat(64) }, error: 'helper digest' },
    { hello: { bootstrapHash: 'c'.repeat(64) }, error: 'bootstrap digest' },
    { hello: { protocol: 2 }, error: 'Invalid' },
  ])('refuses a mismatched helper identity before readiness: $error', async ({ hello, error }) => {
    const test = setup({ hello })
    await expect(test.service.ready).rejects.toThrow(error)
    expect(() => test.service.nodeExecutable).toThrow('not ready')
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow()
  })

  it('joins disposal requested before directory allocation publishes a child', async () => {
    const test = setup()
    const rejected = expect(test.service.ready).rejects.toThrow('closed before startup')
    const disposal = test.service.dispose()
    await Promise.all([rejected, disposal])
    expect(transport.spawn).not.toHaveBeenCalled()
    expect(transport.remove).toHaveBeenCalledWith('/virtual/ssh-startup', { recursive: true, force: true })
  })

  it('preserves the first SSH process error and closes later requests', async () => {
    const test = setup()
    await test.service.ready
    const failure = new Error('SSH transport refused')
    test.child.emit('error', failure)
    await Promise.resolve()
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toBe(failure)
    expect(test.child.signals).toContain('SIGTERM')
  })

  it('cancels bounded administrative work and allows explicit process waits past that deadline', async () => {
    const test = setup()
    await test.service.ready
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      const pending = test.service.request('held', {}, z.null())
      const rejected = expect(pending).rejects.toThrow('cancelled')
      const remoteSignal = await test.requestEntered
      deadline.abort()
      await rejected
      await expect.poll(() => remoteSignal.aborted).toBe(true)
      expect(timeout).toHaveBeenCalledWith(1000)
      test.release()
      expect(await test.service.request('echo', 42, z.number(), undefined, true)).toBe(42)
      const caller = AbortSignal.abort(new Error('caller cancelled'))
      await expect(test.service.request('echo', {}, z.unknown(), caller)).rejects.toThrow('caller cancelled')
    } finally { timeout.mockRestore() }
  })

  it('returns authenticated paused streams and rejects paths outside the helper root', async () => {
    const test = setup()
    await test.service.ready
    for (const path of ['/tmp/other/control', '/tmp/remote-helper/control:extra', '/tmp/remote-helper/control\n']) {
      await expect(test.service.connectStream({ path, capability: 'b'.repeat(64) })).rejects.toThrow('invalid stream path')
    }
    expect(transport.exec).not.toHaveBeenCalled()
    const socket = await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    expect(socket).toBe(test.secure)
    expect(socket.readableFlowing).toBe(false)
    socket.destroy(new Error('data channel closed'))
    await expect.poll(() => transport.exec.mock.calls.length).toBe(2)
    expect(transport.exec.mock.calls[1]?.[1]).toContain('cancel')
  })

  it('cancels a failed forwarding reservation before surfacing its error', async () => {
    const failure = new Error('forwarding refused')
    const test = setup({ forwardFailure: failure })
    await test.service.ready
    await expect(test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })).rejects.toBe(failure)
    expect(transport.exec.mock.calls[1]?.[1]).toContain('cancel')
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('keeps caller cancellation attached while a forwarded socket is connecting', async () => {
    const test = setup({ holdConnect: true })
    await test.service.ready
    const controller = new AbortController()
    const pending = test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }, controller.signal)
    const rejected = expect(pending).rejects.toThrow('caller stopped')
    await expect.poll(() => transport.connect.mock.calls.length).toBe(1)
    controller.abort('caller stopped')
    await rejected
    expect(test.raw.destroyed).toBe(true)
  })

  it('reports directory creation failure without starting a helper process', async () => {
    const failure = new Error('temporary directory unavailable')
    const test = setup({ directoryFailure: failure })
    await expect(test.service.ready).rejects.toBe(failure)
    await test.service.dispose()
    expect(transport.spawn).not.toHaveBeenCalled()
    expect(transport.remove).not.toHaveBeenCalled()
  })

  it('invalidates requests when a heartbeat reports a failed helper', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const test = setup({ heartbeatFailure: new Error('helper unhealthy') })
    try {
      await test.service.ready
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow('helper unhealthy')
      expect(test.child.signals).toContain('SIGTERM')
    } finally { await test.service.dispose(); vi.useRealTimers() }
  })

  it('force-kills a helper process that does not exit after termination', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const test = setup()
    try {
      await test.service.ready
      test.child.ignoreTerm = true
      const disposal = test.service.dispose()
      await test.child.terminating.promise
      await vi.advanceTimersByTimeAsync(1000)
      await disposal
      expect(test.child.signals).toContain('SIGKILL')
    } finally {
      test.child.ignoreTerm = false
      test.child.kill()
      await test.service.dispose()
      vi.useRealTimers()
    }
  })

  it('joins authenticated sockets whose native close callbacks are delayed', async () => {
    const test = setup()
    await test.service.ready
    await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    test.raw.holdDestroy = true
    test.secure.holdDestroy = true
    let disposed = false
    const disposal = test.service.dispose().then(() => { disposed = true })
    await test.child.terminating.promise
    expect(disposed).toBe(false)
    expect(test.raw.finishDestroy).toBeTypeOf('function')
    expect(test.secure.finishDestroy).toBeTypeOf('function')
    test.secure.releaseDestroy()
    test.raw.releaseDestroy()
    await disposal
    expect(test.raw.closed).toBe(true)
    expect(test.secure.closed).toBe(true)
  })

  it('closes authenticated sockets when the SSH process fails', async () => {
    const test = setup()
    await test.service.ready
    await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    test.child.emit('error', new Error('transport lost'))
    await test.service.dispose()
    expect(test.raw.destroyed).toBe(true)
    expect(test.secure.destroyed).toBe(true)
  })

  it('contains a failed local forwarding-path removal and still disposes the connection', async () => {
    const test = setup()
    await test.service.ready
    const socket = await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    transport.remove.mockRejectedValueOnce(new Error('forwarding path already removed'))
    socket.destroy()
    await expect.poll(() => transport.remove.mock.calls.length).toBe(1)
    await test.service.dispose()
    expect(transport.remove).toHaveBeenLastCalledWith('/virtual/ssh-startup', { recursive: true, force: true })
  })
})
