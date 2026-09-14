import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer } from '../src/protocol.ts'
import { SshConnection } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), connect: vi.fn(), tlsConnect: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: transport.spawn,
  execFile: transport.execFile,
}))
vi.mock('node:net', async importOriginal => ({
  ...await importOriginal<typeof import('node:net')>(),
  createConnection: transport.connect,
}))

vi.mock('node:tls', async importOriginal => ({
  ...await importOriginal<typeof import('node:tls')>(),
  connect: transport.tlsConnect,
}))

// These transport-only tests own no filesystem or native process; cleanup
// settles in microtasks so it cannot hide an unjoined control command.
vi.mock('node:fs/promises', () => ({
  mkdtemp: async () => '/virtual/dsh-ssh-test',
  rm: async () => {},
}))

class PendingSocket extends Duplex {
  override _read(): void {}
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback()
  }

  disableRenegotiation(): void {}
}

class HelperChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private stopped = false
  readonly signals: (string | undefined)[] = []

  kill(signal?: string): boolean {
    this.signals.push(signal)
    if (!this.stopped) {
      this.stopped = true
      queueMicrotask(() => { this.emit('close', 0, null) })
    }
    return true
  }
}

async function setup(phase: 'connect' | 'authenticate', pauseControl?: 'forward' | 'cancel', holdHeartbeat = false, holdClose = false) {
  const child = new HelperChild()
  const heartbeat = Promise.withResolvers<null>()
  const ordinary = Promise.withResolvers<null>()
  const ordinaryEntered = Promise.withResolvers<undefined>()
  const closing = Promise.withResolvers<null>()
  const closeEntered = Promise.withResolvers<undefined>()
  let heartbeatCalls = 0
  const helper = new SshRpcPeer(child.stdin, child.stdout, 4096, 8, async (method) => {
    if (method === 'close') { closeEntered.resolve(undefined); return holdClose ? closing.promise : null }
    if (method === 'heartbeat') { heartbeatCalls++; return holdHeartbeat ? heartbeat.promise : null }
    if (method === 'ordinary') { ordinaryEntered.resolve(undefined); return ordinary.promise }
    if (method !== 'hello') throw new Error(`unexpected helper operation: ${method}`)
    return { protocol: 1, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: 'v24.19.0', node: '/usr/bin/node', root: '/tmp/remote-helper', workspace: '/workspace' }
  })
  const rawSocket = new PendingSocket()
  const secureSocket = new PendingSocket()
  const authenticating = Promise.withResolvers<undefined>()
  const allocated = Promise.withResolvers<undefined>()
  const controlEntered = Promise.withResolvers<undefined>()
  const controlAborted = Promise.withResolvers<undefined>()
  let finishControl: (() => void) | undefined
  let controlChild: HelperChild | undefined
  transport.spawn.mockReturnValue(child)
  transport.execFile.mockImplementation((
    _file: string, args: string[], options: { signal: AbortSignal },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const command = new HelperChild()
    if (pauseControl !== undefined && args.includes(pauseControl)) {
      controlChild = command
      finishControl = () => { command.kill() }
      options.signal.addEventListener('abort', () => {
        callback(new Error('control command cancelled'), '', '')
        controlAborted.resolve(undefined)
      }, { once: true })
      controlEntered.resolve(undefined)
    } else queueMicrotask(() => { callback(null, '', ''); command.kill() })
    return command
  })
  transport.connect.mockImplementation(() => {
    allocated.resolve(undefined)
    if (phase === 'authenticate') queueMicrotask(() => { rawSocket.emit('connect') })
    return rawSocket
  })
  transport.tlsConnect.mockImplementation(() => {
    rawSocket.on('error', (error) => { secureSocket.destroy(error) })
    rawSocket.once('close', () => { secureSocket.destroy() })
    secureSocket.once('close', () => { rawSocket.destroy() })
    authenticating.resolve(undefined)
    return secureSocket
  })
  const socket = phase === 'connect' ? rawSocket : secureSocket
  const ctx = new Context()
  const fiber = ctx.plugin(SshConnection, {
    host: 'hermetic-test', node: '/usr/bin/node', helper: '/opt/dsh/helper.js', helperHash: 'a'.repeat(64), workspace: '/workspace',
    requestTimeoutMs: 10_000, maxFrameBytes: 4096, maxPending: holdHeartbeat ? 1 : 8, leaseMs: 30_000,
  })
  onTestFinished(async () => {
    heartbeat.resolve(null)
    ordinary.resolve(null)
    closing.resolve(null)
    finishControl?.()
    rawSocket.destroy()
    secureSocket.destroy()
    helper.close()
    child.stderr.destroy()
    child.kill()
    await fiber.dispose()
    vi.clearAllMocks()
  })
  await fiber
  const pending = ctx.ssh.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
  const observed = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  if (pauseControl === 'forward') await controlEntered.promise
  else await allocated.promise
  if (phase === 'authenticate') await authenticating.promise
  return { service: ctx.ssh, socket, observed, controlEntered: controlEntered.promise,
    controlAborted: controlAborted.promise, finishControl: () => { finishControl?.() },
    controlSignals: () => controlChild?.signals, heartbeatCalls: () => heartbeatCalls,
    ordinaryEntered: ordinaryEntered.promise, releaseOrdinary: () => { ordinary.resolve(null) },
    releaseHeartbeat: () => { heartbeat.resolve(null) }, closeEntered: closeEntered.promise,
    releaseClose: () => { closing.resolve(null) } }
}

describe.skipIf(process.platform === 'win32')('SSH stream establishment disposal', () => {
  it.each(['ready continuation', 'already closing'] as const)('rejects new requests during the %s without sending them', async (phase) => {
    const state = await setup('connect', undefined, false, true)
    const request = () => state.service.request('ordinary', {}, z.null(), undefined, true)
      .then(() => ({ kind: 'completed' as const }), (error: unknown) => ({ kind: 'rejected' as const, error }))
    const pending = phase === 'ready continuation' ? request() : undefined
    const disposal = state.service.dispose()
    await state.closeEntered
    const outcome = await Promise.race([
      pending ?? request(),
      state.ordinaryEntered.then(() => ({ kind: 'admitted' as const })),
    ])
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind !== 'rejected') throw new Error('request was sent after disposal began')
    expect(String(outcome.error)).toContain('SSH connection is closed')
    state.releaseClose()
    await disposal
  })

  it('keeps one heartbeat outstanding when ordinary capacity is full and its reply is delayed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let state: Awaited<ReturnType<typeof setup>> | undefined
    try {
      state = await setup('connect', undefined, true)
      let ordinarySettled = false
      const pending = state.service.request('ordinary', {}, z.null(), undefined, true)
        .then(value => ({ value }), (error: unknown) => ({ error }))
        .finally(() => { ordinarySettled = true })
      await state.ordinaryEntered
      await vi.advanceTimersByTimeAsync(10_000)
      expect(state.heartbeatCalls()).toBe(1)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(state.heartbeatCalls()).toBe(1)
      expect(ordinarySettled).toBe(false)
      state.releaseHeartbeat()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(state.heartbeatCalls()).toBe(2)
      state.releaseOrdinary()
      expect(await pending).toEqual({ value: null })
    } finally {
      state?.releaseHeartbeat()
      state?.releaseOrdinary()
      await state?.service.dispose()
      vi.useRealTimers()
    }
  })

  it('force-kills a control command that outlives cancellation and joins its close', async () => {
    const { service, observed, controlAborted, controlSignals } = await setup('connect', 'forward')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const disposal = service.dispose()
      await controlAborted
      await vi.advanceTimersByTimeAsync(10_000)
      await disposal
      expect(controlSignals()).toContain('SIGKILL')
      expect(await observed).toHaveProperty('error')
    } finally { vi.useRealTimers() }
  })

  it.each(['forward', 'cancel'] as const)('joins a pending SSH %s command after its cancellation callback', async (command) => {
    const { service, socket, observed, controlEntered, controlAborted, finishControl } = await setup('connect', command)
    if (command === 'cancel') socket.destroy()
    await controlEntered
    let disposed = false
    const disposal = service.dispose().then(() => { disposed = true })
    await controlAborted
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    finishControl()
    await disposal
    expect(await observed).toHaveProperty('error')
    const commands = transport.execFile.mock.calls.length
    await expect(service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })).rejects.toThrow(/closed|disconnected|lost/)
    expect(transport.execFile.mock.calls).toHaveLength(commands)
  })

  it.each(['connect', 'authenticate'] as const)('rejects a close-only socket while awaiting %s', async (phase) => {
    const { socket, observed } = await setup(phase)
    const errors: Error[] = []
    socket.on('error', (error) => { errors.push(error) })
    socket.destroy()
    const result = await observed
    expect(result).toHaveProperty('error')
    expect(String('error' in result ? result.error : '')).toMatch(/clos(?:ed|ing)|lost|refused/)
    expect(errors).toEqual([])
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('data')).toBe(0)
    expect(socket.listenerCount('end')).toBe(0)
    expect(socket.listenerCount('secureConnect')).toBe(0)
  })

  it.each(['connect', 'authenticate'] as const)('settles establishment when the connection is disposed during %s', async (phase) => {
    const { service, socket, observed } = await setup(phase)
    await service.dispose()
    const result = await observed
    expect(result).toHaveProperty('error')
    expect(String('error' in result ? result.error : '')).toMatch(/clos(?:ed|ing)|lost|refused/)
    expect(socket.destroyed).toBe(true)
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('data')).toBe(0)
    expect(socket.listenerCount('end')).toBe(0)
    expect(socket.listenerCount('secureConnect')).toBe(0)
  })
})
